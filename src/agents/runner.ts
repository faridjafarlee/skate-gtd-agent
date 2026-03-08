import { complete, completeStream, completeWithFallback, completeStreamWithFallback, completeWithTools } from "../core/llm/client.js";
import type { LLMToolDef } from "../core/llm/client.js";
import type { ToolDefinition } from "../types/tooling.js";
import type { AgentRole } from "../types/index.js";
import { allowListKey } from "../security/allow-list.js";
import { logApproval } from "../security/audit.js";

export interface AgentRunInput {
  role: AgentRole | string;
  taskDescription: string;
  /** Primary model (legacy, use modelIds when available) */
  modelId?: string;
  /** Ordered list of models to try (first succeeds wins). Enables fallback. */
  modelIds?: string[];
  context?: string;
  /** Override system prompt (for custom agents) */
  systemPrompt?: string;
  /** When set, stream output and call this for each chunk */
  onChunk?: (chunk: string) => void;
}

export interface AgentRunResult {
  role: AgentRole | string;
  output: string;
  durationMs: number;
  usage?: { promptTokens: number; completionTokens: number };
  /** Model actually used (may differ from primary when fallback kicked in) */
  modelUsed?: string;
  /** Tool name -> call count for this agent run (CC-21) */
  toolCalls?: Record<string, number>;
}

const ROLE_PROMPTS: Record<AgentRole, string> = {
  scout: `You are the Scout agent. Your job is to explore the task, gather requirements, and identify constraints.
Output a concise summary of: (1) what the user wants, (2) key constraints or unknowns, (3) suggested next steps.
Be brief and actionable.`,

  planner: `You are the Planner agent. Your job is to create an implementation plan.
Given the task and any scout context, output a numbered list of concrete steps to accomplish the task.
Each step should be specific and executable.`,

  builder: `You are the Builder agent. Your job is to implement the plan.
Given the task, plan, and any prior context, produce the actual implementation.
For code tasks: output complete, runnable code. For other tasks: produce the deliverable.
Be concrete and complete.`,

  reviewer: `You are the Reviewer agent. Your job is to review work for quality.
Given the task, plan, and implementation, identify issues: bugs, edge cases, style, maintainability.
Output a concise review with specific suggestions.`,

  documenter: `You are the Documenter agent. Your job is to document the work.
Given the task and implementation, produce clear documentation: README, comments, or user-facing docs.
Be concise and useful.`,

  red_team: `You are the Red Team agent. Your job is adversarial testing and security review.
Given the task and implementation, identify potential failures, security issues, and edge cases.
Output specific concerns and recommendations.`,
};

export async function runAgent(input: AgentRunInput): Promise<AgentRunResult> {
  const systemPrompt = input.systemPrompt ?? (ROLE_PROMPTS[input.role as keyof typeof ROLE_PROMPTS] ?? `You are an agent. Complete the task.`);
  const userPrompt = [
    `Task: ${input.taskDescription}`,
    input.context ? `Context from previous agents:\n${input.context}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const modelIds = input.modelIds ?? (input.modelId ? [input.modelId] : []);
  if (modelIds.length === 0) {
    throw new Error("runAgent requires modelId or modelIds");
  }

  const opts = { systemPrompt, temperature: 0.5 };
  const start = Date.now();
  const response =
    modelIds.length > 1
      ? input.onChunk
        ? await completeStreamWithFallback(modelIds, opts, userPrompt, input.onChunk)
        : await completeWithFallback(modelIds, opts, userPrompt)
      : input.onChunk
        ? await completeStream({ modelId: modelIds[0], ...opts }, userPrompt, input.onChunk)
        : await complete({ modelId: modelIds[0], ...opts }, userPrompt);

  const durationMs = Date.now() - start;
  const modelUsed = "modelUsed" in response ? (response as { modelUsed: string }).modelUsed : modelIds[0];

  return {
    role: input.role,
    output: response.content,
    durationMs,
    usage: response.usage,
    modelUsed,
  };
}

function toolDefToLLM(def: ToolDefinition): LLMToolDef {
  return {
    name: def.name,
    description: def.description,
    parameters: Object.fromEntries(
      Object.entries(def.parameters).map(([k, v]) => [k, { type: v.type, description: v.description }])
    ),
  };
}

export type ExecuteToolFn = (
  name: string,
  args: Record<string, unknown>,
  policy: import("../types/tooling.js").ToolPolicy,
  options?: { cwd?: string; allowOnceKeys?: Set<string>; idempotencyKey?: string }
) => Promise<import("../types/tooling.js").ToolResult>;

/** User choice when a tool requires approval: allow once, don't ask again (session/project), reject, or edit args then run. */
export type ToolApprovalChoice = "allow" | "session" | "project" | "reject";

/** Result of tool approval: choice plus optional edited args (for "allow" when user edited) or reject feedback. */
export interface ToolApprovalResult {
  choice: ToolApprovalChoice;
  editedArgs?: Record<string, unknown>;
  rejectFeedback?: string;
}

/** Vision attachment (CC-20): image URL or base64. */
export type VisionAttachment =
  | { type: "image_url"; image_url: { url: string } }
  | { type: "image"; data: string; mimeType?: string };

export interface AgentRunWithToolsInput extends AgentRunInput {
  tools: ToolDefinition[];
  executeTool: ExecuteToolFn;
  toolPolicy: import("../types/tooling.js").ToolPolicy;
  cwd?: string;
  /** Image attachments for vision-capable models (CC-20). */
  attachments?: VisionAttachment[];
  /** When set, called with content after each LLM round (incremental output when using tools). */
  onChunk?: (chunk: string) => void;
  /** When a tool returns requiresApproval, call this with tool name, category, and args; may return reject (with feedback) or edited args. */
  onToolApprovalRequest?: (toolName: string, category: string, args: Record<string, unknown>) => Promise<ToolApprovalResult>;
  addToSessionAllow?: (toolName: string, category: string) => void;
  addToProjectAllow?: (cwd: string, toolName: string, category: string) => Promise<void>;
  loadProjectAllow?: (cwd: string) => Promise<Set<string>>;
  /** Re-inject current TODO/goal after each tool round (agent-trends 23). When set, called after tool results are pushed; reminder is appended as a user message. */
  getReminder?: () => string;
  /** For write tools, return an idempotency key (e.g. taskId:toolCallId) so replay returns cached result (agent-trends 65). */
  getIdempotencyKey?: (toolName: string, toolCallId: string) => string | undefined;
}

/**
 * Run an agent with tool-calling: loop completeWithTools -> execute tool_calls -> append results until no more tools.
 */
export async function runAgentWithTools(input: AgentRunWithToolsInput): Promise<AgentRunResult> {
  const systemPrompt =
    input.systemPrompt ?? (ROLE_PROMPTS[input.role as keyof typeof ROLE_PROMPTS] ?? "You are an agent. Complete the task.");
  const segmentUserRequest = process.env.GTD_SEGMENT_USER_REQUEST !== "0" && process.env.GTD_SEGMENT_USER_REQUEST !== "false";
  const taskPart = segmentUserRequest
    ? `Task (user request):\n<user_request>\n${input.taskDescription}\n</user_request>`
    : `Task: ${input.taskDescription}`;
  const userContent = [
    taskPart,
    input.context ? `Context from previous agents:\n${input.context}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const modelIds = input.modelIds ?? (input.modelId ? [input.modelId] : []);
  if (modelIds.length === 0) throw new Error("runAgentWithTools requires modelId or modelIds");

  const llmTools = input.tools.map(toolDefToLLM);
  const userMessageContent: import("../core/llm/client.js").LLMChatMessage["content"] =
    input.attachments?.length
      ? ([{ type: "text", text: userContent }, ...input.attachments] as import("../core/llm/client.js").LLMContentPart[])
      : userContent;
  const messages: import("../core/llm/client.js").LLMChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessageContent },
  ];
  const cwd = input.cwd ?? process.cwd();
  const opts = { systemPrompt, temperature: 0.5 };
  const maxToolRounds = 20;
  let round = 0;
  let lastContent = "";
  let lastUsage: { promptTokens: number; completionTokens: number } | undefined;
  const start = Date.now();
  let modelUsed = modelIds[0];
  const toolCallsAcc: Record<string, number> = {};
  let modelIndex = 0;

  while (round < maxToolRounds) {
    const modelId = modelIds[modelIndex]!;
    let response: Awaited<ReturnType<typeof completeWithTools>>;
    try {
      response = await completeWithTools(
        { modelId, ...opts },
        messages,
        llmTools
      );
    } catch (e) {
      if (modelIndex < modelIds.length - 1) {
        modelIndex++;
        continue;
      }
      throw e;
    }
    lastContent = response.content;
    lastUsage = response.usage;
    modelUsed = response.model ?? modelId;
    if (response.content && input.onChunk) input.onChunk(response.content);

    const assistantMsg: import("../core/llm/client.js").LLMChatMessage = {
      role: "assistant",
      content: response.content || undefined,
      toolCalls: response.toolCalls,
    };
    messages.push(assistantMsg);

    if (!response.toolCalls?.length) break;

    // CC-15: execute all tool calls in parallel, then resolve approvals and push results in order
    const toolOpts = response.toolCalls.map((tc) => {
      const o: { cwd: string; idempotencyKey?: string; allowOnceKeys?: Set<string> } = { cwd };
      const def = input.tools.find((t) => t.name === tc.name);
      if (def?.category === "write" && input.getIdempotencyKey) o.idempotencyKey = input.getIdempotencyKey(tc.name, tc.id);
      return o;
    });
    const initialResults = await Promise.all(
      response.toolCalls.map((tc, i) => input.executeTool(tc.name, tc.arguments, input.toolPolicy, toolOpts[i]!))
    );
    const resolvedResults = await Promise.all(
      response.toolCalls.map(async (tc, i) => {
        let result = initialResults[i]!;
        if (result.requiresApproval && input.onToolApprovalRequest) {
          const def = input.tools.find((t) => t.name === tc.name);
          const category = (def?.category ?? "command") as string;
          const approval = await input.onToolApprovalRequest(tc.name, category, tc.arguments);
          logApproval({ tool: tc.name, category, decision: approval.choice });
          if (approval.choice === "reject") {
            result = {
              success: false,
              error: approval.rejectFeedback?.trim() || "User rejected this tool run.",
            };
          } else {
            const argsToUse = approval.editedArgs ?? tc.arguments;
            if (approval.choice === "allow") {
              const allowOnceKeys = new Set<string>([allowListKey(tc.name, category)]);
              result = await input.executeTool(tc.name, argsToUse, input.toolPolicy, { ...toolOpts[i], allowOnceKeys });
            } else if (approval.choice === "session" && input.addToSessionAllow) {
              input.addToSessionAllow(tc.name, category);
              result = await input.executeTool(tc.name, argsToUse, input.toolPolicy, toolOpts[i]!);
            } else if (approval.choice === "project" && input.addToProjectAllow && input.loadProjectAllow && input.toolPolicy.allowList) {
              await input.addToProjectAllow(cwd, tc.name, category);
              input.toolPolicy.allowList.project = await input.loadProjectAllow(cwd);
              result = await input.executeTool(tc.name, argsToUse, input.toolPolicy, toolOpts[i]!);
            }
          }
        }
        return result;
      })
    );
    for (let i = 0; i < response.toolCalls.length; i++) {
      const tc = response.toolCalls[i]!;
      const result = resolvedResults[i]!;
      const output = result.success
        ? (result.output ?? "OK")
        : `Error: ${result.error ?? "unknown"}${result.requiresApproval ? " (approval required)" : ""}`;
      messages.push({ role: "tool", toolCallId: tc.id, content: output });
      toolCallsAcc[tc.name] = (toolCallsAcc[tc.name] ?? 0) + 1;
    }
    if (input.getReminder) {
      const reminder = input.getReminder();
      if (reminder?.trim()) {
        messages.push({ role: "user", content: `[Reminder] ${reminder.trim()}` });
      }
    }
    round++;
  }

  return {
    role: input.role,
    output: lastContent,
    durationMs: Date.now() - start,
    usage: lastUsage,
    modelUsed,
    toolCalls: Object.keys(toolCallsAcc).length ? toolCallsAcc : undefined,
  };
}
