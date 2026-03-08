/**
 * Unified tool runtime for model-invoked tools.
 * File, shell, git, and web tools with policy enforcement.
 */

import { readFile, writeFile, unlink, mkdir, readdir } from "fs/promises";
import { createReadStream } from "fs";
import { createInterface } from "readline";
import { resolve, sep, dirname } from "path";
import { runSandboxedCommand } from "../security/sandbox.js";
import { checkToolPermission, checkPathPermission, type ToolPolicy } from "../security/policy.js";
import { allowListKey } from "../security/allow-list.js";
import { logToolCall, audit } from "../security/audit.js";
import { isPathIgnored, appendProjectMemory, getProjectMemoryPath } from "../memory/store.js";
import type { ToolDefinition, ToolResult, ToolResultRiskLevel } from "../types/tooling.js";
import { withRetry, toolRetryOptions } from "../core/retry.js";

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "list_directory",
    description: "List directory contents. Optional respect_git_ignore (default true) filters by .gitignore/.gtdignore. Optional ignore: array of glob patterns to exclude.",
    parameters: {
      path: { type: "string", description: "Directory path (default: .)" },
      respect_git_ignore: { type: "boolean", description: "Exclude paths matching .gitignore/.gtdignore (default true)" },
      ignore: { type: "array", description: "Optional list of glob patterns to exclude (e.g. ['node_modules', '*.log'])" },
      workspace_root_index: { type: "number", description: "When GTD_WORKSPACE_ROOTS is set: 0-based index of root (default 0)" },
    },
    category: "read",
  },
  {
    name: "read_file",
    description: "Read contents of a file. When GTD_WORKSPACE_ROOTS is set, use workspace_root_index (0-based) to run in that root. Optional offset/limit (1-based line numbers) for large files.",
    parameters: {
      path: { type: "string", description: "File path" },
      workspace_root_index: { type: "number", description: "When GTD_WORKSPACE_ROOTS is set: 0-based index of root (default 0)" },
      offset: { type: "number", description: "Optional 1-based start line (inclusive). Use with limit to read a range." },
      limit: { type: "number", description: "Optional max lines to return. When set, output is prefixed with a truncation message." },
    },
    category: "read",
  },
  {
    name: "write_file",
    description: "Write content to a file. When GTD_WORKSPACE_ROOTS is set, use workspace_root_index (0-based) to run in that root.",
    parameters: {
      path: { type: "string" }, content: { type: "string" },
      workspace_root_index: { type: "number", description: "When GTD_WORKSPACE_ROOTS is set: 0-based index of root (default 0)" },
    },
    category: "write",
  },
  {
    name: "edit_file",
    description: "Replace first occurrence of old_string with new_string in a file.",
    parameters: {
      path: { type: "string", description: "File path" },
      old_string: { type: "string", description: "Exact string to find" },
      new_string: { type: "string", description: "Replacement string" },
      workspace_root_index: { type: "number", description: "When GTD_WORKSPACE_ROOTS is set: 0-based index of root (default 0)" },
    },
    category: "write",
  },
  {
    name: "apply_patch",
    description: "Apply a unified diff (patch) to the working tree. Patch is applied from the given directory.",
    parameters: {
      patch: { type: "string", description: "Unified diff content" },
      cwd: { type: "string", description: "Directory to apply patch from (default: current)" },
      workspace_root_index: { type: "number", description: "When GTD_WORKSPACE_ROOTS is set: 0-based index of root (default 0)" },
    },
    category: "write",
  },
  {
    name: "append_project_memory",
    description: "Append text to project MEMORY.md (project root). Use to persist a fact or decision from this session. File is created if missing.",
    parameters: {
      text: { type: "string", description: "Content to append (markdown-friendly)" },
      workspace_root_index: { type: "number", description: "When GTD_WORKSPACE_ROOTS is set: 0-based index of root (default 0)" },
    },
    category: "write",
  },
  {
    name: "run_command",
    description: "Execute a shell command. When GTD_WORKSPACE_ROOTS is set, use workspace_root_index (0-based) to run in that root.",
    parameters: {
      command: { type: "string" }, cwd: { type: "string", description: "Working directory (optional)" },
      workspace_root_index: { type: "number", description: "When GTD_WORKSPACE_ROOTS is set: 0-based index of root (default 0)" },
    },
    category: "command",
  },
  {
    name: "git_status",
    description: "Get git status. When GTD_WORKSPACE_ROOTS is set, use workspace_root_index (0-based) to run in that root.",
    parameters: {
      path: { type: "string", description: "Repo path (optional)" },
      workspace_root_index: { type: "number", description: "When GTD_WORKSPACE_ROOTS is set: 0-based index of root (default 0)" },
    },
    category: "git",
  },
  {
    name: "git_diff",
    description: "Show git diff (working tree vs index or ref). Optionally limit to path.",
    parameters: {
      path: { type: "string", description: "Repo path (optional)" },
      ref: { type: "string", description: "Compare against ref (e.g. HEAD, branch); default working tree vs index" },
      workspace_root_index: { type: "number", description: "When GTD_WORKSPACE_ROOTS is set: 0-based index of root (default 0)" },
    },
    category: "git",
  },
  {
    name: "git_commit",
    description: "Create a git commit with the given message. Stage changes first with run_command git add.",
    parameters: {
      message: { type: "string", description: "Commit message" }, path: { type: "string", description: "Repo path (optional)" },
      workspace_root_index: { type: "number", description: "When GTD_WORKSPACE_ROOTS is set: 0-based index of root (default 0)" },
    },
    category: "git",
  },
  {
    name: "web_fetch",
    description: "Fetch URL content",
    parameters: { url: { type: "string" } },
    category: "network",
  },
  {
    name: "web_search",
    description: "Search the web (requires SERPER_API_KEY). Returns titles and snippets. Use web_fetch to load a result URL.",
    parameters: { query: { type: "string", description: "Search query" } },
    category: "network",
  },
  {
    name: "browser_screenshot",
    description: "Open URL in headless browser and return page text or take screenshot (requires Playwright).",
    parameters: { url: { type: "string" }, action: { type: "string", description: "Optional: 'text' (default) or 'screenshot' path" } },
    category: "browser",
  },
  {
    name: "mcp_call",
    description: "Invoke a tool on a registered MCP server. Use server_id from gtd mcp list and tool name from gtd mcp tools.",
    parameters: {
      server_id: { type: "string", description: "MCP server id (from gtd mcp list)" },
      tool_name: { type: "string", description: "Tool name (from gtd mcp tools <server_id>)" },
      arguments: { type: "object", description: "Tool arguments as JSON object" },
    },
    category: "mcp",
  },
  {
    name: "run_subagent",
    description: "Run an isolated subagent to answer a focused question or explore a narrow scope. Uses a separate context window; returns only a concise excerpt or summary. Use for parallel exploration or when you need a dedicated pass (e.g. search one area, summarize one file).",
    parameters: {
      question: { type: "string", description: "The question or task for the subagent (e.g. 'Summarize the API in src/api.ts', 'What env vars does this app use?')" },
      context_snippet: { type: "string", description: "Optional context to pass (e.g. file path or short excerpt). Keep small." },
      max_output_chars: { type: "number", description: "Optional max length of the returned excerpt (default 4000, max 8000)" },
    },
    category: "command",
  },
  {
    name: "read_files",
    description: "Read multiple files in one call to reduce round-trips. Returns each file's path and content (or error). Use when you need several files for context.",
    parameters: {
      paths: { type: "array", description: "Array of file paths to read (e.g. [\"src/a.ts\", \"src/b.ts\"]). Max 20 files." },
      workspace_root_index: { type: "number", description: "When GTD_WORKSPACE_ROOTS is set: 0-based index of root (default 0)" },
    },
    category: "read",
  },
  {
    name: "sample_tabular",
    description: "Read first N lines of a tabular file (CSV, TSV, etc.) and total line count without loading the full file. Use for large data files to sample or summarize structure.",
    parameters: {
      path: { type: "string", description: "File path (CSV, Excel path, JSON lines, or any text table)" },
      max_rows: { type: "number", description: "Max lines to return (default 30)" },
      workspace_root_index: { type: "number", description: "When GTD_WORKSPACE_ROOTS is set: 0-based index of root (default 0)" },
    },
    category: "read",
  },
];

function getDef(name: string): ToolDefinition | undefined {
  return TOOL_DEFINITIONS.find((t) => t.name === name);
}

/**
 * Execute a tool with policy enforcement.
 */
/** When workspaceRoots is set, resolved path must be under one of the roots (multi-repo spike). */
function isUnderWorkspaceRoots(resolvedPath: string, roots: string[]): boolean {
  for (const r of roots) {
    const rootNorm = resolve(r);
    if (resolvedPath === rootNorm || resolvedPath.startsWith(rootNorm + sep)) return true;
  }
  return false;
}

/** A.3: Ensure path is under cwd (or under workspaceRoots when set). No write outside workspace. */
function checkPathUnderWorkspace(resolvedPath: string, cwd: string, workspaceRoots: string[] | undefined): string | null {
  const cwdNorm = resolve(cwd);
  const underCwd = resolvedPath === cwdNorm || resolvedPath.startsWith(cwdNorm + sep);
  if (workspaceRoots?.length) {
    if (isUnderWorkspaceRoots(resolvedPath, workspaceRoots)) return null;
    return `Path ${resolvedPath} is outside workspace roots (GTD_WORKSPACE_ROOTS).`;
  }
  if (!underCwd) return `Path ${resolvedPath} is outside workspace (cwd).`;
  return null;
}

function checkWorkspaceRoots(pathArg: string, cwd: string, workspaceRoots: string[] | undefined): string | null {
  const resolved = resolve(cwd, pathArg);
  return checkPathUnderWorkspace(resolved, cwd, workspaceRoots);
}

/** Default risk level by tool category (agent-trends 40). */
function getDefaultRiskLevel(toolName: string, category: ToolDefinition["category"]): ToolResultRiskLevel {
  if (toolName === "run_command" || toolName === "mcp_call") return "high";
  if (category === "network" || category === "command") return "high";
  if (category === "write" || toolName === "git_commit") return "medium";
  return "low";
}

/** Command sanitization (agent-trends 35): detect injection patterns and classify risk. */
function sanitizeCommand(command: string): { sanitized: string; risk: ToolResultRiskLevel; safetyNote?: string } {
  const trimmed = command.trim();
  const dangerous = [
    { pattern: /\$\([^)]*\)/g, name: "command substitution $(...)" },
    { pattern: /`[^`]*`/g, name: "backtick substitution" },
    { pattern: /\|\s*\w+/g, name: "piped command" },
    { pattern: /;\s*\w+/g, name: "chained command (;)" },
    { pattern: /&&\s*\w+/g, name: "chained command (&&)" },
    { pattern: /\|\|/g, name: "chained command (||)" },
  ];
  let risk: ToolResultRiskLevel = "low";
  const notes: string[] = [];
  for (const { pattern, name } of dangerous) {
    if (trimmed.match(pattern)) {
      risk = risk === "critical" ? "critical" : "high";
      notes.push(name);
    }
  }
  if (trimmed.includes("eval ") || trimmed.includes("curl ") || /^\s*rm\s+-?rf/.test(trimmed)) {
    risk = "critical";
    notes.push("high-impact command");
  }
  const safetyNote = notes.length ? `Command classified as ${risk}; patterns detected: ${notes.join(", ")}.` : undefined;
  return { sanitized: trimmed, risk, safetyNote };
}

/** In-memory store for idempotent write results (agent-trends 65). Key -> last ToolResult; capped size. */
const idempotencyWriteStore = new Map<string, ToolResult>();
const IDEMPOTENCY_STORE_MAX = 500;

function getIdempotencyCached(key: string): ToolResult | undefined {
  return idempotencyWriteStore.get(key);
}
function setIdempotencyCached(key: string, result: ToolResult): void {
  if (idempotencyWriteStore.size >= IDEMPOTENCY_STORE_MAX) {
    const firstKey = idempotencyWriteStore.keys().next().value as string | undefined;
    if (firstKey != null) idempotencyWriteStore.delete(firstKey);
  }
  idempotencyWriteStore.set(key, result);
}
function cacheWriteResult(key: string | undefined, result: ToolResult): ToolResult {
  if (key && result.success) setIdempotencyCached(key, result);
  return result;
}

export async function executeTool(
  toolName: string,
  args: Record<string, unknown>,
  policy: ToolPolicy,
  options?: {
    cwd?: string;
    allowOnceKeys?: Set<string>;
    workspaceRoots?: string[];
    toolTimeouts?: Partial<Record<string, number>>;
    /** When set for write tools, duplicate calls with same key return cached result (replay safety). */
    idempotencyKey?: string;
  }
): Promise<ToolResult> {
  const def = getDef(toolName);
  if (!def) {
    return { success: false, error: `Unknown tool: ${toolName}`, riskLevel: "low" };
  }

  if (def.category === "write" && options?.idempotencyKey) {
    const cached = getIdempotencyCached(options.idempotencyKey);
    if (cached != null) return { ...cached, output: (cached.output ?? "OK") + " (idempotent replay)" };
  }

  const perm = checkToolPermission(toolName, def.category, policy);
  if (perm === "deny") {
    return {
      success: false,
      error: `Tool ${toolName} denied by policy`,
      riskLevel: getDefaultRiskLevel(toolName, def.category),
    };
  }
  const allowOnce = perm === "ask" && options?.allowOnceKeys?.has(allowListKey(toolName, def.category));
  if (perm === "ask" && !allowOnce) {
    logToolCall({ tool: toolName, category: def.category, outcome: "approval_required" });
    return {
      success: false,
      requiresApproval: true,
      error: `Tool ${toolName} requires approval`,
      riskLevel: getDefaultRiskLevel(toolName, def.category),
    };
  }

  const cwd = (options?.cwd ?? process.cwd()) as string;
  const workspaceRoots = options?.workspaceRoots;
  const defaultTimeout = Math.max(1000, Math.min(300_000, parseInt(process.env.GTD_TOOL_TIMEOUT_MS ?? "30000", 10) || 30_000));
  const categoryTimeout = options?.toolTimeouts?.[def.category];
  const toolTimeoutMs = categoryTimeout != null && categoryTimeout > 0 ? Math.min(300_000, categoryTimeout) : defaultTimeout;

  function argsSummary(): string {
    const path = args.path != null ? String(args.path) : undefined;
    const cmd = args.command != null ? String(args.command) : undefined;
    if (path != null) return `path=${path}`;
    if (cmd != null) return `command=${cmd.slice(0, 80)}`;
    return "";
  }

  try {
    const result: ToolResult = await withRetry(async () => {
    switch (toolName) {
      case "list_directory": {
        const pathArg = String(args.path ?? ".").trim() || ".";
        const dirPath = resolve(cwd, pathArg);
        const wrErr = checkWorkspaceRoots(pathArg, cwd, workspaceRoots);
        if (wrErr) return { success: false, error: wrErr };
        if (!checkPathPermission(dirPath, policy, "read")) {
          return { success: false, error: `Path denied: ${dirPath}` };
        }
        const respectGitIgnore = args.respect_git_ignore !== false;
        const ignorePatterns = Array.isArray(args.ignore) ? (args.ignore as unknown[]).map((x) => String(x)).filter(Boolean) : [];
        let entries: Array<{ name: string; isDirectory: () => boolean }>;
        try {
          const raw = await readdir(dirPath, { withFileTypes: true });
          entries = raw.map((e) => ({ name: String(e.name), isDirectory: () => e.isDirectory() }));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { success: false, error: `list_directory failed: ${msg}` };
        }
        let names = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort();
        if (respectGitIgnore) {
          const filtered: string[] = [];
          for (const n of names) {
            const full = resolve(dirPath, n.replace(/\/$/, ""));
            const ignored = await isPathIgnored(cwd, full);
            if (!ignored) filtered.push(n);
          }
          names = filtered;
        }
        if (ignorePatterns.length > 0) {
          names = names.filter((n) => {
            const base = n.replace(/\/$/, "");
            for (const p of ignorePatterns) {
              if (p === base || base === p) return false;
              if (p.endsWith("*") && base.startsWith(p.slice(0, -1))) return false;
              if (p.includes("*") && new RegExp("^" + p.replace(/\*/g, ".*") + "$").test(base)) return false;
            }
            return true;
          });
        }
        return { success: true, output: names.join("\n") || "(empty)" };
      }
      case "read_file": {
        const path = resolve(cwd, String(args.path ?? ""));
        const wrErr = checkWorkspaceRoots(String(args.path ?? ""), cwd, workspaceRoots);
        if (wrErr) return { success: false, error: wrErr };
        if (!checkPathPermission(path, policy, "read")) {
          return { success: false, error: `Path denied: ${path}` };
        }
        const buf = await readFile(path);
        const hasNull = buf.includes(0);
        const nonPrintable = buf.filter((b) => b < 32 && b !== 9 && b !== 10 && b !== 13).length;
        const likelyBinary = hasNull || (buf.length > 0 && nonPrintable / buf.length > 0.3);
        if (likelyBinary) {
          return { success: true, output: `[Binary or non-UTF-8 file skipped: ${path}. Use a different tool for binary files.]` };
        }
        const content = buf.toString("utf-8");
        const lineOffset = typeof args.offset === "number" && args.offset >= 1 ? Math.floor(args.offset) - 1 : 0;
        const lineLimit = typeof args.limit === "number" && args.limit >= 1 ? Math.floor(args.limit) : 0;
        if (lineLimit > 0) {
          const lines = content.split(/\r?\n/);
          const total = lines.length;
          const start = Math.min(lineOffset, total);
          const end = Math.min(start + lineLimit, total);
          const slice = lines.slice(start, end).join("\n");
          const msg = `File content truncated: showing lines ${start + 1}–${end} of ${total}.\n\n`;
          return { success: true, output: msg + slice };
        }
        return { success: true, output: content };
      }
      case "read_files": {
        const rawPaths = Array.isArray(args.paths) ? (args.paths as unknown[]).map((p) => String(p).trim()).filter(Boolean) : [];
        const rootIndex = args.workspace_root_index != null ? Number(args.workspace_root_index) : 0;
        const effectiveCwd = workspaceRoots?.length && rootIndex >= 0 && workspaceRoots[rootIndex] ? workspaceRoots[rootIndex] : cwd;
        const paths = rawPaths.slice(0, 20);
        if (paths.length === 0) return { success: false, error: "paths array is required (max 20 paths)" };
        const maxPerFile = 60_000;
        const parts: string[] = [];
        for (const p of paths) {
          const fullPath = resolve(effectiveCwd, p);
          const wrErr = checkWorkspaceRoots(p, effectiveCwd, workspaceRoots);
          if (wrErr) {
            parts.push(`--- ${p} ---\nError: ${wrErr}`);
            continue;
          }
          if (!checkPathPermission(fullPath, policy, "read")) {
            parts.push(`--- ${p} ---\nError: Path denied`);
            continue;
          }
          try {
            const buf = await readFile(fullPath);
            const hasNull = buf.includes(0);
            const nonPrintable = buf.filter((b) => b < 32 && b !== 9 && b !== 10 && b !== 13).length;
            const likelyBinary = hasNull || (buf.length > 0 && nonPrintable / buf.length > 0.3);
            if (likelyBinary) {
              parts.push(`--- ${p} ---\n[Binary or non-UTF-8 file skipped]`);
              continue;
            }
            let content = buf.toString("utf-8");
            if (content.length > maxPerFile) content = content.slice(0, maxPerFile) + "\n[...truncated]";
            parts.push(`--- ${p} ---\n${content}`);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            parts.push(`--- ${p} ---\nError: ${msg}`);
          }
        }
        return { success: true, output: parts.join("\n\n") };
      }
      case "write_file": {
        const path = resolve(cwd, String(args.path ?? ""));
        const wrErr = checkPathUnderWorkspace(path, cwd, workspaceRoots);
        if (wrErr) return { success: false, error: wrErr };
        if (!checkPathPermission(path, policy, "write")) {
          return { success: false, error: `Path denied: ${path}` };
        }
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, String(args.content ?? ""), "utf-8");
        return cacheWriteResult(options?.idempotencyKey, { success: true, output: `Wrote ${path}` });
      }
      case "edit_file": {
        const path = resolve(cwd, String(args.path ?? ""));
        const wrErr = checkPathUnderWorkspace(path, cwd, workspaceRoots);
        if (wrErr) return { success: false, error: wrErr };
        if (!checkPathPermission(path, policy, "read") || !checkPathPermission(path, policy, "write")) {
          return { success: false, error: `Path denied: ${path}` };
        }
        const content = await readFile(path, "utf-8");
        const oldStr = String(args.old_string ?? "");
        const newStr = String(args.new_string ?? "");
        if (!oldStr) return { success: false, error: "old_string is required" };
        const idx = content.indexOf(oldStr);
        if (idx === -1) return { success: false, error: "old_string not found in file" };
        const updated = content.slice(0, idx) + newStr + content.slice(idx + oldStr.length);
        await writeFile(path, updated, "utf-8");
        return cacheWriteResult(options?.idempotencyKey, { success: true, output: `Updated ${path}` });
      }
      case "apply_patch": {
        const patchContent = String(args.patch ?? "");
        const patchCwd = args.cwd ? resolve(cwd, String(args.cwd)) : cwd;
        const patchWrErr = checkPathUnderWorkspace(patchCwd, cwd, workspaceRoots);
        if (patchWrErr) return { success: false, error: patchWrErr };
        if (!patchContent.trim()) return { success: false, error: "patch content is required" };
        const patchFileName = `.gtd-patch-${Date.now()}.patch`;
        const patchFile = resolve(patchCwd, patchFileName);
        try {
          await writeFile(patchFile, patchContent, "utf-8");
          const { stdout, stderr, exitCode } = await runSandboxedCommand(
            `patch -p0 --forward -i ${patchFileName}`,
            policy,
            { cwd: patchCwd, timeoutMs: toolTimeoutMs }
          );
          await unlink(patchFile).catch(() => {});
          const out = [stdout, stderr].filter(Boolean).join("\n").trim();
          if (exitCode !== 0) return { success: false, error: out || `patch exited ${exitCode}` };
          return cacheWriteResult(options?.idempotencyKey, { success: true, output: out || "Patch applied" });
        } catch (e) {
          await unlink(patchFile).catch(() => {});
          return { success: false, error: e instanceof Error ? e.message : String(e) };
        }
      }
      case "append_project_memory": {
        const rootIndex = args.workspace_root_index != null ? Number(args.workspace_root_index) : 0;
        const effectiveCwd = workspaceRoots?.length && rootIndex >= 0 && workspaceRoots[rootIndex] ? workspaceRoots[rootIndex] : cwd;
        const memoryPath = getProjectMemoryPath(effectiveCwd);
        if (!checkPathPermission(memoryPath, policy, "write")) {
          return { success: false, error: `Path denied: ${memoryPath}` };
        }
        const text = String(args.text ?? "").trim();
        if (!text) return { success: false, error: "text is required" };
        try {
          await appendProjectMemory(effectiveCwd, text);
          audit({
            type: "memory_write",
            message: "Appended to MEMORY.md",
            meta: { textPreview: text.slice(0, 200), path: memoryPath },
          }).catch(() => {});
          return cacheWriteResult(options?.idempotencyKey, { success: true, output: "Appended to MEMORY.md" });
        } catch (e) {
          return { success: false, error: e instanceof Error ? e.message : String(e) };
        }
      }
      case "run_command": {
        const rawCommand = String(args.command ?? "");
        const runCwd = args.cwd ? resolve(cwd, String(args.cwd)) : cwd;
        const runWrErr = checkWorkspaceRoots(args.cwd ? String(args.cwd) : ".", cwd, workspaceRoots);
        if (runWrErr) return { success: false, error: runWrErr, riskLevel: "high" };
        const firstToken = rawCommand.trim().split(/\s+/)[0]?.toLowerCase();
        if (firstToken && ["sudo", "su", "pkexec", "doas"].includes(firstToken)) {
          return {
            success: false,
            error: "Elevation (sudo/su/pkexec/doas) is not allowed for security. Run the command without elevation.",
            riskLevel: "critical",
            safetyNote: "Elevation commands are blocked.",
          };
        }
        const { sanitized: command, risk: cmdRisk, safetyNote: cmdSafetyNote } = sanitizeCommand(rawCommand);
        if (cmdRisk === "critical" && process.env.GTD_SANITIZE_COMMAND_STRICT === "1") {
          return {
            success: false,
            error: "Command rejected: high-risk patterns detected. Set GTD_SANITIZE_COMMAND_STRICT=0 to allow (not recommended).",
            riskLevel: "critical",
            safetyNote: cmdSafetyNote,
          };
        }
        const { stdout, stderr, exitCode } = await runSandboxedCommand(command, policy, { cwd: runCwd, timeoutMs: toolTimeoutMs });
        const out = [stdout, stderr].filter(Boolean).join("\n").trim() || (exitCode === 0 ? "OK" : `Exit ${exitCode}`);
        const runResult: ToolResult = {
          success: exitCode === 0,
          output: out,
          error: exitCode !== 0 ? `Exit code ${exitCode}` : undefined,
          riskLevel: cmdRisk,
          safetyNote: cmdSafetyNote,
        };
        return runResult;
      }
      case "git_status": {
        const repoPath = args.path ? resolve(cwd, String(args.path)) : cwd;
        const gitWrErr = checkWorkspaceRoots(args.path ? String(args.path) : ".", cwd, workspaceRoots);
        if (gitWrErr) return { success: false, error: gitWrErr };
        const { stdout, stderr, exitCode } = await runSandboxedCommand("git status", policy, { cwd: repoPath, timeoutMs: toolTimeoutMs });
        const out = stdout || stderr || (exitCode === 0 ? "Clean" : `git status failed: ${exitCode}`);
        return { success: exitCode === 0, output: out };
      }
      case "git_diff": {
        const repoPath = args.path ? resolve(cwd, String(args.path)) : cwd;
        const gitDiffWrErr = checkWorkspaceRoots(args.path ? String(args.path) : ".", cwd, workspaceRoots);
        if (gitDiffWrErr) return { success: false, error: gitDiffWrErr };
        const ref = typeof args.ref === "string" && args.ref.trim() ? args.ref.trim() : "";
        const cmd = ref ? `git diff --no-color ${ref}` : "git diff --no-color";
        const { stdout, stderr, exitCode } = await runSandboxedCommand(cmd, policy, { cwd: repoPath, timeoutMs: toolTimeoutMs });
        const out = stdout || stderr || "";
        return { success: exitCode <= 1, output: out || "(no diff)", error: exitCode > 1 ? stderr || `git diff exited ${exitCode}` : undefined };
      }
      case "git_commit": {
        const repoPath = args.path ? resolve(cwd, String(args.path)) : cwd;
        const gitCommitWrErr = checkWorkspaceRoots(args.path ? String(args.path) : ".", cwd, workspaceRoots);
        if (gitCommitWrErr) return { success: false, error: gitCommitWrErr };
        const message = String(args.message ?? "").trim();
        if (!message) return { success: false, error: "message is required" };
        const escaped = message.replace(/"/g, '\\"');
        const { stdout, stderr, exitCode } = await runSandboxedCommand(`git commit -m "${escaped}"`, policy, { cwd: repoPath });
        const out = [stdout, stderr].filter(Boolean).join("\n").trim();
        const commitResult: ToolResult = { success: exitCode === 0, output: out || (exitCode === 0 ? "Committed" : ""), error: exitCode !== 0 ? out || "git commit failed" : undefined };
        return cacheWriteResult(options?.idempotencyKey, commitResult);
      }
      case "web_fetch": {
        const url = String(args.url ?? "");
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
          return { success: false, error: "Invalid URL" };
        }
        const res = await fetch(url, { signal: AbortSignal.timeout(toolTimeoutMs) });
        const text = await res.text();
        return { success: res.ok, output: text.slice(0, 50_000), error: !res.ok ? `HTTP ${res.status}` : undefined };
      }
      case "web_search": {
        const apiKey = process.env.SERPER_API_KEY;
        if (!apiKey) {
          return { success: false, error: "web_search requires SERPER_API_KEY (get one at https://serper.dev). Or use an MCP search server with gtd mcp tools." };
        }
        const query = String(args.query ?? "").trim();
        if (!query) return { success: false, error: "query is required" };
        try {
          const res = await fetch("https://google.serper.dev/search", {
            method: "POST",
            headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
            body: JSON.stringify({ q: query }),
            signal: AbortSignal.timeout(toolTimeoutMs),
          });
          const data = (await res.json()) as { organic?: Array<{ title?: string; snippet?: string; link?: string }> };
          const organic = data.organic ?? [];
          const lines = organic.slice(0, 10).map((o, i) => `${i + 1}. ${o.title ?? ""}\n   ${o.snippet ?? ""}\n   ${o.link ?? ""}`);
          return { success: res.ok, output: lines.join("\n\n") || "No results", error: !res.ok ? `HTTP ${res.status}` : undefined };
        } catch (e) {
          return { success: false, error: e instanceof Error ? e.message : String(e) };
        }
      }
      case "sample_tabular": {
        const pathArg = String(args.path ?? "");
        const wrErr = checkWorkspaceRoots(pathArg, cwd, workspaceRoots);
        if (wrErr) return { success: false, error: wrErr };
        const pathResolved = resolve(cwd, pathArg);
        if (!checkPathPermission(pathResolved, policy, "read")) {
          return { success: false, error: `Path denied: ${pathResolved}` };
        }
        const maxRows = typeof args.max_rows === "number" && args.max_rows >= 1 ? Math.min(Math.floor(args.max_rows), 500) : 30;
        try {
          const rl = createInterface({ input: createReadStream(pathResolved, { encoding: "utf-8" }), crlfDelay: Infinity });
          const lines: string[] = [];
          let total = 0;
          for await (const line of rl) {
            total++;
            if (lines.length < maxRows) lines.push(line);
          }
          const sample = lines.join("\n");
          const summary = `Total lines: ${total}. Showing first ${lines.length} line(s).\n\n${sample}`;
          return { success: true, output: summary };
        } catch (e) {
          return { success: false, error: e instanceof Error ? e.message : String(e) };
        }
      }
      case "browser_screenshot": {
        const url = String(args.url ?? "");
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
          return { success: false, error: "Invalid URL" };
        }
        const action = (args.action as string) ?? "text";
        try {
          const playwright = await import("playwright").catch(() => null);
          if (!playwright) {
            return { success: false, error: "Browser automation requires Playwright. Install with: npm install playwright" };
          }
          const browser = await playwright.chromium.launch({ headless: true });
          try {
            const page = await browser.newPage();
            await page.goto(url, { waitUntil: "domcontentloaded", timeout: toolTimeoutMs });
            if (action === "screenshot") {
              const outPath = resolve(cwd, `screenshot-${Date.now()}.png`);
              await page.screenshot({ path: outPath });
              return { success: true, output: `Screenshot saved: ${outPath}` };
            }
            const text = (await page.evaluate("document.body ? document.body.innerText : ''")) as string;
            return { success: true, output: text.slice(0, 50_000) };
          } finally {
            await browser.close();
          }
        } catch (e) {
          return { success: false, error: e instanceof Error ? e.message : String(e) };
        }
      }
      case "mcp_call": {
        const serverId = String(args.server_id ?? "").trim();
        const toolName = String(args.tool_name ?? "").trim();
        const toolArgs = (args.arguments && typeof args.arguments === "object" && !Array.isArray(args.arguments))
          ? (args.arguments as Record<string, unknown>)
          : {};
        if (!serverId || !toolName) {
          return { success: false, error: "server_id and tool_name are required" };
        }
        const { getMcpServer } = await import("../mcp/store.js");
        const { callMcpTool } = await import("../mcp/client.js");
        const server = await getMcpServer(serverId);
        if (!server) {
          return { success: false, error: `MCP server ${serverId} not found. Run 'gtd mcp list' to see registered servers.` };
        }
        const result = await callMcpTool(server, toolName, toolArgs);
        if (result.success) {
          return { success: true, output: result.output ?? "OK" };
        }
        return { success: false, error: result.error ?? "MCP tool call failed" };
      }
      default:
        return { success: false, error: `Tool ${toolName} not implemented` };
    }
    }, toolRetryOptions());
    if (result && !result.requiresApproval) {
      logToolCall({
        tool: toolName,
        category: def.category,
        outcome: result.success ? "success" : "failure",
        error: result.error,
        argsSummary: argsSummary(),
      });
    }
    result.riskLevel = result.riskLevel ?? getDefaultRiskLevel(toolName, def.category);
    return result;
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    logToolCall({ tool: toolName, category: def.category, outcome: "failure", error: err, argsSummary: argsSummary() });
    return { success: false, error: err, riskLevel: getDefaultRiskLevel(toolName, def.category) };
  }
}

/**
 * List available tools for model context.
 * When toolChoice is "read_only", returns only tools with category "read" (CC-16).
 */
export function listTools(options?: { toolChoice?: string }): ToolDefinition[] {
  const all = [...TOOL_DEFINITIONS];
  if (options?.toolChoice === "read_only") {
    return all.filter((t) => t.category === "read");
  }
  return all;
}
