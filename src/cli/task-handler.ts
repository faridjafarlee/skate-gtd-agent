import chalk from "chalk";
import ora from "ora";
import { SingleBar } from "cli-progress";
import { v4 as uuidv4 } from "uuid";
import { createInterface } from "readline";
import { renderBanner } from "./banner.js";
import { renderAgentGrid } from "./panels.js";
import { routeForTask } from "../core/models/index.js";
import { getAllRoles, getRolesForProfile } from "../core/agents/registry.js";
import { runOrchestration } from "../orchestrator/loop.js";
import { saveTask, toStored, getTask, listTasks, TaskConflictError } from "../storage/store.js";
import { loadConfig, loadConfigForCwd, getConfigForChannel, getMergedTemplates } from "../storage/config.js";
import { loadWorkspaceConfig } from "../storage/workspace.js";
import { getMemoryEntries, loadProjectMemory, loadProjectRulesFromConfig, loadProjectRulesForRole, loadGlobalRules } from "../memory/store.js";
import { indexChunksIfNeeded, memoryContentSignature, retrieveWithSources } from "../memory/rag.js";
import { getActiveMode, getMode } from "../modes/store.js";
import { getTraceId, setTraceId } from "../audit/events.js";
import { audit } from "../security/audit.js";
import { isCancelled, clearCancel } from "../storage/cancel.js";
import { loadProjectAllow, getSessionAllow, addToSessionAllow, addToProjectAllow, loadPersistedSessionAllow } from "../security/allow-list.js";
import { resolvePolicy, loadPolicyBundle } from "../security/policy.js";
import { notifyTaskStateChange, notifyPostStep } from "../connectors/task-webhook.js";
import { getMcpServer } from "../mcp/store.js";
import { readMcpResource } from "../mcp/client.js";
import { runBeforeTaskHooks, runAfterTaskHooks, runBeforeAgentHooks, runAfterAgentHooks } from "../plugins/hooks-runner.js";
import { normalizePermissionMode } from "../storage/config.js";
import { parseCodeBlocks, writeCodeBlocks } from "../agents/file-writer.js";
import { highlightMarkdown } from "./terminal-markdown.js";
import { estimateTaskCost } from "../core/cost.js";
import {
  isGitRepo,
  hasDirtyFiles,
  commitAll,
  generateCommitMessage,
} from "../git/auto-commit.js";
import { writeFile, mkdir, readFile } from "fs/promises";
import { dirname, resolve, join } from "path";
import { spawn, spawnSync } from "child_process";
import { homedir } from "os";
import type { AgentPanelState } from "./panels.js";

/** Short task id for copy-paste (first 8 chars); gtd retry/approve accept prefix. */
export function shortTaskId(id: string): string {
  return (id ?? "").slice(0, 8);
}

/** PI-3: Extension config from GTD_EXTENSION_CONFIG or .gtd/extension.json */
export interface ExtensionConfig {
  timeouts?: Record<string, number>;
  disabledPhases?: string[];
  captureStderr?: string | boolean;
}

let extensionConfigCache: ExtensionConfig | null | undefined;

async function loadExtensionConfig(): Promise<ExtensionConfig | null> {
  if (extensionConfigCache !== undefined) return extensionConfigCache ?? null;
  const configPath = process.env.GTD_EXTENSION_CONFIG?.trim() || resolve(process.cwd(), ".gtd", "extension.json");
  try {
    const raw = await readFile(configPath, "utf-8");
    const parsed = JSON.parse(raw) as ExtensionConfig;
    extensionConfigCache = parsed;
    return parsed;
  } catch {
    extensionConfigCache = null;
    return null;
  }
}

/** Run extension script when GTD_EXTENSION_SCRIPT is set (PI-style hook). Phases: start, pre_plan, pre_step, post_step, post_plan (after plan built), approval (when blocked), end. Exported for tests. PI-3/PI-4/PI-6: config file, per-phase timeout, stderr capture. */
export async function runExtensionHook(
  phase: "start" | "pre_plan" | "end" | "post_step" | "pre_step" | "post_plan" | "approval",
  env: Record<string, string>
): Promise<void> {
  const script = process.env.GTD_EXTENSION_SCRIPT;
  if (!script?.trim()) return;
  const config = await loadExtensionConfig();
  if (config?.disabledPhases?.includes(phase)) return;
  const defaultTimeout = Math.max(1000, Math.min(300_000, parseInt(process.env.GTD_EXTENSION_SCRIPT_TIMEOUT_MS ?? "10000", 10) || 10_000));
  const timeoutMs = Math.max(1000, Math.min(300_000, config?.timeouts?.[phase] ?? defaultTimeout));
  const envWithTrace = { ...env, TRACE_ID: getTraceId() ?? "" };
  const failTaskOnNonZero = process.env.GTD_EXTENSION_FAIL_TASK === "1" || process.env.GTD_EXTENSION_FAIL_TASK === "true";
  const debug = process.env.GTD_EXTENSION_DEBUG === "1" || process.env.GTD_EXTENSION_DEBUG === "true";
  const captureStderr = config?.captureStderr ?? process.env.GTD_EXTENSION_CAPTURE_STDERR;
  const stderrLogPath = typeof captureStderr === "string" && captureStderr
    ? resolve(captureStderr)
    : captureStderr
      ? join(process.env.GTD_DATA_DIR ?? join(homedir(), ".skate"), "extension.log")
      : "";
  const startMs = Date.now();
  if (debug) process.stderr.write(`[gtd] Extension phase: ${phase}\n`);
  const stdio: "ignore" | ["ignore", "pipe", "pipe"] = stderrLogPath ? ["ignore", "pipe", "pipe"] : "ignore";
  return new Promise((resolve, reject) => {
    const proc = spawn(script, [], { env: { ...process.env, ...envWithTrace }, stdio, shell: true });
    if (stderrLogPath && proc.stderr) {
      const chunks: Buffer[] = [];
      proc.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
      proc.stderr.on("end", () => {
        if (chunks.length > 0) {
          const line = `[${new Date().toISOString()}] [${phase}] ${Buffer.concat(chunks).toString("utf-8")}`;
          writeFile(stderrLogPath, line, { flag: "a" }).catch(() => {});
        }
      });
    }
    const t = setTimeout(() => {
      proc.kill("SIGTERM");
      process.stderr.write(`[gtd] Extension script timed out after ${timeoutMs}ms (SIGTERM)\n`);
      resolve();
    }, timeoutMs);
    proc.on("exit", (code, signal) => {
      clearTimeout(t);
      const duration = Date.now() - startMs;
      if (debug) process.stderr.write(`[gtd] Extension phase ${phase} done in ${duration}ms (exit ${code ?? signal})\n`);
      if (code != null && code !== 0) {
        process.stderr.write(`[gtd] Extension script exit code: ${code}\n`);
        if (failTaskOnNonZero) reject(new Error(`Extension script failed with exit code ${code}`));
      }
      resolve();
    });
    proc.on("error", (err) => {
      clearTimeout(t);
      process.stderr.write(`[gtd] Extension script error: ${err.message}\n`);
      resolve();
    });
  });
}

export interface TaskHandlerOptions {
  auto?: boolean;
  quality?: string;
  model?: string;
  /** Named mode: architect (plan only), debug (fast), ask (require approval) */
  mode?: string;
  write?: boolean;
  outDir?: string;
  dryRun?: boolean;
  format?: string;
  /** Plan output format (Scout/Planner); when json, dry-run outputs structured plan JSON */
  planFormat?: string;
  stream?: boolean;
  quiet?: boolean;
  tag?: string[];
  interactive?: boolean;
  useProgressBar?: boolean;
  /** Abort task after N seconds */
  timeout?: number;
  /** Write deliverable (builder output) to file */
  output?: string;
  /** Max agent steps (turns); 0 = no limit */
  maxTurns?: number;
  /** Max total tokens (prompt + completion); 0 = no limit */
  maxTokens?: number;
  /** Tool permission mode (default, plan, accept-edits, dont-ask, bypass; aliases: acceptEdits, dontAsk, bypassPermissions) */
  permissionMode?: string;
  /** Run task inside Docker (requires GTD_CONTAINER_IMAGE) */
  container?: boolean;
  /** Per-step timeout in ms (or from GTD_STEP_TIMEOUT_MS); aborts current role step when exceeded. */
  stepTimeoutMs?: number;
  /** CLI version for JSON output (pipeline contract). */
  version?: string;
  /** When set (e.g. from HTTP API), use this task id instead of generating one. */
  taskId?: string;
  /** When set (e.g. from API), use these roots for multi-repo; overrides GTD_WORKSPACE_ROOTS. */
  workspaceRoots?: string[];
  /** Optional progress callback (e.g. for API streaming CC-4). */
  onProgress?: (phase: string, role: string, status: string, output?: string) => void;
  /** Image attachments for Builder vision (CC-20): image_url or base64. */
  attachments?: Array<{ type: "image_url"; image_url: { url: string } } | { type: "image"; data: string; mimeType?: string }>;
  /** PI-12: Print only the builder deliverable (no banner, no "Task completed", no --- Deliverable ---). */
  printOnly?: boolean;
  /** PI-17: Extra container volume mounts ("host:container" or "host:container:ro"; comma-separated or repeated). */
  containerVolumes?: string[];
  /** Prepend current directory listing to task description (headless / --include-directories). */
  includeDirectories?: boolean;
  /** Prepend note to consider all relevant files in context (headless / --all-files; use with care). */
  allFiles?: boolean;
  /** When true, do not persist task to store (no history for this run). */
  ephemeral?: boolean;
  /** Called once when task starts (for REPL: inject-while-running). */
  onTaskStart?: (taskId: string) => void;
  /** REPL inject-while-running: return next user-injected instruction (consumed at step boundaries). */
  getInjectedInstruction?: () => string | undefined;
  /** Aider-style: context from session-added files (prepended to memory). */
  addedFilesContext?: string;
  /** Aider-style: repo map (symbols/signatures) prepended to memory. */
  repoMapContext?: string;
  /** Disable all git use (no auto-commit, no dirty commit, no prompts). */
  noGit?: boolean;
  /** Disable auto-commit after agent edits (default: commit when task completes with changes). */
  noAutoCommits?: boolean;
  /** Don't commit dirty files before running the task (default: commit preexisting changes first). */
  noDirtyCommits?: boolean;
  /** Mark commits with (gtd) in author/committer (Aider-style attribution). */
  commitAttribution?: boolean;
  /** Run lint after task completes; if lint fails, call onLintFailure (e.g. queue for next task). Default true when not dryRun. */
  autoLint?: boolean;
  /** Lint command (default: GTD_LINT_CMD or "npm run lint"). */
  lintCmd?: string;
  /** Called when post-task lint fails; receives raw output and optional structured verify result (agent-trends 49). */
  onLintFailure?: (output: string, structured?: import("./verify.js").VerifyOutput) => void;
  /** Run test command after task completes when true. */
  autoTest?: boolean;
  /** Test command (default: GTD_TEST_CMD). */
  testCmd?: string;
  /** Called when post-task test fails; receives raw output and optional structured verify result (agent-trends 49). */
  onTestFailure?: (output: string, structured?: import("./verify.js").VerifyOutput) => void;
  /** Run pre-commit hooks on auto-commits (default: skip with --no-verify). */
  gitCommitVerify?: boolean;
  /** Edit format for Builder: "diff" (prefer apply_patch) or "whole" (prefer write_file/edit_file). Overrides config and GTD_EDIT_FORMAT. */
  editFormat?: "diff" | "whole";
  /** Named profile to apply for this run (e.g. work, quick). Merges config.profiles[name] over current config. */
  profile?: string;
  /** Session-only memory (this REPL session); not persisted to MEMORY.md. Prepended to memory context. */
  sessionMemory?: string;
  /** When set with format json, validate the task result JSON against this schema path (JSON Schema); fail and exit 1 if invalid. */
  resultSchema?: string;
  /** Max verify iterations (agent-trends 47): when lint/test fails, re-run with failure in context until pass or this count. 0 = disabled. */
  autoIterateVerify?: number;
}

function question(rl: ReturnType<typeof createInterface>, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => resolve(answer.trim()));
  });
}

/** Prompt for tool approval: allow / session / project / edit args / reject with feedback. */
async function promptToolApproval(
  toolName: string,
  category: string,
  args: Record<string, unknown>
): Promise<import("../agents/runner.js").ToolApprovalResult> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(chalk.yellow(`\nTool "${toolName}" (${category}) requires approval.`));
    const argsStr = Object.keys(args).length ? `\nArgs: ${JSON.stringify(args)}` : "";
    console.log(chalk.dim(argsStr));
    const answer = await question(
      rl,
      " [y] Allow once  [s] Session  [p] Project  [e] Edit args  [r] Reject: "
    );
    const c = (answer || "y").toLowerCase().trim()[0];
    if (c === "r") {
      const feedback = await question(rl, "Rejection feedback for the model (optional): ");
      return { choice: "reject", rejectFeedback: feedback?.trim() || undefined };
    }
    if (c === "e") {
      const edited = await question(rl, "Enter new args as JSON (or leave empty to cancel): ");
      const trimmed = edited?.trim();
      if (!trimmed) return { choice: "reject", rejectFeedback: "User cancelled edit." };
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        return { choice: "allow", editedArgs: parsed };
      } catch {
        console.log(chalk.red("Invalid JSON; treating as reject."));
        return { choice: "reject", rejectFeedback: "Invalid JSON when editing args." };
      }
    }
    if (c === "s") return { choice: "session" };
    if (c === "p") return { choice: "project" };
    return { choice: "allow" };
  } finally {
    rl.close();
  }
}

export async function promptInteractive(description: string): Promise<{ proceed: boolean; description: string }> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(chalk.cyan("\nTask: ") + description);
    const answer = await question(rl, "Proceed? (y/n/edit): ");
    if (answer.toLowerCase() === "y" || answer === "") {
      return { proceed: true, description };
    }
    if (answer.toLowerCase() === "n") {
      return { proceed: false, description };
    }
    if (answer.toLowerCase() === "edit") {
      const newDesc = await question(rl, "Enter new description: ");
      rl.close();
      return newDesc ? { proceed: true, description: newDesc } : { proceed: false, description };
    }
    return { proceed: true, description };
  } finally {
    rl.close();
  }
}

export async function runTask(
  description: string,
  opts: TaskHandlerOptions = {}
): Promise<void> {
  const useContainer = opts.container ?? (process.env.GTD_USE_CONTAINER === "1" || process.env.GTD_USE_CONTAINER === "true");
  if (useContainer) {
    const image = process.env.GTD_CONTAINER_IMAGE;
    if (!image?.trim()) {
      console.error(chalk.red("Container mode requires GTD_CONTAINER_IMAGE (e.g. your-registry/skate:latest)"));
      process.exitCode = 1;
      return;
    }
    const workDir = process.cwd();
    const args = ["run", "--rm", "-v", `${workDir}:/workspace`, "-w", "/workspace"];
    const extraVolumes = opts.containerVolumes?.length
      ? opts.containerVolumes
      : (process.env.GTD_CONTAINER_VOLUMES ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
    for (const v of extraVolumes) args.push("-v", v);
    const envAllow = (process.env.GTD_CONTAINER_ENV_ALLOW ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const envVars = ["GTD_DATA_DIR", "GTD_ORG_CONFIG", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "SERPER_API_KEY", ...envAllow];
    for (const k of envVars) {
      if (process.env[k]) args.push("-e", `${k}=${process.env[k]}`);
    }
    args.push(image, "gtd", "task", JSON.stringify(description));
    if (opts.auto) args.push("--auto");
    if (opts.quality) args.push("--quality", opts.quality);
    if (opts.dryRun) args.push("--dry-run");
    if (opts.quiet) args.push("--quiet");
    const { spawn } = await import("child_process");
    const child = spawn("docker", args, { stdio: "inherit", cwd: workDir });
    const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
    if (code != null && code !== 0) process.exitCode = code;
    return;
  }

  const { initOtel } = await import("../telemetry/otel.js");
  initOtel();
  const { loadAndApplyModelsConfig } = await import("../storage/models-config.js");
  await loadAndApplyModelsConfig();
  await loadPersistedSessionAllow();
  const cwd = process.cwd();
  let cfg = await loadConfigForCwd(cwd);
  if (opts.profile && cfg.profiles?.[opts.profile]) cfg = { ...cfg, ...cfg.profiles[opts.profile] };
  cfg = getConfigForChannel(cfg, "cli");
  const workspace = await loadWorkspaceConfig(cwd);
  if (workspace) {
    if (workspace.defaultMode && opts.mode == null) opts.mode = workspace.defaultMode;
    if (workspace.roots?.length && !opts.workspaceRoots?.length) {
      opts.workspaceRoots = workspace.roots.map((p) =>
        p.startsWith("/") || /^[A-Za-z]:/.test(p) ? resolve(p) : join(cwd, p)
      );
    }
  }
  const templates = await getMergedTemplates(cfg);
  let taskDescription = description;
  if (description.startsWith(":")) {
    const key = description.slice(1).trim();
    const template = templates[key];
    if (template) {
      taskDescription = template;
    } else if (!(opts.quiet ?? false)) {
      console.log(chalk.yellow(`Template :${key} not found. Using as literal description.`));
    }
  }

  if (opts.includeDirectories) {
    const { readdir } = await import("fs/promises");
    try {
      const entries = await readdir(cwd, { withFileTypes: true });
      const listing = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort().join(" ");
      taskDescription = `[Current directory (${cwd}): ${listing}]\n\n${taskDescription}`;
    } catch {
      taskDescription = `[Current directory: (unable to list)]\n\n${taskDescription}`;
    }
  }

  if (opts.allFiles) {
    taskDescription = `[Consider all relevant files in the workspace; list and read as needed. Use with care for large repos.]\n\n${taskDescription}`;
  }

  if (opts.interactive) {
    const { proceed, description: finalDesc } = await promptInteractive(taskDescription);
    if (!proceed) {
      console.log(chalk.dim("Task cancelled."));
      return;
    }
    taskDescription = finalDesc;
  }

  // Apply active mode overrides
  const activeModeId = await getActiveMode();
  const activeMode = activeModeId ? await getMode(activeModeId) : undefined;
  let quality = (opts.quality ?? activeMode?.qualityProfile ?? cfg.qualityProfile ?? "balanced") as "fast" | "balanced" | "max";
  let approvalPolicy = opts.auto ? "auto" : (activeMode?.approvalPolicy ?? cfg.approvalPolicy ?? "hybrid");
  let dryRun = opts.dryRun ?? false;
  const namedMode = (opts.mode ?? workspace?.defaultMode ?? cfg.defaultMode ?? "").toLowerCase();
  if (namedMode === "architect") {
    dryRun = true;
    quality = "balanced";
  } else if (namedMode === "debug") {
    quality = "fast";
  } else if (namedMode === "ask") {
    approvalPolicy = "always";
  } else if (namedMode === "help") {
    approvalPolicy = "always";
    taskDescription =
      "[Help mode: You are answering questions about the gtd/skate CLI. Answer only about usage, configuration, and troubleshooting. Do not edit files or run code.]\n\n" +
      taskDescription;
  } else if (namedMode === "orchestrator") {
    quality = "balanced";
    approvalPolicy = "hybrid";
  }
  const modelOverrides = activeMode?.modelOverrides ?? cfg.modelOverrides;
  let roles = getRolesForProfile(quality, cfg.profileRoles);
  if (namedMode === "architect") roles = ["scout", "planner"];
  const routingContext = { requiresTools: true, preferLocal: cfg.localFirst };
  const routing = routeForTask("balanced", routingContext);
  const modelId =
    opts.model === "__auto__"
      ? (routing?.modelId ?? undefined)
      : (opts.model ?? activeMode?.defaultModel ?? cfg.defaultModel ?? routing?.modelId);
  const quiet = opts.quiet ?? false;
  const streamJsonl = !!(opts.stream && (opts.format ?? "").toLowerCase() === "json");
  const printOnly = opts.printOnly ?? opts.output === "-";

  const effectiveProfileName = opts.profile ?? cfg.defaultProfile;
  if (!quiet && !streamJsonl) {
    console.log(renderBanner({
      mode: approvalPolicy === "auto" ? "Auto" : "Hybrid",
      router: "Balanced",
      agentsActive: roles.length,
      model: modelId ?? "—",
      profile: effectiveProfileName ?? undefined,
      persona: cfg.persona,
    }));
    console.log(`\nTask: "${taskDescription}"`);
    console.log(`Quality: ${quality} | Mode: ${approvalPolicy}`);
    if (dryRun) console.log(chalk.yellow("(dry-run: Scout + Planner only)"));
    if (namedMode === "ask") console.log(chalk.yellow("(ask mode: discuss only, no file edits)"));
    if (namedMode === "help") console.log(chalk.yellow("(help mode: answers about gtd/skate only)"));
    console.log(`Model: ${modelId ?? "none (enable models with gtd models enable)"}`);
    console.log(`Agents: ${roles.join(", ")}`);
    console.log("");
  }

  const taskId = opts.taskId ?? uuidv4();
  opts.onTaskStart?.(taskId);
  setTraceId(taskId);
  const panelState = new Map<string, AgentPanelState>();
  for (const r of getAllRoles(cfg.agents)) {
    panelState.set(r.id, {
      role: r.name,
      status: "idle",
      progress: 0,
      description: r.description,
    });
  }

  const activePhases = roles.map((id) => getAllRoles(cfg.agents).find((r) => r.id === id)?.name).filter(Boolean) as string[];
  const totalPhases = activePhases.length;
  let spinner: ReturnType<typeof ora> | null = null;
  let progressBar: SingleBar | null = null;
  let completedPhases = 0;
  const useProgressBar = opts.useProgressBar !== false && (!quiet && totalPhases > 0 && !opts.stream);

  const abortController = new AbortController();
  const cancelPoll = dryRun ? null : setInterval(() => {
    if (isCancelled(taskId)) abortController.abort();
  }, 500);
  const timeoutMs = opts.timeout && opts.timeout > 0 ? opts.timeout * 1000 : 0;
  const timeoutId = timeoutMs ? setTimeout(() => abortController.abort(), timeoutMs) : null;
  const onSignal = () => {
    if (!abortController.signal.aborted) {
      process.stderr.write(chalk.yellow("\nShutting down… (finishing current step)\n"));
      abortController.abort();
    }
  };
  if (!dryRun) {
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  }

  const ephemeral = opts.ephemeral === true;
  let savedForConflict: Awaited<ReturnType<typeof getTask>>;
  try {
    await runExtensionHook("start", { TASK_PHASE: "start", TASK_ID: taskId, TASK_DESCRIPTION: taskDescription });
    if (!dryRun && !ephemeral) {
      await saveTask(toStored({
        id: taskId,
        description: taskDescription,
        source: "cli",
        qualityProfile: quality,
        approvalPolicy,
        status: "in_progress",
        tags: opts.tag?.length ? opts.tag : undefined,
      }));
      savedForConflict = await getTask(taskId);
    } else {
      savedForConflict = undefined;
    }

    // Build memory context from project rules + MEMORY.md + structured entries + optional RAG
    const cwd = process.cwd();
    const globalRules = await loadGlobalRules();
    const projectRules = await loadProjectRulesFromConfig(cwd, cfg.rules, cfg.rulesDefaultNames);
    const projectMemory = await loadProjectMemory(cwd);
    const entries = await getMemoryEntries();
    const memoryParts: string[] = [];
    if (opts.addedFilesContext) memoryParts.push(opts.addedFilesContext);
    if (opts.repoMapContext) memoryParts.push(`Repo map:\n${opts.repoMapContext}`);
    if (opts.sessionMemory) memoryParts.push(`Session memory (this session only):\n${opts.sessionMemory}`);
    if (globalRules) memoryParts.push(`Global rules:\n${globalRules}`);
    if (projectRules) memoryParts.push(`Project rules:\n${projectRules}`);
    if (projectMemory) memoryParts.push(`Project MEMORY.md:\n${projectMemory}`);
    if (entries.length) {
      memoryParts.push("Structured memory:\n" + entries.map((e) => `- ${e.key}: ${e.value}`).join("\n"));
    }
    // Optional RAG: index chunks from MEMORY.md + entries, then retrieve top-k by task similarity
    const ragChunks: { id: string; text: string }[] = [];
    if (projectMemory) {
      projectMemory.split(/\n\n+/).forEach((p, i) => {
        const t = p.trim();
        if (t) ragChunks.push({ id: `mem_${i}`, text: t });
      });
    }
    entries.forEach((e) => ragChunks.push({ id: e.id, text: `${e.key}: ${e.value}` }));
    const contentSignature = memoryContentSignature(projectMemory, entries);
    await indexChunksIfNeeded(ragChunks, contentSignature);
    const ragTopK = Math.max(1, Math.min(50, parseInt(process.env.GTD_RAG_TOP_K ?? "5", 10) || 5));
    const ragChunksWithSources = await retrieveWithSources(taskDescription, ragTopK);
    if (ragChunksWithSources.length) {
      const ragBlock = ragChunksWithSources
        .map((c) => `[Source: ${c.sourceId}]\n${c.text}`)
        .join("\n\n");
      memoryParts.push("Relevant memory (RAG):\n" + ragBlock);
    }
    let memoryContext = memoryParts.length ? memoryParts.join("\n\n") : undefined;
    const memoryBudget = Math.max(0, parseInt(process.env.GTD_MEMORY_MAX_CHARS ?? "16384", 10) || 16384);
    if (memoryBudget > 0 && memoryContext && memoryContext.length > memoryBudget) {
      memoryContext = memoryContext.slice(0, memoryBudget - 60) + "\n\n[... memory truncated (GTD_MEMORY_MAX_CHARS) ...]";
    }

    const projectAllow = await loadProjectAllow(cwd);
    const sessionAllow = getSessionAllow();
    const askOrHelp = namedMode === "ask" || namedMode === "help";
    const effectivePermissionMode = askOrHelp
      ? "plan"
      : (opts.permissionMode != null
          ? (normalizePermissionMode(opts.permissionMode) ?? cfg.permissionMode)
          : cfg.permissionMode);
    const policyBundlePath = join(cwd, ".gtd", "policy.json");
    const policyBundle = await loadPolicyBundle(policyBundlePath);
    const toolPolicy = effectivePermissionMode
      ? resolvePolicy(
          { mode: effectivePermissionMode, allowList: { session: sessionAllow, project: projectAllow } },
          policyBundle ?? undefined
        )
      : policyBundle
        ? resolvePolicy(undefined, policyBundle)
        : undefined;
    if (effectivePermissionMode === "bypass") {
      audit({ type: "action_executed", taskId, message: "Permission mode bypass used" });
    }

    await runExtensionHook("pre_plan", {
      TASK_PHASE: "pre_plan",
      TASK_ID: taskId,
      TASK_DESCRIPTION: taskDescription,
      TASK_STATUS: "",
      TASK_ERROR: "",
    });

    await runBeforeTaskHooks({ TASK_ID: taskId, TASK_DESCRIPTION: taskDescription });

    const [plannerRules, builderRules] = await Promise.all([
      loadProjectRulesForRole(cwd, "planner", cfg.rulesByRole),
      loadProjectRulesForRole(cwd, "builder", cfg.rulesByRole),
    ]);
    const roleRules: Partial<Record<string, string>> = {};
    if (plannerRules) roleRules.planner = plannerRules;
    if (builderRules) roleRules.builder = builderRules;

    let mcpContext: string | undefined;
    if (cfg.mcpContextResources?.length) {
      const parts: string[] = [];
      for (const { serverId, uri } of cfg.mcpContextResources) {
        const server = await getMcpServer(serverId);
        if (server) {
          const res = await readMcpResource(server, uri);
          const text = res.success && res.contents?.length ? res.contents[0]?.text : undefined;
          if (text) parts.push(text);
        }
      }
      if (parts.length) mcpContext = parts.join("\n\n");
    }

    const canPromptToolApproval = Boolean(process.stdin.isTTY && process.stdout.isTTY && !opts.auto);
    const useGit = !opts.noGit && isGitRepo(cwd);
    if (useGit && !opts.noDirtyCommits && hasDirtyFiles(cwd)) {
      const pre = commitAll(cwd, "chore: save work before task", { noVerify: !opts.gitCommitVerify });
      if (pre.success && !quiet) console.log(chalk.dim("Committed existing changes before task."));
      else if (!pre.success && !quiet) console.log(chalk.yellow("Could not commit dirty files: " + (pre.error ?? "unknown")));
    }
    let extensionStepIndex = 0;
    const extensionTotalSteps = 5;
    const maxIterate =
      opts.autoIterateVerify ??
      (process.env.GTD_AUTO_ITERATE_VERIFY ? Math.max(0, parseInt(process.env.GTD_AUTO_ITERATE_VERIFY, 10) || 0) : 0);
    let lastResult: Awaited<ReturnType<typeof runOrchestration>> | null = null;
    let verifyFailureToInject: string | undefined;
    let iteration = 0;
    let verifyAlreadyRunInLoop = false;

    while (true) {
      const orchestrationOpts: Parameters<typeof runOrchestration>[0] = {
        taskId,
        taskDescription,
        qualityProfile: quality,
        approvalPolicy,
        modelId: modelId ?? undefined,
        modelOverrides,
        preferLocal: cfg.localFirst,
        memoryContext,
        roleRules: Object.keys(roleRules).length ? roleRules : undefined,
        mcpContext,
        customAgents: cfg.agents,
        profileRoles: cfg.profileRoles,
        dryRun,
        streamOutput: opts.stream,
        signal: abortController.signal,
        maxTurns:
          opts.maxTurns !== undefined
            ? (opts.maxTurns > 0 ? opts.maxTurns : undefined)
            : (cfg.maxTurns != null && cfg.maxTurns > 0
                ? cfg.maxTurns
                : process.env.GTD_MAX_TURNS
                  ? Math.max(1, parseInt(process.env.GTD_MAX_TURNS, 10) || 20)
                  : 20),
        maxTokens: opts.maxTokens && opts.maxTokens > 0 ? opts.maxTokens : undefined,
        toolPolicy,
        onToolApprovalRequest: canPromptToolApproval ? promptToolApproval : undefined,
        addToSessionAllow: canPromptToolApproval ? addToSessionAllow : undefined,
        addToProjectAllow: canPromptToolApproval ? addToProjectAllow : undefined,
        loadProjectAllow: canPromptToolApproval ? loadProjectAllow : undefined,
        stepTimeoutMs:
          opts.stepTimeoutMs ??
          (process.env.GTD_STEP_TIMEOUT_MS ? Math.max(0, parseInt(process.env.GTD_STEP_TIMEOUT_MS, 10) || 0) : undefined),
        costCapUsd: process.env.GTD_TASK_COST_CAP ? Math.max(0, parseFloat(process.env.GTD_TASK_COST_CAP) || 0) : undefined,
        costWarnPct: process.env.GTD_TASK_COST_WARN_PCT ? Math.max(0, Math.min(100, parseInt(process.env.GTD_TASK_COST_WARN_PCT, 10) || 0)) : undefined,
        workspaceRoots:
          opts.workspaceRoots?.length
            ? opts.workspaceRoots.map((p) => (p.startsWith("/") || /^[A-Za-z]:/.test(p) ? resolve(p) : resolve(process.cwd(), p)))
            : process.env.GTD_WORKSPACE_ROOTS
              ? process.env.GTD_WORKSPACE_ROOTS.split(",").map((p) => p.trim()).filter(Boolean).map((p) => (p.startsWith("/") || /^[A-Za-z]:/.test(p) ? resolve(p) : resolve(process.cwd(), p)))
              : undefined,
        toolChoice: cfg.toolChoice,
        toolTimeouts: cfg.toolTimeouts,
        editFormat: opts.editFormat ?? (["diff", "whole"].includes(process.env.GTD_EDIT_FORMAT ?? "") ? process.env.GTD_EDIT_FORMAT as "diff" | "whole" : undefined) ?? cfg.editFormat,
        attachments: opts.attachments,
        getInjectedInstruction: () => {
          if (verifyFailureToInject != null) {
            const v = verifyFailureToInject;
            verifyFailureToInject = undefined;
            return v;
          }
          return opts.getInjectedInstruction?.();
        },
        ...(lastResult != null &&
        verifyFailureToInject != null &&
        lastResult.outputs &&
        lastResult.plan
          ? { resumeFrom: { outputs: Object.fromEntries(lastResult.outputs), plan: lastResult.plan } }
          : {}),
      onToolConfirm: !quiet
        ? (name, _args, status, err) => {
            if (status === "start") console.log(chalk.dim(`  → ${name} …`));
            else if (status === "end") console.log(chalk.dim(`  ✓ ${name} succeeded`));
            else console.log(chalk.dim(`  ✗ ${name} failed: ${err instanceof Error ? err.message : String(err)}`));
          }
        : undefined,
      onPhaseEnd: async (role, output, planStepId) => {
        await runAfterAgentHooks({ TASK_ID: taskId, TASK_DESCRIPTION: taskDescription, ROLE: role });
        await runExtensionHook("post_step", {
          TASK_PHASE: "post_step",
          ROLE: role,
          TASK_ID: taskId,
          TASK_DESCRIPTION: taskDescription,
          OUTPUT_PREVIEW: output?.slice(0, 500) ?? "",
          STEP_INDEX: String(extensionStepIndex),
          TOTAL_STEPS: String(extensionTotalSteps),
          ...(planStepId != null && planStepId !== "" ? { PLAN_STEP_ID: planStepId } : {}),
        });
        await notifyPostStep({
          phase: "post_step",
          taskId,
          taskDescription,
          role,
          stepIndex: extensionStepIndex,
          totalSteps: extensionTotalSteps,
          outputPreview: output?.slice(0, 500) ?? undefined,
          planStepId: planStepId != null && planStepId !== "" ? planStepId : undefined,
        });
        extensionStepIndex++;
      },
      onPhaseStart: async (role, planStepId) => {
        await runExtensionHook("pre_step", {
          TASK_PHASE: "pre_step",
          ROLE: role,
          TASK_ID: taskId,
          TASK_DESCRIPTION: taskDescription,
          STEP_INDEX: String(extensionStepIndex),
          TOTAL_STEPS: String(extensionTotalSteps),
          ...(planStepId != null && planStepId !== "" ? { PLAN_STEP_ID: planStepId } : {}),
        });
        await runBeforeAgentHooks({ TASK_ID: taskId, TASK_DESCRIPTION: taskDescription, ROLE: role });
      },
      onPostPlan: (tid, plan) =>
        runExtensionHook("post_plan", {
          TASK_PHASE: "post_plan",
          TASK_ID: tid,
          TASK_DESCRIPTION: taskDescription,
          PLAN_STEPS: String(plan.steps.length),
        }),
      onApprovalBlocked: (tid) =>
        runExtensionHook("approval", {
          TASK_PHASE: "approval",
          TASK_ID: tid,
          TASK_DESCRIPTION: taskDescription,
          TASK_STATUS: "blocked",
        }),
      onProgress: (_phase, role, status, output) => {
        if (streamJsonl) {
          const ev = status === "chunk" && role
            ? { event: "output_chunk", taskId, role, output }
            : role
              ? { event: "step_done", taskId, role, status }
              : { event: "phase", taskId, phase: _phase };
          console.log(JSON.stringify(ev));
          opts.onProgress?.(_phase, role ?? "", status, output);
          return;
        }
        opts.onProgress?.(_phase, role ?? "", status, output);
        const def = getAllRoles(cfg.agents).find((r) => r.name === role);
        const id = def?.id;
        if (id) {
          const p = panelState.get(id);
          if (p) {
            p.status = status === "done" ? "done" : status === "error" ? "error" : status === "running" ? "running" : "idle";
            p.progress = status === "done" ? 100 : status === "running" ? 50 : p.progress;
          }
        }
        if (!quiet) {
          if (role && status === "chunk" && output) {
            process.stdout.write(output);
            return;
          }
          const idx = activePhases.indexOf(role) + 1;
          const progressText = totalPhases > 0 ? ` (${idx}/${totalPhases})` : "";
          if (useProgressBar && totalPhases > 0) {
            if (status === "running") {
              if (!progressBar) {
                progressBar = new SingleBar({
                  format: " {bar} | {phase} | {value}/{total}",
                  barCompleteChar: "=",
                  barIncompleteChar: " ",
                });
                progressBar.start(totalPhases, completedPhases, { phase: role });
              } else {
                progressBar.update(completedPhases, { phase: role });
              }
            } else if (status === "done") {
              completedPhases++;
              if (progressBar) {
                progressBar.update(completedPhases, { phase: role });
              }
            } else if (status === "error" && progressBar) {
              progressBar.stop();
              progressBar = null;
            }
          }
          if (!useProgressBar) {
            if (role && status === "running") {
              if (!spinner) spinner = ora().start();
              spinner.text = chalk.cyan(`${role}${progressText}`);
            } else if (role && status === "done") {
              if (spinner) {
                spinner.succeed(chalk.green(`${role} done`));
                spinner = null;
              }
              if (output && !(opts.stream && role === "Builder")) {
                console.log(chalk.dim(highlightMarkdown(output.slice(0, 400) + (output.length > 400 ? "…" : ""))));
              }
              console.log("");
            } else if (role && status === "error") {
              if (spinner) {
                spinner.fail(chalk.red(`${role}: ${output ?? "error"}`));
                spinner = null;
              } else if (output) {
                console.log(chalk.red(`✗ ${role} error: ${output}`));
              }
            }
          }
        }
      },
    };
      const result = await runOrchestration(orchestrationOpts);
      lastResult = result;
      if (result.status !== "completed" || dryRun) break;
      const builderOutForVerify = result.outputs.get("builder");
      if (!builderOutForVerify) break;

      let verifyFailed = false;
      if (maxIterate > 0 && !dryRun && opts.autoLint !== false) {
        const { parseVerifyOutput, formatVerifyForModel } = await import("./verify.js");
        const lintCmd = opts.lintCmd ?? process.env.GTD_LINT_CMD ?? "npm run lint";
        const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
        const lintResult = spawnSync(shell, [process.platform === "win32" ? "/c" : "-c", lintCmd], {
          cwd,
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "pipe"],
        });
        const lintOut = ((lintResult.stdout ?? "") + (lintResult.stderr ?? "")).trim();
        if (lintResult.status !== 0) {
          opts.onLintFailure?.(lintOut, parseVerifyOutput(lintOut));
          verifyFailureToInject = formatVerifyForModel(parseVerifyOutput(lintOut), "lint");
          verifyFailed = true;
        }
      }
      if (verifyFailed && iteration < maxIterate) {
        if (!quiet) console.log(chalk.dim(`Verify failed; re-running (iteration ${iteration + 1}/${maxIterate})…`));
        iteration++;
        verifyAlreadyRunInLoop = true;
        continue;
      }
      if (verifyFailed) break;

      if (maxIterate > 0 && !dryRun && opts.autoTest && (opts.testCmd ?? process.env.GTD_TEST_CMD)) {
        const { parseVerifyOutput, formatVerifyForModel } = await import("./verify.js");
        const testCmd = opts.testCmd ?? process.env.GTD_TEST_CMD!;
        const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
        const testResult = spawnSync(shell, [process.platform === "win32" ? "/c" : "-c", testCmd], {
          cwd,
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "pipe"],
        });
        const testOut = ((testResult.stdout ?? "") + (testResult.stderr ?? "")).trim();
        if (testResult.status !== 0) {
          opts.onTestFailure?.(testOut, parseVerifyOutput(testOut));
          verifyFailureToInject = formatVerifyForModel(parseVerifyOutput(testOut), "test");
          verifyFailed = true;
        }
      }
      if (verifyFailed && iteration < maxIterate) {
        if (!quiet) console.log(chalk.dim(`Verify failed; re-running (iteration ${iteration + 1}/${maxIterate})…`));
        iteration++;
        verifyAlreadyRunInLoop = true;
        continue;
      }
      if (verifyFailed) break;
      verifyAlreadyRunInLoop = maxIterate > 0;
      break;
    }
    const result = lastResult!;

    if (progressBar) {
      (progressBar as SingleBar).stop();
      progressBar = null;
    }

    for (const r of getAllRoles(cfg.agents)) {
      const p = panelState.get(r.id);
      if (p && roles.includes(r.id)) {
        p.status = result.status === "completed" ? "done" : result.status === "failed" ? "error" : p.status;
        p.progress = result.status === "completed" ? 100 : p.progress;
      }
    }
    if (!quiet && !streamJsonl) console.log("\n" + renderAgentGrid(Array.from(panelState.values())));
    if (!quiet && !streamJsonl && (result.usage || (result.usageByModel && Object.keys(result.usageByModel).length > 0))) {
      const total =
        (result.usage ? result.usage.promptTokens + result.usage.completionTokens : 0) ||
        (result.usageByModel ? Object.values(result.usageByModel).reduce((s, u) => s + u.promptTokens + u.completionTokens, 0) : 0);
      const cost = estimateTaskCost({ usage: result.usage, usageByModel: result.usageByModel });
      const tok = total >= 1000 ? (total / 1000).toFixed(1) + "k" : String(total);
      const costStr = cost !== undefined ? `; ~$${cost.toFixed(2)}` : "";
      console.log(chalk.dim(`Tokens: ${tok}${costStr} — gtd show ${shortTaskId(result.taskId)} for usage`));
    }

    await runExtensionHook("end", {
      TASK_PHASE: "end",
      TASK_ID: result.taskId,
      TASK_STATUS: result.status,
      TASK_ERROR: result.error ?? "",
    });

    await runAfterTaskHooks({
      TASK_ID: result.taskId,
      TASK_DESCRIPTION: taskDescription,
      TASK_STATUS: result.status,
      TASK_ERROR: result.error ?? "",
    });

    if (dryRun) {
      const format = (opts.format ?? "text").toLowerCase();
      const planFormat = (opts.planFormat ?? "text").toLowerCase();
      const usePlanJson = format === "json" || planFormat === "json";
      if (usePlanJson) {
        const plan = result.plan;
        const json = JSON.stringify({
          ...(opts.version ? { version: opts.version } : {}),
          taskId: result.taskId,
          ...(namedMode ? { mode: namedMode } : {}),
          qualityProfile: quality,
          approvalPolicy,
          ...(result.estimatedContextTokens != null ? { estimatedContextTokens: result.estimatedContextTokens } : {}),
          plan: plan ? {
            id: plan.id,
            taskId: plan.taskId,
            steps: plan.steps.map((s) => ({
              id: s.id,
              order: s.order,
              description: s.description,
              assignedRole: s.assignedRole,
              riskLevel: s.riskLevel,
              requiresApproval: s.requiresApproval,
              ...(s.workspaceRootIndex != null ? { workspaceRootIndex: s.workspaceRootIndex } : {}),
            })),
            estimatedRisk: plan.estimatedRisk,
            createdAt: plan.createdAt instanceof Date ? plan.createdAt.toISOString() : plan.createdAt,
          } : null,
          scout: result.outputs.get("scout") ?? null,
          planner: result.outputs.get("planner") ?? null,
          error: result.error ?? null,
        }, null, 2);
        console.log(json);
      } else if (quiet) {
        const planText = result.outputs.get("planner") ?? result.error ?? "";
        console.log(planText);
      } else {
        console.log(chalk.bold("\n--- Plan (dry-run) ---"));
        console.log(result.error ?? "");
        if (result.outputs.get("scout")) {
          console.log(chalk.bold("\n--- Scout ---"));
          console.log(highlightMarkdown(result.outputs.get("scout") ?? ""));
        }
        if (result.outputs.get("planner")) {
          console.log(chalk.bold("\n--- Planner ---"));
          console.log(highlightMarkdown(result.outputs.get("planner") ?? ""));
        }
      }
      process.exitCode = 0;
      return;
    }

    const outputsRecord = Object.fromEntries(result.outputs);
    if (!ephemeral) {
      await saveTask(toStored({
        id: result.taskId,
        description: taskDescription,
        source: "cli",
        qualityProfile: quality,
        approvalPolicy,
        status: result.status,
        plan: result.plan,
        tags: opts.tag?.length ? opts.tag : undefined,
      }, {
        completedAt: new Date().toISOString(),
        error: result.error,
        outputs: outputsRecord,
        usage: result.usage,
        usageByModel: result.usageByModel,
        toolCalls: result.toolCalls,
      }), dryRun ? undefined : { expectedUpdatedAt: savedForConflict?.updatedAt });
    }

    if (result.status === "blocked" || result.status === "completed" || result.status === "failed") {
      notifyTaskStateChange({
        taskId: result.taskId,
        status: result.status,
        outputs: outputsRecord,
        error: result.error,
      }).catch(() => {});
    }
    const format = (opts.format ?? "text").toLowerCase();
    if (streamJsonl) {
      const doneEv: Record<string, unknown> = { event: "done", taskId: result.taskId, status: result.status };
      if (opts.version) doneEv.version = opts.version;
      console.log(JSON.stringify(doneEv));
      process.exitCode = result.status === "completed" ? 0 : 1;
      return;
    }
    if (format === "json") {
      const plan = result.plan;
      const fullTaskJson = {
        ...(opts.version ? { version: opts.version } : {}),
        success: result.status === "completed",
        taskId: result.taskId,
        traceId: getTraceId() ?? undefined,
        status: result.status,
        ...(result.errorCode != null ? { errorCode: result.errorCode } : {}),
        ...(namedMode ? { mode: namedMode } : {}),
        qualityProfile: quality,
        approvalPolicy,
        plan: plan
          ? {
              id: plan.id,
              taskId: plan.taskId,
              steps: plan.steps.map((s) => ({
                id: s.id,
                order: s.order,
                description: s.description,
                assignedRole: s.assignedRole,
                riskLevel: s.riskLevel,
                requiresApproval: s.requiresApproval,
                ...(s.workspaceRootIndex != null ? { workspaceRootIndex: s.workspaceRootIndex } : {}),
              })),
              estimatedRisk: plan.estimatedRisk,
              createdAt: plan.createdAt instanceof Date ? plan.createdAt.toISOString() : plan.createdAt,
            }
          : null,
        outputs: outputsRecord,
        usage: result.usage,
        usageByModel: result.usageByModel,
        toolCalls: result.toolCalls ?? undefined,
        error: result.error ?? null,
      };
      if (opts.resultSchema) {
        try {
          const { readFile } = await import("fs/promises");
          const { resolve } = await import("path");
          const schemaPath = resolve(cwd, opts.resultSchema);
          const schemaJson = await readFile(schemaPath, "utf-8");
          const schema = JSON.parse(schemaJson) as object;
          const { Ajv } = await import("ajv");
          const ajv = new Ajv();
          const validate = ajv.compile(schema);
          if (!validate(fullTaskJson)) {
            console.error(chalk.red("Task result did not match --result-schema:"));
            console.error(JSON.stringify(validate.errors, null, 2));
            process.exitCode = 1;
            return;
          }
        } catch (e) {
          console.error(chalk.red("Result schema validation failed: " + (e instanceof Error ? e.message : String(e))));
          process.exitCode = 1;
          return;
        }
      }
      console.log(JSON.stringify(fullTaskJson, null, 2));
      process.exitCode = result.status === "completed" ? 0 : 1;
      return;
    }
    if (result.status === "completed") {
      const builderOut = result.outputs.get("builder");
      if (builderOut) {
        if (opts.output && opts.output !== "-") {
          const dir = dirname(opts.output);
          if (dir) await mkdir(dir, { recursive: true });
          await writeFile(opts.output, builderOut, "utf-8");
          if (!quiet && !printOnly) console.log(chalk.green(`\nDeliverable written to ${opts.output}`));
        }
        if (printOnly || opts.output === "-") {
          console.log(highlightMarkdown(builderOut));
        } else {
          if (!quiet) {
            console.log(chalk.green("\n✓ Task completed."));
            console.log(chalk.dim(`Task ID: ${result.taskId}`));
            console.log(chalk.bold("\n--- Deliverable ---"));
          }
          console.log(highlightMarkdown(builderOut));
        }

        if (opts.write) {
          const outDir = opts.outDir ?? process.cwd();
          const blocks = parseCodeBlocks(builderOut);
          if (blocks.length > 0) {
            const dryRun = !opts.auto;
            if (dryRun) {
              const { written } = await writeCodeBlocks(blocks, outDir, { dryRun: true });
              console.log(chalk.yellow("\nFiles to write (use --auto to apply):"));
              for (const p of written) console.log(`  ${p}`);
            } else {
              const { written, skipped } = await writeCodeBlocks(blocks, outDir);
              if (written.length > 0) {
                console.log(chalk.green("\nWritten:"));
                for (const p of written) console.log(`  ${p}`);
              }
              if (skipped.length > 0) {
                console.log(chalk.yellow("Skipped:"));
                for (const p of skipped) console.log(`  ${p}`);
              }
            }
          }
        }
        if (useGit && !opts.noAutoCommits && hasDirtyFiles(cwd)) {
          const msg = generateCommitMessage(taskDescription, { template: cfg.commitMessagePrompt });
          const commitResult = commitAll(cwd, msg, {
            noVerify: !opts.gitCommitVerify,
            attribution: opts.commitAttribution ?? true,
          });
          if (commitResult.success && !quiet) console.log(chalk.green("\nCommitted: " + msg));
          else if (!commitResult.success && !quiet) console.log(chalk.yellow("Auto-commit failed: " + (commitResult.error ?? "unknown")));
        }
        if (!verifyAlreadyRunInLoop && !dryRun && opts.autoLint !== false) {
          const lintCmd = opts.lintCmd ?? process.env.GTD_LINT_CMD ?? "npm run lint";
          const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
          const lintResult = spawnSync(shell, [process.platform === "win32" ? "/c" : "-c", lintCmd], {
            cwd,
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "pipe"],
          });
          const lintOut = ((lintResult.stdout ?? "") + (lintResult.stderr ?? "")).trim();
          if (lintResult.status !== 0) {
            if (!quiet) console.log(chalk.yellow("\nLint failed (exit " + (lintResult.status ?? "?") + "). Output below or queued for next task."));
            if (lintOut && !quiet) console.log(lintOut.slice(0, 8000) + (lintOut.length > 8000 ? "\n…" : ""));
            const { parseVerifyOutput } = await import("./verify.js");
            opts.onLintFailure?.(lintOut, parseVerifyOutput(lintOut));
          }
        }
        if (!verifyAlreadyRunInLoop && !dryRun && opts.autoTest && (opts.testCmd ?? process.env.GTD_TEST_CMD)) {
          const testCmd = opts.testCmd ?? process.env.GTD_TEST_CMD!;
          const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
          const testResult = spawnSync(shell, [process.platform === "win32" ? "/c" : "-c", testCmd], {
            cwd,
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "pipe"],
          });
          const testOut = ((testResult.stdout ?? "") + (testResult.stderr ?? "")).trim();
          if (testResult.status !== 0) {
            if (!quiet) console.log(chalk.yellow("\nTest failed (exit " + (testResult.status ?? "?") + "). Output below or queued for next task."));
            if (testOut && !quiet) console.log(testOut.slice(0, 8000) + (testOut.length > 8000 ? "\n…" : ""));
            const { parseVerifyOutput } = await import("./verify.js");
            opts.onTestFailure?.(testOut, parseVerifyOutput(testOut));
          }
        }
      }
    } else if (result.status === "failed") {
      console.log(chalk.red("\n✗ Task failed: " + (result.error ?? "Unknown error")));
      console.log(chalk.dim(`Run: gtd retry ${shortTaskId(result.taskId)}`));
    } else if (result.status === "cancelled") {
      console.log(chalk.yellow("\n⊘ Task cancelled. Exiting gracefully."));
    } else if (result.status === "blocked") {
      console.log(chalk.yellow("\n⏸ Blocked: " + (result.error ?? "Approval required")));
      console.log(chalk.dim(`Run: gtd approve ${shortTaskId(result.taskId)}`));
    }
    const notifyCmd = process.env.GTD_NOTIFY_CMD?.trim();
    if (notifyCmd && result.status) {
      const descFirst = taskDescription.split(/\n/)[0]?.trim().slice(0, 100) ?? "";
      spawn(notifyCmd, [], {
        env: {
          ...process.env,
          GTD_NOTIFY_TASK_ID: result.taskId,
          GTD_NOTIFY_STATUS: result.status,
          GTD_NOTIFY_DESCRIPTION: descFirst,
        },
        stdio: "ignore",
        detached: true,
      }).unref();
    }
    process.exitCode = result.status === "completed" ? 0 : 1;
  } catch (e) {
    process.exitCode = 1;
    if (e instanceof TaskConflictError) {
      console.log(chalk.yellow("\n⊘ " + e.message));
    } else if ((e && typeof (e as { name?: string }).name === "string" && (e as { name: string }).name === "AbortError") || (e instanceof Error && e.message?.toLowerCase().includes("abort"))) {
      console.log(chalk.yellow("\n⊘ Shutting down gracefully (interrupted)."));
    } else {
      console.log(chalk.red("\n✗ Error: " + (e instanceof Error ? e.message : String(e))));
    }
    if (!dryRun && !ephemeral) {
      try {
        await saveTask(toStored({
          id: taskId,
          description: taskDescription,
          source: "cli",
          qualityProfile: quality,
          approvalPolicy,
          status: "failed",
          tags: opts.tag?.length ? opts.tag : undefined,
        }, { error: e instanceof Error ? e.message : String(e), completedAt: new Date().toISOString() }), { expectedUpdatedAt: savedForConflict?.updatedAt });
      } catch (saveErr) {
        if (!(saveErr instanceof TaskConflictError)) throw saveErr;
      }
      notifyTaskStateChange({
        taskId,
        status: "failed",
        error: e instanceof Error ? e.message : String(e),
      }).catch(() => {});
    }
  } finally {
    if (spinner) spinner.stop();
    if (progressBar) progressBar.stop();
    if (cancelPoll) clearInterval(cancelPoll);
    if (timeoutId) clearTimeout(timeoutId);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await clearCancel(taskId);
  }
}

/** Result of approving a blocked task (for CLI and approval UI). */
export interface ApproveTaskResult {
  success: boolean;
  taskId: string;
  status?: string;
  error?: string;
  deliverable?: string;
}

/**
 * Approve a blocked task by id (or id prefix) and resume execution. Used by `gtd approve <id>`, `gtd approvals -i`, and the approval web UI.
 * When opts.pendingToolApproval is set (e.g. from API/dashboard edit or reject), the first tool that requires approval on resume will receive this decision.
 */
export async function approveTask(
  idArg: string,
  opts?: {
    onProgress?: (role: string, status: string) => void;
    quiet?: boolean;
    reason?: string;
    /** When set, the first tool approval request on resume will receive this result (e.g. from API/dashboard edit args or reject with feedback). */
    pendingToolApproval?: import("../agents/runner.js").ToolApprovalResult;
  }
): Promise<ApproveTaskResult> {
  let task = await getTask(idArg);
  if (!task) {
    const tasks = await listTasks({ limit: 50 });
    task = tasks.find((t) => t.id.startsWith(idArg) || t.id === idArg) ?? undefined;
  }
  if (!task) {
    return { success: false, taskId: idArg, error: `Task ${idArg} not found` };
  }
  if (task.status !== "blocked") {
    return { success: true, taskId: task.id, status: task.status };
  }
  if (!task.outputs || !task.plan) {
    return { success: false, taskId: task.id, error: "Blocked task missing outputs or plan" };
  }
  const cfg = await loadConfig();
  audit({ type: "approval_granted", taskId: task.id, message: opts?.reason ?? "User approved blocked task" });
  const pendingToolApproval = opts?.pendingToolApproval;
  try {
    const result = await runOrchestration({
      taskId: task.id,
      taskDescription: task.description,
      qualityProfile: task.qualityProfile,
      approvalPolicy: "auto",
      resumeFrom: { outputs: task.outputs, plan: task.plan },
      modelOverrides: cfg.modelOverrides,
      customAgents: cfg.agents,
      profileRoles: cfg.profileRoles,
      onProgress: opts?.onProgress
        ? (_phase, role, status) => opts.onProgress!(role ?? "", status ?? "")
        : undefined,
      onToolApprovalRequest:
        pendingToolApproval !== undefined
          ? (() => {
              let used = false;
              return async (
                _toolName: string,
                _category: string,
                _args: Record<string, unknown>
              ): Promise<import("../agents/runner.js").ToolApprovalResult> => {
                if (!used) {
                  used = true;
                  return pendingToolApproval;
                }
                return { choice: "allow" };
              };
            })()
          : undefined,
    });
    const outputsRecord = Object.fromEntries(result.outputs);
    await saveTask(
      toStored(
        {
          id: result.taskId,
          description: task.description,
          source: task.source,
          sourceId: task.sourceId,
          qualityProfile: task.qualityProfile,
          approvalPolicy: task.approvalPolicy,
          status: result.status,
          plan: result.plan,
        },
        {
          completedAt: new Date().toISOString(),
          error: result.error,
          outputs: outputsRecord,
          usage: result.usage,
          usageByModel: result.usageByModel,
          toolCalls: result.toolCalls,
        }
      ),
      { expectedUpdatedAt: task.updatedAt }
    );
    if (result.status === "completed" || result.status === "failed") {
      notifyTaskStateChange({
        taskId: result.taskId,
        status: result.status,
        outputs: outputsRecord,
        error: result.error,
      }).catch(() => {});
    }
    const deliverable = result.outputs.get("builder");
    return {
      success: result.status === "completed",
      taskId: result.taskId,
      status: result.status,
      error: result.error,
      deliverable,
    };
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    return { success: false, taskId: task.id, status: "failed", error: err };
  }
}
