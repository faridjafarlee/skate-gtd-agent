import { v4 as uuidv4 } from "uuid";
import { runAgent, runAgentWithTools } from "../agents/runner.js";
import { selectRolesForTask, getCustomPrompt } from "../core/agents/registry.js";
import { routeForTask, getModelsForTask } from "../core/models/index.js";
import { executeTool, listTools } from "../tools/runtime.js";
import { resolvePolicy } from "../security/policy.js";
import { compactContextIfEnabled, compactContextAsync, compactContext, getMaxContextChars, getCompactTriggerChars } from "../memory/compaction.js";
import type { Plan, Step, QualityProfile, ApprovalPolicy, AgentRole } from "../types/index.js";
import type { ToolPolicy } from "../types/tooling.js";
import { classifyRisk, requiresApproval } from "./approval.js";

const VALID_ROLES: AgentRole[] = ["scout", "planner", "builder", "reviewer", "documenter", "red_team"];

const DEFAULT_MAX_PLAN_STEPS = 20;

function getMaxPlanSteps(): number {
  const v = process.env.GTD_MAX_PLAN_STEPS;
  if (v === undefined || v === "") return DEFAULT_MAX_PLAN_STEPS;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 1 && n <= 200 ? n : DEFAULT_MAX_PLAN_STEPS;
}

/**
 * Validate plan.steps schema before execution. Throws with a clear message if invalid.
 */
export function validatePlanSteps(plan: Plan): void {
  if (!plan.steps || !Array.isArray(plan.steps)) {
    throw new Error("Plan has no steps array");
  }
  for (let i = 0; i < plan.steps.length; i++) {
    const s = plan.steps[i];
    if (!s || typeof s !== "object") {
      throw new Error(`Plan step ${i + 1}: expected object, got ${typeof s}`);
    }
    if (typeof s.id !== "string" || !s.id) throw new Error(`Plan step ${i + 1}: missing or invalid id`);
    if (typeof s.planId !== "string" || !s.planId) throw new Error(`Plan step ${i + 1}: missing or invalid planId`);
    if (typeof s.order !== "number" || !Number.isInteger(s.order) || s.order < 1) throw new Error(`Plan step ${i + 1}: order must be a positive integer`);
    if (typeof s.description !== "string" || s.description.length > 10000) throw new Error(`Plan step ${i + 1}: description must be a string (max 10000 chars)`);
    if (typeof s.assignedRole !== "string" || !VALID_ROLES.includes(s.assignedRole as AgentRole)) {
      throw new Error(`Plan step ${i + 1}: assignedRole must be one of ${VALID_ROLES.join(", ")}`);
    }
    const validRisk: Step["riskLevel"][] = ["low", "medium", "high", "critical"];
    if (typeof s.riskLevel !== "string" || !validRisk.includes(s.riskLevel)) {
      throw new Error(`Plan step ${i + 1}: riskLevel must be one of ${validRisk.join(", ")}`);
    }
    const validStatus: Step["status"][] = ["pending", "approved", "running", "done", "failed"];
    if (typeof s.status !== "string" || !validStatus.includes(s.status)) {
      throw new Error(`Plan step ${i + 1}: status must be one of ${validStatus.join(", ")}`);
    }
    if (typeof s.requiresApproval !== "boolean") throw new Error(`Plan step ${i + 1}: requiresApproval must be boolean`);
  }
  const maxSteps = getMaxPlanSteps();
  if (plan.steps.length > maxSteps) {
    throw new Error(`Plan has ${plan.steps.length} steps; maximum allowed is ${maxSteps} (GTD_MAX_PLAN_STEPS). Simplify the plan or increase the limit.`);
  }
}

/**
 * Try to parse machine-readable subtasks from Planner output.
 * Looks for a ```json ... ``` block or "subtasks"/"steps" key with array of { description, order?, assignedRole? }.
 * Exported for tests.
 */
export function parsePlannerSubtasks(plannerOutput: string, planId: string, _taskId: string): Step[] | null {
  if (!plannerOutput?.trim()) return null;
  let jsonStr: string | null = null;
  const codeBlock = /```(?:json)?\s*([\s\S]*?)```/.exec(plannerOutput);
  if (codeBlock?.[1]) jsonStr = codeBlock[1].trim();
  if (!jsonStr) {
    const stepsMatch = /"steps"\s*:\s*(\[[\s\S]*?\])/.exec(plannerOutput);
    const subtasksMatch = /"subtasks"\s*:\s*(\[[\s\S]*?\])/.exec(plannerOutput);
    const arr = stepsMatch?.[1] ?? subtasksMatch?.[1];
    if (arr) jsonStr = arr;
  }
  if (!jsonStr) return null;
  try {
    const data = JSON.parse(jsonStr) as unknown;
    const arr = Array.isArray(data) ? data : (data && typeof data === "object" && ("steps" in data) && Array.isArray((data as { steps: unknown }).steps))
      ? (data as { steps: unknown[] }).steps
      : (data && typeof data === "object" && ("subtasks" in data) && Array.isArray((data as { subtasks: unknown }).subtasks))
        ? (data as { subtasks: unknown[] }).subtasks
        : null;
    if (!arr || arr.length === 0) return null;
    const steps: Step[] = [];
    for (let i = 0; i < arr.length; i++) {
      const item = arr[i] as Record<string, unknown>;
      const desc = typeof item.description === "string" ? item.description : typeof item.title === "string" ? item.title : String(item);
      if (!desc || desc.length > 5000) continue;
      const order = typeof item.order === "number" ? item.order : i + 1;
      const role = typeof item.assignedRole === "string" && VALID_ROLES.includes(item.assignedRole as AgentRole)
        ? (item.assignedRole as AgentRole)
        : "builder";
      const riskLevel = classifyRisk(desc);
      const requiresApproval = item.requiresApproval === true || riskLevel === "high" || riskLevel === "critical";
      const workspaceRootIndex =
        typeof item.workspace_root_index === "number" && Number.isFinite(item.workspace_root_index)
          ? item.workspace_root_index
          : typeof item.workspaceRootIndex === "number" && Number.isFinite(item.workspaceRootIndex)
            ? item.workspaceRootIndex
            : undefined;
      steps.push({
        id: uuidv4(),
        planId,
        order,
        description: desc,
        assignedRole: role,
        riskLevel,
        status: "pending",
        requiresApproval,
        ...(workspaceRootIndex != null && workspaceRootIndex >= 0 ? { workspaceRootIndex } : {}),
      });
    }
    return steps.length > 0 ? steps : null;
  } catch {
    return null;
  }
}
import { audit } from "../security/audit.js";
import { newTraceId, setTraceId } from "../audit/events.js";
import { recordMetric } from "../telemetry/metrics.js";
import { estimateCost } from "../core/cost.js";
import { initOtel, getTracer, startSpan, endSpan } from "../telemetry/otel.js";

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
}

/** Machine-parseable failure/outcome code for scripting and API. */
export type OrchestrationErrorCode =
  | "completed"
  | "tool_failed"
  | "timeout"
  | "policy_denied"
  | "approval_required"
  | "cancelled"
  | "limits_reached"
  | "model_unavailable";

export interface OrchestrationResult {
  taskId: string;
  plan?: Plan;
  outputs: Map<string, string>;
  status: "completed" | "failed" | "blocked" | "cancelled";
  error?: string;
  /** Machine-parseable code for scripting/API (agent-trends 62). */
  errorCode?: OrchestrationErrorCode;
  usage?: TokenUsage;
  usageByModel?: Record<string, TokenUsage>;
  /** Approximate context size in tokens (dry-run only; plan + memory). */
  estimatedContextTokens?: number;
  /** Tool name -> call count (Builder phase; CC-21). */
  toolCalls?: Record<string, number>;
}

export interface RunOptions {
  taskDescription: string;
  qualityProfile: QualityProfile;
  approvalPolicy: ApprovalPolicy;
  modelId?: string;
  /** Per-role model overrides (e.g. { scout: "gpt-4o-mini", builder: "claude-sonnet-4" }) */
  modelOverrides?: Partial<Record<string, string>>;
  taskId?: string;
  onProgress?: (phase: string, role: string, status: string, output?: string) => void;
  /** When resuming a blocked task, skip Scout/Planner and use these outputs. Approval gate is bypassed. */
  resumeFrom?: { outputs: Record<string, string>; plan: Plan };
  /** When true, run Scout and Planner only, return plan without executing Builder. */
  dryRun?: boolean;
  /** When aborted, stop and return status "cancelled". */
  signal?: AbortSignal;
  /** Custom agent definitions from config */
  customAgents?: Array<{ id: string; name: string; prompt: string; description?: string }>;
  /** Override roles per profile (from config.profileRoles) */
  profileRoles?: Partial<Record<string, string[]>>;
  /** Stream Builder output in real time via onProgress(phase, role, "chunk", chunk) */
  streamOutput?: boolean;
  /** Memory context (MEMORY.md + structured entries) to prepend to agent context */
  memoryContext?: string;
  /** Max agent steps (turns) to run; after this, stop and return (status completed or partial). */
  maxTurns?: number;
  /** Max total tokens (prompt + completion) for the task; when exceeded, stop. */
  maxTokens?: number;
  /** Tool policy for Builder tool calls; when set, Builder uses runAgentWithTools. */
  toolPolicy?: ToolPolicy;
  /** When set, Builder will prompt on tool approval; supports allow/session/project, edit args, and reject with feedback. */
  onToolApprovalRequest?: (toolName: string, category: string, args: Record<string, unknown>) => Promise<import("../agents/runner.js").ToolApprovalResult>;
  addToSessionAllow?: (toolName: string, category: string) => void;
  addToProjectAllow?: (cwd: string, toolName: string, category: string) => Promise<void>;
  loadProjectAllow?: (cwd: string) => Promise<Set<string>>;
  /** Called after each agent step completes (PI-style post_step extension phase). PI-7: planStepId set when running a single plan step (runOnlyStepIndex). */
  onPhaseEnd?: (role: string, output?: string, planStepId?: string) => void | Promise<void>;
  /** Called before each agent step (PI-style pre_step extension phase). PI-7: planStepId set when running a single plan step (runOnlyStepIndex). */
  onPhaseStart?: (role: string, planStepId?: string) => void | Promise<void>;
  /** When set with resumeFrom, run only this role (1-based index into plan.steps; role = plan.steps[index-1].assignedRole). */
  runOnlyStepIndex?: number;
  /** Called after plan is built, before approval gate (PI-style post_plan extension phase). */
  onPostPlan?: (taskId: string, plan: Plan) => void | Promise<void>;
  /** Called when task becomes blocked at approval gate (PI-style approval extension phase). */
  onApprovalBlocked?: (taskId: string, plan: Plan) => void | Promise<void>;
  /** Per-step timeout in ms; aborts the current role step (e.g. Builder) without killing the whole task. */
  stepTimeoutMs?: number;
  /** Max estimated cost in USD; when exceeded, stop and return (status completed with message). */
  costCapUsd?: number;
  /** When set (e.g. 80), warn via onProgress when estimated cost reaches this % of costCapUsd (GTD_TASK_COST_WARN_PCT). */
  costWarnPct?: number;
  /** When set, file and git tools are restricted to paths under these roots (multi-repo / monorepo spike). */
  workspaceRoots?: string[];
  /** Restrict Builder to a subset of tools, e.g. "read_only" (CC-16). */
  toolChoice?: string;
  /** Per-category tool timeouts in ms, e.g. { network: 30000, command: 60000 } (CC-19). */
  toolTimeouts?: Partial<Record<string, number>>;
  /** Optional callback for tool confirmation messages: (name, args, "start"|"end"|"error", err?). */
  onToolConfirm?: (name: string, args: Record<string, unknown>, status: "start" | "end" | "error", err?: unknown) => void;
  /** Role-specific rules text (CC-10), merged into context per role. */
  roleRules?: Partial<Record<string, string>>;
  /** MCP resource context (CC-18): text loaded from configured MCP resource URIs, appended to Builder/Planner context. */
  mcpContext?: string;
  /** Image attachments for Builder (CC-20 vision): image_url or base64, passed to vision-capable model. */
  attachments?: Array<{ type: "image_url"; image_url: { url: string } } | { type: "image"; data: string; mimeType?: string }>;
  /** REPL inject-while-running: return next user-injected instruction (consumed). Used at step boundaries. */
  getInjectedInstruction?: () => string | undefined;
  /** Edit format for Builder: "diff" = prefer apply_patch, "whole" = prefer write_file/edit_file (default). */
  editFormat?: "diff" | "whole";
  /** When true, prefer local models (e.g. Ollama) when routing; cloud as opt-in (local-first). */
  preferLocal?: boolean;
  /** Optional custom compaction (agent-trends 84). When set, called with context text when over trigger; return compacted string. */
  compactionHook?: (text: string) => Promise<string>;
}

function addUsage(
  acc: { promptTokens: number; completionTokens: number },
  byModel: Record<string, TokenUsage>,
  modelId: string,
  usage?: { promptTokens: number; completionTokens: number }
): void {
  if (!usage) return;
  acc.promptTokens += usage.promptTokens;
  acc.completionTokens += usage.completionTokens;
  const existing = byModel[modelId];
  if (existing) {
    existing.promptTokens += usage.promptTokens;
    existing.completionTokens += usage.completionTokens;
  } else {
    byModel[modelId] = { promptTokens: usage.promptTokens, completionTokens: usage.completionTokens };
  }
}

function usageResult(acc: { promptTokens: number; completionTokens: number }, byModel: Record<string, TokenUsage>): { usage?: TokenUsage; usageByModel?: Record<string, TokenUsage> } {
  if (acc.promptTokens === 0 && acc.completionTokens === 0) return {};
  return {
    usage: { promptTokens: acc.promptTokens, completionTokens: acc.completionTokens },
    usageByModel: Object.keys(byModel).length ? byModel : undefined,
  };
}

export async function runOrchestration(options: RunOptions): Promise<OrchestrationResult> {
  const taskId = options.taskId ?? uuidv4();
  newTraceId();
  initOtel();
  const span = getTracer() ? startSpan("gtd.orchestration", { "task.id": taskId }) : undefined;
  const run = async (): Promise<OrchestrationResult> => {
  const outputs = new Map<string, string>();
  const usageAcc = { promptTokens: 0, completionTokens: 0 };
  const usageByModel: Record<string, TokenUsage> = {};
  let toolCallsFromBuilder: Record<string, number> | undefined;
  const withToolCalls = (r: OrchestrationResult): OrchestrationResult =>
    toolCallsFromBuilder && Object.keys(toolCallsFromBuilder).length > 0 ? { ...r, toolCalls: toolCallsFromBuilder } : r;

  const routingContext = { requiresTools: true, preferLocal: options.preferLocal };
  const routing = routeForTask("balanced", routingContext);
  const defaultModelId = options.modelId ?? routing?.modelId;
  const fallbackModels = getModelsForTask("balanced", routingContext);
  const resolveModelIds = (role: string): string[] => {
    const override = options.modelOverrides?.[role];
    if (override) return [override];
    if (defaultModelId) {
      const idx = fallbackModels.indexOf(defaultModelId);
      if (idx >= 0) return fallbackModels;
      return [defaultModelId, ...fallbackModels.filter((m) => m !== defaultModelId)];
    }
    return fallbackModels;
  };
  const resolveModel = (role: string): string | undefined =>
    options.modelOverrides?.[role] ?? defaultModelId;
  if (!defaultModelId && !options.modelOverrides) {
    return { taskId, outputs, status: "failed", error: "No LLM model enabled. Run 'gtd models enable <id>' first.", errorCode: "model_unavailable", ...usageResult(usageAcc, usageByModel) };
  }

  let roles = selectRolesForTask(options.qualityProfile, options.taskDescription, options.profileRoles);
  const resumeFrom = options.resumeFrom;
  const isResume = !!resumeFrom;
  let currentPlanStepId: string | undefined;
  if (resumeFrom && options.runOnlyStepIndex != null && options.runOnlyStepIndex >= 1 && resumeFrom.plan.steps.length >= options.runOnlyStepIndex) {
    const step = resumeFrom.plan.steps[options.runOnlyStepIndex - 1];
    roles = [step.assignedRole];
    currentPlanStepId = step.id;
  }

  if (resumeFrom) {
    for (const [k, v] of Object.entries(resumeFrom.outputs)) {
      outputs.set(k, v);
    }
  }

  let stepAbortController: AbortController | null = null;
  let stepTimeoutId: ReturnType<typeof setTimeout> | null = null;
  const startStepTimeout = (): void => {
    if (stepTimeoutId) clearTimeout(stepTimeoutId);
    stepAbortController = new AbortController();
    const ms = options.stepTimeoutMs ?? 0;
    stepTimeoutId = ms > 0 ? setTimeout(() => stepAbortController!.abort(), ms) : null;
  };
  const clearStepTimeout = (): void => {
    if (stepTimeoutId) {
      clearTimeout(stepTimeoutId);
      stepTimeoutId = null;
    }
    stepAbortController = null;
  };
  const checkAborted = (): boolean => options.signal?.aborted ?? stepAbortController?.signal.aborted ?? false;
  let turnCount = 0;
  const maxTurns = options.maxTurns ?? 0;
  const maxTokens = options.maxTokens ?? 0;
  const costCapUsd = options.costCapUsd ?? 0;
  const totalCostUsd = (): number => {
    let sum = 0;
    for (const [modelId, u] of Object.entries(usageByModel)) {
      const c = estimateCost(modelId, u.promptTokens, u.completionTokens);
      if (c !== undefined) sum += c;
    }
    return sum;
  };
  const checkLimits = (): boolean => {
    if (maxTurns > 0 && turnCount >= maxTurns) return true;
    if (maxTokens > 0 && usageAcc.promptTokens + usageAcc.completionTokens >= maxTokens) return true;
    if (costCapUsd > 0 && totalCostUsd() >= costCapUsd) return true;
    return false;
  };
  let costWarnEmitted = false;
  const maybeEmitCostWarn = (): void => {
    const costWarnPct = options.costWarnPct ?? 0;
    if (costWarnEmitted || costCapUsd <= 0 || costWarnPct <= 0 || totalCostUsd() < costCapUsd * (costWarnPct / 100)) return;
    costWarnEmitted = true;
    options.onProgress?.("cost_warn", "", "warn", `Estimated cost at ${Math.round((100 * totalCostUsd()) / costCapUsd)}% of cap ($${costCapUsd})`);
  };

  options.onProgress?.("select_roles", "", "running");

  if (checkAborted()) {
    return { taskId, outputs, status: "cancelled", error: "Task cancelled", errorCode: "cancelled", ...usageResult(usageAcc, usageByModel) };
  }

  // Scout (skip when resuming)
  if (!isResume && roles.includes("scout")) {
    const scoutModel = resolveModel("scout");
    if (!scoutModel) {
      options.onProgress?.("scout", "Scout", "error", "No model for Scout");
      return { taskId, outputs, status: "failed", error: "No model for Scout. Enable a model or set modelOverrides.scout.", errorCode: "model_unavailable", ...usageResult(usageAcc, usageByModel) };
    }
    await options.onPhaseStart?.("Scout", currentPlanStepId);
    options.onProgress?.("scout", "Scout", "running");
    startStepTimeout();
    const scoutStart = Date.now();
    try {
      const result = await runAgent({
        role: "scout",
        taskDescription: options.taskDescription,
        modelIds: resolveModelIds("scout"),
        systemPrompt: getCustomPrompt("scout", options.customAgents),
      });
      turnCount++;
      addUsage(usageAcc, usageByModel, result.modelUsed ?? scoutModel, result.usage);
      outputs.set("scout", result.output);
      options.onProgress?.("scout", "Scout", "done", result.output);
      await options.onPhaseEnd?.("Scout", result.output, currentPlanStepId);
      void recordMetric({ type: "step_latency", taskId, step: "scout", role: "scout", latencyMs: Date.now() - scoutStart, modelId: result.modelUsed });
      if (checkLimits()) {
        return { taskId, plan: undefined, outputs, status: "completed", error: maxTurns > 0 && turnCount >= maxTurns ? "Max turns reached." : "Token budget reached.", errorCode: "limits_reached", ...usageResult(usageAcc, usageByModel) };
      }
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      options.onProgress?.("scout", "Scout", "error", err);
      return { taskId, outputs, status: "failed", error: `Scout failed: ${err}`, errorCode: "tool_failed", ...usageResult(usageAcc, usageByModel) };
    } finally {
      clearStepTimeout();
    }
  }

  if (checkAborted()) return { taskId, outputs, status: "cancelled", error: "Task cancelled", errorCode: "cancelled", ...usageResult(usageAcc, usageByModel) };
  if (checkLimits()) return { taskId, outputs, status: "completed", error: "Max turns, token budget, or cost cap (GTD_TASK_COST_CAP) reached.", errorCode: "limits_reached", ...usageResult(usageAcc, usageByModel) };

  // Planner (skip when resuming)
  const memoryPrefix = options.memoryContext ? `[Memory]\n${options.memoryContext}\n\n` : "";
  const mcpPrefix = options.mcpContext ? `[MCP context]\n${options.mcpContext}\n\n` : "";
  let planContext = memoryPrefix + mcpPrefix + (outputs.get("scout") ?? "");
  if (options.roleRules?.planner) planContext = options.roleRules.planner + "\n\n" + planContext;
  if (!isResume && roles.includes("planner")) {
    const plannerModel = resolveModel("planner");
    if (!plannerModel) {
      options.onProgress?.("planner", "Planner", "error", "No model for Planner");
      return { taskId, outputs, status: "failed", error: "No model for Planner.", errorCode: "model_unavailable", ...usageResult(usageAcc, usageByModel) };
    }
    await options.onPhaseStart?.("Planner", currentPlanStepId);
    options.onProgress?.("planner", "Planner", "running");
    startStepTimeout();
    try {
      const result = await runAgent({
        role: "planner",
        taskDescription: options.taskDescription,
        modelIds: resolveModelIds("planner"),
        context: planContext,
        systemPrompt: getCustomPrompt("planner", options.customAgents),
      });
      turnCount++;
      addUsage(usageAcc, usageByModel, result.modelUsed ?? plannerModel, result.usage);
      outputs.set("planner", result.output);
      planContext = result.output;
      options.onProgress?.("planner", "Planner", "done", result.output);
      await options.onPhaseEnd?.("Planner", result.output, currentPlanStepId);
      if (checkLimits()) {
        return { taskId, outputs, status: "completed", error: "Max turns, token budget, or cost cap (GTD_TASK_COST_CAP) reached.", errorCode: "limits_reached", ...usageResult(usageAcc, usageByModel) };
      }
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      options.onProgress?.("planner", "Planner", "error", err);
      return { taskId, outputs, status: "failed", error: `Planner failed: ${err}`, ...usageResult(usageAcc, usageByModel) };
    } finally {
      clearStepTimeout();
    }
  }

  if (checkAborted()) return { taskId, outputs, status: "cancelled", error: "Task cancelled", errorCode: "cancelled", ...usageResult(usageAcc, usageByModel) };
  if (checkLimits()) return { taskId, outputs, status: "completed", error: "Max turns, token budget, or cost cap (GTD_TASK_COST_CAP) reached.", errorCode: "limits_reached", ...usageResult(usageAcc, usageByModel) };

  // Build plan steps (use existing plan when resuming; else try Planner subtasks or single step)
  const planId = uuidv4();
  let plan: Plan;
  if (isResume && resumeFrom) {
    plan = resumeFrom.plan;
  } else {
    const parsedSteps = parsePlannerSubtasks(planContext, planId, taskId);
    const steps: Step[] =
      parsedSteps && parsedSteps.length > 0
        ? parsedSteps.sort((a, b) => a.order - b.order).map((s, i) => ({ ...s, order: i + 1 }))
        : [
            {
              id: uuidv4(),
              planId,
              order: 1,
              description: `Implement: ${options.taskDescription}`,
              assignedRole: "builder" as AgentRole,
              riskLevel: classifyRisk(options.taskDescription),
              status: "pending" as const,
              requiresApproval: false,
            },
          ];
    const riskOrder: Record<Step["riskLevel"], number> = { low: 0, medium: 1, high: 2, critical: 3 };
    const maxRisk = steps.reduce<Step["riskLevel"]>(
      (acc, s) => (riskOrder[s.riskLevel] > riskOrder[acc] ? s.riskLevel : acc),
      "low"
    );
    plan = {
      id: planId,
      taskId,
      steps,
      estimatedRisk: maxRisk,
      createdAt: new Date(),
    };
  }

  validatePlanSteps(plan);

  await options.onPostPlan?.(taskId, plan);

  // Dry run: return plan after Scout + Planner (CC-11: include context size estimate)
  if (options.dryRun) {
    const planSummary = plan.steps.map((s, i) => `${i + 1}. ${s.description}`).join("\n");
    const contextChars = (options.memoryContext?.length ?? 0) + JSON.stringify(plan).length;
    const estimatedContextTokens = Math.ceil(contextChars / 4);
    return { taskId, plan, outputs, status: "completed", error: `[dry-run] Plan ready. Steps:\n${planSummary}`, estimatedContextTokens, ...usageResult(usageAcc, usageByModel) };
  }

  // Approval gate (bypassed when resuming)
  const approvalPolicy = isResume ? "auto" : options.approvalPolicy;
  for (const step of plan.steps) {
    if (requiresApproval(step, approvalPolicy)) {
      options.onProgress?.("approval_gate", step.assignedRole, "blocked", "Approval required");
      audit({ type: "approval_request", taskId, stepId: step.id, message: step.description });
      await options.onApprovalBlocked?.(taskId, plan);
      return { taskId, plan, outputs, status: "blocked", error: `Approval required. Run 'gtd approve ${taskId}' or use --auto.`, errorCode: "approval_required", ...usageResult(usageAcc, usageByModel) };
    }
  }

  if (checkAborted()) return { taskId, plan, outputs, status: "cancelled", error: "Task cancelled", errorCode: "cancelled", ...usageResult(usageAcc, usageByModel) };

  // Builder (skip when resuming and output already exists)
  let buildContextRaw = [memoryPrefix ? memoryPrefix.trim() : null, mcpPrefix ? mcpPrefix.trim() : null, outputs.get("scout"), outputs.get("planner")].filter(Boolean).join("\n\n");
  const editFormatHint =
    options.editFormat === "diff"
      ? "[Edit format: Prefer apply_patch (unified diff) for file edits when possible; use write_file only for new files.]"
      : options.editFormat === "whole"
        ? "[Edit format: Prefer write_file or edit_file (search-replace) for edits; use apply_patch only when a unified diff is already available.]"
        : "";
  if (editFormatHint) buildContextRaw = editFormatHint + "\n\n" + buildContextRaw;
  if (options.roleRules?.builder) buildContextRaw = options.roleRules.builder + "\n\n" + buildContextRaw;
  const maxContextChars = getMaxContextChars();
  const triggerChars = getCompactTriggerChars();
  if (buildContextRaw.length > triggerChars) {
    buildContextRaw = compactContext(buildContextRaw, maxContextChars);
  }
  const builderCwdForCompact = options.workspaceRoots?.[0] ?? process.cwd();
  let buildContext: string;
  if (options.compactionHook && buildContextRaw.length > triggerChars) {
    buildContext = await options.compactionHook(buildContextRaw);
  } else if (process.env.GTD_SESSION_COMPACT === "summarize") {
    buildContext = await compactContextAsync(buildContextRaw, undefined, resolveModel("planner"), builderCwdForCompact);
  } else {
    buildContext = compactContextIfEnabled(buildContextRaw);
  }
  if (roles.includes("builder") && !outputs.has("builder")) {
    let effectiveBuildContext = buildContext;
    const injected = options.getInjectedInstruction?.();
    if (injected?.trim()) {
      effectiveBuildContext = buildContext + `\n\n[User injected during run: ${injected.trim()}]\n`;
    }
    const builderModel = resolveModel("builder");
    if (!builderModel) {
      options.onProgress?.("builder", "Builder", "error", "No model for Builder");
      return { taskId, plan, outputs, status: "failed", error: "No model for Builder.", errorCode: "model_unavailable", ...usageResult(usageAcc, usageByModel) };
    }
    await options.onPhaseStart?.("Builder", currentPlanStepId);
    options.onProgress?.("builder", "Builder", "running");
    startStepTimeout();
    const builderToolPolicy =
      options.toolPolicy ??
      resolvePolicy(
        options.approvalPolicy === "auto"
          ? { mode: "dont-ask" }
          : options.approvalPolicy === "always"
            ? { mode: "plan" }
            : undefined
      );
    const useTools = !!builderToolPolicy;
    const currentStep =
      options.runOnlyStepIndex != null && options.runOnlyStepIndex >= 1 && plan.steps[options.runOnlyStepIndex - 1]
        ? plan.steps[options.runOnlyStepIndex - 1]
        : null;
    const defaultWorkspaceRootIndex = currentStep?.workspaceRootIndex;
    try {
      const builderCwd = process.cwd();
      const roots = options.workspaceRoots;
      const execToolWithRoots = (name: string, args: Record<string, unknown>, policy: import("../security/policy.js").ToolPolicy, opts?: { cwd?: string; allowOnceKeys?: Set<string> }): Promise<import("../types/tooling.js").ToolResult> => {
        if (name === "run_subagent" && process.env.GTD_SUBAGENT_DISABLED !== "1") {
          return (async (): Promise<import("../types/tooling.js").ToolResult> => {
            const question = String((args as { question?: string }).question ?? "").trim();
            if (!question) return { success: false, error: "run_subagent: question is required", riskLevel: "low" };
            const contextSnippet = typeof (args as { context_snippet?: string }).context_snippet === "string"
              ? (args as { context_snippet: string }).context_snippet.trim().slice(0, 4000)
              : "";
            const maxChars = typeof (args as { max_output_chars?: number }).max_output_chars === "number"
              ? Math.min(8000, Math.max(500, Math.floor((args as { max_output_chars: number }).max_output_chars)))
              : 4000;
            options.onToolConfirm?.(name, args, "start");
            try {
              const subResult = await runAgent({
                role: "builder",
                taskDescription: question,
                context: contextSnippet ? `Context:\n${contextSnippet}` : "",
                modelIds: resolveModelIds("builder"),
                systemPrompt: "You are a focused subagent. Answer only the given question with a concise excerpt or summary. Do not use tools. Be brief and relevant.",
              });
              const output = subResult.output.length > maxChars ? subResult.output.slice(0, maxChars) + "\n[...truncated]" : subResult.output;
              options.onToolConfirm?.(name, args, "end");
              return { success: true, output };
            } catch (e) {
              const err = e instanceof Error ? e.message : String(e);
              options.onToolConfirm?.(name, args, "error", e);
              return { success: false, error: `Subagent failed: ${err}`, riskLevel: "low" };
            }
          })();
        }
        const { workspace_root_index, ...restArgs } = args as Record<string, unknown> & { workspace_root_index?: number };
        const rootIndex = workspace_root_index != null ? Number(workspace_root_index) : defaultWorkspaceRootIndex;
        const effectiveCwd =
          roots?.length && rootIndex != null && rootIndex >= 0 && roots[rootIndex]
            ? roots[rootIndex]
            : (opts?.cwd ?? builderCwd);
        options.onToolConfirm?.(name, restArgs, "start");
        return executeTool(name, restArgs, policy, { ...opts, cwd: effectiveCwd, workspaceRoots: roots, toolTimeouts: options.toolTimeouts })
          .then((out) => {
            options.onToolConfirm?.(name, restArgs, "end");
            return out;
          })
          .catch((err) => {
            options.onToolConfirm?.(name, restArgs, "error", err);
            throw err;
          });
      };
      const result = useTools
        ? await runAgentWithTools({
            role: "builder",
            taskDescription: options.taskDescription,
            modelIds: resolveModelIds("builder"),
            context: effectiveBuildContext,
            systemPrompt: getCustomPrompt("builder", options.customAgents),
            tools: listTools({ toolChoice: options.toolChoice }),
            executeTool: execToolWithRoots,
            toolPolicy: builderToolPolicy,
            cwd: builderCwd,
            attachments: options.attachments,
            onChunk: options.streamOutput ? (chunk) => options.onProgress?.("builder", "Builder", "chunk", chunk) : undefined,
            onToolApprovalRequest: options.onToolApprovalRequest,
            addToSessionAllow: options.addToSessionAllow,
            addToProjectAllow: options.addToProjectAllow,
            loadProjectAllow: options.loadProjectAllow,
            getReminder:
              plan && currentStep
                ? () => {
                    const idx = plan.steps.findIndex((s) => s.id === currentStep!.id);
                    const remaining = idx >= 0 ? plan.steps.slice(idx).map((s) => s.description) : [currentStep.description];
                    const tail = remaining.slice(1).map((d) => d.slice(0, 80)).join("; ") || "none";
                    return `Current step (${currentStep.order}/${plan.steps.length}): ${currentStep.description}. Remaining: ${tail}.`;
                  }
                : undefined,
            getIdempotencyKey: (toolName, toolCallId) => `${taskId}:${toolCallId}`,
          })
        : await runAgent({
            role: "builder",
            taskDescription: options.taskDescription,
            modelIds: resolveModelIds("builder"),
            context: effectiveBuildContext,
            systemPrompt: getCustomPrompt("builder", options.customAgents),
            onChunk: options.streamOutput ? (chunk) => options.onProgress?.("builder", "Builder", "chunk", chunk) : undefined,
          });
      turnCount++;
      addUsage(usageAcc, usageByModel, result.modelUsed ?? builderModel, result.usage);
      maybeEmitCostWarn();
      outputs.set("builder", result.output);
      if (result.toolCalls && Object.keys(result.toolCalls).length > 0) {
        toolCallsFromBuilder = result.toolCalls;
      }
      options.onProgress?.("builder", "Builder", "done", result.output);
      await options.onPhaseEnd?.("Builder", result.output, currentPlanStepId);
      if (checkLimits()) {
        return withToolCalls({ taskId, plan, outputs, status: "completed", error: "Max turns, token budget, or cost cap (GTD_TASK_COST_CAP) reached.", errorCode: "limits_reached", ...usageResult(usageAcc, usageByModel) });
      }
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      options.onProgress?.("builder", "Builder", "error", err);
      return withToolCalls({ taskId, plan, outputs, status: "failed", error: `Builder failed: ${err}`, errorCode: "tool_failed", ...usageResult(usageAcc, usageByModel) });
    } finally {
      clearStepTimeout();
    }
  }

  if (checkAborted()) return withToolCalls({ taskId, plan, outputs, status: "cancelled", error: "Task cancelled", errorCode: "cancelled", ...usageResult(usageAcc, usageByModel) });
  if (checkLimits()) return withToolCalls({ taskId, plan, outputs, status: "completed", error: "Max turns, token budget, or cost cap (GTD_TASK_COST_CAP) reached.", errorCode: "limits_reached", ...usageResult(usageAcc, usageByModel) });

  // Reviewer and Documenter run in parallel (both depend only on Builder)
  let postBuilderContextRaw = [buildContext, outputs.get("builder")].filter(Boolean).join("\n\n");
  const injectedReview = options.getInjectedInstruction?.();
  if (injectedReview?.trim()) postBuilderContextRaw = postBuilderContextRaw + `\n\n[User injected during run: ${injectedReview.trim()}]\n`;
  if (postBuilderContextRaw.length > triggerChars) {
    postBuilderContextRaw = compactContext(postBuilderContextRaw, maxContextChars);
  }
  let postBuilderContext: string;
  if (options.compactionHook && postBuilderContextRaw.length > triggerChars) {
    postBuilderContext = await options.compactionHook(postBuilderContextRaw);
  } else if (process.env.GTD_SESSION_COMPACT === "summarize") {
    postBuilderContext = await compactContextAsync(postBuilderContextRaw, undefined, resolveModel("reviewer"), builderCwdForCompact);
  } else {
    postBuilderContext = compactContextIfEnabled(postBuilderContextRaw);
  }
  const runReviewer = async (): Promise<void> => {
    if (!roles.includes("reviewer") || outputs.has("reviewer")) return;
    const reviewerModel = resolveModel("reviewer") ?? defaultModelId;
    if (!reviewerModel) return;
    await options.onPhaseStart?.("Reviewer", currentPlanStepId);
    options.onProgress?.("reviewer", "Reviewer", "running");
    try {
      const result = await runAgent({
        role: "reviewer",
        taskDescription: options.taskDescription,
        modelIds: resolveModelIds("reviewer"),
        context: postBuilderContext,
        systemPrompt: getCustomPrompt("reviewer", options.customAgents),
      });
      turnCount++;
      addUsage(usageAcc, usageByModel, result.modelUsed ?? reviewerModel, result.usage);
      outputs.set("reviewer", result.output);
      options.onProgress?.("reviewer", "Reviewer", "done", result.output);
      await options.onPhaseEnd?.("Reviewer", result.output, currentPlanStepId);
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      options.onProgress?.("reviewer", "Reviewer", "error", err);
    }
  };
  const runDocumenter = async (): Promise<void> => {
    if (!roles.includes("documenter") || outputs.has("documenter")) return;
    const documenterModel = resolveModel("documenter") ?? defaultModelId;
    if (!documenterModel) return;
    await options.onPhaseStart?.("Documenter", currentPlanStepId);
    options.onProgress?.("documenter", "Documenter", "running");
    try {
      const result = await runAgent({
        role: "documenter",
        taskDescription: options.taskDescription,
        modelIds: resolveModelIds("documenter"),
        context: postBuilderContext,
        systemPrompt: getCustomPrompt("documenter", options.customAgents),
      });
      turnCount++;
      addUsage(usageAcc, usageByModel, result.modelUsed ?? documenterModel, result.usage);
      outputs.set("documenter", result.output);
      options.onProgress?.("documenter", "Documenter", "done", result.output);
      await options.onPhaseEnd?.("Documenter", result.output, currentPlanStepId);
    } catch {
      // Documenter failure is non-fatal
    }
  };
  startStepTimeout();
  try {
    await Promise.all([runReviewer(), runDocumenter()]);
  } finally {
    clearStepTimeout();
  }

  if (checkAborted()) return { taskId, plan, outputs, status: "cancelled", error: "Task cancelled", errorCode: "cancelled", ...usageResult(usageAcc, usageByModel) };

  const BUILTIN_IDS = new Set(["scout", "planner", "builder", "reviewer", "documenter"]);
  const extraRoles = roles.filter((r) => !BUILTIN_IDS.has(r));
  for (const roleId of extraRoles) {
    if (outputs.has(roleId)) continue;
    const roleModel = resolveModel(roleId) ?? defaultModelId;
    if (!roleModel) continue;
    const roleDef = options.customAgents?.find((a) => a.id === roleId);
    const displayName = roleDef?.name ?? roleId;
    await options.onPhaseStart?.(displayName, currentPlanStepId);
    options.onProgress?.(roleId, displayName, "running");
    try {
      const result = await runAgent({
        role: roleId as import("../types/index.js").AgentRole,
        taskDescription: options.taskDescription,
        modelIds: resolveModelIds(roleId),
        context: postBuilderContext,
        systemPrompt: getCustomPrompt(roleId, options.customAgents),
      });
      turnCount++;
      addUsage(usageAcc, usageByModel, result.modelUsed ?? roleModel, result.usage);
      outputs.set(roleId, result.output);
      options.onProgress?.(roleId, displayName, "done", result.output);
      await options.onPhaseEnd?.(displayName, result.output, currentPlanStepId);
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      options.onProgress?.(roleId, displayName, "error", err);
    }
    if (checkAborted()) return withToolCalls({ taskId, plan, outputs, status: "cancelled", error: "Task cancelled", errorCode: "cancelled", ...usageResult(usageAcc, usageByModel) });
    if (checkLimits()) return withToolCalls({ taskId, plan, outputs, status: "completed", error: "Max turns, token budget, or cost cap (GTD_TASK_COST_CAP) reached.", errorCode: "limits_reached", ...usageResult(usageAcc, usageByModel) });
  }

  audit({ type: "task_completed", taskId, message: "Orchestration completed" });
  void recordMetric({
    type: "token_usage",
    taskId,
    promptTokens: usageAcc.promptTokens,
    completionTokens: usageAcc.completionTokens,
    meta: usageByModel,
  });

  setTraceId(undefined);
  return withToolCalls({ taskId, plan, outputs, status: "completed", ...usageResult(usageAcc, usageByModel) });
  };
  let result: OrchestrationResult | undefined;
  try {
    result = await run();
    return result!;
  } finally {
    if (span) {
      if (result?.usage) {
        span.setAttribute("gtd.task.prompt_tokens", result.usage.promptTokens);
        span.setAttribute("gtd.task.completion_tokens", result.usage.completionTokens);
      }
      endSpan(span, result != null && result.status !== "failed" && result.status !== "cancelled");
    }
  }
}
