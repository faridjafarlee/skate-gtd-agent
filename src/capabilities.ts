/**
 * Capability introspection for parity tracking.
 * Expose implemented feature flags and maturity for `gtd capabilities`.
 */

export type ParityLevel = "exact" | "close" | "partial" | "missing";

export interface Capability {
  id: string;
  name: string;
  enabled: boolean;
  parity: ParityLevel;
  /** Short description */
  description?: string;
}

export interface Capabilities {
  version: string;
  capabilities: Capability[];
}

export function getCapabilities(version: string): Capabilities {
  return {
    version,
    capabilities: [
      { id: "interactive", name: "Interactive REPL", enabled: true, parity: "close", description: "gtd interactive / repl; optional blessed TUI with suggestions, recent tasks, MCP tools panel; REPL history in ~/.skate/repl-history" },
      { id: "one-shot", name: "One-shot / headless", enabled: true, parity: "close", description: "gtd task" },
      { id: "resume", name: "Resume / continue", enabled: true, parity: "close", description: "gtd retry, gtd approve" },
      { id: "session-fork", name: "Session forking", enabled: true, parity: "close", description: "gtd session fork" },
      { id: "session-list", name: "Session list/resume", enabled: true, parity: "close", description: "gtd session list" },
      { id: "json-stream", name: "JSON / stream output", enabled: true, parity: "close", description: "--format json, --stream" },
      { id: "token-budget", name: "Max turns / token budget", enabled: true, parity: "close", description: "--max-turns, --max-tokens, --timeout" },
      { id: "plan-mode", name: "Plan mode (read-only)", enabled: true, parity: "close", description: "--dry-run" },
      { id: "plan-json", name: "Plan as JSON", enabled: true, parity: "exact", description: "--dry-run --format json, --plan-format json" },
      { id: "permission-modes", name: "Permission modes", enabled: true, parity: "close", description: "default, plan, accept-edits, dont-ask, bypass; aliases acceptEdits, dontAsk, bypassPermissions" },
      { id: "sandbox", name: "Policy-enforced sandbox", enabled: true, parity: "close", description: "Policy + bwrap (GTD_USE_BWRAP=1) or macOS sandbox-exec (GTD_USE_SANDBOX=1)" },
      { id: "per-tool-policy", name: "Per-tool/per-path policy", enabled: true, parity: "close", description: "policy.toolOverrides, allowedPaths, deniedPaths" },
      { id: "file-tools", name: "File read/edit/write", enabled: true, parity: "close", description: "read_file, write_file, edit_file, apply_patch" },
      { id: "shell-tools", name: "Shell / bash", enabled: true, parity: "close", description: "gtd tools run run_command" },
      { id: "git-tools", name: "Git tools", enabled: true, parity: "close", description: "git_status, git_diff, git_commit (Builder)" },
      { id: "web-tools", name: "Web fetch / search", enabled: true, parity: "close", description: "web_fetch, web_search (Serper when SERPER_API_KEY set)" },
      { id: "browser-tools", name: "Browser automation", enabled: true, parity: "close", description: "browser_screenshot (Playwright optional)" },
      { id: "model-tool-calls", name: "Model-invoked tool calls", enabled: true, parity: "close", description: "Builder uses runAgentWithTools (OpenAI, Anthropic, Gemini)" },
      { id: "project-memory", name: "Project memory (MEMORY.md)", enabled: true, parity: "close", description: "gtd memory project, loadProjectMemory in orchestration" },
      { id: "structured-memory", name: "Structured memory store", enabled: true, parity: "close", description: "gtd memory list/get/set" },
      { id: "mode-profiles", name: "Mode profiles", enabled: true, parity: "close", description: "gtd mode list/use/export/import, presets for quality/model/permission" },
      { id: "rules", name: "Rules / instructions", enabled: true, parity: "close", description: ".gtd/rules.md, RULES.md, templates" },
      { id: "semantic-index", name: "Semantic index / RAG", enabled: true, parity: "close", description: "GTD_RAG_ENABLED=1, indexChunks/retrieve in memory context" },
      { id: "session-compaction", name: "Session compaction", enabled: true, parity: "close", description: "GTD_SESSION_COMPACT=1 truncation, summarize for LLM" },
      { id: "mcp", name: "MCP server management", enabled: true, parity: "close", description: "gtd mcp list/register/test/remove/tools/resources" },
      { id: "mcp-tool-invocation", name: "MCP tool invocation in Builder", enabled: true, parity: "close", description: "Builder can call tools from registered MCP servers" },
      { id: "plugin-sdk", name: "Plugin SDK / manifest", enabled: true, parity: "close", description: "gtd plugins list/validate, schemas/plugin.schema.json" },
      { id: "connectors", name: "Chat connectors", enabled: true, parity: "close", description: "Telegram, Slack, Discord, etc." },
      { id: "webhook", name: "Webhook", enabled: true, parity: "exact" },
      { id: "multi-agent", name: "Multi-agent pipeline", enabled: true, parity: "close", description: "Scout→Planner→Builder→Reviewer→Documenter" },
      { id: "parallel-steps", name: "Parallel steps", enabled: true, parity: "close", description: "Reviewer+Documenter" },
      { id: "resume-from-step", name: "Resume from step", enabled: true, parity: "exact", description: "gtd retry --from-step" },
      { id: "step-timeout", name: "Per-step timeout", enabled: true, parity: "close", description: "gtd task --step-timeout, GTD_STEP_TIMEOUT_MS" },
      { id: "idempotent-save", name: "Task save conflict handling", enabled: true, parity: "close", description: "Optimistic concurrency (updatedAt), TaskConflictError on conflict" },
      { id: "custom-agents", name: "Custom agent roles", enabled: true, parity: "close", description: "config.agents" },
      { id: "cost-tracking", name: "Cost / token tracking", enabled: true, parity: "close", description: "gtd usage, gtd usage --by-task, gtd show <id> usage/cost; GTD_TASK_COST_CAP to stop when cap reached; gtd models usage with est. cost" },
      { id: "doctor", name: "Health / diagnostics", enabled: true, parity: "close", description: "gtd doctor (config, data dir, models, MCP, env, --ping-models)" },
      { id: "retries", name: "Retries / backoff", enabled: true, parity: "close", description: "GTD_RETRY_LLM_MAX, GTD_RETRY_TOOLS_MAX, exponential backoff" },
      { id: "audit-log", name: "Persistent audit log", enabled: true, parity: "close", description: "gtd audit list, JSONL with trace IDs" },
      { id: "telemetry", name: "Metrics and usage telemetry", enabled: true, parity: "close", description: "gtd telemetry list, step latency, token usage" },
      { id: "git-workflows", name: "Git-native workflows", enabled: true, parity: "close", description: "gtd git worktree, branch, diff, status, pr create, pr status; GITHUB_TOKEN/GH_TOKEN" },
      { id: "managed-settings", name: "Managed settings", enabled: true, parity: "close", description: "gtd config lock/unlock" },
      { id: "review-queue", name: "Review queue", enabled: true, parity: "close", description: "gtd review" },
      { id: "session-handoff", name: "Session handoff", enabled: true, parity: "close", description: "gtd session handoff" },
      { id: "run-replay", name: "Run replay", enabled: true, parity: "close", description: "gtd replay <id> — timeline of audit + telemetry" },
      { id: "policy-bundles", name: "Policy bundles", enabled: true, parity: "close", description: "GTD_POLICY_BUNDLE, loadPolicyBundle" },
      { id: "secrets-check", name: "Secrets hygiene", enabled: true, parity: "close", description: "gtd governance secrets-check" },
      { id: "org-restrictions", name: "Org-level restrictions", enabled: true, parity: "close", description: "org.json / GTD_ORG_CONFIG, gtd org list/use, gtd governance org" },
      { id: "extension-hook", name: "Extension hook", enabled: true, parity: "close", description: "GTD_EXTENSION_SCRIPT on task start/end" },
      { id: "named-modes", name: "Named task modes", enabled: true, parity: "close", description: "gtd task --mode architect|debug|ask|orchestrator" },
      { id: "dont-ask-again", name: "Don't ask again (session/project)", enabled: true, parity: "close", description: "Session allow list + .gtd/allow.json" },
      { id: "container-run", name: "Containerized task run", enabled: true, parity: "close", description: "gtd task --container, GTD_USE_CONTAINER, GTD_CONTAINER_IMAGE" },
      { id: "plugin-run", name: "Plugin command execution", enabled: true, parity: "close", description: "gtd plugins run <pluginId> <commandId>; docs/parity/plugin-execution.md with example" },
      { id: "plugin-hooks", name: "Plugin beforeTask/afterTask hooks", enabled: true, parity: "close", description: "Manifest hooks run before/after pipeline; GTD_PLUGINS_DIR, GTD_PLUGIN_HOOK_TIMEOUT_MS" },
      { id: "mcp-resource-read", name: "MCP resource read", enabled: true, parity: "close", description: "gtd mcp read-resource <id> <uri>" },
      { id: "last-run", name: "Last run summary", enabled: true, parity: "close", description: "gtd last" },
      { id: "health-endpoint", name: "Health endpoint", enabled: true, parity: "close", description: "GET /health when gtd serve (HEALTH_PORT); webhook /health" },
      { id: "parallel-worktrees", name: "Parallel worktrees", enabled: true, parity: "close", description: "gtd run-parallel --worktrees" },
      { id: "planner-subtasks", name: "Planner structured subtasks", enabled: true, parity: "close", description: "Parse JSON subtasks from Planner output; --dry-run --format json" },
      { id: "cost-cap", name: "Per-task cost cap", enabled: true, parity: "close", description: "GTD_TASK_COST_CAP (USD); task stops when estimated cost reaches cap" },
      { id: "workspace-roots", name: "Workspace roots (monorepo)", enabled: true, parity: "close", description: "GTD_WORKSPACE_ROOTS; file/git tools restricted to paths under roots" },
      { id: "planner-templates", name: "Planner templates", enabled: true, parity: "close", description: "gtd task \"...\" --template fix-bug | add-feature | refactor" },
      { id: "handoff-import", name: "Handoff bundle import", enabled: true, parity: "close", description: "gtd session handoff-import <file>; then gtd retry <id>; bundle schema in session-handoff.md" },
      { id: "json-contract", name: "JSON output contract", enabled: true, parity: "close", description: "Guaranteed fields for full-task and dry-run --format json; docs/parity/print-json-scriptability.md" },
    ],
  };
}
