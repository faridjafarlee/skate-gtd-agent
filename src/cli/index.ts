#!/usr/bin/env node

import { createRequire } from "module";
import { join, isAbsolute, resolve, extname } from "path";
import { program } from "commander";

const require = createRequire(import.meta.url);
const pkg = require("../../package.json") as { name?: string; version: string; description?: string };
import chalk from "chalk";
import { v4 as uuidv4 } from "uuid";
import { renderBanner } from "./banner.js";
import { listModels, getModel, enableModel, disableModel, routeForTask, getEnabledModelIds } from "./../core/models/index.js";
import { runOrchestration } from "./../orchestrator/loop.js";
import { saveTask, listTasks, getTask, toStored, importTasks, searchTasks, getUsageSummary, deleteTask, getDataDir, TaskConflictError } from "./../storage/store.js";
import {
  loadAuthEnvSync,
  saveAuthCredential,
  clearAuthCredentials,
  getSetProviderKeys,
  hasStoredAuthFile,
  getAuthEnvPath,
  PROVIDER_ENV_KEYS,
} from "../storage/auth-credentials.js";
import { estimateCost, estimateTaskCost, formatEstimatedCost } from "./../core/cost.js";
import { loadAndApplyModelsConfig, persistModelsConfig } from "./../storage/models-config.js";
import { loadConfig, saveConfig, resetConfig, getMergedTemplates, setConfigLock, loadOrgRestrictions, normalizePermissionMode, listOrgIds, getActiveConfigPath, getConfigDir, loadConfigForCwd } from "./../storage/config.js";
import { audit } from "./../security/audit.js";
import { ping as pingModel } from "./../core/llm/client.js";
import { backup as doBackup, restore as doRestore } from "./../storage/backup.js";
import { requestCancel } from "./../storage/cancel.js";
import { runTask, approveTask, shortTaskId } from "./task-handler.js";
import { formatVerifyForModel } from "./verify.js";
import { parseCodeBlocks, writeCodeBlocks } from "./../agents/file-writer.js";
import { startTelegramBot } from "./../connectors/telegram.js";
import { startSlackBot } from "./../connectors/slack.js";
import { startWhatsAppBot } from "./../connectors/whatsapp.js";
import { startSignalBot } from "./../connectors/signal.js";
import { startDiscordBot } from "./../connectors/discord.js";
import { startWebhookServer } from "./../connectors/webhook.js";
import { startEmailConnector } from "./../connectors/email.js";
import { startMatrixBot } from "./../connectors/matrix.js";
import { getCapabilities } from "../capabilities.js";
import { streamSubscribe, streamEmit } from "../api/task-stream.js";
import { listTools, executeTool } from "../tools/runtime.js";
import { resolvePolicy, loadPolicyBundle } from "../security/policy.js";
import { getSandboxMechanism, loadSandboxProfileFromProject, getSandboxExtraReadDirs, addSandboxExtraReadDir } from "../security/sandbox.js";
import { platform } from "os";
import { getSessionAllow, loadProjectAllow, addToSessionAllow, addToProjectAllow } from "../security/allow-list.js";
import { checkConfigSecrets } from "../governance/secrets.js";
import { getMemoryEntries, setMemoryEntry, getMemoryEntry, deleteMemoryEntry, loadProjectMemory, loadProjectRules, loadProjectRulesFromConfig, loadGlobalRules, isPathIgnored, appendProjectMemory, trimProjectMemory, getProjectMemoryPath } from "../memory/store.js";
import { buildRepoMap } from "../memory/repo-map.js";
import { listModes, getMode, setMode, getActiveMode, setActiveMode } from "../modes/store.js";
import { listMcpServers, getMcpServer, registerMcpServer, removeMcpServer } from "../mcp/store.js";
import { testMcpServer, listMcpTools, listMcpResources, readMcpResource } from "../mcp/client.js";
import { runGtdMcpServer } from "../mcp/gtd-server.js";
import type { McpServerConfig } from "../mcp/store.js";
import { loadPluginManifest, discoverPlugins, discoverPluginsWithPaths } from "../plugins/loader.js";
import { getAuditLog, getAuditLogByTaskId } from "../audit/events.js";
import { getMetrics, getMetricsByTaskId } from "../telemetry/metrics.js";
import { createWorktree, createBranch, getCurrentBranch, getDiffStats, isGitRepo, createPr, prStatus, createBranchAndPr } from "../git/workflows.js";
import {
  hasDirtyFiles,
  commitAll,
  getLastCommit,
  isAgentCommit,
  undoLastCommit,
  runGitCommand,
  generateCommitMessage,
} from "../git/auto-commit.js";

loadAuthEnvSync();

function collectTag(val: string, memo: string[]): string[] {
  return (memo ?? []).concat(val);
}

function collectConfig(val: string, memo: string[]): string[] {
  return (memo ?? []).concat(val);
}

/** Human-readable duration (e.g. "2m 30s", "1h 5m 0s"). */
function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const s = Math.floor(ms / 1000) % 60;
  const m = Math.floor(ms / 60000) % 60;
  const h = Math.floor(ms / 3600000);
  const parts: string[] = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(" ");
}

/** A.5: Restricted env for plugin run — no GTD_* secrets unless allowlisted. */
function buildPluginRunEnv(pluginId: string, pluginPath: string, commandId: string): Record<string, string> {
  const allowExtra = (process.env.GTD_PLUGIN_ENV_ALLOW ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const allowedGtd = new Set(["GTD_PLUGIN_ID", "GTD_PLUGIN_PATH", "GTD_COMMAND_ID", "GTD_DATA_DIR", "GTD_PLUGINS_DIR", ...allowExtra]);
  const secretLike = /(?:api[_-]?key|secret|token|password|auth|credential)/i;
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k.startsWith("GTD_")) {
      if (allowedGtd.has(k) && !secretLike.test(k)) env[k] = v;
      continue;
    }
    if (secretLike.test(k) || k.endsWith("_API_KEY") || k.endsWith("_TOKEN")) continue;
    env[k] = v;
  }
  env.GTD_PLUGIN_ID = pluginId;
  env.GTD_PLUGIN_PATH = pluginPath;
  env.GTD_COMMAND_ID = commandId;
  if (process.env.GTD_DATA_DIR) env.GTD_DATA_DIR = process.env.GTD_DATA_DIR;
  return env;
}

program
  .name("skate")
  .description("Skate — GTD. Agent orchestration CLI")
  .version(pkg.version);

program
  .command("version")
  .description("Show version")
  .option("-f, --format <fmt>", "Output format: text | json", "text")
  .action(async function (this: { opts: () => { format?: string } }) {
    const opts = this.opts();
    const format = (opts.format ?? "text").toLowerCase();
    if (format === "json") {
      console.log(JSON.stringify({ version: pkg.version }, null, 2));
    } else {
      console.log(pkg.version);
    }
  });

program
  .command("about")
  .description("Show version and short info (for bug reports and IDE integration)")
  .option("-f, --format <fmt>", "Output format: text | json", "text")
  .action(async function (this: { opts: () => { format?: string } }) {
    const opts = this.opts();
    const format = (opts.format ?? "text").toLowerCase();
    if (format === "json") {
      console.log(JSON.stringify({ name: pkg.name, version: pkg.version, description: pkg.description }, null, 2));
    } else {
      console.log(`${pkg.name} ${pkg.version}`);
      console.log(pkg.description ?? "Precision orchestration CLI");
      console.log(chalk.dim("Share this when filing issues. Full health: gtd doctor"));
    }
  });

program
  .command("completion [shell]")
  .description("Print shell completion script (bash, zsh). Source in profile or run: gtd completion zsh >> ~/.zshrc")
  .action((shell: string | undefined) => {
    const cmds = program.commands.filter((c) => !c.name().startsWith(":")).map((c) => c.name());
    const list = [...new Set(cmds)].sort().join(" ");
    const s = (shell ?? process.env.SHELL ?? "").toLowerCase();
    if (s.includes("zsh") || (shell && shell.toLowerCase() === "zsh")) {
      console.log(`# gtd completion (zsh)\ncompdef _gtd gtd\n_gtd() { _values 'gtd' ${list.split(" ").map((x) => `"${x}"`).join(" ")} }`);
    } else {
      console.log(`# gtd completion (bash)\n_gtd() { COMPREPLY=($(compgen -W "${list}" -- "\${COMP_WORDS[COMP_CWORD]}")); }\ncomplete -F _gtd gtd`);
    }
  });

program
  .command("privacy")
  .description("Show privacy notice and telemetry consent (Gemini-style /privacy)")
  .action(() => {
    console.log(chalk.bold("Privacy"));
    console.log("  Skate runs tasks locally. Task descriptions, file paths, and tool outputs are sent to configured LLM providers (e.g. OpenAI, Anthropic) when you run a task.");
    console.log("  Telemetry: set GTD_TELEMETRY=0 to disable, or see docs for consent and data retention.");
    console.log(chalk.dim("  Config and data dir: gtd config path; gtd doctor for env summary."));
  });

program
  .command("setup")
  .description("First-run or on-demand wizard: configure provider, default model, quality profile (Calliope-style)")
  .option("-y, --yes", "Use defaults without prompting (write config if missing)")
  .action(async (opts: { yes?: boolean }) => {
    console.log(renderBanner());
    const configPath = getActiveConfigPath();
    const configDir = getConfigDir();
    console.log(chalk.dim("Config directory: " + configDir));
    console.log(chalk.dim("Active config:   " + configPath + (process.env.GTD_ENV ? " (GTD_ENV=" + process.env.GTD_ENV + ")" : "") + "\n"));
    let cfg = await loadConfig();
    const isNew = !cfg.defaultModel && cfg.qualityProfile === "balanced" && cfg.approvalPolicy === "hybrid";
    if (opts.yes) {
      if (isNew) {
        await saveConfig({ qualityProfile: "balanced", approvalPolicy: "hybrid" });
        console.log(chalk.green("Config initialized with defaults. Run gtd models enable <id> and gtd config set defaultModel <id> to set a model."));
      }
      return;
    }
    const { createInterface } = await import("readline");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const question = (q: string) => new Promise<string>((resolve) => rl.question(q, (a) => resolve((a ?? "").trim())));
    try {
      const providers = ["anthropic", "openai", "google", "ollama"];
      const provList = providers.join(", ");
      const p = await question(`Provider (${provList}, or skip) [skip]: `);
      const provider = p.toLowerCase() || "skip";
      if (provider !== "skip" && !providers.includes(provider)) {
        console.log(chalk.yellow("Unknown provider. Run gtd auth login -p <provider> to set API key, then gtd config set defaultModel <id>."));
        rl.close();
        return;
      }
      if (provider !== "skip") {
        console.log(chalk.dim("Set API key: gtd auth login -p " + provider + " (or set " + (provider === "openai" ? "OPENAI_API_KEY" : provider === "anthropic" ? "ANTHROPIC_API_KEY" : provider === "google" ? "GOOGLE_AI_API_KEY" : "OLLAMA") + " in env)."));
      }
      const models = listModels();
      const byProvider = provider !== "skip" ? models.filter((m) => m.metadata.provider === provider) : models;
      const enabled = byProvider.filter((m) => m.enabled);
      const modelIds = (enabled.length ? enabled : byProvider).map((m) => m.metadata.id).slice(0, 8);
      const modelList = modelIds.join(", ");
      const m = await question(`Default model (${modelList}, or id) [${cfg.defaultModel ?? "none"}]: `);
      const defaultModel = m || cfg.defaultModel;
      if (defaultModel && defaultModel !== "none") {
        const q = await question("Quality profile (fast | balanced | max) [balanced]: ");
        const qualityProfile = (q || "balanced") as "fast" | "balanced" | "max";
        if (!["fast", "balanced", "max"].includes(qualityProfile)) {
          console.log(chalk.yellow("Using balanced."));
          cfg = { ...cfg, defaultModel: defaultModel, qualityProfile: "balanced" };
        } else {
          cfg = { ...cfg, defaultModel: defaultModel, qualityProfile };
        }
      } else {
        cfg = { ...cfg, defaultModel: undefined };
      }
      await saveConfig({ defaultModel: cfg.defaultModel, qualityProfile: cfg.qualityProfile });
      console.log(chalk.green("\nConfig saved."));
      if (cfg.defaultModel) {
        const found = getModel(cfg.defaultModel);
        if (found && !found.enabled) {
          const enable = await question("Enable model " + cfg.defaultModel + "? (y/n) [y]: ");
          if (enable.toLowerCase() !== "n") {
            enableModel(cfg.defaultModel);
            await persistModelsConfig();
            console.log(chalk.green("Model enabled."));
          }
        }
      }
      console.log(chalk.dim("Config file: " + configPath));
    } finally {
      rl.close();
    }
  });

const authCmd = program
  .command("auth")
  .description("Login / logout (store API keys in data dir; loaded at CLI startup)");

authCmd
  .command("login")
  .description("Store API key for a provider (openai, anthropic, google). Keys saved to data dir and loaded on next gtd run.")
  .option("-p, --provider <name>", "Provider: openai | anthropic | google", "openai")
  .option("--key-from-stdin", "Read API key from stdin (no prompt)")
  .action(async function (this: { opts: () => { provider?: string; keyFromStdin?: boolean } }) {
    const opts = this.opts();
    const provider = (opts.provider ?? "openai").toLowerCase().trim();
    const envKey = PROVIDER_ENV_KEYS[provider] ?? (provider === "openai" ? "OPENAI_API_KEY" : provider === "anthropic" ? "ANTHROPIC_API_KEY" : "GOOGLE_AI_API_KEY");
    let key: string;
    if (opts.keyFromStdin) {
      const { createInterface } = await import("readline");
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const line = await new Promise<string>((resolve) => rl.once("line", (l) => resolve(l)));
      rl.close();
      key = line.trim();
    } else {
      const { createInterface } = await import("readline");
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      key = await new Promise<string>((resolve) => {
        rl.question(`Enter ${envKey} (input hidden): `, (k) => { rl.close(); resolve(k.trim()); });
      });
    }
    if (!key) {
      console.error(chalk.red("No key provided."));
      process.exitCode = 1;
      return;
    }
    await saveAuthCredential(envKey, key);
    console.log(chalk.green(`Saved ${envKey} to ${getAuthEnvPath()}. Keys are loaded on next gtd run.`));
  });

authCmd
  .command("logout")
  .description("Remove stored API keys (delete env file in data dir)")
  .action(async () => {
    const removed = await clearAuthCredentials();
    if (removed) {
      console.log(chalk.green("Logged out. Stored keys removed from " + getAuthEnvPath()));
      console.log(chalk.dim("Current process still has env vars. Open a new terminal or unset OPENAI_API_KEY ANTHROPIC_API_KEY GOOGLE_AI_API_KEY."));
    } else {
      console.log(chalk.dim("No stored credentials to remove. Keys may be in environment only."));
    }
  });

authCmd
  .command("status")
  .description("Show which API keys are set (from env or stored file)")
  .action(() => {
    const set = getSetProviderKeys();
    const fromFile = hasStoredAuthFile();
    if (set.length === 0) {
      console.log(chalk.dim("No API keys set. Run: gtd auth login (or set OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_AI_API_KEY in env)."));
      return;
    }
    console.log(chalk.cyan("API keys set: ") + set.join(", "));
    if (fromFile) console.log(chalk.dim("Stored file: " + getAuthEnvPath()));
  });

program
  .command("capabilities")
  .description("Show implemented feature flags and parity maturity")
  .option("-f, --format <fmt>", "Output format: text | json", "text")
  .action(async function (this: { opts: () => { format?: string } }) {
    const opts = this.opts();
    const format = (opts.format ?? "text").toLowerCase();
    const caps = getCapabilities(pkg.version);
    if (format === "json") {
      console.log(JSON.stringify(caps, null, 2));
      return;
    }
    console.log(renderBanner());
    console.log(`\nCapabilities (version ${caps.version}):\n`);
    const enabled = caps.capabilities.filter((c) => c.enabled);
    const disabled = caps.capabilities.filter((c) => !c.enabled);
    if (enabled.length > 0) {
      console.log(chalk.green("Enabled:"));
      for (const c of enabled) {
        const parity = c.parity === "exact" ? chalk.green(c.parity) : c.parity === "close" ? chalk.cyan(c.parity) : chalk.yellow(c.parity);
        console.log(`  ${chalk.cyan(c.id)} ${parity} ${c.description ?? c.name}`);
      }
    }
    if (disabled.length > 0) {
      console.log(chalk.dim("\nNot yet implemented:"));
      for (const c of disabled.slice(0, 12)) {
        console.log(`  ${chalk.dim(c.id)} ${c.parity} ${c.name}`);
      }
      if (disabled.length > 12) {
        console.log(chalk.dim(`  ... and ${disabled.length - 12} more`));
      }
    }
  });

const toolsCmd = program
  .command("tools")
  .description("List and run tools (file, shell, git, web)");

toolsCmd
  .command("list")
  .description("List available tools")
  .option("-f, --format <fmt>", "Output format: text | json", "text")
  .action(async function (this: { opts: () => { format?: string } }) {
    const opts = this.opts();
    const format = (opts.format ?? "text").toLowerCase();
    const tools = listTools();
    if (format === "json") {
      console.log(JSON.stringify({ tools }, null, 2));
      return;
    }
    console.log(renderBanner());
    console.log("\nAvailable tools:");
    for (const t of tools) {
      console.log(`  ${chalk.cyan(t.name)} (${t.category}) - ${t.description}`);
    }
  });

toolsCmd
  .command("run <name> [argsJson]")
  .description("Run a tool. Args as JSON, e.g. {\"path\":\"file.txt\"} for read_file. Example: gtd tools run read_file '{\"path\":\"file.txt\"}' -m dont-ask")
  .option("-m, --mode <mode>", "Permission mode: default | plan | accept-edits | dont-ask | bypass (aliases: acceptEdits, dontAsk, bypassPermissions). Example: -m dont-ask", "dont-ask")
  .option("-f, --format <fmt>", "Output format: text | json", "text")
  .addHelpText("after", `
Permission modes (-m / --mode):
  default       Ask before running tools
  plan          Read-only; no file/shell writes
  accept-edits  Accept file edits without prompt
  dont-ask      No prompts (use session + project allow list)
  bypass        Skip policy checks
Tool categories: read (read_file), edit (write_file, edit_file, apply_patch), bash (run_command), git, network.`)
  .action(async function (this: { opts: () => { mode?: string; format?: string } }, name: string, argsJson?: string) {
    const opts = this.opts();
    let args: Record<string, unknown> = {};
    if (argsJson) {
      try {
        args = JSON.parse(argsJson) as Record<string, unknown>;
      } catch {
        console.log(chalk.red("Invalid JSON args"));
        process.exitCode = 1;
        return;
      }
    }
    const bundlePath = process.env.GTD_POLICY_BUNDLE;
    const bundle = bundlePath ? await loadPolicyBundle(bundlePath) : null;
    const policy = resolvePolicy(
      { mode: normalizePermissionMode(opts.mode ?? "dont-ask") ?? "dont-ask" },
      bundle
    );
    const format = (opts.format ?? "text").toLowerCase();
    const result = await executeTool(name, args, policy);
    if (format === "json") {
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.success ? 0 : 1;
      return;
    }
    if (result.success) {
      if (result.output) console.log(result.output);
    } else {
      console.log(chalk.red(result.error ?? "Tool failed"));
      process.exitCode = 1;
    }
  });

program
  .command("permission-modes")
  .description("List permission modes (machine-readable for agents)")
  .option("-f, --format <fmt>", "Output format: text | json", "json")
  .action(async function (this: { opts: () => { format?: string } }) {
    const opts = this.opts();
    const modes = [
      { id: "default", description: "Ask before running tools", tier: "ask" },
      { id: "plan", description: "Read-only; no file/shell writes", tier: "read" },
      { id: "accept-edits", description: "Accept file edits without prompt", tier: "edit" },
      { id: "dont-ask", description: "No prompts (use allow list)", tier: "allow" },
      { id: "bypass", description: "Skip policy checks", tier: "bypass" },
    ];
    const format = (opts.format ?? "json").toLowerCase();
    if (format === "json") {
      console.log(JSON.stringify({ permissionModes: modes, aliases: { acceptEdits: "accept-edits", dontAsk: "dont-ask", bypassPermissions: "bypass" } }, null, 2));
    } else {
      console.log("Permission modes:");
      modes.forEach((m) => console.log(`  ${m.id} (${m.tier}): ${m.description}`));
    }
  });

const sessionCmd = program
  .command("session")
  .description("Session primitives (list, fork, id)");

sessionCmd
  .command("id")
  .description("Print session id (GTD_SESSION_ID if set, else a new UUID for this invocation)")
  .action(() => {
    const id = process.env.GTD_SESSION_ID ?? uuidv4();
    console.log(id);
  });

sessionCmd
  .command("list")
  .description("List resumable sessions (recent tasks)")
  .option("-n, --limit <n>", "Max sessions", "20")
  .option("-f, --format <fmt>", "Output format: text | json", "text")
  .action(async function (this: { opts: () => { limit?: string; format?: string } }) {
    const opts = this.opts();
    const limit = parseInt(opts.limit ?? "20", 10) || 20;
    const tasks = await listTasks({ limit });
    const format = (opts.format ?? "text").toLowerCase();
    if (format === "json") {
      console.log(JSON.stringify({ sessions: tasks.map((t) => ({ id: t.id, taskId: t.id, description: t.description, status: t.status, createdAt: t.createdAt })) }, null, 2));
      return;
    }
    console.log(renderBanner());
    console.log("\nSessions (resumable tasks):");
    for (const t of tasks) {
      const statusColor = t.status === "completed" ? chalk.green : t.status === "failed" ? chalk.red : chalk.yellow;
      console.log(`  ${chalk.cyan(t.id.slice(0, 8))} ${statusColor(t.status)} ${t.description.slice(0, 50)}${t.description.length > 50 ? "…" : ""}`);
    }
  });

sessionCmd
  .command("fork <id>")
  .description("Fork a task (create new task with same outputs up to step)")
  .option("-s, --from-step <role>", "Truncate outputs from this step", "builder")
  .option("-f, --format <fmt>", "Output format: text | json", "text")
  .action(async function (this: { opts: () => { fromStep?: string; format?: string } }, id: string) {
    const opts = this.opts();
    const format = (opts.format ?? "text").toLowerCase();
    let task = await getTask(id);
    if (!task) {
      const tasks = await listTasks({ limit: 50 });
      task = tasks.find((t) => t.id.startsWith(id) || t.id === id);
    }
    if (!task || !task.outputs || !task.plan) {
      if (format === "json") {
        console.log(JSON.stringify({ success: false, error: "Task not found or missing outputs/plan" }, null, 2));
        process.exitCode = 1;
      } else {
        console.log(chalk.red("Task not found or missing outputs/plan"));
        process.exitCode = 1;
      }
      return;
    }
    const ROLE_ORDER = ["scout", "planner", "builder", "reviewer", "documenter"];
    const fromStep = (opts.fromStep ?? "builder").toLowerCase();
    const idx = ROLE_ORDER.indexOf(fromStep);
    const keep = idx >= 0 ? ROLE_ORDER.slice(0, idx) : [];
    const forkedOutputs = Object.fromEntries(Object.entries(task.outputs).filter(([k]) => keep.includes(k)));
    const newId = uuidv4();
    const forked = toStored({
      id: newId,
      description: task.description,
      source: task.source,
      qualityProfile: task.qualityProfile,
      approvalPolicy: "auto",
      status: "pending",
      plan: task.plan,
      tags: task.tags,
      createdAt: new Date(),
    }, { outputs: forkedOutputs });
    await saveTask(forked);
    if (format === "json") {
      console.log(JSON.stringify({ success: true, taskId: newId, forkedFrom: task.id }, null, 2));
    } else {
      console.log(chalk.green(`Forked task ${shortTaskId(newId)} from ${shortTaskId(task.id)}. Run 'gtd retry ${shortTaskId(newId)}' to continue.`));
    }
  });

const cloudCmd = program
  .command("cloud")
  .description("Browse and run tasks on a remote GTD serve (set GTD_CLOUD_URL, optional GTD_CLOUD_API_KEY)");

cloudCmd
  .command("list", { isDefault: true })
  .description("List cloud tasks (default when running 'gtd cloud')")
  .option("-n, --limit <n>", "Max tasks", "20")
  .option("-s, --status <status>", "Filter by status (pending, in_progress, blocked, completed, failed, cancelled)")
  .option("-f, --format <fmt>", "Output format: text | json", "text")
  .action(async function (this: { opts: () => { limit?: string; status?: string; format?: string } }) {
    const opts = this.opts();
    const { cloudListTasks } = await import("../api/cloud-client.js");
    try {
      const limit = Math.min(50, parseInt(opts.limit ?? "20", 10) || 20);
      const { tasks } = await cloudListTasks({ limit, status: opts.status });
      const format = (opts.format ?? "text").toLowerCase();
      if (format === "json") {
        console.log(JSON.stringify({ tasks }, null, 2));
        return;
      }
      if (tasks.length === 0) {
        console.log(chalk.dim("No cloud tasks. Run: gtd cloud exec \"<description>\" to create one."));
        return;
      }
      console.log(chalk.cyan("Cloud tasks:"));
      for (const t of tasks) {
        const statusColor = t.status === "completed" ? chalk.green : t.status === "failed" ? chalk.red : chalk.yellow;
        console.log(`  ${chalk.cyan(t.id.slice(0, 8))} ${statusColor(t.status)} ${(t.description ?? "").slice(0, 50)}${(t.description ?? "").length > 50 ? "…" : ""}`);
      }
    } catch (e) {
      console.error(chalk.red(e instanceof Error ? e.message : String(e)));
      process.exitCode = 1;
    }
  });

cloudCmd
  .command("show <id>")
  .description("Show a cloud task by ID or prefix")
  .option("-f, --format <fmt>", "Output format: text | json", "text")
  .action(async function (this: { opts: () => { format?: string } }, id: string) {
    const opts = this.opts();
    const { cloudGetTask, cloudListTasks } = await import("../api/cloud-client.js");
    try {
      let taskId = id.trim();
      if (taskId.length < 36) {
        const { tasks } = await cloudListTasks({ limit: 50 });
        const match = tasks.find((t) => t.id.startsWith(taskId) || t.id === taskId);
        if (!match) {
          console.error(chalk.red("Task not found"));
          process.exitCode = 1;
          return;
        }
        taskId = match.id;
      }
      const task = await cloudGetTask(taskId);
      const format = (opts.format ?? "text").toLowerCase();
      if (format === "json") {
        console.log(JSON.stringify(task, null, 2));
        return;
      }
      const statusColor = task.status === "completed" ? chalk.green : task.status === "failed" ? chalk.red : chalk.yellow;
      console.log(chalk.cyan("Task: ") + taskId.slice(0, 8) + " " + statusColor(task.status));
      console.log(chalk.dim("Description: ") + (task.description ?? "").slice(0, 200) + ((task.description ?? "").length > 200 ? "…" : ""));
      if (task.error) console.log(chalk.red("Error: ") + task.error);
      if (task.outputs && Object.keys(task.outputs).length > 0) {
        console.log(chalk.dim("Outputs: ") + Object.keys(task.outputs).join(", "));
      }
    } catch (e) {
      console.error(chalk.red(e instanceof Error ? e.message : String(e)));
      process.exitCode = 1;
    }
  });

cloudCmd
  .command("exec <description>")
  .description("Run a task on the cloud (POST to remote API)")
  .option("-e, --env <id>", "Environment ID (sent as X-GTD-Env header and body.env)")
  .option("-f, --format <fmt>", "Output format: text | json", "text")
  .action(async function (this: { opts: () => { env?: string; format?: string } }, description: string) {
    const opts = this.opts();
    const { cloudExecTask } = await import("../api/cloud-client.js");
    const desc = (description ?? "").trim();
    if (!desc) {
      console.error(chalk.red("Description is required. Example: gtd cloud exec \"Fix the bug\""));
      process.exitCode = 1;
      return;
    }
    try {
      const { taskId } = await cloudExecTask(desc, { env: opts.env });
      const format = (opts.format ?? "text").toLowerCase();
      if (format === "json") {
        console.log(JSON.stringify({ taskId }, null, 2));
        return;
      }
      console.log(chalk.green("Task started on cloud: ") + chalk.cyan(taskId.slice(0, 8)));
      console.log(chalk.dim("View: gtd cloud show " + taskId.slice(0, 8)));
    } catch (e) {
      console.error(chalk.red(e instanceof Error ? e.message : String(e)));
      process.exitCode = 1;
    }
  });

const memoryCmd = program
  .command("memory")
  .description("Structured memory (MEMORY.md, key-value store)");

memoryCmd
  .command("list")
  .description("List memory entries")
  .option("-f, --format <fmt>", "Output format: text | json", "text")
  .action(async function (this: { opts: () => { format?: string } }) {
    const opts = this.opts();
    const entries = await getMemoryEntries();
    const format = (opts.format ?? "text").toLowerCase();
    if (format === "json") {
      console.log(JSON.stringify({ entries }, null, 2));
      return;
    }
    console.log(renderBanner());
    console.log("\nMemory entries:");
    for (const e of entries) {
      console.log(`  ${chalk.cyan(e.key)}: ${e.value.slice(0, 60)}${e.value.length > 60 ? "…" : ""}`);
    }
  });

memoryCmd
  .command("get <key>")
  .description("Get a memory entry")
  .action(async (key: string) => {
    const val = await getMemoryEntry(key);
    console.log(val ?? "");
  });

memoryCmd
  .command("set <key> <value>")
  .description("Set a memory entry")
  .action(async (key: string, value: string) => {
    await setMemoryEntry(key, value);
    console.log(chalk.green(`Set ${key}`));
  });

memoryCmd
  .command("delete <key>")
  .description("Remove a memory entry (forget/correct). Use key from gtd memory list.")
  .option("-f, --format <fmt>", "Output format: text | json", "text")
  .action(async function (this: { opts: () => { format?: string } }, key: string) {
    const format = (this.opts().format ?? "text").toLowerCase();
    const removed = await deleteMemoryEntry(key);
    if (format === "json") {
      console.log(JSON.stringify({ key, removed }, null, 2));
      if (!removed) process.exitCode = 1;
      return;
    }
    if (removed) console.log(chalk.green(`Removed ${key}`));
    else {
      console.log(chalk.yellow(`No entry for key: ${key}`));
      process.exitCode = 1;
    }
  });

memoryCmd
  .command("search <query>")
  .description("Search memory by semantic similarity (RAG). Requires GTD_RAG_ENABLED=1 and OPENAI_API_KEY.")
  .option("-k, --top <n>", "Number of chunks to return (default 10)", "10")
  .option("-f, --format <fmt>", "Output format: text | json", "text")
  .action(async function (this: { opts: () => { format?: string; top?: string } }, query: string) {
    const opts = this.opts();
    const k = Math.max(1, Math.min(50, parseInt(opts.top ?? "10", 10) || 10));
    const format = (opts.format ?? "text").toLowerCase();
    const { retrieveWithSources } = await import("../memory/rag.js");
    const chunks = await retrieveWithSources(query, k);
    if (format === "json") {
      console.log(JSON.stringify({ query, chunks }, null, 2));
      return;
    }
    if (chunks.length === 0) {
      console.log(chalk.dim("No results. Enable RAG (GTD_RAG_ENABLED=1, OPENAI_API_KEY) and run gtd memory index."));
      return;
    }
    for (const c of chunks) {
      console.log(chalk.cyan("[Source: " + c.sourceId + "]"));
      console.log(c.text);
      console.log("");
    }
  });

memoryCmd
  .command("project")
  .description("Show MEMORY.md from current directory")
  .option("-f, --format <fmt>", "Output format: text | json", "text")
  .action(async function (this: { opts: () => { format?: string } }) {
    const opts = this.opts();
    const content = await loadProjectMemory(process.cwd());
    const format = (opts.format ?? "text").toLowerCase();
    if (format === "json") {
      console.log(JSON.stringify({ path: "MEMORY.md", content }, null, 2));
      return;
    }
    if (content) console.log(content);
    else console.log(chalk.dim("No MEMORY.md in current directory."));
  });

memoryCmd
  .command("index")
  .description("Force re-index of RAG (MEMORY.md + entries). Requires GTD_RAG_ENABLED=1 and OPENAI_API_KEY.")
  .option("-f, --format <fmt>", "Output format: text | json", "text")
  .action(async function (this: { opts: () => { format?: string } }) {
    const opts = this.opts();
    const { indexChunks } = await import("../memory/rag.js");
    const projectMemory = await loadProjectMemory(process.cwd());
    const entries = await getMemoryEntries();
    const ragChunks: { id: string; text: string }[] = [];
    if (projectMemory) {
      projectMemory.split(/\n\n+/).forEach((p, i) => {
        const t = p.trim();
        if (t) ragChunks.push({ id: `mem_${i}`, text: t });
      });
    }
    entries.forEach((e) => ragChunks.push({ id: e.id, text: `${e.key}: ${e.value}` }));
    await indexChunks(ragChunks);
    const format = (opts.format ?? "text").toLowerCase();
    if (format === "json") {
      console.log(JSON.stringify({ indexed: ragChunks.length }, null, 2));
    } else {
      console.log(chalk.green(`Indexed ${ragChunks.length} chunk(s) for RAG.`));
    }
  });

/** Resolve rule/context paths from config and return which exist (for footer, rules-list, rules-refresh). */
async function getRulesPathsAndFound(cwd: string): Promise<{ paths: string[]; found: string[] }> {
  const cfg = await loadConfig();
  const paths: string[] = [];
  if (cfg.rules?.length) {
    for (const r of cfg.rules) {
      paths.push(isAbsolute(r) ? r : join(cwd, r));
    }
  } else if (cfg.rulesDefaultNames?.length) {
    for (const n of cfg.rulesDefaultNames) {
      paths.push(isAbsolute(n) ? n : join(cwd, n));
    }
  } else {
    paths.push(join(cwd, ".gtd", "rules.md"), join(cwd, "RULES.md"), join(cwd, ".cursor", "AGENTS.md"), join(cwd, "AGENTS.md"));
  }
  const { readFile } = await import("fs/promises");
  const found: string[] = [];
  for (const p of paths) {
    if (await isPathIgnored(cwd, p)) continue;
    try {
      await readFile(p, "utf-8");
      found.push(p);
    } catch {
      // not found
    }
  }
  return { paths, found };
}

memoryCmd
  .command("rules-list")
  .description("List paths of rule/context files in use (Gemini-style memory list)")
  .option("-f, --format <fmt>", "Output format: text | json", "text")
  .action(async function (this: { opts: () => { format?: string } }) {
    const opts = this.opts();
    const cwd = process.cwd();
    const { paths, found } = await getRulesPathsAndFound(cwd);
    const format = (opts.format ?? "text").toLowerCase();
    if (format === "json") {
      console.log(JSON.stringify({ paths, loaded: found }, null, 2));
      return;
    }
    console.log("Rule file paths (checked in order):");
    for (const p of paths) {
      const ok = found.includes(p);
      console.log(`  ${ok ? chalk.green("✓") : chalk.dim("—")} ${p}`);
    }
    if (found.length === 0) console.log(chalk.dim("  (none found; agents use no project rules)"));
  });

memoryCmd
  .command("rules-show")
  .description("Show full concatenated rules/context sent to agents (Gemini-style memory show)")
  .option("-f, --format <fmt>", "Output format: text | json", "text")
  .action(async function (this: { opts: () => { format?: string } }) {
    const opts = this.opts();
    const cwd = process.cwd();
    const cfg = await loadConfig();
    const globalRules = await loadGlobalRules();
    const projectContent = await loadProjectRulesFromConfig(cwd, cfg.rules, cfg.rulesDefaultNames);
    const content = [globalRules, projectContent].filter(Boolean).join("\n\n");
    const format = (opts.format ?? "text").toLowerCase();
    if (format === "json") {
      console.log(JSON.stringify({ content, length: content.length }, null, 2));
      return;
    }
    if (content) console.log(content);
    else console.log(chalk.dim("No project rules loaded. Add .gtd/rules.md, RULES.md, or set config.rules. Global: gtd memory rules-add."));
  });

memoryCmd
  .command("rules-refresh")
  .description("Reload context/rules from disk without restart (Gemini-style memory refresh)")
  .option("-f, --format <fmt>", "Output format: text | json", "text")
  .action(async function (this: { opts: () => { format?: string } }) {
    const opts = this.opts();
    const cwd = process.cwd();
    const { found } = await getRulesPathsAndFound(cwd);
    const format = (opts.format ?? "text").toLowerCase();
    if (format === "json") {
      console.log(JSON.stringify({ refreshed: true, pathCount: found.length }, null, 2));
      return;
    }
    console.log(chalk.green(`Context reloaded. ${found.length} file(s) in use.`));
  });

memoryCmd
  .command("rules-add <text>")
  .description("Append text to global context file (Gemini-style memory add; stored in data dir)")
  .action(async (text: string) => {
    const { appendFile, mkdir } = await import("fs/promises");
    const dataDir = getDataDir();
    const globalPath = join(dataDir, "global-rules.md");
    await mkdir(dataDir, { recursive: true });
    await appendFile(globalPath, (text || "").trimEnd() + "\n", "utf-8");
    console.log(chalk.green(`Appended to ${globalPath}`));
  });

memoryCmd
  .command("refresh")
  .description("Alias for memory index: force re-index of RAG so agents see fresh MEMORY.md and entries")
  .option("-f, --format <fmt>", "Output format: text | json", "text")
  .action(async function (this: { opts: () => { format?: string } }) {
    const opts = this.opts();
    const { indexChunks } = await import("../memory/rag.js");
    const projectMemory = await loadProjectMemory(process.cwd());
    const entries = await getMemoryEntries();
    const ragChunks: { id: string; text: string }[] = [];
    if (projectMemory) {
      projectMemory.split(/\n\n+/).forEach((p, i) => {
        const t = p.trim();
        if (t) ragChunks.push({ id: `mem_${i}`, text: t });
      });
    }
    entries.forEach((e) => ragChunks.push({ id: e.id, text: `${e.key}: ${e.value}` }));
    await indexChunks(ragChunks);
    const format = (opts.format ?? "text").toLowerCase();
    if (format === "json") {
      console.log(JSON.stringify({ indexed: ragChunks.length }, null, 2));
    } else {
      console.log(chalk.green(`Refreshed RAG: ${ragChunks.length} chunk(s) indexed.`));
    }
  });

const allowCmd = program
  .command("allow")
  .description("Tool allow list (session + project; don't ask again)");

allowCmd
  .command("list")
  .description("Show current session and project allow state")
  .option("-f, --format <fmt>", "Output format: text | json", "text")
  .action(async function (this: { opts: () => { format?: string } }) {
    const opts = this.opts();
    const session = getSessionAllow();
    const cwd = process.cwd();
    const project = await loadProjectAllow(cwd);
    const sessionArr = Array.from(session).sort();
    const projectArr = Array.from(project).sort();
    const format = (opts.format ?? "text").toLowerCase();
    if (format === "json") {
      console.log(JSON.stringify({ session: sessionArr, project: projectArr, cwd }, null, 2));
      return;
    }
    console.log(chalk.cyan("Session (this process):"));
    if (sessionArr.length === 0) console.log("  (none)");
    else sessionArr.forEach((k) => console.log(`  ${k}`));
    console.log(chalk.cyan("\nProject (.gtd/allow.json):"));
    if (projectArr.length === 0) console.log("  (none)");
    else projectArr.forEach((k) => console.log(`  ${k}`));
  });

const rulesCmd = program
  .command("rules")
  .description("Project rules and Cursor/IDE snippets (CC-7)");

rulesCmd
  .command("export")
  .description("Export rules snippet for Cursor or other IDEs")
  .option("-f, --format <fmt>", "Output format: cursor", "cursor")
  .option("-o, --output <path>", "Write to file (default: stdout)")
  .action(async function (this: { opts: () => { format?: string; output?: string } }) {
    const opts = this.opts();
    const format = (opts.format ?? "cursor").toLowerCase();
    if (format !== "cursor") {
      console.error(chalk.red("Only --format cursor is supported."));
      process.exitCode = 1;
      return;
    }
    const snippet = `# Skate – Cursor / agent rules

- Use \`gtd task "<description>"\` to create and run a new task. Use \`--stream\` for live output.
- Use \`gtd retry <taskId>\` to resume a failed task; \`gtd approve <taskId>\` to approve a blocked task and continue.
- Use \`gtd status <id>\` or \`gtd show <id>\` to inspect task state; \`gtd inbox\` for pending/blocked.
- Permission modes: \`dont-ask\` (auto-allow tools), \`plan\` (approve per plan), \`ask\` (approve per tool). Set via \`gtd allow\` or config.
- When the agent drives GTD: prefer \`gtd task\` for new work; \`gtd retry\` only after a task has failed; \`gtd approve\` when task is blocked and user approved.
`;
    if (opts.output) {
      const { writeFile, mkdir } = await import("fs/promises");
      const { dirname } = await import("path");
      const dir = dirname(opts.output);
      if (dir) await mkdir(dir, { recursive: true });
      await writeFile(opts.output, snippet, "utf-8");
      console.log(chalk.green(`Wrote ${opts.output}`));
    } else {
      console.log(snippet);
    }
  });

const modeCmd = program
  .command("mode")
  .description("Mode profiles (model, quality, permission presets)");

modeCmd
  .command("list")
  .description("List mode definitions")
  .option("-f, --format <fmt>", "Output format: text | json", "text")
  .action(async function (this: { opts: () => { format?: string } }) {
    const opts = this.opts();
    const modes = await listModes();
    const active = await getActiveMode();
    const format = (opts.format ?? "text").toLowerCase();
    if (format === "json") {
      console.log(JSON.stringify({ modes, active }, null, 2));
      return;
    }
    console.log(renderBanner());
    console.log(`\nModes (active: ${active ?? "none"}):`);
    for (const m of modes) {
      const mark = m.id === active ? chalk.green(" *") : "";
      console.log(`  ${chalk.cyan(m.id)} ${m.name}${mark}`);
    }
  });

modeCmd
  .command("use <id>")
  .description("Set active mode")
  .action(async (id: string) => {
    const mode = await getMode(id);
    if (!mode) {
      console.log(chalk.red(`Mode ${id} not found`));
      process.exitCode = 1;
      return;
    }
    await setActiveMode(id);
    console.log(chalk.green(`Active mode: ${id}`));
  });

modeCmd
  .command("clear")
  .description("Clear active mode")
  .action(async () => {
    await setActiveMode(undefined);
    console.log(chalk.green("Active mode cleared"));
  });

modeCmd
  .command("export <id>")
  .description("Export mode definition to JSON file")
  .option("-o, --output <path>", "Output file path", "mode-<id>.json")
  .action(async function (this: { opts: () => { output?: string } }, id: string) {
    const opts = this.opts();
    const mode = await getMode(id);
    if (!mode) {
      console.log(chalk.red(`Mode ${id} not found`));
      process.exitCode = 1;
      return;
    }
    const outPath = (opts.output ?? `mode-${id}.json`).replace("<id>", id);
    const { writeFile } = await import("fs/promises");
    await writeFile(outPath, JSON.stringify(mode, null, 2), "utf-8");
    console.log(chalk.green(`Exported ${id} to ${outPath}`));
  });

modeCmd
  .command("import <path>")
  .description("Import mode definition from JSON file")
  .action(async (path: string) => {
    const { readFile } = await import("fs/promises");
    try {
      const raw = await readFile(path, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (!parsed.id || !parsed.name || typeof parsed.id !== "string" || typeof parsed.name !== "string") {
        console.log(chalk.red("Invalid mode: id and name required"));
        process.exitCode = 1;
        return;
      }
      const mode: import("../modes/store.js").ModeDefinition = {
        id: parsed.id as string,
        name: parsed.name as string,
        qualityProfile: ["fast", "balanced", "max"].includes(parsed.qualityProfile as string) ? (parsed.qualityProfile as "fast" | "balanced" | "max") : undefined,
        approvalPolicy: ["auto", "hybrid", "always"].includes(parsed.approvalPolicy as string) ? (parsed.approvalPolicy as "auto" | "hybrid" | "always") : undefined,
        permissionMode: parsed.permissionMode ? normalizePermissionMode(String(parsed.permissionMode)) : undefined,
        defaultModel: typeof parsed.defaultModel === "string" ? parsed.defaultModel : undefined,
        modelOverrides: parsed.modelOverrides && typeof parsed.modelOverrides === "object" && !Array.isArray(parsed.modelOverrides) ? (parsed.modelOverrides as Record<string, string>) : undefined,
      };
      await setMode(mode);
      console.log(chalk.green(`Imported mode ${mode.id}`));
    } catch (e) {
      console.log(chalk.red(`Failed to import: ${(e as Error).message}`));
      process.exitCode = 1;
    }
  });

const mcpCmd = program
  .command("mcp")
  .description("MCP server management (register, list, test, remove)");

mcpCmd
  .command("list")
  .description("List registered MCP servers")
  .option("-f, --format <fmt>", "Output format: text | json", "text")
  .action(async function (this: { opts: () => { format?: string } }) {
    const opts = this.opts();
    const servers = await listMcpServers();
    const format = (opts.format ?? "text").toLowerCase();
    if (format === "json") {
      console.log(JSON.stringify({ servers }, null, 2));
      return;
    }
    console.log(renderBanner());
    console.log("\nMCP servers:");
    for (const s of servers) {
      const cfg = s.transport === "stdio" ? `${s.config.command} ${(s.config.args ?? []).join(" ")}` : s.config.url;
      console.log(`  ${chalk.cyan(s.id)} ${s.name} (${s.transport}) ${chalk.dim(cfg ?? "")}`);
    }
  });

mcpCmd
  .command("register <id>")
  .description("Register an MCP server")
  .option("-n, --name <name>", "Display name", "MCP Server")
  .option("-t, --transport <type>", "Transport: stdio | url", "stdio")
  .option("-c, --command <cmd>", "Command for stdio (e.g. npx)")
  .option("-a, --args <args>", "Args as JSON array (e.g. [\"-y\",\"@modelcontextprotocol/server-filesystem\"]")
  .option("-u, --url <url>", "URL for url transport")
  .option("--test", "Ping server after register (exit non-zero if unreachable)")
  .option("-f, --format <fmt>", "Output format: text | json", "text")
  .action(async function (this: { opts: () => { name?: string; transport?: string; command?: string; args?: string; url?: string; format?: string; test?: boolean } }, id: string) {
    const opts = this.opts();
    if (!id?.trim()) {
      console.error(chalk.red("MCP server id is required. Example: gtd mcp register my-server --command npx --args '[\"@modelcontextprotocol/server-filesystem\"]'"));
      process.exitCode = 1;
      return;
    }
    const transport = (opts.transport ?? "stdio") as "stdio" | "url";
    let config: McpServerConfig["config"];
    if (transport === "url") {
      if (!opts.url) {
        console.log(chalk.red("url transport requires --url"));
        process.exitCode = 1;
        return;
      }
      const allowlist = (process.env.GTD_MCP_URL_ALLOWLIST ?? "")
        .split(",")
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean);
      if (allowlist.length === 0) {
        console.log(chalk.red("URL MCP requires GTD_MCP_URL_ALLOWLIST (comma-separated hostnames). Example: export GTD_MCP_URL_ALLOWLIST=localhost,api.example.com"));
        process.exitCode = 1;
        return;
      }
      let host: string;
      try {
        host = new URL(opts.url).hostname.toLowerCase();
      } catch {
        console.log(chalk.red("Invalid URL"));
        process.exitCode = 1;
        return;
      }
      if (!allowlist.includes(host)) {
        console.log(chalk.red(`Host ${host} is not in GTD_MCP_URL_ALLOWLIST. Allowed: ${allowlist.join(", ")}`));
        process.exitCode = 1;
        return;
      }
      config = { url: opts.url };
    } else {
      const cmd = opts.command ?? "npx";
      let args: string[] = [];
      if (opts.args) {
        try {
          args = JSON.parse(opts.args) as string[];
        } catch {
          console.log(chalk.red("Invalid --args JSON"));
          process.exitCode = 1;
          return;
        }
      }
      config = { command: cmd, args };
    }
    const cfg: McpServerConfig = {
      id,
      name: opts.name ?? id,
      transport,
      config,
    };
    await registerMcpServer(cfg);
    const format = (opts.format ?? "text").toLowerCase();
    if (opts.test) {
      const result = await testMcpServer(cfg);
      if (format === "json") {
        console.log(JSON.stringify({ registered: true, id, test: result }, null, 2));
        if (!result.success) process.exitCode = 1;
      } else if (result.success) {
        console.log(chalk.green(`Registered MCP server ${id}`));
        console.log(chalk.green(`✓ ${id} OK (connectivity check passed)`));
      } else {
        console.log(chalk.green(`Registered MCP server ${id}`));
        console.log(chalk.red(`✗ ${id} unreachable: ${result.error}`));
        process.exitCode = 1;
      }
    } else if (format === "json") {
      console.log(JSON.stringify({ success: true, id }, null, 2));
    } else {
      console.log(chalk.green(`Registered MCP server ${id}`));
    }
  });

mcpCmd
  .command("test <id>")
  .description("Test MCP server connectivity")
  .option("-f, --format <fmt>", "Output format: text | json", "text")
  .action(async function (this: { opts: () => { format?: string } }, id: string) {
    const opts = this.opts();
    const server = await getMcpServer(id);
    if (!server) {
      console.log(chalk.red(`MCP server ${id} not found`));
      process.exitCode = 1;
      return;
    }
    const result = await testMcpServer(server);
    const format = (opts.format ?? "text").toLowerCase();
    if (format === "json") {
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.success ? 0 : 1;
      return;
    }
    if (result.success) {
      console.log(chalk.green(`✓ ${id} OK`));
    } else {
      console.log(chalk.red(`✗ ${id}: ${result.error}`));
      process.exitCode = 1;
    }
  });

mcpCmd
  .command("remove <id>")
  .description("Remove MCP server")
  .option("-f, --format <fmt>", "Output format: text | json", "text")
  .action(async function (this: { opts: () => { format?: string } }, id: string) {
    const opts = this.opts();
    const ok = await removeMcpServer(id);
    const format = (opts.format ?? "text").toLowerCase();
    if (format === "json") {
      console.log(JSON.stringify({ success: ok }, null, 2));
    } else if (ok) {
      console.log(chalk.green(`Removed ${id}`));
    } else {
      console.log(chalk.red(`MCP server ${id} not found`));
      process.exitCode = 1;
    }
  });

mcpCmd
  .command("tools [id]")
  .description("List tools from MCP server(s). Omit id to list tools from all registered stdio servers.")
  .option("-f, --format <fmt>", "Output format: text | json", "text")
  .action(async function (this: { opts: () => { format?: string } }, id?: string) {
    const opts = this.opts();
    const servers = id ? [await getMcpServer(id)].filter(Boolean) as McpServerConfig[] : await listMcpServers();
    if (servers.length === 0) {
      console.log(chalk.red(id ? `MCP server ${id} not found` : "No MCP servers registered"));
      process.exitCode = 1;
      return;
    }
    const format = (opts.format ?? "text").toLowerCase();
    const results: Record<string, { success: boolean; error?: string; tools?: { name: string; description?: string }[] }> = {};
    for (const s of servers) {
      const r = await listMcpTools(s);
      results[s.id] = r.success
        ? { success: true, tools: r.tools?.map((t) => ({ name: t.name, description: t.description })) ?? [] }
        : { success: false, error: r.error };
    }
    if (format === "json") {
      console.log(JSON.stringify(results, null, 2));
      const anyFail = Object.values(results).some((v) => !v.success);
      if (anyFail) process.exitCode = 1;
      return;
    }
    for (const [sid, r] of Object.entries(results)) {
      console.log(chalk.cyan(`\n${sid}:`));
      if (!r.success) {
        console.log(chalk.red(`  ${r.error}`));
        process.exitCode = 1;
      } else {
        const tools = r.tools ?? [];
        if (tools.length === 0) console.log(chalk.dim("  (no tools)"));
        else for (const t of tools) console.log(`  ${t.name}${t.description ? chalk.dim(` — ${t.description}`) : ""}`);
      }
    }
  });

mcpCmd
  .command("resources [id]")
  .description("List resources from MCP server(s). Omit id to list from all registered stdio servers.")
  .option("-f, --format <fmt>", "Output format: text | json", "text")
  .action(async function (this: { opts: () => { format?: string } }, id?: string) {
    const opts = this.opts();
    const servers = id ? [await getMcpServer(id)].filter(Boolean) as McpServerConfig[] : await listMcpServers();
    if (servers.length === 0) {
      console.log(chalk.red(id ? `MCP server ${id} not found` : "No MCP servers registered"));
      process.exitCode = 1;
      return;
    }
    const format = (opts.format ?? "text").toLowerCase();
    const results: Record<string, { success: boolean; error?: string; resources?: { uri: string; name?: string }[] }> = {};
    for (const s of servers) {
      const r = await listMcpResources(s);
      results[s.id] = r.success
        ? { success: true, resources: r.resources?.map((res) => ({ uri: res.uri, name: res.name })) ?? [] }
        : { success: false, error: r.error };
    }
    if (format === "json") {
      console.log(JSON.stringify(results, null, 2));
      const anyFail = Object.values(results).some((v) => !v.success);
      if (anyFail) process.exitCode = 1;
      return;
    }
    for (const [sid, r] of Object.entries(results)) {
      console.log(chalk.cyan(`\n${sid}:`));
      if (!r.success) {
        console.log(chalk.red(`  ${r.error}`));
        process.exitCode = 1;
      } else {
        const resources = r.resources ?? [];
        if (resources.length === 0) console.log(chalk.dim("  (no resources)"));
        else for (const res of resources) console.log(`  ${res.uri}${res.name ? chalk.dim(` — ${res.name}`) : ""}`);
      }
    }
  });

mcpCmd
  .command("read-resource <id> <uri>")
  .description("Read one resource by URI from an MCP server (stdio only)")
  .option("-f, --format <fmt>", "Output format: text | json", "text")
  .action(async function (this: { opts: () => { format?: string } }, id: string, uri: string) {
    const opts = this.opts();
    const server = await getMcpServer(id);
    if (!server) {
      console.log(chalk.red(`MCP server ${id} not found`));
      process.exitCode = 1;
      return;
    }
    const r = await readMcpResource(server, uri);
    const format = (opts.format ?? "text").toLowerCase();
    if (format === "json") {
      console.log(JSON.stringify(r, null, 2));
      if (!r.success) process.exitCode = 1;
      return;
    }
    if (!r.success) {
      console.log(chalk.red(r.error ?? "Read failed"));
      process.exitCode = 1;
      return;
    }
    const contents = r.contents ?? [];
    for (const c of contents) {
      if (c.text != null) process.stdout.write(c.text);
      if (c.blob != null) process.stdout.write(Buffer.from(c.blob, "base64").toString("utf-8"));
    }
  });

mcpCmd
  .command("serve")
  .description("Run GTD as an MCP server on stdio (tools: gtd_create_task, gtd_approve, gtd_show, gtd_list_tasks, gtd_retry). For IDE integration.")
  .action(() => {
    runGtdMcpServer();
  });

const pluginCmd = program
  .command("plugins")
  .description("Plugin SDK: list, validate, discover from registry");

pluginCmd
  .command("list")
  .description("Discover and list plugins (node_modules)")
  .option("-d, --dir <path>", "Search directory", "node_modules")
  .option("-f, --format <fmt>", "Output format: text | json", "text")
  .action(async function (this: { opts: () => { dir?: string; format?: string } }) {
    const opts = this.opts();
    const defaultPluginsDir = process.env.GTD_PLUGINS_DIR || opts.dir || "node_modules";
    const dir = defaultPluginsDir ? (isAbsolute(defaultPluginsDir) ? defaultPluginsDir : join(process.cwd(), defaultPluginsDir)) : join(process.cwd(), "node_modules");
    const plugins = await discoverPlugins(dir);
    const format = (opts.format ?? "text").toLowerCase();
    if (format === "json") {
      console.log(JSON.stringify({ plugins }, null, 2));
      return;
    }
    console.log(renderBanner());
    console.log(`\nPlugins (from ${dir}):`);
    for (const p of plugins) {
      console.log(`  ${chalk.cyan(p.id)} ${p.name}@${p.version}`);
    }
  });

program
  .command("extensions")
  .description("List extensions/plugins (same as gtd plugins list; Gemini-style /extensions)")
  .option("-d, --dir <path>", "Search directory", "node_modules")
  .option("-f, --format <fmt>", "Output format: text | json", "text")
  .action(async function (this: { opts: () => { dir?: string; format?: string } }) {
    const opts = this.opts();
    const defaultPluginsDir = process.env.GTD_PLUGINS_DIR || opts.dir || "node_modules";
    const dir = defaultPluginsDir ? (isAbsolute(defaultPluginsDir) ? defaultPluginsDir : join(process.cwd(), defaultPluginsDir)) : join(process.cwd(), "node_modules");
    const plugins = await discoverPlugins(dir);
    const format = (opts.format ?? "text").toLowerCase();
    if (format === "json") {
      console.log(JSON.stringify({ extensions: plugins }, null, 2));
      return;
    }
    console.log(renderBanner());
    console.log(`\nExtensions (from ${dir}):`);
    for (const p of plugins) {
      console.log(`  ${chalk.cyan(p.id)} ${p.name}@${p.version}`);
    }
  });

pluginCmd
  .command("discover")
  .description("List plugins from a registry (URL or path). Set GTD_PLUGIN_REGISTRY_URL or use --registry.")
  .option("-r, --registry <url|path>", "Registry URL or path to JSON (plugins array with id, name, repo, description)")
  .option("-f, --format <fmt>", "Output format: text | json", "text")
  .action(async function (this: { opts: () => { registry?: string; format?: string } }) {
    const opts = this.opts();
    const registry = opts.registry ?? process.env.GTD_PLUGIN_REGISTRY_URL ?? "";
    const format = (opts.format ?? "text").toLowerCase();
    let data: { plugins?: Array<{ id: string; name: string; repo: string; description?: string }> };
    if (registry.startsWith("http://") || registry.startsWith("https://")) {
      try {
        const res = await fetch(registry);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        data = (await res.json()) as { plugins?: Array<{ id: string; name: string; repo: string; description?: string }> };
      } catch (e) {
        console.error(chalk.red("Failed to fetch registry: " + (e instanceof Error ? e.message : String(e))));
        process.exitCode = 1;
        return;
      }
    } else if (registry) {
      const path = isAbsolute(registry) ? registry : join(process.cwd(), registry);
      const { readFile } = await import("fs/promises");
      try {
        const raw = await readFile(path, "utf-8");
        data = JSON.parse(raw) as { plugins?: Array<{ id: string; name: string; repo: string; description?: string }> };
      } catch (e) {
        console.error(chalk.red("Failed to read registry: " + (e instanceof Error ? e.message : String(e))));
        process.exitCode = 1;
        return;
      }
    } else {
      const defaultPath = join(process.cwd(), "docs", "plugins", "plugin-registry.json");
      try {
        const { readFile } = await import("fs/promises");
        const raw = await readFile(defaultPath, "utf-8");
        data = JSON.parse(raw) as { plugins?: Array<{ id: string; name: string; repo: string; description?: string }> };
      } catch {
        console.log(chalk.dim("No registry configured. Set GTD_PLUGIN_REGISTRY_URL or pass --registry <url|path>."));
        return;
      }
    }
    const plugins = Array.isArray(data?.plugins) ? data.plugins : [];
    if (format === "json") {
      console.log(JSON.stringify({ plugins }, null, 2));
      return;
    }
    console.log(renderBanner());
    console.log("\nRegistry plugins:");
    if (plugins.length === 0) console.log("  (none)");
    else for (const p of plugins) console.log(`  ${chalk.cyan(p.id)} ${p.name} ${chalk.dim(p.repo)} ${p.description ?? ""}`);
  });

pluginCmd
  .command("validate <path>")
  .description("Validate plugin manifest at path")
  .option("-f, --format <fmt>", "Output format: text | json", "text")
  .action(async function (this: { opts: () => { format?: string } }, path: string) {
    const opts = this.opts();
    const result = await loadPluginManifest(path);
    const format = (opts.format ?? "text").toLowerCase();
    if (format === "json") {
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.success ? 0 : 1;
      return;
    }
    if (result.success && result.manifest) {
      console.log(chalk.green(`✓ Valid: ${result.manifest.id}@${result.manifest.version}`));
    } else {
      console.log(chalk.red(`✗ Invalid: ${result.error}`));
      process.exitCode = 1;
    }
  });

pluginCmd
  .command("run <pluginId> <commandId>")
  .description("Run a plugin command by plugin id and command id (from manifest commands)")
  .option("-d, --dir <path>", "Search directory for plugins (default: GTD_PLUGINS_DIR or node_modules)", process.env.GTD_PLUGINS_DIR || "node_modules")
  .action(async function (this: { opts: () => { dir?: string } }, pluginId: string, commandId: string) {
    const opts = this.opts();
    if (!pluginId?.trim() || !commandId?.trim()) {
      console.error(chalk.red("Plugin id and command id are required. Example: gtd plugins run my-plugin my-command"));
      process.exitCode = 1;
      return;
    }
    const defaultDir = process.env.GTD_PLUGINS_DIR || "node_modules";
    const searchDir = opts.dir ? (isAbsolute(opts.dir) ? opts.dir : join(process.cwd(), opts.dir)) : join(process.cwd(), defaultDir);
    const plugins = await discoverPluginsWithPaths(searchDir);
    const match = plugins.find((p) => p.manifest.id === pluginId || p.manifest.name === pluginId);
    if (!match) {
      console.log(chalk.red(`Plugin not found: ${pluginId}`));
      process.exitCode = 1;
      return;
    }
    const cmd = match.manifest.commands?.find((c) => c.id === commandId);
    if (!cmd) {
      console.log(chalk.red(`Command not found: ${commandId} in ${match.manifest.id}. Available: ${match.manifest.commands?.map((c) => c.id).join(", ") ?? "none"}`));
      process.exitCode = 1;
      return;
    }
    const handler = cmd.handler;
    if (!handler) {
      console.log(chalk.red(`Command ${commandId} has no handler in manifest`));
      process.exitCode = 1;
      return;
    }
    const handlerPath = isAbsolute(handler) ? handler : join(match.path, handler);
    const { spawn } = await import("child_process");
    const pluginEnv = buildPluginRunEnv(match.manifest.id, match.path, commandId);
    const child = spawn(process.execPath, [handlerPath], {
      cwd: match.path,
      stdio: "inherit",
      env: pluginEnv,
    });
    const code = await new Promise<number | null>((resolve) => {
      child.on("exit", (c) => resolve(c));
    });
    if (code != null && code !== 0) process.exitCode = code;
  });

const auditCmd = program
  .command("audit")
  .description("Persistent audit log (governance)");

auditCmd
  .command("list")
  .description("List audit events")
  .option("-n, --limit <n>", "Max events", "50")
  .option("-f, --format <fmt>", "Output format: text | json", "text")
  .action(async function (this: { opts: () => { limit?: string; format?: string } }) {
    const opts = this.opts();
    const limit = parseInt(opts.limit ?? "50", 10) || 50;
    const events = await getAuditLog(limit);
    const format = (opts.format ?? "text").toLowerCase();
    if (format === "json") {
      console.log(JSON.stringify({ events }, null, 2));
      return;
    }
    console.log(renderBanner());
    console.log(`\nAudit log (last ${events.length}):`);
    for (const e of events) {
      const ts = e.timestamp;
      console.log(`  ${chalk.dim(ts)} ${chalk.cyan(e.type)} ${e.taskId ?? ""} ${e.message ?? ""}`);
    }
  });

const telemetryCmd = program
  .command("telemetry")
  .description("Metrics and usage telemetry");

telemetryCmd
  .command("list")
  .description("List metric events")
  .option("-n, --limit <n>", "Max events", "100")
  .option("-f, --format <fmt>", "Output format: text | json", "text")
  .action(async function (this: { opts: () => { limit?: string; format?: string } }) {
    const opts = this.opts();
    const limit = parseInt(opts.limit ?? "100", 10) || 100;
    const events = await getMetrics(limit);
    const format = (opts.format ?? "text").toLowerCase();
    if (format === "json") {
      console.log(JSON.stringify({ events }, null, 2));
      return;
    }
    console.log(renderBanner());
    console.log(`\nTelemetry (last ${events.length}):`);
    for (const e of events) {
      const parts = [e.type, e.taskId, e.step ?? e.role, e.latencyMs ? `${e.latencyMs}ms` : "", e.modelId ?? ""].filter(Boolean);
      console.log(`  ${chalk.dim(e.timestamp)} ${parts.join(" ")}`);
    }
  });

telemetryCmd
  .command("dashboard")
  .description("Generate HTML telemetry dashboard")
  .option("-o, --output <path>", "Output HTML file path")
  .option("--open", "Open the generated file in the default browser")
  .option("-n, --limit <n>", "Max metric events", "500")
  .action(async function (this: { opts: () => { output?: string; open?: boolean; limit?: string } }) {
    const opts = this.opts();
    const { generateDashboardHtml } = await import("../telemetry/dashboard.js");
    const limit = parseInt(opts.limit ?? "500", 10) || 500;
    const metrics = await getMetrics(limit);
    const auditEvents = await getAuditLog(limit);
    const path = await generateDashboardHtml(metrics, auditEvents, opts.output);
    console.log(chalk.green(`Dashboard written: ${path}`));
    if (opts.open) {
      const { execSync } = await import("child_process");
      try {
        execSync(`open "${path}"`, { stdio: "pipe" });
      } catch {
        try {
          execSync(`xdg-open "${path}"`, { stdio: "pipe" });
        } catch {
          console.log(chalk.dim("Open the file manually in your browser."));
        }
      }
    }
  });

const gitCmd = program
  .command("git")
  .description("Git-native workflows (worktree, branch-per-task, diff)");

gitCmd
  .command("worktree <branch> [path]")
  .description("Create worktree for branch")
  .option("-f, --format <fmt>", "Output format: text | json", "text")
  .action(async function (this: { opts: () => { format?: string } }, branch: string, path?: string) {
    const opts = this.opts();
    const cwd = process.cwd();
    if (!isGitRepo(cwd)) {
      console.log(chalk.red("Not a git repository"));
      process.exitCode = 1;
      return;
    }
    const result = createWorktree(cwd, branch, path);
    const format = (opts.format ?? "text").toLowerCase();
    if (format === "json") {
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.success ? 0 : 1;
      return;
    }
    if (result.success) {
      console.log(chalk.green(`Worktree created: ${result.path} (branch ${result.branch})`));
    } else {
      console.log(chalk.red(result.error));
      process.exitCode = 1;
    }
  });

gitCmd
  .command("branch <name>")
  .description("Create branch for task (branch-per-task)")
  .option("-f, --format <fmt>", "Output format: text | json", "text")
  .action(async function (this: { opts: () => { format?: string } }, name: string) {
    const opts = this.opts();
    const cwd = process.cwd();
    if (!isGitRepo(cwd)) {
      console.log(chalk.red("Not a git repository"));
      process.exitCode = 1;
      return;
    }
    const result = createBranch(cwd, name);
    const format = (opts.format ?? "text").toLowerCase();
    if (format === "json") {
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.success ? 0 : 1;
      return;
    }
    if (result.success) {
      console.log(chalk.green(`Branch created: ${result.branch}`));
    } else {
      console.log(chalk.red(result.error));
      process.exitCode = 1;
    }
  });

gitCmd
  .command("diff [ref]")
  .description("Show diff stats")
  .option("-f, --format <fmt>", "Output format: text | json", "text")
  .action(async function (this: { opts: () => { format?: string } }, ref?: string) {
    const opts = this.opts();
    const cwd = process.cwd();
    if (!isGitRepo(cwd)) {
      console.log(chalk.red("Not a git repository"));
      process.exitCode = 1;
      return;
    }
    const result = getDiffStats(cwd, ref ?? "HEAD");
    const format = (opts.format ?? "text").toLowerCase();
    if (format === "json") {
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.success ? 0 : 1;
      return;
    }
    if (result.success && result.output) {
      console.log(result.output);
    } else {
      console.log(chalk.red(result.error ?? "No diff"));
      process.exitCode = 1;
    }
  });

gitCmd
  .command("status")
  .description("Show current branch")
  .option("-f, --format <fmt>", "Output format: text | json", "text")
  .action(async function (this: { opts: () => { format?: string } }) {
    const opts = this.opts();
    const cwd = process.cwd();
    if (!isGitRepo(cwd)) {
      console.log(chalk.red("Not a git repository"));
      process.exitCode = 1;
      return;
    }
    const branch = getCurrentBranch(cwd);
    const format = (opts.format ?? "text").toLowerCase();
    if (format === "json") {
      console.log(JSON.stringify({ branch }, null, 2));
      return;
    }
    console.log(chalk.cyan(branch ?? "unknown"));
  });

const gitPrCmd = gitCmd.command("pr").description("Pull request (gh pr)");

gitPrCmd
  .command("create")
  .description("Create a PR (gh pr create)")
  .option("-t, --title <title>", "PR title")
  .option("-b, --body <body>", "PR body")
  .option("--base <branch>", "Base branch")
  .option("--head <branch>", "Head branch")
  .option("--draft", "Create as draft")
  .option("-f, --format <fmt>", "Output format: text | json", "text")
  .action(async function (
    this: { opts: () => { title?: string; body?: string; base?: string; head?: string; draft?: boolean; format?: string } }
  ) {
    const opts = this.opts();
    const cwd = process.cwd();
    if (!isGitRepo(cwd)) {
      console.log(chalk.red("Not a git repository"));
      process.exitCode = 1;
      return;
    }
    const result = createPr(cwd, {
      title: opts.title,
      body: opts.body,
      base: opts.base,
      head: opts.head,
      draft: opts.draft,
    });
    const format = (opts.format ?? "text").toLowerCase();
    if (format === "json") {
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.success ? 0 : 1;
      return;
    }
    if (result.success && result.output) {
      console.log(result.output);
    } else {
      console.log(chalk.red(result.error ?? "Failed to create PR"));
      process.exitCode = 1;
    }
  });

gitPrCmd
  .command("status")
  .description("Show PR status (gh pr status)")
  .option("-f, --format <fmt>", "Output format: text | json", "text")
  .action(async function (this: { opts: () => { format?: string } }) {
    const opts = this.opts();
    const cwd = process.cwd();
    if (!isGitRepo(cwd)) {
      console.log(chalk.red("Not a git repository"));
      process.exitCode = 1;
      return;
    }
    const result = prStatus(cwd);
    const format = (opts.format ?? "text").toLowerCase();
    if (format === "json") {
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.success ? 0 : 1;
      return;
    }
    if (result.success && result.output) {
      console.log(result.output);
    } else {
      console.log(chalk.red(result.error ?? "Failed to get PR status"));
      process.exitCode = 1;
    }
  });

gitCmd
  .command("branch-and-pr <branch>")
  .description("Create branch and open PR (gh). Branch-per-task flow.")
  .option("-t, --title <title>", "PR title")
  .option("-b, --body <body>", "PR body")
  .option("--base <branch>", "Base branch")
  .option("--draft", "Create as draft")
  .option("-f, --format <fmt>", "Output format: text | json", "text")
  .action(async function (
    this: { opts: () => { title?: string; body?: string; base?: string; draft?: boolean; format?: string } },
    branch: string
  ) {
    const opts = this.opts();
    const cwd = process.cwd();
    if (!isGitRepo(cwd)) {
      console.log(chalk.red("Not a git repository"));
      process.exitCode = 1;
      return;
    }
    const result = createBranchAndPr(cwd, branch, {
      title: opts.title,
      body: opts.body,
      base: opts.base,
      draft: opts.draft,
    });
    const format = (opts.format ?? "text").toLowerCase();
    if (format === "json") {
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.success ? 0 : 1;
      return;
    }
    if (result.success && result.output) {
      console.log(result.output);
    } else {
      console.log(chalk.red(result.error ?? "Failed"));
      process.exitCode = 1;
    }
  });

program
  .command("review")
  .description("Review queue: tasks needing approval (blocked)")
  .option("-n, --limit <n>", "Max tasks", "20")
  .option("-f, --format <fmt>", "Output format: text | json", "text")
  .action(async function (this: { opts: () => { limit?: string; format?: string } }) {
    const opts = this.opts();
    const limit = parseInt(opts.limit ?? "20", 10) || 20;
    const tasks = await listTasks({ status: "blocked", limit });
    const format = (opts.format ?? "text").toLowerCase();
    if (format === "json") {
      console.log(JSON.stringify({ queue: tasks.map((t) => ({ id: t.id, description: t.description, error: t.error, createdAt: t.createdAt })) }, null, 2));
      return;
    }
    console.log(renderBanner());
    console.log("\nReview queue (blocked, need approval):");
    for (const t of tasks) {
      console.log(`  ${chalk.cyan(t.id.slice(0, 8))} ${t.description.slice(0, 50)}${t.description.length > 50 ? "…" : ""}`);
      console.log(chalk.dim(`    gtd approve ${shortTaskId(t.id)}`));
    }
    if (tasks.length === 0) console.log(chalk.dim("  No tasks awaiting approval."));
  });

sessionCmd
  .command("handoff <id> [path]")
  .description("Export task state for session handoff (resume on another instance)")
  .option("-f, --format <fmt>", "Output format: text | json", "text")
  .option("-r, --remote <url>", "POST handoff bundle to a remote GTD API (e.g. gtd serve --api). Use ?run=1 to start retry/approve on the remote.")
  .action(async function (this: { opts: () => { format?: string; remote?: string } }, id: string, pathArg?: string) {
    const opts = this.opts();
    let task = await getTask(id);
    if (!task) {
      const tasks = await listTasks({ limit: 50 });
      task = tasks.find((t) => t.id.startsWith(id) || t.id === id);
    }
    if (!task) {
      console.log(chalk.red("Task not found"));
      process.exitCode = 1;
      return;
    }
    const handoff = {
      version: 1,
      cliVersion: pkg.version,
      taskId: task.id,
      description: task.description,
      status: task.status,
      plan: task.plan,
      outputs: task.outputs ?? {},
      error: task.error,
      createdAt: task.createdAt,
      hint: "Import this task and run gtd retry <id> to continue.",
    };
    const format = (opts.format ?? "text").toLowerCase();
    if (opts.remote) {
      const remoteUrl = opts.remote.replace(/\/$/, "") + "/api/handoff";
      const apiKey = process.env.GTD_API_KEY;
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
      try {
        const res = await fetch(remoteUrl, {
          method: "POST",
          headers,
          body: JSON.stringify(handoff),
        });
        const data = await res.json().catch(() => ({})) as { taskId?: string; imported?: boolean; error?: string; run?: boolean };
        if (!res.ok) {
          console.error(chalk.red(data?.error ?? `HTTP ${res.status}`));
          process.exitCode = 1;
          return;
        }
        if (format === "json") {
          console.log(JSON.stringify({ success: true, remote: remoteUrl, ...data }, null, 2));
        } else {
          console.log(chalk.green(`Handoff sent to ${remoteUrl}. Task ${data.taskId ?? task.id}${data.run ? " (run started on remote)" : ""}.`));
        }
      } catch (e) {
        console.error(chalk.red("Remote handoff failed: " + (e instanceof Error ? e.message : String(e))));
        process.exitCode = 1;
      }
      return;
    }
    if (pathArg) {
      const { writeFile } = await import("fs/promises");
      await writeFile(pathArg, JSON.stringify(handoff, null, 2), "utf-8");
      if (format === "json") {
        console.log(JSON.stringify({ success: true, path: pathArg, taskId: task.id }, null, 2));
      } else {
        console.log(chalk.green(`Handoff written to ${pathArg}. Run 'gtd retry ${shortTaskId(task.id)}' on target to resume.`));
      }
    } else {
      if (format === "json") {
        console.log(JSON.stringify(handoff, null, 2));
      } else {
        console.log(chalk.dim("Handoff JSON (use --path to write to file):"));
        console.log(JSON.stringify(handoff, null, 2));
      }
    }
  });

sessionCmd
  .command("handoff-import <file>")
  .description("Import handoff bundle from file (creates/updates task in store; then run gtd retry <id>)")
  .option("--dry-run", "Validate bundle only; do not import (K-20)")
  .action(async function (this: { opts: () => { dryRun?: boolean } }, filePath: string) {
    const opts = this.opts();
    const { readFile } = await import("fs/promises");
    let raw: string;
    try {
      raw = await readFile(filePath, "utf-8");
    } catch (e) {
      console.error(chalk.red("Cannot read file: " + (e instanceof Error ? e.message : String(e))));
      process.exitCode = 1;
      return;
    }
    let handoff: { taskId?: string; description?: string; status?: string; plan?: unknown; outputs?: Record<string, string>; error?: string; createdAt?: string };
    try {
      handoff = JSON.parse(raw) as typeof handoff;
    } catch (e) {
      console.error(chalk.red("Invalid JSON: " + (e instanceof Error ? e.message : String(e))));
      process.exitCode = 1;
      return;
    }
    const taskId = handoff.taskId;
    if (!taskId || typeof taskId !== "string" || !taskId.trim()) {
      console.error(chalk.red("Handoff bundle missing or invalid taskId (required)."));
      process.exitCode = 1;
      return;
    }
    if (!handoff.plan && (!handoff.outputs || Object.keys(handoff.outputs).length === 0)) {
      console.error(chalk.yellow("Warning: bundle has no plan and no outputs; gtd retry may have no context."));
    }
    if (opts.dryRun) {
      console.log(chalk.green(`Valid handoff bundle: taskId=${taskId}. Use without --dry-run to import.`));
      return;
    }
    const stored = toStored({
      id: taskId,
      description: handoff.description ?? "",
      source: "cli",
      qualityProfile: "balanced",
      approvalPolicy: "hybrid",
      status: (handoff.status as "pending" | "in_progress" | "blocked" | "completed" | "failed" | "cancelled") ?? "blocked",
      plan: handoff.plan as Parameters<typeof toStored>[0]["plan"],
      createdAt: handoff.createdAt ? new Date(handoff.createdAt) : new Date(),
    }, { error: handoff.error, outputs: handoff.outputs });
    await saveTask(stored);
    console.log(chalk.green(`Imported task ${shortTaskId(taskId)}. Run 'gtd retry ${shortTaskId(taskId)}' to continue.`));
  });

sessionCmd
  .command("handoff-apply <file>")
  .description("Apply handoff bundle output to local tree (writes code blocks from builder output to cwd)")
  .option("--dry-run", "List files that would be written")
  .action(async function (this: { opts: () => { dryRun?: boolean } }, filePath: string) {
    const opts = this.opts();
    const { readFile } = await import("fs/promises");
    const cwd = process.cwd();
    let raw: string;
    try {
      raw = await readFile(resolve(cwd, filePath), "utf-8");
    } catch (e) {
      console.error(chalk.red("Cannot read file: " + (e instanceof Error ? e.message : String(e))));
      process.exitCode = 1;
      return;
    }
    let handoff: { outputs?: Record<string, string> };
    try {
      handoff = JSON.parse(raw) as typeof handoff;
    } catch (e) {
      console.error(chalk.red("Invalid JSON: " + (e instanceof Error ? e.message : String(e))));
      process.exitCode = 1;
      return;
    }
    const builderOut = handoff.outputs?.builder ?? handoff.outputs?.documenter ?? Object.values(handoff.outputs ?? {})[0];
    if (!builderOut || typeof builderOut !== "string") {
      console.error(chalk.red("Handoff has no builder/documenter output to apply."));
      process.exitCode = 1;
      return;
    }
    const blocks = parseCodeBlocks(builderOut);
    if (blocks.length === 0) {
      console.log(chalk.yellow("No code blocks found in output."));
      return;
    }
    const { written, skipped } = await writeCodeBlocks(blocks, cwd, { dryRun: opts.dryRun });
    if (opts.dryRun) {
      console.log(chalk.dim("Would write: " + written.join(", ")));
    } else {
      console.log(chalk.green("Wrote: " + written.join(", ")));
      if (skipped.length) console.log(chalk.dim("Skipped: " + skipped.join(", ")));
    }
  });

program
  .command("start")
  .description("Start Skate and show welcome screen")
  .action(() => {
    console.log(renderBanner({ mode: "Hybrid", router: "Balanced", agentsActive: 6 }));
    console.log("Type 'gtd task \"<description>\"' to create a task, or 'gtd --help' for more commands.");
  });

program
  .command("init")
  .description("Generate a project context file (.gtd/rules.md) for agents (Gemini-style /init)")
  .option("-f, --force", "Overwrite existing .gtd/rules.md")
  .action(async (opts: { force?: boolean } = {}) => {
    const cwd = process.cwd();
    const rulesPath = join(cwd, ".gtd", "rules.md");
    const { mkdir, writeFile, readFile } = await import("fs/promises");
    try {
      await readFile(rulesPath, "utf-8");
      if (!opts.force) {
        console.log(chalk.yellow(".gtd/rules.md already exists. Use --force to overwrite."));
        return;
      }
    } catch {
      // file missing, ok to create
    }
    await mkdir(join(cwd, ".gtd"), { recursive: true });
    const template = `# Project context

Describe your project, stack, and conventions here. This file is loaded as context for Skate agents.

- **Stack:** (e.g. Node 20, TypeScript, React)
- **Conventions:** (e.g. prefer functional components, no default exports)
- **Paths:** (e.g. source in src/, tests in __tests__/)
`;
    await writeFile(rulesPath, template.trimEnd() + "\n", "utf-8");
    console.log(chalk.green(`Created ${rulesPath}. Edit it to add project context.`));
  });

/** Read stdin to a string (for headless: echo "desc" | gtd task). */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8").trim();
}

/** Read file at path or stdin (for IDE code actions: path from editor or pipe selection). */
async function readFileOrStdin(path?: string): Promise<string> {
  const p = (path ?? "").trim();
  if (p) {
    const { readFile } = await import("fs/promises");
    const abs = isAbsolute(p) ? p : resolve(process.cwd(), p);
    return readFile(abs, "utf-8");
  }
  return readStdin();
}

program
  .command("lint-suggest [cwd]")
  .description("Show detected primary language and suggested lint command (built-in per-language hints). Use for GTD_LINT_CMD or config.lintByLanguage.")
  .option("-C, --cd <path>", "Directory to detect language from (default: current)")
  .option("--list", "List all built-in linter commands by language")
  .action(async function (this: { opts: () => { cd?: string; list?: boolean } }, cwdArg?: string) {
    const opts = this.opts();
    const { BUILTIN_LINTER_BY_LANG, detectPrimaryLanguage, inferLintCmd } = await import("./lint-infer.js");
    const baseDir = opts.cd ?? cwdArg ?? process.cwd();
    const dir = resolve(baseDir);
    if (opts.list) {
      console.log("Built-in linter commands by language (used when no GTD_LINT_CMD or config):");
      const entries = Object.entries(BUILTIN_LINTER_BY_LANG).sort(([a], [b]) => a.localeCompare(b));
      for (const [lang, cmd] of entries) {
        console.log(`  ${chalk.cyan(lang.padEnd(12))} ${cmd}`);
      }
      console.log(chalk.dim("\nOverride with GTD_LINT_CMD, --lint-cmd, or config.lintByLanguage."));
      return;
    }
    const cfg = await loadConfig();
    const primary = await detectPrimaryLanguage(dir);
    const suggested = await inferLintCmd(dir, cfg);
    if (primary) {
      console.log(`Detected language: ${chalk.cyan(primary)}`);
      console.log(`Suggested lint:    ${chalk.green(suggested)}`);
      const builtin = BUILTIN_LINTER_BY_LANG[primary];
      if (builtin && builtin !== suggested) console.log(chalk.dim(`  (built-in default for ${primary}: ${builtin})`));
    } else {
      console.log("No primary language detected in " + dir);
      console.log(`Fallback lint:     ${chalk.green(suggested)}`);
    }
    console.log(chalk.dim("\nUse: gtd lint-suggest --list to see all built-in languages."));
  });

program
  .command("task [description]")
  .description("Create and execute a new task (description from arg, -p/--prompt, or stdin when piped)")
  .option("-p, --prompt <text>", "Task description (headless/scripting)")
  .option("-a, --auto", "Run fully autonomous (skip approval gates)")
  .option("--yolo", "Alias for --auto (auto-approve all tool actions)")
  .option("-q, --quality <level>", "Quality profile: fast | balanced | max", "balanced")
  .option("-m, --model <id>", "Override model (default: router selection)")
  .option("--api-key <key=value>", "Set API key for this run (e.g. OPENAI_API_KEY=sk-...); repeatable", collectConfig, [])
  .option("-w, --write", "Write Builder code blocks to files")
  .option("-o, --out-dir <dir>", "Output directory for --write (default: cwd)", process.cwd())
  .option("-d, --dry-run", "Run Scout and Planner only, show plan without executing")
  .option("-f, --format <fmt>", "Output format: text | json (only with --dry-run for plan; full task with json for headless)", "text")
  .option("--output-format <fmt>", "Alias for --format (headless/CI: use json for machine-readable response, stats, error)", "text")
  .option("--plan-format <fmt>", "Plan output format: text | json (Scout/Planner; use with --dry-run)", "text")
  .option("--stream", "Stream Builder output in real time")
  .option("--quiet", "Minimal output, only final result")
  .option("-i, --interactive", "Prompt to confirm or edit task description before running")
  .option("--no-progress", "Disable phase-based progress bar")
  .option("--timeout <seconds>", "Abort task after N seconds")
  .option("--step-timeout <seconds>", "Per-step timeout (abort current role step after N seconds; or set GTD_STEP_TIMEOUT_MS)")
  .option("--max-turns <n>", "Max agent steps (turns); stop when reached")
  .option("--max-tokens <n>", "Max total tokens (prompt + completion); stop when reached")
  .option("--output <path>", "Write deliverable to file (use - for stdout only)")
  .option("--print-only", "Print only the builder deliverable (PI-12)")
  .option("--mode <name>", "Named mode: architect (plan only) | debug (fast) | ask (require approval) | orchestrator (full pipeline)")
  .option("--permission-mode <mode>", "Tool permission: default | plan | accept-edits | dont-ask | bypass (aliases: acceptEdits, dontAsk, bypassPermissions). Example: gtd task 'fix lint' --permission-mode dont-ask")
  .option("--approval-mode <mode>", "Headless-style permission: auto_edit (accept file edits) or auto (dont-ask). Maps to --permission-mode.")
  .addHelpText("after", `
Permission modes (--permission-mode): default=ask | plan=read-only | accept-edits=auto edits | dont-ask=no prompts | bypass=skip policy
  default       Ask before running tools
  plan          Read-only; no file/shell writes
  accept-edits  Accept file edits without prompt (edit tier)
  dont-ask      No prompts (use session + project allow list)
  bypass        Skip policy checks (bash/full tier)`)
  .option("--container", "Run task inside Docker (set GTD_CONTAINER_IMAGE)")
  .option("--container-volume <mount>", "Extra container volume (host:container); repeatable (PI-17)", (v: string, prev: string[]) => (prev ?? []).concat(v), [])
  .option("--template <name>", "Planner template: fix-bug | add-feature | refactor | diagram | data-script | data-chart (prepends context for Planner)")
  .option("-t, --tag <tag>", "Add tag (repeatable)", collectTag, [])
  .option("--include-directories", "Prepend current directory listing to task (headless)")
  .option("--all-files", "Prepend note to consider all relevant files in context (use with care)")
  .option("-C, --cd <path>", "Set working directory for the task (Codex-style)")
  .option("-c, --config <key=value>", "Override config for this run (e.g. defaultModel=gpt-4o, permissionMode=dont-ask); repeatable", collectConfig, [])
  .option("--ephemeral", "Do not persist task to store (no history for this run)")
  .option("--no-auto-lint", "Disable running lint after task completes")
  .option("--lint-cmd <cmd>", "Lint command (default: GTD_LINT_CMD or npm run lint)")
  .option("--auto-test", "Run test command after task completes")
  .option("--test-cmd <cmd>", "Test command (default: GTD_TEST_CMD; e.g. npm test)")
  .option("--iterate-verify <n>", "On lint/test failure, re-run with failure in context up to N times (0=off). Env: GTD_AUTO_ITERATE_VERIFY", "0")
  .option("--git-commit-verify", "Run pre-commit hooks on auto-commits (default: skip with --no-verify)")
  .option("--edit-format <format>", "Builder edit format: diff (prefer apply_patch) or whole (prefer write_file/edit_file)")
  .option("--watch", "After running once, watch working directory and re-run task on file changes (IDE-style; debounced)")
  .option("--profile <name>", "Use named profile for this run (e.g. work, quick); merges config.profiles[name]")
  .option("--attempts <n>", "Run task N times (best-of-N); each run creates a task; compare with gtd show <id>", "1")
  .option("--output-schema <path>", "Validate JSON output against JSON Schema (use with --output; requires output file to be valid JSON)")
  .option("--result-schema <path>", "Validate task result JSON (--format json) against JSON Schema; fail with exit 1 if invalid")
  .option("--attach <path>", "Attach image for vision (PNG/JPEG/GIF/WebP); repeatable (e.g. --attach screenshot.png)", (v: string, prev: string[]) => (prev ?? []).concat(v), [])
  .action(async (description: string | undefined, opts: { prompt?: string; auto?: boolean; yolo?: boolean; approvalMode?: string; quality?: string; model?: string; write?: boolean; outDir?: string; dryRun?: boolean; format?: string; outputFormat?: string; planFormat?: string; stream?: boolean; quiet?: boolean; interactive?: boolean; progress?: boolean; timeout?: string; stepTimeout?: string; maxTurns?: string; maxTokens?: string; output?: string; printOnly?: boolean; mode?: string; permissionMode?: string; profile?: string; container?: boolean; containerVolume?: string[]; template?: string; tag?: string[]; includeDirectories?: boolean; allFiles?: boolean; cd?: string; config?: string[]; ephemeral?: boolean; autoLint?: boolean; lintCmd?: string; autoTest?: boolean; testCmd?: string; iterateVerify?: string; gitCommitVerify?: boolean; editFormat?: string; watch?: boolean; apiKey?: string[]; attempts?: string; outputSchema?: string; resultSchema?: string; attach?: string[] }) => {
    const approvalToPermission: Record<string, string> = { auto_edit: "accept-edits", auto: "dont-ask" };
    const inlineConfig: Record<string, string> = {};
    for (const pair of opts.config ?? []) {
      const eq = pair.indexOf("=");
      if (eq > 0) inlineConfig[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
    }
    const effectivePermission = opts.permissionMode ?? (inlineConfig.permissionMode ?? (opts.approvalMode ? approvalToPermission[opts.approvalMode.toLowerCase()] : undefined));
    let desc = (opts.prompt ?? description ?? "").trim();
    if (!desc && !process.stdin.isTTY) {
      try {
        desc = await readStdin();
      } catch {
        // ignore
      }
    }
    const templateName = (opts.template ?? "").toLowerCase();
    const builtinTemplates: Record<string, string> = {
      "fix-bug": "Fix the following bug. ",
      "add-feature": "Implement the following feature. ",
      "refactor": "Refactor as follows. ",
      "diagram": "Output a Mermaid or ASCII diagram for: ",
      "data-script": "Generate a runnable script (Python preferred, or Node/R if requested) that: ",
      "data-chart": "Generate code to produce a chart or plot from the given data or description. Output runnable code (e.g. Python matplotlib/seaborn or Node) and how to run it. ",
    };
    if (templateName) {
      let prefix = builtinTemplates[templateName];
      if (!prefix) {
        const cfg = await loadConfig();
        const merged = await getMergedTemplates(cfg);
        const custom = typeof merged[templateName] === "string" ? (merged[templateName] as string).trim() + " " : "";
        if (custom) prefix = custom;
      }
      if (prefix) desc = prefix + desc;
    }
    if (!desc) {
      console.error(chalk.red("Task description is required. Example: gtd task \"Add a README\""));
      process.exitCode = 1;
      return;
    }
    if (desc.length > 10000) {
      console.error(chalk.red("Task description must be at most 10000 characters."));
      process.exitCode = 1;
      return;
    }
    const timeout = opts.timeout ? parseInt(opts.timeout, 10) : undefined;
    const stepTimeoutMs = opts.stepTimeout ? Math.max(0, parseInt(opts.stepTimeout, 10) * 1000) || undefined : undefined;
    const maxTurns = opts.maxTurns ? parseInt(opts.maxTurns, 10) : undefined;
    const maxTokens = opts.maxTokens ? parseInt(opts.maxTokens, 10) : undefined;
    const runInDir = opts.cd ? resolve(process.cwd(), opts.cd) : null;
    const origCwd = runInDir ? process.cwd() : null;
    if (runInDir) process.chdir(runInDir);
    for (const kv of opts.apiKey ?? []) {
      const eq = kv.indexOf("=");
      if (eq > 0) {
        const key = kv.slice(0, eq).trim();
        const value = kv.slice(eq + 1).trim();
        if (key) process.env[key] = value;
      }
    }
    const attempts = Math.max(1, parseInt(opts.attempts ?? "1", 10) || 1);
    const taskIds: string[] = [];
    const taskCfg = await loadConfig();
    const taskCwd = runInDir ?? process.cwd();
    const attachPaths = opts.attach ?? [];
    const imageExtMime: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
    let taskAttachments: Array<{ type: "image_url"; image_url: { url: string } } | { type: "image"; data: string; mimeType?: string }> | undefined;
    if (attachPaths.length > 0) {
      const { readFile } = await import("fs/promises");
      taskAttachments = [];
      for (const p of attachPaths) {
        const abs = p.startsWith("/") || /^[A-Za-z]:/.test(p) ? p : resolve(taskCwd, p);
        const mime = imageExtMime[extname(abs).toLowerCase()];
        if (!mime) {
          if (!opts.quiet) console.warn(chalk.yellow("Skipping " + p + " (unsupported image type; use .png, .jpg, .gif, .webp)"));
          continue;
        }
        try {
          const buf = await readFile(abs);
          taskAttachments.push({ type: "image", data: buf.toString("base64"), mimeType: mime });
        } catch (e) {
          if (!opts.quiet) console.warn(chalk.yellow("Could not read " + p + ": " + (e instanceof Error ? e.message : String(e))));
        }
      }
      if (taskAttachments.length === 0) taskAttachments = undefined;
    }
    const { inferLintCmd } = await import("./lint-infer.js");
    const effectiveLintCmd = opts.lintCmd ?? process.env.GTD_LINT_CMD ?? taskCfg.lintCmd ?? await inferLintCmd(taskCwd, taskCfg);
    try {
    for (let i = 0; i < attempts; i++) {
      if (attempts > 1 && i > 0) console.log(chalk.dim(`\n--- Attempt ${i + 1}/${attempts} ---\n`));
      await runTask(desc, {
        auto: opts.auto ?? opts.yolo,
        quality: opts.quality ?? inlineConfig.qualityProfile,
        model: opts.model ?? inlineConfig.defaultModel,
        write: opts.write,
        outDir: opts.outDir,
        dryRun: opts.dryRun,
        format: opts.outputFormat ?? opts.format,
        planFormat: opts.planFormat,
        stream: opts.stream,
        quiet: opts.quiet,
        interactive: opts.interactive,
        useProgressBar: opts.progress !== false,
        timeout: timeout && timeout > 0 ? timeout : undefined,
        stepTimeoutMs: stepTimeoutMs && stepTimeoutMs > 0 ? stepTimeoutMs : undefined,
        maxTurns: maxTurns && maxTurns > 0 ? maxTurns : undefined,
        maxTokens: maxTokens && maxTokens > 0 ? maxTokens : undefined,
        output: opts.output,
        printOnly: opts.printOnly,
        mode: opts.mode,
        permissionMode: effectivePermission ?? opts.permissionMode ?? inlineConfig.permissionMode,
        container: opts.container,
        containerVolumes: opts.containerVolume?.length ? opts.containerVolume : undefined,
        tag: opts.tag,
        version: pkg.version,
        includeDirectories: opts.includeDirectories,
        allFiles: opts.allFiles,
        ephemeral: opts.ephemeral,
        autoLint: opts.autoLint,
        lintCmd: effectiveLintCmd,
        autoTest: opts.autoTest,
        testCmd: opts.testCmd ?? process.env.GTD_TEST_CMD ?? taskCfg.testCmd,
        autoIterateVerify: opts.iterateVerify != null ? Math.max(0, parseInt(opts.iterateVerify, 10) || 0) : undefined,
        gitCommitVerify: opts.gitCommitVerify,
        editFormat: opts.editFormat === "diff" || opts.editFormat === "whole" ? opts.editFormat : undefined,
        profile: opts.profile?.trim() || undefined,
        attachments: taskAttachments,
        resultSchema: opts.resultSchema?.trim() || undefined,
      });
      const recent = await listTasks({ limit: 1 });
      if (recent.length > 0) taskIds.push(recent[0].id);
    }
    if (attempts > 1 && taskIds.length > 0) {
      console.log(chalk.dim("\nBest-of-N: compare with gtd show <id> — " + taskIds.map((id) => shortTaskId(id)).join(", ")));
    }
    if (opts.watch) {
      const watchCmd = process.env.GTD_WATCH_CMD?.trim();
      const runTaskOpts = {
        auto: opts.auto ?? opts.yolo,
        quality: opts.quality ?? inlineConfig.qualityProfile,
        model: opts.model ?? inlineConfig.defaultModel,
        write: opts.write,
        outDir: opts.outDir,
        dryRun: opts.dryRun,
        format: opts.outputFormat ?? opts.format,
        planFormat: opts.planFormat,
        stream: opts.stream,
        quiet: opts.quiet,
        interactive: false,
        useProgressBar: opts.progress !== false,
        timeout: timeout && timeout > 0 ? timeout : undefined,
        stepTimeoutMs: stepTimeoutMs && stepTimeoutMs > 0 ? stepTimeoutMs : undefined,
        maxTurns: maxTurns && maxTurns > 0 ? maxTurns : undefined,
        maxTokens: maxTokens && maxTokens > 0 ? maxTokens : undefined,
        output: opts.output,
        printOnly: opts.printOnly,
        mode: opts.mode,
        permissionMode: effectivePermission ?? opts.permissionMode ?? inlineConfig.permissionMode,
        container: opts.container,
        containerVolumes: opts.containerVolume?.length ? opts.containerVolume : undefined,
        tag: opts.tag,
        version: pkg.version,
        includeDirectories: opts.includeDirectories,
        allFiles: opts.allFiles,
        ephemeral: opts.ephemeral,
        autoLint: opts.autoLint,
        lintCmd: effectiveLintCmd,
        autoTest: opts.autoTest,
        testCmd: opts.testCmd ?? process.env.GTD_TEST_CMD ?? taskCfg.testCmd,
        autoIterateVerify: opts.iterateVerify != null ? Math.max(0, parseInt(opts.iterateVerify, 10) || 0) : undefined,
        gitCommitVerify: opts.gitCommitVerify,
        editFormat: (opts.editFormat === "diff" || opts.editFormat === "whole" ? opts.editFormat : undefined) as "diff" | "whole" | undefined,
        profile: opts.profile?.trim() || undefined,
        attachments: taskAttachments,
      };
      const runAgain = async (): Promise<void> => {
        if (!opts.quiet) console.log(chalk.cyan("\n[Watch] Re-running task…\n"));
        try {
          await runTask(desc, runTaskOpts);
        } catch (e) {
          if (!opts.quiet) console.error(chalk.red("Watch re-run failed: " + (e instanceof Error ? e.message : String(e))));
        }
      };
      if (watchCmd) {
        const { spawn } = await import("child_process");
        const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
        const shFlag = process.platform === "win32" ? "/c" : "-c";
        const env = { ...process.env, GTD_TASK_DESCRIPTION: desc, GTD_TASK_CWD: taskCwd };
        if (!opts.quiet) console.log(chalk.dim(`\nRunning GTD_WATCH_CMD. Set GTD_TASK_DESCRIPTION / GTD_TASK_CWD in your script. Ctrl+C to stop.\n`));
        for (;;) {
          const child = spawn(shell, [shFlag, watchCmd], { stdio: "inherit", env, cwd: taskCwd });
          await new Promise<void>((res, rej) => {
            child.on("exit", (code) => { res(); if (code !== 0 && code != null) process.exitCode = code; });
            child.on("error", rej);
          });
          await runAgain();
        }
      }
      const { watch } = await import("fs");
      const watchDebounceMs = Math.max(1000, parseInt(process.env.GTD_WATCH_DEBOUNCE_MS ?? "3000", 10) || 3000);
      let watchTimer: ReturnType<typeof setTimeout> | null = null;
      const onFsChange = (): void => {
        if (watchTimer) return;
        watchTimer = setTimeout(async () => {
          watchTimer = null;
          await runAgain();
        }, watchDebounceMs);
      };
      try {
        watch(taskCwd, { recursive: true }, onFsChange);
        if (!opts.quiet) console.log(chalk.dim(`\nWatching ${taskCwd} (debounce ${watchDebounceMs}ms). Ctrl+C to stop. GTD_WATCH_CMD=… to use a custom watcher.`));
        await new Promise<void>(() => {});
      } catch (watchErr) {
        if (!opts.quiet) console.error(chalk.yellow("Watch failed: " + (watchErr instanceof Error ? watchErr.message : String(watchErr)) + ". Set GTD_WATCH_CMD to a command that exits once per change (e.g. inotifywait -e modify -r .)."));
      }
    }
    if (opts.outputSchema && opts.output && opts.output !== "-") {
      const { readFile } = await import("fs/promises");
      const cwd = process.cwd();
      const outPath = resolve(cwd, opts.output);
      const schemaPath = resolve(cwd, opts.outputSchema);
      try {
        const [schemaJson, outputJson] = await Promise.all([readFile(schemaPath, "utf-8"), readFile(outPath, "utf-8")]);
        const schema = JSON.parse(schemaJson) as object;
        let data: unknown;
        try {
          data = JSON.parse(outputJson);
        } catch {
          console.error(chalk.red("Output file is not valid JSON; cannot validate against schema."));
          process.exitCode = 1;
          return;
        }
        const { Ajv } = await import("ajv");
        const ajv = new Ajv();
        const validate = ajv.compile(schema);
        if (!validate(data)) {
          console.error(chalk.red("Output did not match schema:"));
          console.error(validate.errors);
          process.exitCode = 1;
        } else {
          console.log(chalk.green("Output validated against schema."));
        }
      } catch (e) {
        if (e instanceof SyntaxError) {
          console.error(chalk.red("Invalid schema JSON: " + e.message));
        } else {
          console.error(chalk.red("Schema validation failed: " + (e instanceof Error ? e.message : String(e))));
        }
        process.exitCode = 1;
      }
    }
    } finally {
      if (origCwd) process.chdir(origCwd);
    }
  });

const MAX_PARALLEL = 4;

program
  .command("run-parallel [desc1] [desc2] [desc3] [desc4]")
  .description("Run 2–4 tasks in parallel (same repo; use --worktrees for isolated worktrees; max 4). Use --from-plan to use step descriptions from a plan JSON (K-7).")
  .option("-q, --quiet", "Minimal output")
  .option("--worktrees", "Create N git worktrees, run one task per worktree in parallel, then report")
  .option("--merge", "After --worktrees, merge worktree branches into current branch (requires --worktrees)")
  .option("--cleanup", "After --worktrees (and optional --merge), remove worktree directories")
  .option("--cleanup-on-failure", "When --merge fails, still remove worktrees (K-15)")
  .option("--from-plan <path>", "Read plan JSON from path; use plan.steps[].description as task descriptions (2–4 steps; K-7)")
  .option("-f, --format <fmt>", "Output format: text | json (for summary; K-14)", "text")
  .action(async function (this: { opts: () => { quiet?: boolean; worktrees?: boolean; merge?: boolean; cleanup?: boolean; cleanupOnFailure?: boolean; fromPlan?: string; format?: string } }, desc1?: string, desc2?: string, desc3?: string, desc4?: string) {
    const opts = this.opts();
    const { spawn } = await import("child_process");
    const { readFile } = await import("fs/promises");
    const gtdBin = process.argv[1] ?? join(process.cwd(), "dist/cli/index.js");
    const cwd = process.cwd();
    let descriptions: string[];
    if (opts.fromPlan) {
      try {
        const raw = await readFile(opts.fromPlan, "utf-8");
        const data = JSON.parse(raw) as { plan?: { steps?: Array<{ description?: string }> } };
        const steps = data?.plan?.steps ?? [];
        descriptions = steps.map((s) => (s.description ?? "").trim()).filter(Boolean).slice(0, MAX_PARALLEL);
        if (descriptions.length < 2) {
          console.error(chalk.red("Plan must have at least 2 steps with descriptions. Found: " + descriptions.length));
          process.exitCode = 1;
          return;
        }
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e);
        console.error(chalk.red("Failed to read --from-plan file: " + err));
        process.exitCode = 1;
        return;
      }
    } else {
      descriptions = [desc1, desc2, desc3, desc4].filter((d): d is string => !!d).slice(0, MAX_PARALLEL);
      if (descriptions.length < 2) {
        console.error(chalk.red("Provide at least 2 task descriptions, or use --from-plan <plan.json>."));
        process.exitCode = 1;
        return;
      }
    }

    if (opts.worktrees) {
      if (!isGitRepo(cwd)) {
        console.error(chalk.red("Not a git repo. Run from repository root."));
        process.exitCode = 1;
        return;
      }
      const suffix = Date.now().toString(36);
      const worktrees = descriptions.map((_, i) => ({
        branch: `gtd-parallel-${i + 1}-${suffix}`,
        path: join(cwd, `worktree-parallel-${i + 1}`),
      }));
      const results = worktrees.map((w) => createWorktree(cwd, w.branch, w.path));
      if (!results.every((r) => r.success)) {
        console.error(chalk.red("Failed to create worktrees:"), results.find((r) => !r.success)?.error);
        process.exitCode = 1;
        return;
      }
      if (!opts.quiet) {
        worktrees.forEach((w, i) => console.log(chalk.cyan(`Worktree ${i + 1}:`), w.path, chalk.dim("(" + w.branch + ")")));
      }
      const runInCwd = (desc: string, workDir: string) =>
        new Promise<number>((resolve) => {
          const child = spawn(process.execPath, [gtdBin, "task", desc], { cwd: workDir, stdio: opts.quiet ? "pipe" : "inherit", env: process.env });
          child.on("exit", (code) => resolve(code ?? 0));
        });
      const codes = await Promise.all(descriptions.map((d, i) => runInCwd(d, worktrees[i].path)));
      const fmt = (opts.format ?? "text").toLowerCase();
      const report = { taskIds: worktrees.map((w, i) => ({ branch: w.branch, path: w.path, exitCode: codes[i] })), merged: [] as string[], mergeFailed: false };
      if (!opts.quiet && fmt !== "json") {
        console.log(chalk.cyan("\nSummary:"));
        codes.forEach((code, i) => console.log(`  Task ${i + 1}:`, code === 0 ? chalk.green("ok") : chalk.red("exit " + code)));
      }
      if (opts.merge && codes.some((c) => c === 0)) {
        const { execSync } = await import("child_process");
        try {
          worktrees.forEach((w, i) => {
            if (codes[i] === 0) {
              execSync(`git merge ${w.branch} --no-edit`, { cwd, stdio: opts.quiet ? "pipe" : "inherit" });
              report.merged.push(w.branch);
            }
          });
          if (!opts.quiet && fmt !== "json") console.log(chalk.green("Merged worktree branches into current branch."));
        } catch {
          report.mergeFailed = true;
          if (!opts.quiet && fmt !== "json") {
            console.log(chalk.yellow("Merge had conflicts or failed (K-13). Resolve manually: git status, fix conflicts, then git add && git commit."));
            console.log(chalk.dim("Worktrees left at: " + worktrees.map((w) => w.path).join(", ")));
            console.log(chalk.dim("To merge a single branch: git merge <branch> --no-edit (or --no-ff)."));
          }
          process.exitCode = 1;
        }
      } else if (!opts.quiet && !opts.merge && fmt !== "json") {
        console.log(chalk.dim("Worktrees left at " + worktrees.map((w) => w.path).join(", ") + ". Remove with: git worktree remove <path>"));
      }
      const cleanupOnFailure = (opts as { cleanupOnFailure?: boolean }).cleanupOnFailure;
      const doCleanup = opts.cleanup || (report.mergeFailed && cleanupOnFailure);
      if (doCleanup) {
        const { execSync } = await import("child_process");
        for (const w of worktrees) {
          try { execSync(`git worktree remove "${w.path}" --force`, { cwd, stdio: "pipe" }); } catch { /* ignore */ }
        }
        if (!opts.quiet && fmt !== "json") console.log(chalk.dim("Worktrees removed."));
      }
      if (fmt === "json") {
        console.log(JSON.stringify({ tasks: report.taskIds, merged: report.merged, mergeFailed: report.mergeFailed }, null, 2));
      }
      if (codes.some((c) => c !== 0)) process.exitCode = Math.max(...codes);
      return;
    }

    const run = (desc: string) =>
      new Promise<number>((resolve) => {
        const child = spawn(process.execPath, [gtdBin, "task", desc], { cwd, stdio: opts.quiet ? "pipe" : "inherit", env: process.env });
        child.on("exit", (code) => resolve(code ?? 0));
      });
    const codes = await Promise.all(descriptions.map(run));
    if (opts.quiet && codes.some((c) => c !== 0)) process.exitCode = Math.max(...codes);
  });

program
  .command("last")
  .description("Show last run summary (most recent task)")
  .option("-f, --format <fmt>", "Output format: text | json", "text")
  .action(async function (this: { opts: () => { format?: string } }) {
    const opts = this.opts();
    const tasks = await listTasks({ limit: 1 });
    const task = tasks[0];
    const format = (opts.format ?? "text").toLowerCase();
    if (!task) {
      if (format === "json") {
        console.log(JSON.stringify({ last: null }, null, 2));
      } else {
        console.log(chalk.dim("No tasks yet. Run gtd task \"<description>\" to start."));
      }
      return;
    }
    if (format === "json") {
      const lastPayload: Record<string, unknown> = { id: task.id, description: task.description, status: task.status, createdAt: task.createdAt, completedAt: task.completedAt, error: task.error };
      if (task.usage) lastPayload.usage = task.usage;
      const estCost = estimateTaskCost(task);
      if (estCost !== undefined) lastPayload.estimatedCost = estCost;
      console.log(JSON.stringify({ last: lastPayload }, null, 2));
      return;
    }
    const statusColor = task.status === "completed" ? chalk.green : task.status === "failed" ? chalk.red : chalk.yellow;
    console.log(chalk.bold("Last run:"));
    console.log(`  ${chalk.cyan(task.id.slice(0, 8))} ${statusColor(task.status)} ${task.description.slice(0, 60)}${task.description.length > 60 ? "…" : ""}`);
    console.log(`  Created: ${task.createdAt}`);
    if (task.completedAt) {
      console.log(`  Completed: ${task.completedAt}`);
      const created = task.createdAt ? new Date(task.createdAt).getTime() : NaN;
      const completed = new Date(task.completedAt).getTime();
      if (Number.isFinite(created) && Number.isFinite(completed) && completed >= created) {
        console.log(`  Duration: ${formatDuration(completed - created)}`);
      }
    }
    if (task.error) console.log(chalk.red(`  Error: ${task.error}`));
    const estCost = estimateTaskCost(task);
    if (estCost !== undefined) console.log(chalk.dim(`  Estimated cost: ~ $${estCost.toFixed(2)} (see gtd show ${task.id.slice(0, 8)} for full usage)`));
  });

program
  .command("run-step <taskId> <stepIndex> [stepDescription]")
  .description("Run a single plan step for an existing task (optional stepDescription override for logs/handoff)")
  .option("-f, --format <fmt>", "Output format: text | json", "text")
  .option("-d, --description <text>", "Override step description for this run (logs and handoff)")
  .action(async function (this: { opts: () => { format?: string; description?: string } }, idArg: string, stepIndexArg: string, stepDescriptionArg?: string) {
    const opts = this.opts();
    await loadAndApplyModelsConfig();
    let task = await getTask(idArg);
    if (!task) {
      const tasks = await listTasks({ limit: 50 });
      task = tasks.find((t) => t.id.startsWith(idArg) || t.id === idArg);
    }
    if (!task) {
      console.error(chalk.red(`Task ${idArg} not found.`));
      process.exitCode = 1;
      return;
    }
    if (!task.plan?.steps?.length || !task.outputs) {
      console.error(chalk.red("Task must have a plan and outputs (e.g. run once or dry-run first)."));
      process.exitCode = 1;
      return;
    }
    const stepIndex = parseInt(stepIndexArg, 10);
    if (!Number.isFinite(stepIndex) || stepIndex < 1 || stepIndex > task.plan.steps.length) {
      console.error(chalk.red(`Step index must be 1–${task.plan.steps.length}.`));
      process.exitCode = 1;
      return;
    }
    const step = task.plan.steps[stepIndex - 1];
    const roleOrder = ["scout", "planner", "builder", "reviewer", "documenter"];
    const roleIdx = roleOrder.indexOf(step.assignedRole);
    if (roleIdx < 0) {
      console.error(chalk.red(`Step role ${step.assignedRole} is not supported for run-step.`));
      process.exitCode = 1;
      return;
    }
    const outputsBefore: Record<string, string> = {};
    for (let i = 0; i < roleIdx; i++) {
      const r = roleOrder[i];
      if (task.outputs[r]) outputsBefore[r] = task.outputs[r];
    }
    const stepDescOverride = opts.description ?? stepDescriptionArg ?? step.description;
    const format = (opts.format ?? "text").toLowerCase();
    if (format !== "json") {
      console.log(chalk.cyan(`Running step ${stepIndex} (${step.assignedRole}): ${(stepDescOverride ?? step.description).slice(0, 50)}…`));
    }
    try {
      const cfg = await loadConfig();
      const result = await runOrchestration({
        taskId: task.id,
        taskDescription: task.description,
        qualityProfile: task.qualityProfile,
        approvalPolicy: "auto",
        resumeFrom: { outputs: outputsBefore, plan: task.plan },
        runOnlyStepIndex: stepIndex,
        modelOverrides: cfg.modelOverrides,
        toolPolicy: resolvePolicy({ mode: "dont-ask" }, null),
        onProgress: (_phase, role, status) => {
          if (format === "json") return;
          if (role && status === "done") console.log(chalk.green(`✓ ${role} done`));
          else if (role && status === "running") console.log(chalk.cyan(`… ${role} running…`));
        },
      });
      const outputsRecord = Object.fromEntries(result.outputs);
      const mergedOutputs = { ...task.outputs, ...outputsRecord };
      await saveTask(toStored({
        id: result.taskId,
        description: task.description,
        source: task.source,
        sourceId: task.sourceId,
        qualityProfile: task.qualityProfile,
        approvalPolicy: task.approvalPolicy,
        status: result.status,
        plan: result.plan ?? task.plan,
      }, {
        completedAt: new Date().toISOString(),
        error: result.error,
        outputs: mergedOutputs,
        usage: result.usage,
        usageByModel: result.usageByModel,
      }));
      if (result.status === "completed") {
        const out = result.outputs.get(step.assignedRole);
        if (format === "json") {
          console.log(JSON.stringify({ success: true, taskId: result.taskId, stepIndex, role: step.assignedRole, output: out ?? undefined }, null, 2));
        } else if (out) {
          console.log(chalk.bold("\n--- Output ---\n") + out);
        } else {
          console.log(chalk.green("\n✓ Step completed."));
        }
      } else {
        if (format === "json") {
          console.log(JSON.stringify({ success: false, taskId: result.taskId, status: result.status, error: result.error }, null, 2));
          process.exitCode = 1;
        } else {
          console.log(chalk.red("\n✗ " + (result.error ?? "Step failed")));
          process.exitCode = 1;
        }
      }
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      if (format === "json") {
        console.log(JSON.stringify({ success: false, error: err }, null, 2));
      } else {
        console.log(chalk.red("\n✗ Error: " + err));
      }
      process.exitCode = 1;
    }
  });

program
  .command("interactive [files...]")
  .alias("repl")
  .description("REPL for multiple tasks in one session (task \"...\", status, exit). Optional files are added to session (Aider-style).")
  .option("--tui", "Use TUI layout (panel)")
  .option("--map-tokens <n>", "Repo map token budget (default: GTD_MAP_TOKENS or 1024); when no session files, budget is increased for dynamic sizing")
  .option("--no-auto-commits", "Disable auto-commit after agent edits")
  .option("--no-dirty-commits", "Don't commit dirty files before running task")
  .option("--no-git", "Disable all git use (no auto-commit, no dirty commit, no init prompt)")
  .option("--chat-mode <mode>", "Start in chat mode: code | ask | architect | help")
  .option("--architect", "Shortcut for --chat-mode architect")
  .option("--editor-model <id>", "Editor model for architect/editor role")
  .option("--no-auto-lint", "Disable auto-lint after task completes")
  .option("--lint-cmd <cmd>", "Lint command (default: GTD_LINT_CMD or npm run lint)")
  .option("--auto-test", "Run test command after each task")
  .option("--test-cmd <cmd>", "Test command (default: GTD_TEST_CMD)")
  .option("--git-commit-verify", "Run pre-commit hooks on auto-commits")
  .option("--profile <name>", "Use named profile for this session (e.g. work, quick); merges config.profiles[name]")
  .option("--multiline", "Multiline mode: Enter = newline, submit with line \".\" only")
  .option("--api-key <key=value>", "Set API key for this session (e.g. OPENAI_API_KEY=sk-...); repeatable", collectConfig, [])
  .option("--vim", "Prefer Vi keybindings (auto-spawns rlwrap with vi mode when available)")
  .action(async (opts: { tui?: boolean; mapTokens?: string; noAutoCommits?: boolean; noDirtyCommits?: boolean; noGit?: boolean; chatMode?: string; architect?: boolean; editorModel?: string; profile?: string; autoLint?: boolean; lintCmd?: string; autoTest?: boolean; testCmd?: string; gitCommitVerify?: boolean; multiline?: boolean; apiKey?: string[]; vim?: boolean } = {}, cmd?: { args?: string[] }) => {
    const initialFiles: string[] = (cmd?.args ?? []).filter((a): a is string => typeof a === "string");
    for (const kv of opts.apiKey ?? []) {
      const eq = kv.indexOf("=");
      if (eq > 0) {
        const key = kv.slice(0, eq).trim();
        const value = kv.slice(eq + 1).trim();
        if (key) process.env[key] = value;
      }
    }
    if (opts.vim) process.env.GTD_VIM = "1";
    if (opts.vim && !process.env.GTD_VIM_RLWRAP_DONE && process.stdin.isTTY) {
      const { spawnSync, spawn } = await import("child_process");
      const check = spawnSync("rlwrap", ["--version"], { encoding: "utf8", stdio: "pipe" });
      if (check.status === 0) {
        const gtdBin = process.argv[1] ?? join(process.cwd(), "dist/cli/index.js");
        const args = process.argv.slice(2).filter((a) => a !== "--vim");
        const viInputrc = join(getDataDir(), ".inputrc-vi");
        const { writeFile } = await import("fs/promises");
        await writeFile(viInputrc, "set editing-mode vi\n", "utf-8").catch(() => {});
        const env = { ...process.env, GTD_VIM_RLWRAP_DONE: "1", INPUTRC: viInputrc };
        const child = spawn("rlwrap", ["-a", gtdBin, "interactive", ...args], { stdio: "inherit", env });
        child.on("exit", (code, sig) => { process.exit(code ?? (sig ? 1 : 0)); });
        return;
      }
    }
    let interactiveCfg = await loadConfigForCwd(process.cwd());
    if (opts.profile?.trim() && interactiveCfg.profiles?.[opts.profile.trim()]) {
      interactiveCfg = { ...interactiveCfg, ...interactiveCfg.profiles[opts.profile.trim()] };
    }
    const sessionProfileName = opts.profile?.trim() ?? interactiveCfg.defaultProfile;
    const { inferLintCmd: inferLintCmdRepl } = await import("./lint-infer.js");
    const replLintCmd = opts.lintCmd ?? interactiveCfg.lintCmd ?? await inferLintCmdRepl(process.cwd(), interactiveCfg);
    const { createInterface } = await import("readline");
    let drawStaticTUI: () => void;
    let drawLiveTUI: (state: { currentTask?: string; history: string[] }) => void;
    let useBlessedInput = false;
    let askInputBlessed: (prompt: string) => Promise<string> = async () => "";
    if (opts.tui) {
      try {
        const tui = await import("./interactive-tui-blessed.js");
        if (tui.useBlessed) {
          drawStaticTUI = tui.drawStaticTUI;
          drawLiveTUI = tui.drawLiveTUI;
          useBlessedInput = true;
          askInputBlessed = tui.askInput;
        } else {
          const def = await import("./interactive-tui.js");
          drawStaticTUI = def.drawStaticTUI;
          drawLiveTUI = def.drawLiveTUI;
        }
      } catch {
        const def = await import("./interactive-tui.js");
        drawStaticTUI = def.drawStaticTUI;
        drawLiveTUI = def.drawLiveTUI;
      }
    } else {
      const def = await import("./interactive-tui.js");
      drawStaticTUI = def.drawStaticTUI;
      drawLiveTUI = def.drawLiveTUI;
    }
    const tuiState: {
      currentTask?: string;
      history: string[];
      suggestions?: string[];
      recentTasks?: Array<{ id: string; description: string; status: string }>;
      mcpTools?: Array<{ serverId: string; name: string }>;
    } | undefined = opts?.tui
      ? { currentTask: undefined, history: [], suggestions: [], recentTasks: [], mcpTools: [] }
      : undefined;
    const REPL_COMMANDS = ["task", "status", "show", "inbox", "search", "history", "approve", "retry", "cancel", "delete", "refresh", "clear", "stats", "tools", "mcp", "privacy", "extensions", "settings", "config", "bug", "editor", "copy", "theme", "auth", "directory", "chat", "chat-mode", "new", "diff", "undo", "commit", "git", "logout", "model", "models", "provider", "editor-model", "weak-model", "permissions", "personality", "persona", "agent", "ps", "experimental", "fork", "statusline", "queue", "edit", "edit-line", "compose", "inject", "reset", "run", "test", "lint", "voice", "web", "paste", "tokens", "report", "code", "ask", "architect", "help-mode", "multiline-mode", "ok", "reasoning-effort", "think-tokens", "sandbox-add-read-dir", "add", "drop", "read-only", "ls", "map", "map-refresh", "copy-context", "load", "save", "memory", "help", "exit", "quit", "setup"];
    const REPL_HELP: Record<string, string> = {
      task: "Run a task: task \"<description>\"",
      status: "Show task status (or list recent): status [id]",
      show: "Show full task details: show <id>",
      provider: "List providers or set session model to first enabled model of provider",
      model: "Show or set session model for next task(s): model [id]",
      models: "List enabled models by provider; optional search: models [query]",
      settings: "Print current merged config (keys redacted)",
      config: "Same as settings — print current config (redacted)",
      help: "List slash commands; help <command> for one command",
      clear: "Clear screen; new conversation hint",
      reset: "Drop all session files and clear context (confirmation when destructive)",
      exit: "Exit REPL; optional save session before exit",
      quit: "Same as exit",
      load: "Load and execute commands from file (one per line; # = comment); lines may use / prefix",
      save: "Save commands to reconstruct session (add + read-only + last task)",
      memory: "Show MEMORY.md; memory add <text> | edit | trim [chars] | session add <text> | session clear",
      setup: "Run first-run/on-demand setup wizard (provider, model, quality)",
    };
    const PRESET_PERSONAS: Record<string, string> = {
      minimal: "Be concise. Minimal prose; only essential information.",
      professional: "Use a clear, professional tone. Structure explanations and recommendations.",
      poetic: "You may use a more creative or expressive tone when appropriate.",
    };
    const refreshTUIState = async (): Promise<void> => {
      if (!tuiState) return;
      try {
        const tasks = await listTasks({ limit: 10 });
        const suggest: string[] = [];
        for (const t of tasks) {
          if (t.status === "blocked") suggest.push("Run: gtd approve " + shortTaskId(t.id));
          if (t.status === "failed") suggest.push("Run: gtd retry " + shortTaskId(t.id));
        }
        if (suggest.length < 4 && tasks.length > 0) {
          const last = tasks[0];
          if (last.status === "completed") suggest.push("Run: gtd show " + shortTaskId(last.id));
          else if (last.status === "in_progress") suggest.push("Run: gtd status " + shortTaskId(last.id));
        }
        tuiState.suggestions = suggest.slice(0, 4);
        tuiState.recentTasks = tasks.slice(0, 5).map((t) => ({ id: t.id, description: t.description, status: t.status }));
        try {
          const servers = await listMcpServers();
          const tools: Array<{ serverId: string; name: string }> = [];
          for (const s of servers) {
            const r = await listMcpTools(s);
            if (r.success && r.tools) for (const t of r.tools) tools.push({ serverId: s.id, name: t.name });
          }
          tuiState.mcpTools = tools;
        } catch {
          // ignore MCP refresh
        }
      } catch {
        // ignore
      }
    };
    if (!process.env.GTD_SESSION_ID) process.env.GTD_SESSION_ID = uuidv4();
    if (opts.tui) {
      drawStaticTUI();
      await refreshTUIState();
      if (tuiState) drawLiveTUI(tuiState);
      const mcpRefreshInterval = setInterval(async () => {
        await refreshTUIState();
        if (tuiState) drawLiveTUI(tuiState);
      }, 60_000);
      const clearMcpInterval = () => { clearInterval(mcpRefreshInterval); };
      process.on("exit", clearMcpInterval);
      process.on("SIGINT", () => { clearMcpInterval(); });
    } else {
      console.log(renderBanner());
      console.log(chalk.dim("Interactive mode. Commands: task \"<description>\", status [id], show <id>, inbox, search [query], history, approve <id>, retry <id>, cancel <id>, delete <id>, refresh, help, exit"));
      console.log(chalk.dim("Shortcuts: Tab = complete, Ctrl+C = cancel, Ctrl+R = reverse history search. Session ID: " + process.env.GTD_SESSION_ID + "\n"));
      const { found: rulesFound } = await getRulesPathsAndFound(process.cwd());
      if (rulesFound.length > 0) console.log(chalk.dim(`Context: ${rulesFound.length} file(s) loaded.\n`));
    }

    const completer = (line: string, callback: (err: Error | null, result?: [string[], string]) => void): void => {
      const trimmed = line.trimStart().replace(/^\s*\/+/, "").trimStart();
      const firstWord = trimmed.split(/\s+/)[0] ?? "";
      const rest = trimmed.slice(firstWord.length).trimStart();
      if (!rest) {
        const hits = REPL_COMMANDS.filter((c) => c.startsWith(firstWord.toLowerCase()));
        if (hits.length === 1 && hits[0] !== "task") return callback(null, [[hits[0] + " "], firstWord]);
        return callback(null, [hits.length ? hits : REPL_COMMANDS, firstWord]);
      }
      const cmd = firstWord.toLowerCase();
      if (cmd === "provider") {
        const models = listModels().filter((c) => c.enabled);
        const providers = [...new Set(models.map((c) => c.metadata.provider).filter(Boolean))].sort() as string[];
        const hits = rest ? providers.filter((p) => p.toLowerCase().startsWith(rest.toLowerCase())) : providers;
        return callback(null, [hits.map((p) => "provider " + p), rest]);
      }
      if (cmd === "model") {
        const models = listModels().filter((c) => c.enabled);
        const ids = models.map((c) => c.metadata.id);
        const hits = rest ? ids.filter((id) => id.toLowerCase().startsWith(rest.toLowerCase())) : ids.slice(0, 15);
        return callback(null, [hits.map((id) => "model " + id), rest]);
      }
      const idCommands = ["show", "status", "approve", "retry", "cancel", "delete"];
      if (!idCommands.includes(cmd)) return callback(null, [[], ""]);
      const prefix = rest;
      const taskIds = tuiState?.recentTasks?.map((t) => t.id) ?? [];
      const completeFromTasks = (ids: string[]) => {
        const hits = prefix ? ids.filter((id) => id.startsWith(prefix) || id.slice(0, 8).startsWith(prefix)) : ids.slice(0, 10);
        const withCmd = hits.map((id) => (cmd === "status" ? "status " + id : cmd + " " + id));
        return [withCmd, prefix] as [string[], string];
      };
      if (taskIds.length) return callback(null, completeFromTasks(taskIds));
      listTasks({ limit: 30 })
        .then((tasks) => callback(null, completeFromTasks(tasks.map((t) => t.id))))
        .catch(() => callback(null, [[], ""]));
    };
    const rl = useBlessedInput ? null : createInterface({
      input: process.stdin,
      output: process.stdout,
      completer,
    });
    const historyPath = join(getDataDir(), "repl-history");
    const rlHistory = rl && "history" in rl ? (rl as { history: string[] }).history : undefined;
    if (rl && rlHistory) {
      try {
        const { readFile } = await import("fs/promises");
        const raw = await readFile(historyPath, "utf-8");
        const lines = raw.split("\n").filter(Boolean).slice(-100);
        for (const l of lines) rlHistory.push(l);
      } catch {
        // no history file yet
      }
    }
    const appendHistory = async (line: string): Promise<void> => {
      if (!line) return;
      try {
        const { appendFile } = await import("fs/promises");
        await appendFile(historyPath, line + "\n", "utf-8");
      } catch {
        // ignore
      }
      if (rlHistory) rlHistory.push(line);
    };
    const question = async (prompt: string): Promise<string> => {
      if (useBlessedInput) return askInputBlessed(prompt);
      if (rlHistory && process.stdin.isTTY && rlHistory.length >= 0) {
        const { readLineWithHistory } = await import("./readline-ctrlr.js");
        return readLineWithHistory(prompt, [...rlHistory]);
      }
      return new Promise((resolve) => rl!.question(prompt, (a) => resolve((a ?? "").trim())));
    };

    const runStatus = async (idArg?: string): Promise<void> => {
      if (idArg) {
        let task = await getTask(idArg);
        if (!task) {
          const tasks = await listTasks({ limit: 50 });
          task = tasks.find((t) => t.id.startsWith(idArg) || t.id === idArg);
        }
        if (!task) {
          console.log(chalk.red(`Task ${idArg} not found.`));
          return;
        }
        console.log(`  ID: ${task.id}`);
        console.log(`  Description: ${task.description}`);
        console.log(`  Status: ${task.status}`);
        if (task.tags?.length) console.log(`  Tags: ${task.tags.join(", ")}`);
      } else {
        const tasks = await listTasks({ limit: 10 });
        if (tasks.length === 0) {
          console.log("No tasks.");
          return;
        }
        const tagStr = (t: { tags?: string[] }) => (t.tags?.length ? ` [${t.tags.join(", ")}]` : "");
        for (const t of tasks) {
          const statusColor = t.status === "completed" ? chalk.green : t.status === "failed" ? chalk.red : chalk.yellow;
          console.log(`  ${chalk.cyan(t.id.slice(0, 8))} ${statusColor(t.status)} ${t.description.slice(0, 40)}${t.description.length > 40 ? "…" : ""}${tagStr(t)}`);
        }
      }
    };

    const resolveTask = async (idArg: string) => {
      let task = await getTask(idArg);
      if (!task) {
        const tasks = await listTasks({ limit: 50 });
        task = tasks.find((t) => t.id.startsWith(idArg) || t.id === idArg);
      }
      return task;
    };

    const runApprove = async (idArg: string): Promise<void> => {
      await loadAndApplyModelsConfig();
      const task = await resolveTask(idArg);
      if (!task) {
        console.log(chalk.red(`Task ${idArg} not found.`));
        return;
      }
      if (task.status !== "blocked") {
        console.log(chalk.yellow(`Task ${task.id} is not blocked (status: ${task.status}).`));
        return;
      }
      if (!task.outputs || !task.plan) {
        console.log(chalk.red("Blocked task missing outputs or plan."));
        return;
      }
      try {
        const result = await runOrchestration({
          taskId: task.id,
          taskDescription: task.description,
          qualityProfile: task.qualityProfile,
          approvalPolicy: "auto",
          resumeFrom: { outputs: task.outputs, plan: task.plan },
          modelOverrides: (await loadConfig()).modelOverrides,
          customAgents: (await loadConfig()).agents,
          profileRoles: (await loadConfig()).profileRoles,
          onProgress: (_p, role, status) => {
            if (role && status === "done") console.log(chalk.green(`✓ ${role} done`));
            else if (role && status === "running") console.log(chalk.cyan(`… ${role} running…`));
          },
        });
        const outputsRecord = Object.fromEntries(result.outputs);
        await saveTask(toStored({
          id: result.taskId,
          description: task.description,
          source: task.source,
          sourceId: task.sourceId,
          qualityProfile: task.qualityProfile,
          approvalPolicy: task.approvalPolicy,
          status: result.status,
          plan: result.plan,
        }, {
          completedAt: new Date().toISOString(),
          error: result.error,
          outputs: outputsRecord,
          usage: result.usage,
          usageByModel: result.usageByModel,
        }), { expectedUpdatedAt: task.updatedAt });
        if (result.status === "completed") {
          const out = result.outputs.get("builder");
          if (out) console.log(chalk.bold("\n--- Deliverable ---\n") + out);
          else console.log(chalk.green("\n✓ Task completed."));
        } else {
          console.log(chalk.red("\n✗ " + (result.error ?? "Task failed")));
        }
      } catch (e) {
        if (e instanceof TaskConflictError) console.log(chalk.yellow("\n⊘ " + e.message));
        else console.log(chalk.red("\n✗ Error: " + (e instanceof Error ? e.message : String(e))));
      }
    };

    const runRetry = async (idArg: string, fromStep?: string, followUp?: string): Promise<void> => {
      await loadAndApplyModelsConfig();
      const task = await resolveTask(idArg);
      if (!task) {
        console.log(chalk.red(`Task ${idArg} not found.`));
        return;
      }
      if (task.status !== "failed") {
        console.log(chalk.yellow(`Task ${task.id} is not failed (status: ${task.status}).`));
        return;
      }
      if (!task.outputs || !task.plan) {
        console.log(chalk.red("Failed task missing outputs or plan."));
        return;
      }
      let resumeOutputs = task.outputs;
      if (fromStep) {
        const validSteps = ["scout", "planner", "builder", "reviewer", "documenter"];
        if (validSteps.includes(fromStep.toLowerCase())) {
          resumeOutputs = truncateOutputsForStep(task.outputs, fromStep.toLowerCase());
          console.log(chalk.dim(`Retrying from step: ${fromStep}`));
        }
      }
      const description = followUp ? `${task.description}\n\nFollow-up: ${followUp}` : task.description;
      if (followUp) console.log(chalk.dim(`Follow-up: ${followUp.slice(0, 60)}${followUp.length > 60 ? "…" : ""}`));
      try {
        const result = await runOrchestration({
          taskId: task.id,
          taskDescription: description,
          qualityProfile: task.qualityProfile,
          approvalPolicy: "auto",
          resumeFrom: { outputs: resumeOutputs, plan: task.plan },
          modelOverrides: (await loadConfig()).modelOverrides,
          customAgents: (await loadConfig()).agents,
          profileRoles: (await loadConfig()).profileRoles,
          onProgress: (_p, role, status) => {
            if (role && status === "done") console.log(chalk.green(`✓ ${role} done`));
            else if (role && status === "running") console.log(chalk.cyan(`… ${role} running…`));
          },
        });
        const outputsRecord = Object.fromEntries(result.outputs);
        await saveTask(toStored({
          id: result.taskId,
          description: task.description,
          source: task.source,
          sourceId: task.sourceId,
          qualityProfile: task.qualityProfile,
          approvalPolicy: task.approvalPolicy,
          status: result.status,
          plan: result.plan,
        }, {
          completedAt: new Date().toISOString(),
          error: result.error,
          outputs: outputsRecord,
          usage: result.usage,
          usageByModel: result.usageByModel,
        }), { expectedUpdatedAt: task.updatedAt });
        if (result.status === "completed") {
          const out = result.outputs.get("builder");
          if (out) console.log(chalk.bold("\n--- Deliverable ---\n") + out);
          else console.log(chalk.green("\n✓ Task completed."));
        } else {
          console.log(chalk.red("\n✗ " + (result.error ?? "Task failed")));
        }
      } catch (e) {
        if (e instanceof TaskConflictError) console.log(chalk.yellow("\n⊘ " + e.message));
        else console.log(chalk.red("\n✗ Error: " + (e instanceof Error ? e.message : String(e))));
      }
    };

    const runCancel = async (idArg: string): Promise<void> => {
      const task = await resolveTask(idArg);
      if (!task) {
        console.log(chalk.red(`Task ${idArg} not found.`));
        return;
      }
      if (task.status !== "in_progress") {
        console.log(chalk.yellow(`Task ${task.id} is not in progress (status: ${task.status}).`));
        return;
      }
      await requestCancel(task.id);
      console.log(chalk.green(`Cancel requested for ${task.id}.`));
    };

    const runDelete = async (idArg: string): Promise<void> => {
      const task = await resolveTask(idArg);
      if (!task) {
        console.log(chalk.red(`Task ${idArg} not found.`));
        return;
      }
      const answer = await question(`Delete task ${task.id}? (y/N): `);
      if (answer.toLowerCase() !== "y" && answer.toLowerCase() !== "yes") {
        console.log("Cancelled.");
        return;
      }
      const ok = await deleteTask(task.id);
      if (ok) {
        console.log(chalk.green(`Deleted task ${task.id}`));
      } else {
        console.log(chalk.red(`Failed to delete ${task.id}`));
      }
    };

    const runSearch = async (query?: string): Promise<void> => {
      const tasks = await searchTasks({ query: query || undefined, limit: 15 });
      if (tasks.length === 0) {
        console.log("No matching tasks.");
        return;
      }
      const tagStr = (t: { tags?: string[] }) => (t.tags?.length ? chalk.dim(` [${t.tags.join(", ")}]`) : "");
      for (const t of tasks) {
        const statusColor = t.status === "completed" ? chalk.green : t.status === "failed" ? chalk.red : chalk.yellow;
        console.log(`  ${chalk.cyan(t.id.slice(0, 8))} ${statusColor(t.status)} ${t.description.slice(0, 45)}${t.description.length > 45 ? "…" : ""}${tagStr(t)}`);
      }
    };

    const runHistory = async (): Promise<void> => {
      const completed = await listTasks({ status: "completed", limit: 10 });
      const failed = await listTasks({ status: "failed", limit: 10 });
      const all = [...completed, ...failed].sort(
        (a, b) => new Date(b.completedAt ?? b.createdAt).getTime() - new Date(a.completedAt ?? a.createdAt).getTime()
      ).slice(0, 10);
      if (all.length === 0) {
        console.log("No completed or failed tasks.");
        return;
      }
      const tagStr = (t: { tags?: string[] }) => (t.tags?.length ? chalk.dim(` [${t.tags.join(", ")}]`) : "");
      for (const t of all) {
        const statusColor = t.status === "completed" ? chalk.green : chalk.red;
        const date = t.completedAt ?? t.createdAt;
        console.log(`  ${chalk.cyan(t.id.slice(0, 8))} ${statusColor(t.status)} ${t.description.slice(0, 40)}${t.description.length > 40 ? "…" : ""}${tagStr(t)} (${date})`);
      }
    };

    const printSuggestions = async (): Promise<void> => {
      const failed = await listTasks({ status: "failed", limit: 3 });
      const blocked = await listTasks({ status: "blocked", limit: 3 });
      const parts: string[] = [];
      if (failed.length) parts.push(`Run: gtd retry ${failed[0].id.slice(0, 8)}`);
      if (blocked.length) parts.push(`Run: gtd approve ${blocked[0].id.slice(0, 8)}`);
      if (parts.length) console.log(chalk.dim("Suggestions: " + parts.join(" | ")));
    };

    const runStats = async (): Promise<void> => {
      const summary = await getUsageSummary({ limit: 30 });
      console.log(chalk.bold("Usage (last 30 tasks):"));
      console.log(`  Tasks: ${summary.totalTasks}`);
      console.log(`  Prompt tokens: ${summary.totalPromptTokens}`);
      console.log(`  Completion tokens: ${summary.totalCompletionTokens}`);
      if (Object.keys(summary.byModel).length > 0) {
        console.log("  By model:");
        for (const [model, u] of Object.entries(summary.byModel)) {
          console.log(`    ${model}: prompt ${u.promptTokens}, completion ${u.completionTokens} (${u.tasks} tasks)`);
        }
      }
    };

    const runShell = async (command: string): Promise<void> => {
      const { execSync } = await import("child_process");
      try {
        const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
        const out = execSync(command, { encoding: "utf8", cwd: process.cwd(), shell });
        if (out) console.log(out);
      } catch (e: unknown) {
        const err = e as { status?: number; stdout?: string; stderr?: string };
        if (err.stdout) console.log(err.stdout);
        if (err.stderr) console.error(chalk.red(err.stderr));
        if (err.status !== undefined) console.log(chalk.dim(`Exit code: ${err.status}`));
      }
    };

    const runToolsList = (withDesc: boolean): void => {
      const tools = listTools();
      if (withDesc) {
        for (const t of tools) {
          console.log(`  ${chalk.cyan(t.name)} (${t.category}) — ${t.description}`);
        }
      } else {
        console.log(tools.map((t) => t.name).join(" "));
      }
    };

    const runMcpDesc = async (): Promise<void> => {
      const servers = await listMcpServers();
      if (servers.length === 0) {
        console.log(chalk.dim("No MCP servers registered. Use gtd mcp add."));
        return;
      }
      for (const s of servers) {
        console.log(chalk.bold(`  ${s.id}`));
        const r = await listMcpTools(s);
        if (r.success && r.tools?.length) {
          for (const t of r.tools) {
            console.log(`    ${chalk.cyan(t.name)} — ${t.description ?? "(no description)"}`);
          }
        } else if (!r.success) {
          console.log(chalk.dim(`    (error: ${r.error})`));
        }
      }
    };

    const runMcpSchema = async (): Promise<void> => {
      const servers = await listMcpServers();
      const out: Record<string, Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>> = {};
      for (const s of servers) {
        const r = await listMcpTools(s);
        if (r.success && r.tools?.length) {
          out[s.id] = r.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
        }
      }
      console.log(JSON.stringify(out, null, 2));
    };

    const runAgent = (): void => {
      console.log(chalk.bold("Pipeline (roles):"));
      console.log(chalk.dim("  scout → planner → builder → reviewer → documenter"));
      const overrides = (interactiveCfg as { modelOverrides?: Record<string, string> }).modelOverrides;
      if (overrides && Object.keys(overrides).length > 0) {
        console.log(chalk.dim("  Per-role models (config.modelOverrides):"));
        for (const [role, id] of Object.entries(overrides)) console.log("    " + role + ": " + id);
      }
      console.log(chalk.dim("  Plan only: gtd task --mode architect \"...\""));
      console.log(chalk.dim("  Set per-role: config.modelOverrides in config file; session model: model <id>"));
    };

    const runPs = async (): Promise<void> => {
      const [inProgress, blocked, recent] = await Promise.all([
        listTasks({ status: "in_progress", limit: 10 }),
        listTasks({ status: "blocked", limit: 5 }),
        listTasks({ limit: 8 }),
      ]);
      if (inProgress.length > 0) {
        console.log(chalk.bold("In progress:"));
        for (const t of inProgress) console.log(`  ${chalk.cyan(shortTaskId(t.id))} ${t.description.slice(0, 50)}${t.description.length > 50 ? "…" : ""}`);
      }
      if (blocked.length > 0) {
        console.log(chalk.bold("Blocked:"));
        for (const t of blocked) console.log(`  ${chalk.yellow(shortTaskId(t.id))} ${t.description.slice(0, 50)}${t.description.length > 50 ? "…" : ""} — gtd approve ${shortTaskId(t.id)}`);
      }
      if (inProgress.length === 0 && blocked.length === 0 && recent.length > 0) {
        console.log(chalk.bold("Recent:"));
        for (const t of recent.slice(0, 6)) {
          const statusColor = t.status === "completed" ? chalk.green : t.status === "failed" ? chalk.red : chalk.dim;
          console.log(`  ${chalk.cyan(shortTaskId(t.id))} ${statusColor(t.status)} ${t.description.slice(0, 45)}${t.description.length > 45 ? "…" : ""}`);
        }
      }
      if (inProgress.length === 0 && blocked.length === 0 && recent.length === 0) console.log(chalk.dim("No tasks. Start with: task \"<description>\""));
    };

    const runPrivacy = (): void => {
      console.log(chalk.bold("Privacy"));
      console.log("  Skate runs tasks locally. Task descriptions and outputs are sent to configured LLM providers when you run a task.");
      console.log("  Telemetry: set GTD_TELEMETRY=0 to disable.");
      console.log(chalk.dim("  Full notice: gtd privacy"));
    };

    const runExtensions = async (): Promise<void> => {
      const pluginsDir = process.env.GTD_PLUGINS_DIR || "node_modules";
      const dir = isAbsolute(pluginsDir) ? pluginsDir : join(process.cwd(), pluginsDir);
      const plugins = await discoverPluginsWithPaths(dir);
      if (plugins.length === 0) {
        console.log(chalk.dim(`No plugins found in ${dir}. Set GTD_PLUGINS_DIR to search elsewhere.`));
        return;
      }
      for (const { manifest } of plugins) {
        console.log(`  ${chalk.cyan(manifest.name ?? manifest.id)} ${chalk.dim(manifest.version ?? "")} — ${manifest.description ?? ""}`);
      }
    };

    const runEditor = (): void => {
      const e = process.env.EDITOR ?? "(not set)";
      const v = process.env.VISUAL ?? "(not set)";
      console.log(chalk.dim(`EDITOR: ${e}`));
      console.log(chalk.dim(`VISUAL: ${v}`));
      console.log(chalk.dim("To change: set EDITOR or VISUAL in your shell. Used by: settings command."));
    };

    const runTheme = (): void => {
      const noColor = process.env.NO_COLOR ?? "(not set)";
      console.log(chalk.dim(`NO_COLOR: ${noColor} (disable colors when set)`));
      console.log(chalk.dim("Terminal theme controls colors. Configurable themes: see docs/reference/configuration.md."));
    };

    const runAuth = (): void => {
      console.log(chalk.dim("API keys: set OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, or GOOGLE_API_KEY."));
      console.log(chalk.dim("Check: gtd doctor. Config: docs/reference/configuration.md."));
    };

    const runSettings = async (): Promise<void> => {
      const cfg = { ...interactiveCfg } as Record<string, unknown>;
      for (const key of Object.keys(cfg)) {
        if (/key|secret|token|password/i.test(key)) cfg[key] = "(redacted)";
      }
      console.log(chalk.bold("Current config (merged, redacted):"));
      console.log(JSON.stringify(cfg, null, 2));
      console.log(chalk.dim("Config file: " + getActiveConfigPath()));
      console.log(chalk.dim("Run: gtd config path — to open, set EDITOR or VISUAL and run your editor on that path."));
    };

    const runBug = async (headline?: string): Promise<void> => {
      const cfg = await loadConfig();
      const baseUrl = (cfg as { bugReportUrl?: string }).bugReportUrl ?? process.env.GTD_BUG_REPORT_URL ?? "";
      if (!baseUrl) {
        console.log(chalk.dim("Set config.bugReportUrl or GTD_BUG_REPORT_URL (e.g. https://github.com/org/repo/issues/new?title=)."));
        return;
      }
      const url = headline ? `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}title=${encodeURIComponent(headline.trim())}` : baseUrl;
      console.log(chalk.dim("Bug report: " + url));
      const openCmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
      try {
        const { execSync } = await import("child_process");
        execSync(`${openCmd} "${url.replace(/"/g, '\\"')}"`, { stdio: "ignore" });
      } catch {
        // ignore; URL already printed
      }
    };

    const runCopy = async (idArg: string): Promise<void> => {
      const task = await resolveTask(idArg);
      if (!task) {
        console.log(chalk.red(`Task ${idArg} not found.`));
        return;
      }
      const text = task.outputs?.builder ?? task.outputs?.documenter ?? "";
      if (!text) {
        console.log(chalk.yellow(`Task ${task.id} has no builder/documenter output to copy.`));
        return;
      }
      const copyCmd = process.env.GTD_COPY_CMD || (process.platform === "darwin" ? "pbcopy" : process.platform === "win32" ? "clip" : "xclip -selection clipboard");
      try {
        const { spawnSync } = await import("child_process");
        const result = spawnSync(copyCmd, process.platform === "win32" ? [] : ["-"], { input: text, shell: process.platform === "win32", encoding: "utf8" });
        if (result.status === 0) console.log(chalk.green("Copied to clipboard."));
        else console.log(chalk.dim("Clipboard command failed. Run: gtd show " + shortTaskId(task.id)));
      } catch {
        console.log(chalk.dim("No clipboard command. Set GTD_COPY_CMD or run: gtd show " + shortTaskId(task.id)));
      }
    };

    const runCopyLast = async (): Promise<void> => {
      const tasks = await listTasks({ limit: 1 });
      if (!tasks[0]) {
        console.log(chalk.yellow("No tasks yet. Run a task first."));
        return;
      }
      await runCopy(tasks[0].id);
    };

    const runReset = (): void => {
      sessionFiles.length = 0;
      sessionReadOnly.clear();
      sessionQueue = undefined;
      lastTaskDesc = undefined;
      repoMapCache = null;
      console.log(chalk.green("Dropped all files and cleared context. New conversation."));
    };

    const runSetup = async (): Promise<void> => {
      const { spawn } = await import("child_process");
      const child = spawn(process.argv[0], [process.argv[1]!, "setup"], { stdio: "inherit", cwd: process.cwd() });
      await new Promise<void>((resolve) => child.on("exit", () => resolve()));
    };

    const runTest = async (cmd: string): Promise<void> => {
      const { execSync } = await import("child_process");
      const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
      try {
        const out = execSync(cmd, { encoding: "utf8", cwd: process.cwd(), shell });
        if (out) console.log(out);
        console.log(chalk.green("Tests passed."));
      } catch (e: unknown) {
        const err = e as { status?: number; stdout?: string; stderr?: string };
        const out = (err.stdout ?? "") + (err.stderr ?? "");
        if (out) console.log(out);
        console.log(chalk.red("Test failed (exit " + (err.status ?? "?") + "). Output queued for next task."));
        sessionQueue = "[Test failed]\n```\n" + out.trim().slice(0, 12000) + (out.length > 12000 ? "\n…" : "") + "\n```";
      }
    };

    const runLint = async (): Promise<void> => {
      const lintCmd = sessionLintCmd ?? process.env.GTD_LINT_CMD ?? "npm run lint";
      const { execSync } = await import("child_process");
      const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
      try {
        const out = execSync(lintCmd, { encoding: "utf8", cwd: process.cwd(), shell });
        if (out) console.log(out);
        console.log(chalk.green("Lint passed."));
      } catch (e: unknown) {
        const err = e as { status?: number; stdout?: string; stderr?: string };
        const out = (err.stdout ?? "") + (err.stderr ?? "");
        if (out) console.log(out);
        console.log(chalk.red("Lint failed. Output queued for next task."));
        const { parseVerifyOutput } = await import("./verify.js");
        sessionQueue = formatVerifyForModel(parseVerifyOutput(out), "lint");
      }
    };

    const runEditorCompose = async (): Promise<string | null> => {
      return runEditorWithInitial(lastTaskDesc ?? "");
    };

    /** Open EDITOR with initial content; return trimmed result (for /edit-line / Ctrl-X Ctrl-E style). */
    const runEditorWithInitial = async (initial: string): Promise<string | null> => {
      const editor = process.env.EDITOR || process.env.VISUAL;
      if (!editor) {
        console.log(chalk.dim("Set EDITOR or VISUAL to use an external editor."));
        return null;
      }
      const { writeFile, readFile, unlink } = await import("fs/promises");
      const { spawnSync } = await import("child_process");
      const tmpPath = join((await import("os")).tmpdir(), `gtd-prompt-${Date.now()}.txt`);
      await writeFile(tmpPath, initial, "utf-8");
      spawnSync(editor, [tmpPath], { stdio: "inherit" });
      const content = (await readFile(tmpPath, "utf-8")).trim();
      try {
        await unlink(tmpPath);
      } catch {
        // ignore
      }
      return content || null;
    };

    const runVoice = async (): Promise<void> => {
      const cmd = process.env.GTD_VOICE_CMD?.trim();
      if (!cmd) {
        console.log(chalk.dim("Set GTD_VOICE_CMD to a command that records and outputs transcript to stdout (e.g. sox + whisper)."));
        return;
      }
      try {
        const { execSync } = await import("child_process");
        const out = execSync(cmd, { encoding: "utf8", cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] });
        const text = (out ?? "").trim();
        if (text) {
          sessionQueue = "[Voice]\n\n" + text.slice(0, 50000);
          console.log(chalk.green("Voice transcript queued for next task (" + text.length + " chars)."));
        } else {
          console.log(chalk.dim("No transcript output. Ensure GTD_VOICE_CMD writes to stdout."));
        }
      } catch (e) {
        console.log(chalk.red("Voice command failed: " + (e instanceof Error ? e.message : String(e))));
      }
    };

    const runWeb = async (url: string): Promise<void> => {
      const maxChars = Math.min(500_000, Math.max(1000, parseInt(process.env.GTD_WEB_MAX_CHARS ?? "15000", 10) || 15000));
      try {
        const res = await fetch(url, { headers: { "User-Agent": "gtd/1.0" } });
        const html = await res.text();
        const stripped = html
          .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
          .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, maxChars);
        sessionQueue = "[From web: " + url + "]\n\n" + stripped;
        console.log(chalk.green("Fetched and queued for next task (" + stripped.length + " chars)."));
      } catch (e) {
        console.log(chalk.red("Fetch failed: " + (e instanceof Error ? e.message : String(e))));
      }
    };

    const runPaste = async (name?: string): Promise<void> => {
      const maxChars = Math.min(500_000, Math.max(1000, parseInt(process.env.GTD_PASTE_MAX_CHARS ?? "50000", 10) || 50000));
      const tryImagePaste = async (): Promise<boolean> => {
        const { execSync } = await import("child_process");
        const { writeFile, readFile, unlink } = await import("fs/promises");
        const { tmpdir } = await import("os");
        const tmpPath = join(tmpdir(), `gtd-paste-${Date.now()}.png`);
        const absPath = resolve(tmpPath);
        try {
          if (process.platform === "darwin") {
            try {
              execSync(`pngpaste "${absPath}"`, { stdio: "pipe" });
            } catch {
              execSync(
                `osascript -e 'set png_data to the clipboard as «class PNGf»' -e 'set f to open for access POSIX file "${absPath}" with write permission' -e 'write png_data to f' -e 'close access f'`,
                { stdio: "pipe" }
              );
            }
          } else if (process.platform === "win32") {
            const psPath = join(tmpdir(), `gtd-paste-${Date.now()}.ps1`);
            const psScript = [
              "Add-Type -AssemblyName System.Windows.Forms",
              "Add-Type -AssemblyName System.Drawing",
              "$img = [System.Windows.Forms.Clipboard]::GetImage()",
              "if ($img) { $img.Save([char]34 + $args[0] + [char]34, [System.Drawing.Imaging.ImageFormat]::Png) }",
            ].join("; ");
            await writeFile(psPath, psScript, "utf-8");
            try {
              execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${psPath}" "${absPath}"`, { stdio: "pipe" });
            } finally {
              await unlink(psPath).catch(() => {});
            }
          } else {
            try {
              execSync(`xclip -selection clipboard -t image/png -o > "${absPath}"`, { stdio: "pipe", shell: "/bin/sh" });
            } catch {
              execSync(`wl-paste --type image/png > "${absPath}"`, { stdio: "pipe", shell: "/bin/sh" });
            }
          }
          const buf = await readFile(absPath);
          if (buf.length === 0) return false;
          await unlink(absPath).catch(() => {});
          const base64 = buf.toString("base64");
          sessionAttachments.push({ type: "image", data: base64, mimeType: "image/png" });
          sessionQueue = (name ? `[Image pasted: ${name}]\n\n` : "[Image pasted]\n\n") + (sessionQueue ?? "");
          console.log(chalk.green("Image pasted; will be attached to next task."));
          return true;
        } catch {
          return false;
        }
      };
      const didImage = await tryImagePaste();
      if (didImage) return;
      const pasteCmd =
        process.platform === "darwin" ? "pbpaste" : process.platform === "win32" ? "powershell -Command Get-Clipboard" : "xclip -selection clipboard -o";
      try {
        const { execSync } = await import("child_process");
        const out = execSync(pasteCmd, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
        const text = (out ?? "").trim();
        if (text) {
          const label = name ? `[Pasted from clipboard: ${name}]\n\n` : "[Pasted from clipboard]\n\n";
          sessionQueue = label + text.slice(0, maxChars) + (text.length > maxChars ? "\n… (truncated)" : "");
          console.log(chalk.green("Pasted " + text.length + " chars" + (name ? ` as "${name}"` : "") + "; queued for next task."));
        } else {
          console.log(chalk.dim("Clipboard empty or not text. Image paste: macOS (built-in), Linux (xclip or wl-paste), Windows (PowerShell)."));
        }
      } catch {
        console.log(chalk.dim("Paste failed. Use pbpaste/xclip/Get-Clipboard or paste manually."));
      }
    };

    const runModelsList = (query?: string): void => {
      const models = listModels();
      const enabled = models.filter((c) => c.enabled);
      const toShow = query ? enabled.filter((c) => (c.metadata.id + " " + (c.metadata.provider ?? "") + " " + (c.metadata.name ?? "")).toLowerCase().includes(query.toLowerCase())) : enabled;
      if (toShow.length === 0) {
        console.log(chalk.dim(query ? "No enabled models matching \"" + query + "\"." : "No enabled models. Run: gtd models enable <id>"));
        return;
      }
      const byProvider = new Map<string, typeof toShow>();
      for (const c of toShow) {
        const p = c.metadata.provider ?? "other";
        if (!byProvider.has(p)) byProvider.set(p, []);
        byProvider.get(p)!.push(c);
      }
      console.log(chalk.bold("Enabled models" + (query ? " (filter: " + query + ")" : "") + ", by provider:"));
      for (const [provider, list] of [...byProvider.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        console.log(chalk.dim("  " + provider + ":"));
        for (const c of list) {
          const cap: string[] = [];
          if (c.metadata.supportsTools) cap.push("tools");
          if (c.metadata.supportsVision) cap.push("vision");
          const ctx = c.metadata.contextWindow >= 1000 ? (c.metadata.contextWindow / 1000).toFixed(0) + "k" : String(c.metadata.contextWindow);
          cap.push(ctx);
          console.log("    " + chalk.cyan(c.metadata.id) + chalk.dim(" — " + (c.metadata.name ?? "") + " [" + cap.join(", ") + "]"));
        }
      }
    };

    /** Session workspace roots (directory add/show). Used as workspaceRoots when running tasks from REPL. */
    const sessionDirectories: string[] = [];
    /** Aider-style: files added to the chat session (paths relative to cwd or absolute). */
    const sessionFiles: string[] = initialFiles.map((f) => (isAbsolute(f) || /^[A-Za-z]:/.test(f) ? f : resolve(process.cwd(), f)));
    /** Aider-style: paths that are read-only (reference only, do not edit). */
    const sessionReadOnly = new Set<string>();
    /** Cached repo map; null = needs refresh. */
    let repoMapCache: string | null = null;
    const mapTokens = Math.max(
      256,
      parseInt(opts.mapTokens ?? process.env.GTD_MAP_TOKENS ?? String(interactiveCfg.mapTokens ?? 1024), 10) || 1024
    );
    /** Session overrides for next runTask (model, permissionMode). */
    let sessionModelOverride: string | undefined;
    let sessionPermissionOverride: string | undefined;
    let sessionPersonality: string | undefined;
    /** Editor model (e.g. architect mode); weak model (e.g. commit messages). */
    let sessionEditorModelOverride: string | undefined;
    let sessionWeakModelOverride: string | undefined;
    /** Queued text to prepend to next task (queue follow-up for next turn). */
    let sessionQueue: string | undefined;
    /** Image (and other) attachments for the next task (e.g. from /paste when clipboard has image). Cleared after task runs. */
    const sessionAttachments: Array<{ type: "image_url"; image_url: { url: string } } | { type: "image"; data: string; mimeType?: string }> = [];
    /** Last task description (for edit previous message). */
    let lastTaskDesc: string | undefined;
    /** When a task is running in background (no await), so user can type 'inject <msg>'. */
    let runningTaskId: string | undefined;
    const injectedQueue: string[] = [];
    /** Queued follow-up to suggest when running task completes (item 69). */
    let injectedFollowUp: string | undefined;
    /** Session-only memory (this REPL session); passed to runTask as sessionMemory; not persisted to MEMORY.md. */
    const sessionSessionMemory: string[] = [];
    /** When true, every line is run as shell command until user types ! again. */
    let shellMode = false;
    /** Queued commands from /load <file> (batch execution). */
    const sessionCommandQueue: string[] = [];
    /** Multiline mode: Enter = newline, submit with line "." only (--multiline or /multiline-mode). */
    let sessionMultilineMode = opts.multiline ?? false;
    /** Reasoning effort (e.g. low/medium/high); passed to runTask when supported. */
    let sessionReasoningEffort: string | undefined;
    /** Thinking token budget (e.g. 8k, 0.5M, 0 to disable); passed to runTask when supported. */
    let sessionThinkTokens: string | undefined;
    const sessionNoGit = opts.noGit ?? false;
    const sessionNoAutoCommits = opts.noAutoCommits ?? false;
    const sessionNoDirtyCommits = opts.noDirtyCommits ?? false;
    type ChatMode = "code" | "ask" | "architect" | "help";
    const validChatModes: ChatMode[] = ["code", "ask", "architect", "help"];
    let sessionChatMode: ChatMode =
      validChatModes.includes((opts.architect ? "architect" : opts.chatMode ?? "code") as ChatMode)
        ? ((opts.architect ? "architect" : opts.chatMode ?? "code") as ChatMode)
        : "code";
    let nextMessageModeOverride: ChatMode | undefined;
    if (opts.editorModel) sessionEditorModelOverride = opts.editorModel;
    const sessionAutoLint = opts.autoLint !== false;
    const sessionLintCmd = replLintCmd;
    const sessionAutoTest = opts.autoTest ?? false;
    const sessionTestCmd = opts.testCmd ?? interactiveCfg.testCmd;
    const sessionGitCommitVerify = opts.gitCommitVerify ?? false;
    const runDirectoryShow = (): void => {
      const cwd = process.cwd();
      const roots = process.env.GTD_WORKSPACE_ROOTS?.split(",").map((p) => p.trim()).filter(Boolean) ?? [];
      if (sessionDirectories.length === 0 && roots.length === 0) {
        console.log(chalk.dim("Workspace: cwd only. Add paths with: directory add <path>. Or set GTD_WORKSPACE_ROOTS."));
        return;
      }
      if (sessionDirectories.length > 0) {
        console.log(chalk.bold("Session directories:"));
        sessionDirectories.forEach((p, i) => console.log(`  ${i + 1}. ${resolve(cwd, p)}`));
      }
      if (roots.length > 0) {
        console.log(chalk.bold("GTD_WORKSPACE_ROOTS:"));
        roots.forEach((p, i) => console.log(`  ${i + 1}. ${p.startsWith("/") || /^[A-Za-z]:/.test(p) ? p : resolve(cwd, p)}`));
      }
    };
    const runDirectoryAdd = (pathArg: string): void => {
      const cwd = process.cwd();
      const abs = pathArg.startsWith("/") || /^[A-Za-z]:/.test(pathArg) ? pathArg : resolve(cwd, pathArg);
      if (sessionDirectories.includes(abs)) {
        console.log(chalk.dim("Already in list: " + abs));
        return;
      }
      sessionDirectories.push(abs);
      console.log(chalk.green("Added: " + abs));
    };

    /** Aider-style: build added-files context string for runTask. */
    const buildAddedFilesContext = async (): Promise<string | undefined> => {
      if (sessionFiles.length === 0) return undefined;
      const cwd = process.cwd();
      const { readFile } = await import("fs/promises");
      const parts: string[] = ["Session files (in chat; edit unless marked read-only):"];
      for (const p of sessionFiles) {
        const abs = p.startsWith("/") || /^[A-Za-z]:/.test(p) ? p : resolve(cwd, p);
        const ro = sessionReadOnly.has(abs) || sessionReadOnly.has(p);
        try {
          const content = await readFile(abs, "utf-8");
          const capped = content.length > 30000 ? content.slice(0, 30000) + "\n… (truncated)" : content;
          parts.push(`--- ${p}${ro ? " [read-only, do not edit]" : ""} ---\n${capped}\n`);
        } catch {
          parts.push(`--- ${p} (unable to read) ---\n`);
        }
      }
      return parts.join("\n");
    };

    const runAdd = (args: string): void => {
      const cwd = process.cwd();
      const paths = args.trim().split(/\s+/).filter(Boolean);
      for (const p of paths) {
        const abs = p.startsWith("/") || /^[A-Za-z]:/.test(p) ? p : resolve(cwd, p);
        if (sessionFiles.includes(abs)) {
          console.log(chalk.dim("Already in session: " + abs));
        } else {
          sessionFiles.push(abs);
          console.log(chalk.green("Added: " + abs));
        }
      }
    };
    const runDrop = (args: string): void => {
      const cwd = process.cwd();
      const paths = args.trim().split(/\s+/).filter(Boolean);
      for (const p of paths) {
        const abs = p.startsWith("/") || /^[A-Za-z]:/.test(p) ? p : resolve(cwd, p);
        const i = sessionFiles.indexOf(abs);
        if (i >= 0) {
          sessionFiles.splice(i, 1);
          sessionReadOnly.delete(abs);
          sessionReadOnly.delete(p);
          console.log(chalk.green("Dropped: " + abs));
        } else {
          console.log(chalk.dim("Not in session: " + abs));
        }
      }
    };
    const runReadOnly = (args: string): void => {
      const cwd = process.cwd();
      const paths = args.trim().split(/\s+/).filter(Boolean);
      for (const p of paths) {
        const abs = p.startsWith("/") || /^[A-Za-z]:/.test(p) ? p : resolve(cwd, p);
        if (!sessionFiles.includes(abs)) sessionFiles.push(abs);
        sessionReadOnly.add(abs);
        sessionReadOnly.add(p);
        console.log(chalk.green("Read-only: " + abs));
      }
    };
    const runLs = (): void => {
      const cwd = process.cwd();
      if (sessionFiles.length === 0) {
        console.log(chalk.dim("No files in session. Use: add <path> or start with: gtd interactive <file1> [file2 ...]"));
        return;
      }
      console.log(chalk.bold("Session files:"));
      for (const p of sessionFiles) {
        const abs = p.startsWith("/") || /^[A-Za-z]:/.test(p) ? p : resolve(cwd, p);
        const ro = sessionReadOnly.has(abs) || sessionReadOnly.has(p);
        console.log("  " + abs + (ro ? chalk.dim(" (read-only)") : ""));
      }
    };
    const runMap = async (): Promise<void> => {
      const cwd = process.cwd();
      if (repoMapCache === null) {
        const prioritizePaths = sessionFiles.map((p) =>
          p.startsWith("/") || /^[A-Za-z]:/.test(p) ? p : resolve(cwd, p)
        );
        repoMapCache = await buildRepoMap(cwd, {
          maxTokens: mapTokens,
          prioritizePaths: prioritizePaths.length ? prioritizePaths : undefined,
        });
      }
      console.log(chalk.bold("Repo map:"));
      console.log(repoMapCache);
    };
    const runMapRefresh = (): void => {
      repoMapCache = null;
      console.log(chalk.green("Repo map cache cleared. Next task or /map will rebuild."));
    };
    const runUndo = (): void => {
      const cwd = process.cwd();
      if (!isGitRepo(cwd)) {
        console.log(chalk.yellow("Not a git repo. Nothing to undo."));
        return;
      }
      const last = getLastCommit(cwd);
      if (!last) {
        console.log(chalk.yellow("No commits to undo."));
        return;
      }
      if (!isAgentCommit(last)) {
        console.log(chalk.yellow("Last commit was not by gtd (author/committer). Undo anyway? (y/n)"));
        console.log(chalk.dim("  Use: git reset --hard HEAD~1 to force."));
        return;
      }
      const result = undoLastCommit(cwd, true);
      if (result.success) console.log(chalk.green("Undid last commit (by gtd)."));
      else console.log(chalk.red("Undo failed: " + (result.error ?? "unknown")));
    };
    const runCommit = async (args: string): Promise<void> => {
      const cwd = process.cwd();
      if (!isGitRepo(cwd)) {
        console.log(chalk.yellow("Not a git repo. Run: git init"));
        return;
      }
      if (!hasDirtyFiles(cwd)) {
        console.log(chalk.dim("Nothing to commit (working tree clean)."));
        return;
      }
      const cfgCommit = await loadConfig();
      const message = args.trim() || generateCommitMessage(lastTaskDesc ?? "update", { template: cfgCommit.commitMessagePrompt });
      const result = commitAll(cwd, message, { noVerify: !sessionGitCommitVerify, attribution: true });
      if (result.success) console.log(chalk.green("Committed: " + message));
      else console.log(chalk.red("Commit failed: " + (result.error ?? "unknown")));
    };
    const runGitRaw = (args: string): void => {
      const cwd = process.cwd();
      const result = runGitCommand(cwd, args);
      if (result.output) console.log(result.output);
      if (result.error && !result.success) console.log(chalk.red(result.error));
    };
    const runCopyContext = async (): Promise<void> => {
      const cwd = process.cwd();
      const parts: string[] = ["# Skate session context", ""];
      if (sessionFiles.length > 0) {
        parts.push("## Session files");
        for (const p of sessionFiles) {
          const ro = sessionReadOnly.has(p) || sessionReadOnly.has(resolve(cwd, p));
          parts.push("- " + p + (ro ? " (read-only)" : ""));
        }
        parts.push("");
      }
      const prioritizePaths = sessionFiles.map((p) =>
        p.startsWith("/") || /^[A-Za-z]:/.test(p) ? p : resolve(cwd, p)
      );
      const map =
        repoMapCache ??
        (await buildRepoMap(cwd, {
          maxTokens: mapTokens,
          prioritizePaths: prioritizePaths.length ? prioritizePaths : undefined,
        }));
      parts.push("## Repo map", "```", map, "```", "");
      const tasks = await listTasks({ limit: 1 });
      if (tasks[0]) {
        const t = await getTask(tasks[0].id);
        if (t) {
          parts.push("## Last task", "ID: " + t.id, "Description: " + t.description, "");
          if (t.outputs?.builder) parts.push("### Builder output", "", t.outputs.builder.slice(0, 8000) + (t.outputs.builder.length > 8000 ? "\n…" : ""));
        }
      }
      const text = parts.join("\n");
      const copyCmd = process.env.GTD_COPY_CMD || (process.platform === "darwin" ? "pbcopy" : process.platform === "win32" ? "clip" : "xclip -selection clipboard");
      try {
        const { spawn } = await import("child_process");
        const child = spawn(copyCmd, [], { stdio: ["pipe", "ignore", "ignore"] });
        child.stdin?.end(text, "utf-8");
        const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
        if (code === 0) console.log(chalk.green("Context copied to clipboard (markdown for web UI)."));
        else throw new Error("Non-zero exit");
      } catch {
        console.log(chalk.dim("Clipboard failed. Context (first 2k chars); paste into web UI:"));
        console.log(text.slice(0, 2000) + (text.length > 2000 ? "\n…" : ""));
      }
    };

    const runChatShare = async (filePath?: string): Promise<void> => {
      if (filePath) {
        const tasks = await listTasks({ limit: 5 });
        const task = tasks[0] ? await getTask(tasks[0].id) : null;
        if (!task) {
          console.log(chalk.yellow("No tasks to export. Run a task first."));
          return;
        }
        const { writeFile } = await import("fs/promises");
        const absPath = filePath.startsWith("/") || /^[A-Za-z]:/.test(filePath) ? filePath : resolve(process.cwd(), filePath);
        await writeFile(absPath, JSON.stringify(task, null, 2), "utf-8");
        console.log(chalk.green(`Exported task ${shortTaskId(task.id)} to ${absPath}`));
      } else {
        console.log(chalk.dim("Export task to JSON: gtd show <id> --format json"));
        console.log(chalk.dim("Or: chat share <file.json> to export the most recent task."));
      }
    };

    const savedChatsPath = () => join(getDataDir(), "saved-chats.json");
    const readSavedChats = async (): Promise<Record<string, string>> => {
      const { readFile } = await import("fs/promises");
      try {
        const raw = await readFile(savedChatsPath(), "utf-8");
        const data = JSON.parse(raw) as Record<string, unknown>;
        if (data && typeof data === "object") {
          return Object.fromEntries(Object.entries(data).filter(([, v]) => typeof v === "string") as [string, string][]);
        }
      } catch {
        // ignore
      }
      return {};
    };
    const writeSavedChats = async (store: Record<string, string>): Promise<void> => {
      const { writeFile, mkdir } = await import("fs/promises");
      await mkdir(getDataDir(), { recursive: true });
      await writeFile(savedChatsPath(), JSON.stringify(store, null, 2), "utf-8");
    };
    const runChatSave = async (tag?: string): Promise<void> => {
      const key = (tag ?? "default").trim() || "default";
      const tasks = await listTasks({ limit: 1 });
      if (!tasks[0]) {
        console.log(chalk.yellow("No recent task to save. Run a task first."));
        return;
      }
      const store = await readSavedChats();
      store[key] = tasks[0].id;
      store["__last__"] = key;
      await writeSavedChats(store);
      console.log(chalk.green(`Saved task ${shortTaskId(tasks[0].id)} as "${key}". Use: chat resume ${key} or chat resume last`));
    };
    const runChatList = async (): Promise<void> => {
      const store = await readSavedChats();
      const keys = Object.keys(store).filter((k) => k !== "__last__");
      if (keys.length === 0) {
        console.log(chalk.dim("No saved chat checkpoints. Use: chat save [tag]"));
        return;
      }
      console.log(chalk.bold("Saved chat checkpoints:"));
      for (const k of keys.sort()) console.log(`  ${k}  →  ${shortTaskId(store[k])}`);
    };
    const runChatResume = async (tag: string): Promise<void> => {
      const store = await readSavedChats();
      const key = tag.trim().toLowerCase();
      const resolvedTag = key === "last" ? store["__last__"] : key;
      const taskId = resolvedTag ? store[resolvedTag] : undefined;
      if (!taskId) {
        console.log(chalk.red(key === "last" ? "No saved checkpoint to resume. Use: chat save [tag] first." : `No saved checkpoint "${tag}". Use: chat list`));
        return;
      }
      await runStatusTask(taskId, "text");
    };
    const runChatDelete = async (tag: string): Promise<void> => {
      const key = tag.trim();
      const store = await readSavedChats();
      if (key === "__last__" || !(key in store)) {
        console.log(chalk.yellow(key === "__last__" ? "Cannot delete __last__. Delete a named checkpoint." : `No saved checkpoint "${key}". Use: chat list`));
        return;
      }
      delete store[key];
      if (store["__last__"] === key) delete store["__last__"];
      await writeSavedChats(store);
      console.log(chalk.green(`Deleted checkpoint "${key}".`));
    };

    const runDiff = async (): Promise<void> => {
      await runShell("git diff");
      console.log(chalk.dim("--- staged ---"));
      await runShell("git diff --staged");
    };

    const runInbox = async (): Promise<void> => {
      const tasks = await listTasks({ status: undefined, limit: 10 });
      const pending = tasks.filter((t) => t.status === "pending" || t.status === "blocked" || t.status === "in_progress");
      const recent = tasks.filter((t) => t.status === "completed" || t.status === "failed").slice(0, 5);
      if (pending.length === 0 && recent.length === 0) {
        console.log("Inbox: No tasks.");
        return;
      }
      const tagStr = (t: { tags?: string[] }) => (t.tags?.length ? chalk.dim(` [${t.tags.join(", ")}]`) : "");
      if (pending.length > 0) {
        console.log("\nPending / In progress:");
        for (const t of pending) {
          console.log(`  ${chalk.cyan(t.id.slice(0, 8))} ${t.status} ${t.description.slice(0, 50)}${t.description.length > 50 ? "…" : ""}${tagStr(t)}`);
        }
      }
      if (recent.length > 0) {
        console.log("\nRecent:");
        for (const t of recent) {
          const statusColor = t.status === "completed" ? chalk.green : chalk.red;
          console.log(`  ${chalk.cyan(t.id.slice(0, 8))} ${statusColor(t.status)} ${t.description.slice(0, 50)}${t.description.length > 50 ? "…" : ""}${tagStr(t)}`);
        }
      }
    };

    const loop = async (): Promise<void> => {
      const cwd = process.cwd();
      const home = process.env.HOME || process.env.USERPROFILE || "";
      const cwdDisplay = home && cwd.startsWith(home) ? "~" + cwd.slice(home.length) : cwd;
      const cwdShort = cwdDisplay.length > 42 ? "…" + cwdDisplay.slice(-41) : cwdDisplay;
      const modeLabel = (nextMessageModeOverride ?? sessionChatMode) === "code" ? "" : ` ${nextMessageModeOverride ?? sessionChatMode}`;
      const prompt = shellMode ? `gtd! ${cwdShort}> ` : `gtd${modeLabel} ${cwdShort}> `;
      let line: string =
        sessionCommandQueue.length > 0 ? sessionCommandQueue.shift()! : await question(chalk.cyan(prompt));
      if (!line) return loop();
      const trimmedFirst = line.trim();
      if (sessionMultilineMode && trimmedFirst !== ".") {
        const lines: string[] = [line];
        while (true) {
          const next =
            sessionCommandQueue.length > 0 ? sessionCommandQueue.shift()! : await question(chalk.dim("… "));
          if (next.trim() === ".") break;
          lines.push(next);
        }
        line = lines.join("\n");
      } else if (trimmedFirst === "{" || /^\{[a-zA-Z0-9]+$/.test(trimmedFirst)) {
        const closeTag = trimmedFirst === "{" ? "}" : trimmedFirst.slice(1) + "}";
        const lines: string[] = [];
        while (true) {
          const next =
            sessionCommandQueue.length > 0 ? sessionCommandQueue.shift()! : await question(chalk.dim("… "));
          if (next.trim() === closeTag) break;
          lines.push(next);
        }
        line = lines.join("\n");
      }
      await appendHistory(line);
      const cmdLine = line.replace(/^\s*\/+/, "").trimStart() || line;
      if (cmdLine === "!") {
        shellMode = !shellMode;
        console.log(chalk.dim(shellMode ? "Shell mode. Commands run in subshell. Type ! to exit." : "Exited shell mode."));
        return loop();
      }
      if (shellMode) {
        await runShell(cmdLine);
        return loop();
      }
      if (/^!\s+.+/.test(cmdLine)) {
        const rest = cmdLine.replace(/^!\s+/, "").trim();
        if (rest) await runShell(rest);
      } else if ((/^ok\s*$/i.test(cmdLine) || /^ok\s+(.+)\s*$/i.test(cmdLine)) && lastTaskDesc) {
        const okArgs = cmdLine.match(/^ok\s+(.+)\s*$/i)?.[1]?.trim();
        nextMessageModeOverride = "code";
        let desc = lastTaskDesc + (okArgs ? "\n\n" + okArgs : "");
        if (sessionQueue) {
          desc = `Queued: ${sessionQueue}\n\n${desc}`;
          sessionQueue = undefined;
        }
        const effectivePersonalityOk = sessionPersonality ?? (interactiveCfg.persona ? PRESET_PERSONAS[interactiveCfg.persona] : undefined);
        if (effectivePersonalityOk) desc = `[Communication style: ${effectivePersonalityOk}.] ${desc}`;
        const rootsOk = sessionDirectories.length > 0 ? sessionDirectories.map((p) => (p.startsWith("/") || /^[A-Za-z]:/.test(p) ? p : resolve(cwd, p))) : undefined;
        const addedCtxOk = await buildAddedFilesContext();
        const dynamicMapTokensOk = sessionFiles.length === 0 ? Math.min(mapTokens * 2, 4096) : mapTokens;
        const prioritizePathsOk = sessionFiles.map((p) => (p.startsWith("/") || /^[A-Za-z]:/.test(p) ? p : resolve(cwd, p)));
        const repoMapOk =
          repoMapCache ??
          (await buildRepoMap(cwd, { maxTokens: dynamicMapTokensOk, prioritizePaths: prioritizePathsOk.length ? prioritizePathsOk : undefined }));
        if (repoMapCache === null) repoMapCache = repoMapOk;
        if (tuiState) tuiState.currentTask = desc;
        const effectiveModeOk = nextMessageModeOverride ?? sessionChatMode;
        nextMessageModeOverride = undefined;
        const attOk = sessionAttachments.length ? [...sessionAttachments] : undefined;
        if (attOk) sessionAttachments.length = 0;
        await runTask(desc, {
          useProgressBar: true,
          workspaceRoots: rootsOk,
          profile: sessionProfileName ?? undefined,
          model: sessionModelOverride,
          permissionMode: sessionPermissionOverride,
          sessionMemory: sessionSessionMemory.length ? sessionSessionMemory.join("\n") : undefined,
          mode: effectiveModeOk,
          onTaskStart: (id) => { runningTaskId = id; },
          getInjectedInstruction: () => injectedQueue.shift(),
          addedFilesContext: addedCtxOk,
          repoMapContext: repoMapOk,
          noGit: sessionNoGit,
          noAutoCommits: sessionNoAutoCommits,
          noDirtyCommits: sessionNoDirtyCommits,
          commitAttribution: true,
          gitCommitVerify: sessionGitCommitVerify,
          autoLint: sessionAutoLint,
          lintCmd: sessionLintCmd,
          autoTest: sessionAutoTest,
          testCmd: sessionTestCmd,
          attachments: attOk,
          onLintFailure: (out, structured) => { sessionQueue = structured ? formatVerifyForModel(structured, "lint") : "[Lint failed]\n```\n" + out.trim().slice(0, 12000) + (out.length > 12000 ? "\n…" : "") + "\n```"; },
          onTestFailure: (out, structured) => { sessionQueue = structured ? formatVerifyForModel(structured, "test") : "[Test failed]\n```\n" + out.trim().slice(0, 12000) + (out.length > 12000 ? "\n…" : "") + "\n```"; },
        });
        runningTaskId = undefined;
        return loop();
      } else if (sessionChatMode === "ask" && /^(go\s*ahead|ok\s*go|do\s*it|proceed)$/i.test(cmdLine.trim()) && lastTaskDesc) {
        nextMessageModeOverride = "code";
        let desc = lastTaskDesc;
        if (sessionQueue) {
          desc = `Queued: ${sessionQueue}\n\n${desc}`;
          sessionQueue = undefined;
        }
        const effectivePersonalityGo = sessionPersonality ?? (interactiveCfg.persona ? PRESET_PERSONAS[interactiveCfg.persona] : undefined);
        if (effectivePersonalityGo) desc = `[Communication style: ${effectivePersonalityGo}.] ${desc}`;
        const roots = sessionDirectories.length > 0 ? sessionDirectories.map((p) => (p.startsWith("/") || /^[A-Za-z]:/.test(p) ? p : resolve(cwd, p))) : undefined;
        const addedCtx = await buildAddedFilesContext();
        const dynamicMapTokens = sessionFiles.length === 0 ? Math.min(mapTokens * 2, 4096) : mapTokens;
        const prioritizePaths = sessionFiles.map((p) => (p.startsWith("/") || /^[A-Za-z]:/.test(p) ? p : resolve(cwd, p)));
        const repoMap =
          repoMapCache ??
          (await buildRepoMap(cwd, { maxTokens: dynamicMapTokens, prioritizePaths: prioritizePaths.length ? prioritizePaths : undefined }));
        if (repoMapCache === null) repoMapCache = repoMap;
        if (tuiState) tuiState.currentTask = desc;
        nextMessageModeOverride = "code";
        const effectiveMode = nextMessageModeOverride ?? sessionChatMode;
        nextMessageModeOverride = undefined;
        const attGo = sessionAttachments.length ? [...sessionAttachments] : undefined;
        if (attGo) sessionAttachments.length = 0;
        await runTask(desc, {
          useProgressBar: true,
          workspaceRoots: roots,
          profile: sessionProfileName ?? undefined,
          model: sessionModelOverride,
          permissionMode: sessionPermissionOverride,
          sessionMemory: sessionSessionMemory.length ? sessionSessionMemory.join("\n") : undefined,
          mode: effectiveMode,
          onTaskStart: (id) => {
            runningTaskId = id;
          },
          getInjectedInstruction: () => injectedQueue.shift(),
          addedFilesContext: addedCtx,
          repoMapContext: repoMap,
          noGit: sessionNoGit,
          noAutoCommits: sessionNoAutoCommits,
          noDirtyCommits: sessionNoDirtyCommits,
          commitAttribution: true,
          gitCommitVerify: sessionGitCommitVerify,
          autoLint: sessionAutoLint,
          lintCmd: sessionLintCmd,
          autoTest: sessionAutoTest,
          testCmd: sessionTestCmd,
          attachments: attGo,
          onLintFailure: (out, structured) => {
            sessionQueue = structured ? formatVerifyForModel(structured, "lint") : "[Lint failed]\n```\n" + out.trim().slice(0, 12000) + (out.length > 12000 ? "\n…" : "") + "\n```";
          },
          onTestFailure: (out, structured) => {
            sessionQueue = structured ? formatVerifyForModel(structured, "test") : "[Test failed]\n```\n" + out.trim().slice(0, 12000) + (out.length > 12000 ? "\n…" : "") + "\n```";
          },
        });
        runningTaskId = undefined;
        return loop();
      } else {
      const taskMatch = cmdLine.match(/^task\s+["']([^"']*)["']\s*$/i) ?? cmdLine.match(/^task\s+(.+?)\s*$/i);
      if (taskMatch) {
        let desc = taskMatch[1].trim();
        lastTaskDesc = desc;
        const cwd = process.cwd();
        const atRefs = desc.match(/@([^\s@]+)/g);
        if (atRefs) {
          const { readFile } = await import("fs/promises");
          const seen = new Set<string>();
          for (const ref of atRefs.slice(0, 5)) {
            const path = ref.slice(1);
            if (seen.has(path)) continue;
            seen.add(path);
            const abs = resolve(cwd, path);
            try {
              const content = await readFile(abs, "utf-8");
              const capped = content.length > 30000 ? content.slice(0, 30000) + "\n… (truncated)" : content;
              desc = desc.replace(ref, `\n--- File ${path} ---\n${capped}\n---\n`);
            } catch {
              desc = desc.replace(ref, `\n[Could not read file: ${path}]\n`);
            }
          }
        }
        if (sessionQueue) {
          desc = `Queued: ${sessionQueue}\n\n${desc}`;
          sessionQueue = undefined;
        }
        const effectivePersonalityCompose = sessionPersonality ?? (interactiveCfg.persona ? PRESET_PERSONAS[interactiveCfg.persona] : undefined);
        if (effectivePersonalityCompose) desc = `[Communication style: ${effectivePersonalityCompose}.] ${desc}`;
        if (sessionFiles.length === 0 && !desc.startsWith("[")) {
          desc = "[No files in session; you may read and edit any file in the workspace using tools.]\n\n" + desc;
        }
        if (tuiState) tuiState.currentTask = desc;
        const roots = sessionDirectories.length > 0 ? sessionDirectories.map((p) => (p.startsWith("/") || /^[A-Za-z]:/.test(p) ? p : resolve(cwd, p))) : undefined;
        if (desc) {
          const addedCtx = await buildAddedFilesContext();
          const dynamicMapTokens =
            sessionFiles.length === 0 ? Math.min(mapTokens * 2, 4096) : mapTokens;
          const prioritizePaths = sessionFiles.map((p) =>
            p.startsWith("/") || /^[A-Za-z]:/.test(p) ? p : resolve(cwd, p)
          );
          const repoMap =
            repoMapCache ??
            (await buildRepoMap(cwd, {
              maxTokens: dynamicMapTokens,
              prioritizePaths: prioritizePaths.length ? prioritizePaths : undefined,
            }));
          if (repoMapCache === null) repoMapCache = repoMap;
          const effectiveMode = nextMessageModeOverride ?? sessionChatMode;
          nextMessageModeOverride = undefined;
          const attTask = sessionAttachments.length ? [...sessionAttachments] : undefined;
          if (attTask) sessionAttachments.length = 0;
          runTask(desc, {
            useProgressBar: true,
            workspaceRoots: roots,
            profile: sessionProfileName ?? undefined,
            model: sessionModelOverride,
            permissionMode: sessionPermissionOverride,
            sessionMemory: sessionSessionMemory.length ? sessionSessionMemory.join("\n") : undefined,
            mode: effectiveMode,
            onTaskStart: (id) => { runningTaskId = id; },
            getInjectedInstruction: () => injectedQueue.shift(),
            addedFilesContext: addedCtx,
            repoMapContext: repoMap,
            noGit: sessionNoGit,
            noAutoCommits: sessionNoAutoCommits,
            noDirtyCommits: sessionNoDirtyCommits,
            commitAttribution: true,
            gitCommitVerify: sessionGitCommitVerify,
            autoLint: sessionAutoLint,
            lintCmd: sessionLintCmd,
            autoTest: sessionAutoTest,
            testCmd: sessionTestCmd,
            attachments: attTask,
            onLintFailure: (out, structured) => {
              sessionQueue = structured ? formatVerifyForModel(structured, "lint") : "[Lint failed]\n```\n" + out.trim().slice(0, 12000) + (out.length > 12000 ? "\n…" : "") + "\n```";
            },
            onTestFailure: (out, structured) => {
              sessionQueue = structured ? formatVerifyForModel(structured, "test") : "[Test failed]\n```\n" + out.trim().slice(0, 12000) + (out.length > 12000 ? "\n…" : "") + "\n```";
            },
          }).then(() => {
            if (injectedFollowUp && runningTaskId) {
              console.log(chalk.dim("Injected: \"" + injectedFollowUp.slice(0, 60) + (injectedFollowUp.length > 60 ? "…" : "") + "\". Run: retry " + shortTaskId(runningTaskId) + " \"" + injectedFollowUp.replace(/"/g, '\\"').slice(0, 80) + (injectedFollowUp.length > 80 ? "…" : "") + "\""));
              injectedFollowUp = undefined;
            }
          }).finally(() => { runningTaskId = undefined; });
          return loop();
        }
      } else if (/^inject\s+(.+)\s*$/i.test(cmdLine) && runningTaskId) {
        const m = cmdLine.match(/^inject\s+(.+)\s*$/i);
        if (m?.[1]) {
          const text = m[1].trim();
          injectedQueue.push(text);
          injectedFollowUp = text;
          console.log(chalk.green("Injected into current run (next step will see it). Also suggested as follow-up if task finishes first: " + text.slice(0, 60) + (text.length > 60 ? "…" : "")));
        }
        return loop();
      } else if (/^inject\s*$/i.test(cmdLine) && runningTaskId) {
        console.log(chalk.yellow("Usage: inject <instruction> — e.g. inject Add unit tests"));
        return loop();
      } else if (/^inject\s/i.test(cmdLine) && !runningTaskId) {
        console.log(chalk.dim("No task running. Start a task first, then type inject <instruction>."));
        return loop();
      } else if (runningTaskId && line.trim()) {
        const trimmed = line.trim();
        const isReplCommand = /^(task|status|show|inbox|search|history|approve|retry|cancel|delete|refresh|clear|stats|tools|mcp|privacy|extensions|settings|config|bug|editor|copy|theme|auth|directory|chat|chat-mode|new|diff|undo|commit|git|logout|model|models|provider|editor-model|weak-model|permissions|personality|persona|agent|ps|experimental|fork|statusline|queue|edit|edit-line|compose|inject|reset|run|test|lint|voice|web|paste|tokens|report|code|ask|architect|help-mode|multiline-mode|ok|reasoning-effort|think-tokens|sandbox-add-read-dir|add|drop|read-only|ls|map|map-refresh|copy-context|load|save|memory|help|exit|quit|setup)\b/i.test(trimmed) || /^!\s?/.test(trimmed);
        if (!isReplCommand) {
          injectedQueue.push(trimmed);
          injectedFollowUp = trimmed;
          console.log(chalk.green("Injected (next step will see it): " + trimmed.slice(0, 60) + (trimmed.length > 60 ? "…" : "")));
          return loop();
        }
      } else if (/^show\s+(\S+)\s*$/i.test(cmdLine)) {
        const m = cmdLine.match(/^show\s+(\S+)\s*$/i);
        if (m?.[1]) await runStatusTask(m[1], "text");
      } else if (/^status\s/i.test(cmdLine)) {
        const m = cmdLine.match(/^status\s+(\S+)\s*$/i);
        await runStatus(m?.[1]);
      } else if (/^status\s*$/i.test(cmdLine)) {
        await runStatus();
      } else if (/^inbox\s*$/i.test(cmdLine)) {
        await runInbox();
      } else if (/^search\s+(.+)\s*$/i.test(cmdLine)) {
        const m = cmdLine.match(/^search\s+(.+)\s*$/i);
        await runSearch(m?.[1]?.trim());
      } else if (/^search\s*$/i.test(cmdLine)) {
        await runSearch();
      } else if (/^history\s*$/i.test(cmdLine)) {
        await runHistory();
      } else if (/^approve\s+(\S+)\s*$/i.test(cmdLine)) {
        const m = cmdLine.match(/^approve\s+(\S+)\s*$/i);
        if (m?.[1]) await runApprove(m[1]);
      } else if (/^retry\s+/i.test(cmdLine)) {
        const validSteps = ["scout", "planner", "builder", "reviewer", "documenter"];
        const rest = cmdLine.replace(/^retry\s+/i, "").trim();
        const idMatch = rest.match(/^(\S+)/);
        if (!idMatch?.[1]) return loop();
        const id = idMatch[1];
        const afterId = rest.slice(id.length).trim();
        let step: string | undefined;
        let followUp: string | undefined;
        if (afterId) {
          const first = afterId.split(/\s+/)[0]?.toLowerCase();
          const isStep = first && validSteps.includes(first);
          if (isStep) {
            step = first;
            const restAfterStep = afterId.slice(first!.length).trim();
            followUp = restAfterStep ? restAfterStep.replace(/^["']|["']$/g, "") : undefined;
          } else {
            followUp = afterId.replace(/^["']|["']$/g, "");
          }
        }
        await runRetry(id, step, followUp);
      } else if (/^cancel\s+(\S+)\s*$/i.test(cmdLine)) {
        const m = cmdLine.match(/^cancel\s+(\S+)\s*$/i);
        if (m?.[1]) await runCancel(m[1]);
      } else if (/^delete\s+(\S+)\s*$/i.test(cmdLine)) {
        const m = cmdLine.match(/^delete\s+(\S+)\s*$/i);
        if (m?.[1]) await runDelete(m[1]);
      } else if (/^refresh\s*$/i.test(cmdLine)) {
        await refreshTUIState();
        if (tuiState) drawLiveTUI(tuiState);
        console.log(chalk.dim("Refreshed task list and MCP tools."));
      } else if (/^clear\s*$/i.test(cmdLine)) {
        console.clear();
        console.log(chalk.dim("New conversation: task \"<description>\""));
      } else if (/^reset\s*$/i.test(cmdLine)) {
        const ans = process.stdin.isTTY && process.stdout.isTTY
          ? await question(chalk.yellow("Clear all session context (files, queue, last task)? (y/n): "))
          : "y";
        if (ans?.toLowerCase() === "y" || ans === "") runReset();
        else console.log(chalk.dim("Reset cancelled."));
      } else if (/^copy\s*$/i.test(cmdLine)) {
        await runCopyLast();
      } else if (/^run\s+(.+)\s*$/i.test(cmdLine)) {
        const m = cmdLine.match(/^run\s+(.+)\s*$/i);
        if (m?.[1]) await runShell(m[1]);
      } else if (/^run\s*$/i.test(cmdLine)) {
        console.log(chalk.yellow("Usage: run <command> — run shell command (same as ! <cmd>)"));
      } else if (/^test\s+(.+)\s*$/i.test(cmdLine)) {
        const m = cmdLine.match(/^test\s+(.+)\s*$/i);
        if (m?.[1]) await runTest(m[1]);
      } else if (/^test\s*$/i.test(cmdLine)) {
        console.log(chalk.yellow("Usage: test <command> — run tests; on failure output is queued for next task"));
      } else if (/^lint\s*$/i.test(cmdLine)) {
        await runLint();
      } else if (/^edit-line\s*$/i.test(cmdLine)) {
        const content = await runEditorWithInitial("");
        if (content) {
          sessionCommandQueue.push(content);
          console.log(chalk.green("Editor content queued as next command."));
        }
        return loop();
      } else if (/^compose\s*$/i.test(cmdLine)) {
        const content = await runEditorCompose();
        if (content) {
          lastTaskDesc = content;
          const roots = sessionDirectories.length > 0 ? sessionDirectories.map((p) => (p.startsWith("/") || /^[A-Za-z]:/.test(p) ? p : resolve(cwd, p))) : undefined;
          const addedCtx = await buildAddedFilesContext();
          const repoMap = repoMapCache ?? (await buildRepoMap(cwd, { maxTokens: mapTokens, prioritizePaths: sessionFiles.length ? sessionFiles.map((p) => (p.startsWith("/") || /^[A-Za-z]:/.test(p) ? p : resolve(cwd, p))) : undefined }));
          if (repoMapCache === null) repoMapCache = repoMap;
          const composeMode = nextMessageModeOverride ?? sessionChatMode;
          nextMessageModeOverride = undefined;
          const attCompose = sessionAttachments.length ? [...sessionAttachments] : undefined;
          if (attCompose) sessionAttachments.length = 0;
          await runTask(content, { useProgressBar: true, workspaceRoots: roots, profile: sessionProfileName ?? undefined, model: sessionModelOverride, permissionMode: sessionPermissionOverride, sessionMemory: sessionSessionMemory.length ? sessionSessionMemory.join("\n") : undefined, mode: composeMode, addedFilesContext: addedCtx, repoMapContext: repoMap, noGit: sessionNoGit, noAutoCommits: sessionNoAutoCommits, noDirtyCommits: sessionNoDirtyCommits, commitAttribution: true, gitCommitVerify: sessionGitCommitVerify, autoLint: sessionAutoLint, lintCmd: sessionLintCmd, autoTest: sessionAutoTest, testCmd: sessionTestCmd, attachments: attCompose, onLintFailure: (out, structured) => { sessionQueue = structured ? formatVerifyForModel(structured, "lint") : "[Lint failed]\n```\n" + out.trim().slice(0, 12000) + (out.length > 12000 ? "\n…" : "") + "\n```"; }, onTestFailure: (out, structured) => { sessionQueue = structured ? formatVerifyForModel(structured, "test") : "[Test failed]\n```\n" + out.trim().slice(0, 12000) + (out.length > 12000 ? "\n…" : "") + "\n```"; } });
        }
      } else if (/^voice\s*$/i.test(cmdLine)) {
        await runVoice();
      } else if (/^web\s+(.+)\s*$/i.test(cmdLine)) {
        const m = cmdLine.match(/^web\s+(.+)\s*$/i);
        if (m?.[1]) await runWeb(m[1].trim());
      } else if (/^web\s*$/i.test(cmdLine)) {
        console.log(chalk.yellow("Usage: web <url> — fetch page, convert to markdown, queue for next task"));
      } else if (/^paste\s*$/i.test(cmdLine) || /^paste\s+(.+)\s*$/i.test(cmdLine)) {
        const pasteName = cmdLine.match(/^paste\s+(.+)\s*$/i)?.[1]?.trim();
        await runPaste(pasteName);
      } else if (/^reasoning-effort\s*$/i.test(cmdLine)) {
        console.log(chalk.dim("Reasoning effort: " + (sessionReasoningEffort ?? "(none). Set: reasoning-effort low|medium|high|clear)")));
      } else if (/^reasoning-effort\s+(.+)\s*$/i.test(cmdLine)) {
        const m = cmdLine.match(/^reasoning-effort\s+(.+)\s*$/i);
        if (m?.[1]) {
          const v = m[1].trim().toLowerCase();
          sessionReasoningEffort = (v === "clear" || v === "none" || !v) ? undefined : m[1].trim();
          console.log(chalk.green("Reasoning effort: " + (sessionReasoningEffort ?? "cleared")));
        }
      } else if (/^think-tokens\s*$/i.test(cmdLine)) {
        console.log(chalk.dim("Think tokens: " + (sessionThinkTokens ?? "(none). Set: think-tokens <n>|clear, e.g. 8k, 0.5M, 0 to disable)")));
      } else if (/^think-tokens\s+(.+)\s*$/i.test(cmdLine)) {
        const m = cmdLine.match(/^think-tokens\s+(.+)\s*$/i);
        if (m?.[1]) {
          const v = m[1].trim().toLowerCase();
          sessionThinkTokens = (v === "clear" || v === "none" || !v) ? undefined : m[1].trim();
          console.log(chalk.green("Think tokens: " + (sessionThinkTokens ?? "cleared")));
        }
      } else if (/^tokens\s*$/i.test(cmdLine)) {
        await runStats();
      } else if (/^report\s*$/i.test(cmdLine)) {
        await runBug();
      } else if (/^report\s+(.+)\s*$/i.test(cmdLine)) {
        const m = cmdLine.match(/^report\s+(.+)\s*$/i);
        if (m?.[1]) await runBug(m[1].trim());
      } else if (/^models\s*$/i.test(cmdLine)) {
        runModelsList();
      } else if (/^models\s+(.+)\s*$/i.test(cmdLine)) {
        const m = cmdLine.match(/^models\s+(.+)\s*$/i);
        if (m?.[1]) runModelsList(m[1].trim());
      } else if (/^editor-model\s*$/i.test(cmdLine)) {
        console.log(chalk.dim("Session editor model: " + (sessionEditorModelOverride ?? "(none). Set: editor-model <id>)")));
      } else if (/^editor-model\s+(.+)\s*$/i.test(cmdLine)) {
        const m = cmdLine.match(/^editor-model\s+(.+)\s*$/i);
        if (m?.[1]) {
          sessionEditorModelOverride = m[1].trim() || undefined;
          console.log(chalk.green("Editor model: " + (sessionEditorModelOverride ?? "cleared")));
        }
      } else if (/^weak-model\s*$/i.test(cmdLine)) {
        console.log(chalk.dim("Session weak model: " + (sessionWeakModelOverride ?? "(none). Set: weak-model <id>)")));
      } else if (/^weak-model\s+(.+)\s*$/i.test(cmdLine)) {
        const m = cmdLine.match(/^weak-model\s+(.+)\s*$/i);
        if (m?.[1]) {
          sessionWeakModelOverride = m[1].trim() || undefined;
          console.log(chalk.green("Weak model: " + (sessionWeakModelOverride ?? "cleared")));
        }
      } else if (/^stats\s*$/i.test(cmdLine)) {
        await runStats();
      } else if (/^tools\s+nodesc\s*$/i.test(cmdLine)) {
        runToolsList(false);
      } else if (/^tools\s*$/i.test(cmdLine) || /^tools\s+desc\s*$/i.test(cmdLine)) {
        runToolsList(true);
      } else if (/^mcp\s+desc\s*$/i.test(cmdLine)) {
        await runMcpDesc();
      } else if (/^mcp\s+schema\s*$/i.test(cmdLine)) {
        await runMcpSchema();
      } else if (/^privacy\s*$/i.test(cmdLine)) {
        runPrivacy();
      } else if (/^extensions\s*$/i.test(cmdLine)) {
        await runExtensions();
      } else if (/^settings\s*$/i.test(cmdLine)) {
        await runSettings();
      } else if (/^config\s*$/i.test(cmdLine)) {
        await runSettings();
      } else if (/^setup\s*$/i.test(cmdLine)) {
        await runSetup();
      } else if (/^bug\s*$/i.test(cmdLine)) {
        await runBug();
      } else if (/^bug\s+(.+)$/i.test(cmdLine)) {
        const m = cmdLine.match(/^bug\s+(.+)$/i);
        if (m?.[1]) await runBug(m[1].trim());
      } else if (/^editor\s*$/i.test(cmdLine)) {
        runEditor();
      } else if (/^copy\s+(\S+)\s*$/i.test(cmdLine)) {
        const m = cmdLine.match(/^copy\s+(\S+)\s*$/i);
        if (m?.[1]) await runCopy(m[1]);
      } else if (/^theme\s*$/i.test(cmdLine)) {
        runTheme();
      } else if (/^auth\s*$/i.test(cmdLine)) {
        runAuth();
      } else if (/^directory\s+show\s*$/i.test(cmdLine)) {
        runDirectoryShow();
      } else if (/^directory\s+add\s+(.+)\s*$/i.test(cmdLine)) {
        const m = cmdLine.match(/^directory\s+add\s+(.+)\s*$/i);
        if (m?.[1]) runDirectoryAdd(m[1].trim());
      } else if (/^chat\s+save\s+(.+)\s*$/i.test(cmdLine)) {
        const m = cmdLine.match(/^chat\s+save\s+(.+)\s*$/i);
        if (m?.[1]) await runChatSave(m[1].trim());
      } else if (/^chat\s+save\s*$/i.test(cmdLine)) {
        await runChatSave();
      } else if (/^chat\s+list\s*$/i.test(cmdLine)) {
        await runChatList();
      } else if (/^chat\s+resume\s+(\S+)\s*$/i.test(cmdLine)) {
        const m = cmdLine.match(/^chat\s+resume\s+(\S+)\s*$/i);
        if (m?.[1]) await runChatResume(m[1]);
      } else if (/^new\s*$/i.test(cmdLine)) {
        console.log(chalk.dim("New conversation. Start with: task \"<description>\""));
      } else if (/^chat-mode\s*$/i.test(cmdLine)) {
        console.log(chalk.dim("Active chat mode: " + sessionChatMode + ". Set: chat-mode code | ask | architect | help"));
      } else if (/^chat-mode\s+(\w+)\s*$/i.test(cmdLine)) {
        const m = cmdLine.match(/^chat-mode\s+(\w+)\s*$/i);
        const mode = m?.[1]?.toLowerCase();
        if (mode && validChatModes.includes(mode as ChatMode)) {
          sessionChatMode = mode as ChatMode;
          console.log(chalk.green("Chat mode: " + sessionChatMode));
        } else {
          console.log(chalk.yellow("Use: chat-mode code | ask | architect | help"));
        }
      } else if (/^code\s*$/i.test(cmdLine)) {
        nextMessageModeOverride = "code";
        console.log(chalk.dim("Next message in code mode (then reverts to " + sessionChatMode + ")"));
      } else if (/^ask\s*$/i.test(cmdLine)) {
        nextMessageModeOverride = "ask";
        console.log(chalk.dim("Next message in ask mode (discuss only, no edits; then reverts to " + sessionChatMode + ")"));
      } else if (/^architect\s*$/i.test(cmdLine)) {
        nextMessageModeOverride = "architect";
        console.log(chalk.dim("Next message in architect mode (plan only; then reverts to " + sessionChatMode + ")"));
      } else if (/^help-mode\s*$/i.test(cmdLine)) {
        nextMessageModeOverride = "help";
        console.log(chalk.dim("Next message in help mode (answers about gtd/skate; then reverts to " + sessionChatMode + ")"));
      } else if (/^diff\s*$/i.test(cmdLine)) {
        await runDiff();
      } else if (/^undo\s*$/i.test(cmdLine)) {
        runUndo();
      } else if (/^commit\s*$/i.test(cmdLine)) {
        await runCommit("");
      } else if (/^commit\s+(.+)\s*$/i.test(cmdLine)) {
        const m = cmdLine.match(/^commit\s+(.+)\s*$/i);
        if (m?.[1]) await runCommit(m[1]);
      } else if (/^git\s+(.+)\s*$/i.test(cmdLine)) {
        const m = cmdLine.match(/^git\s+(.+)\s*$/i);
        if (m?.[1]) runGitRaw(m[1]);
      } else if (/^git\s*$/i.test(cmdLine)) {
        console.log(chalk.yellow("Usage: git <args> — run raw git command (e.g. git status)"));
      } else if (/^add\s+(.+)\s*$/i.test(cmdLine)) {
        const m = cmdLine.match(/^add\s+(.+)\s*$/i);
        if (m?.[1]) runAdd(m[1]);
      } else if (/^add\s*$/i.test(cmdLine)) {
        console.log(chalk.yellow("Usage: add <path> [path ...] — add files to session"));
      } else if (/^drop\s+(.+)\s*$/i.test(cmdLine)) {
        const m = cmdLine.match(/^drop\s+(.+)\s*$/i);
        if (m?.[1]) runDrop(m[1]);
      } else if (/^drop\s*$/i.test(cmdLine)) {
        console.log(chalk.yellow("Usage: drop <path> [path ...] — remove files from session"));
      } else if (/^read-only\s+(.+)\s*$/i.test(cmdLine)) {
        const m = cmdLine.match(/^read-only\s+(.+)\s*$/i);
        if (m?.[1]) runReadOnly(m[1]);
      } else if (/^read-only\s*$/i.test(cmdLine)) {
        console.log(chalk.yellow("Usage: read-only <path> [path ...] — add or mark as reference-only"));
      } else if (/^ls\s*$/i.test(cmdLine)) {
        runLs();
      } else if (/^map\s*$/i.test(cmdLine)) {
        await runMap();
      } else if (/^map-refresh\s*$/i.test(cmdLine)) {
        runMapRefresh();
      } else if (/^copy-context\s*$/i.test(cmdLine)) {
        await runCopyContext();
      } else if (/^load\s+(.+)\s*$/i.test(cmdLine)) {
        const m = cmdLine.match(/^load\s+(.+)\s*$/i);
        if (m?.[1]) {
          const filePath = resolve(cwd, m[1].trim());
          try {
            const { readFile } = await import("fs/promises");
            const raw = await readFile(filePath, "utf-8");
            const queued = raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
            for (const l of queued) sessionCommandQueue.push(l);
            console.log(chalk.green("Loaded " + queued.length + " command(s) from " + filePath));
          } catch (e) {
            console.log(chalk.red("Load failed: " + (e instanceof Error ? e.message : String(e))));
          }
        }
        return loop();
      } else if (/^load\s*$/i.test(cmdLine)) {
        console.log(chalk.yellow("Usage: load <file> — load and execute commands from file (one per line; # = comment)"));
      } else if (/^save\s+(.+)\s*$/i.test(cmdLine)) {
        const m = cmdLine.match(/^save\s+(.+)\s*$/i);
        if (m?.[1]) {
          const filePath = resolve(cwd, m[1].trim());
          try {
            const { writeFile } = await import("fs/promises");
            const lines: string[] = ["# Skate session — run with: load " + m[1].trim(), ""];
            for (const p of sessionFiles) {
              lines.push("add " + p);
              const abs = resolve(cwd, p);
              if (sessionReadOnly.has(abs) || sessionReadOnly.has(p)) lines.push("read-only " + p);
            }
            if (lastTaskDesc) {
              lines.push("");
              lines.push("# Last task (optional):");
              lines.push('task "' + lastTaskDesc.replace(/"/g, '\\"').slice(0, 200) + (lastTaskDesc.length > 200 ? "…" : "") + '"');
            }
            await writeFile(filePath, lines.join("\n") + "\n", "utf-8");
            console.log(chalk.green("Saved session to " + filePath + " (" + sessionFiles.length + " file(s))"));
          } catch (e) {
            console.log(chalk.red("Save failed: " + (e instanceof Error ? e.message : String(e))));
          }
        }
        return loop();
      } else if (/^save\s*$/i.test(cmdLine)) {
        console.log(chalk.yellow("Usage: save <file> — save commands to reconstruct session (add + read-only + last task)"));
      } else if (/^memory\s*$/i.test(cmdLine)) {
        const content = await loadProjectMemory(cwd);
        if (content) console.log(content);
        else console.log(chalk.dim("No MEMORY.md in current directory. Create MEMORY.md or use: memory add <text>"));
      } else if (/^memory\s+add\s+(.+)$/is.test(cmdLine)) {
        const m = cmdLine.match(/^memory\s+add\s+(.+)$/is);
        if (m?.[1]) {
          try {
            await appendProjectMemory(cwd, m[1].trim());
            console.log(chalk.green("Appended to MEMORY.md"));
          } catch (e) {
            console.log(chalk.red("Failed: " + (e instanceof Error ? e.message : String(e))));
          }
        }
      } else if (/^memory\s+edit\s*$/i.test(cmdLine)) {
        const memPath = getProjectMemoryPath(cwd);
        const content = await runEditorWithInitial(await loadProjectMemory(cwd).catch(() => ""));
        if (content != null) {
          const { writeFile } = await import("fs/promises");
          await writeFile(memPath, content, "utf-8");
          console.log(chalk.green("Updated MEMORY.md"));
        }
      } else if (/^memory\s+trim\s*$/i.test(cmdLine)) {
        const maxChars = Math.max(4096, parseInt(process.env.GTD_MEMORY_MAX_CHARS ?? "16384", 10) || 16384);
        const result = await trimProjectMemory(cwd, maxChars);
        if (result.trimmed) console.log(chalk.green(`Trimmed MEMORY.md to ${result.after} chars (was ${result.before})`));
        else console.log(chalk.dim(`MEMORY.md is ${result.before} chars (under limit; no trim). Use: memory trim <chars> to set limit.`));
      } else if (/^memory\s+trim\s+(\d+)\s*$/i.test(cmdLine)) {
        const m = cmdLine.match(/^memory\s+trim\s+(\d+)\s*$/i);
        const maxChars = m?.[1] ? Math.max(100, parseInt(m[1], 10)) : 16384;
        const result = await trimProjectMemory(cwd, maxChars);
        if (result.trimmed) console.log(chalk.green(`Trimmed MEMORY.md to ${result.after} chars (was ${result.before})`));
        else console.log(chalk.dim("MEMORY.md already under " + maxChars + " chars."));
      } else if (/^memory\s+session\s+add\s+(.+)$/is.test(cmdLine)) {
        const m = cmdLine.match(/^memory\s+session\s+add\s+(.+)$/is);
        if (m?.[1]) {
          sessionSessionMemory.push(m[1].trim());
          console.log(chalk.green("Added to session memory (" + sessionSessionMemory.length + " note(s)). Cleared on exit."));
        }
      } else if (/^memory\s+session\s+clear\s*$/i.test(cmdLine)) {
        sessionSessionMemory.length = 0;
        console.log(chalk.green("Session memory cleared."));
      } else if (/^memory\s+session\s*$/i.test(cmdLine)) {
        if (sessionSessionMemory.length) console.log(sessionSessionMemory.join("\n\n"));
        else console.log(chalk.dim("No session memory. Use: memory session add <text>"));
      } else if (/^memory\s+(.+)$/i.test(cmdLine)) {
        console.log(chalk.yellow("Usage: memory | memory add <text> | memory edit | memory trim [chars] | memory session add <text> | memory session clear"));
      } else if (/^multiline-mode\s*$/i.test(cmdLine)) {
        sessionMultilineMode = !sessionMultilineMode;
        console.log(chalk.green("Multiline mode: " + (sessionMultilineMode ? "on (Enter = newline, \".\" to submit)" : "off")));
      } else if (/^logout\s*$/i.test(cmdLine)) {
        const removed = await clearAuthCredentials();
        if (removed) {
          console.log(chalk.green("Logged out. Stored keys removed."));
          console.log(chalk.dim("Current process still has env. Open new terminal or unset OPENAI_API_KEY ANTHROPIC_API_KEY GOOGLE_AI_API_KEY."));
        } else {
          console.log(chalk.dim("No stored credentials. Keys may be in environment only; unset them or start a new shell."));
        }
        return loop();
      } else if (/^model\s*$/i.test(cmdLine)) {
        const isAuto = sessionModelOverride === "__auto__";
        const effectiveId = isAuto ? undefined : (sessionModelOverride ?? interactiveCfg.defaultModel);
        if (isAuto) console.log(chalk.cyan("Session: auto (routing picks model). Set: model <id> or provider <name> to fix."));
        else console.log(chalk.dim("Session model: " + (effectiveId ?? "(config default: " + (interactiveCfg.defaultModel ?? "none") + "). Set: model <id> or provider <name>")));
        const currentProvider = effectiveId ? getModel(effectiveId)?.metadata.provider : undefined;
        if (currentProvider) {
          const forProvider = listModels().filter((c) => c.enabled && c.metadata.provider === currentProvider);
          if (forProvider.length > 0) {
            console.log(chalk.dim("Models for " + currentProvider + ":"));
            for (const c of forProvider) {
              const cap: string[] = [];
              if (c.metadata.supportsTools) cap.push("tools");
              if (c.metadata.supportsVision) cap.push("vision");
              const ctx = c.metadata.contextWindow >= 1000 ? (c.metadata.contextWindow / 1000).toFixed(0) + "k" : String(c.metadata.contextWindow);
              cap.push(ctx);
              console.log("  " + chalk.cyan(c.metadata.id) + chalk.dim(" — " + (c.metadata.name ?? "") + (cap.length ? " [" + cap.join(", ") + "]" : "")));
            }
          }
        }
      } else if (/^model\s+(.+)\s*$/i.test(cmdLine)) {
        const m = cmdLine.match(/^model\s+(.+)\s*$/i);
        const arg = m?.[1]?.trim();
        if (arg) {
          if (arg === "auto" || arg.toLowerCase() === "clear") {
            sessionModelOverride = arg.toLowerCase() === "auto" ? "__auto__" : undefined;
            console.log(chalk.green("Session model: " + (sessionModelOverride === "__auto__" ? "auto (routing)" : "use config default")));
            return loop();
          }
          const effectiveProvider = (sessionModelOverride && sessionModelOverride !== "__auto__" ? getModel(sessionModelOverride) : getModel(interactiveCfg.defaultModel ?? ""))?.metadata.provider;
          const enabled = listModels().filter((c) => c.enabled);
          const byId = enabled.find((c) => c.metadata.id === arg || c.metadata.id.toLowerCase() === arg.toLowerCase());
          const byShort = effectiveProvider
            ? enabled.find((c) => c.metadata.provider === effectiveProvider && (c.metadata.id.toLowerCase().includes(arg.toLowerCase()) || (c.metadata.name && c.metadata.name.toLowerCase().includes(arg.toLowerCase()))))
            : enabled.find((c) => c.metadata.id.toLowerCase().includes(arg.toLowerCase()) || (c.metadata.name && c.metadata.name.toLowerCase().includes(arg.toLowerCase())));
          const chosen = byId ?? byShort;
          if (chosen) {
            sessionModelOverride = chosen.metadata.id;
            console.log(chalk.green("Session model: " + chosen.metadata.id + " (" + (chosen.metadata.provider ?? "") + ")"));
          } else {
            sessionModelOverride = arg;
            console.log(chalk.green("Session model: " + arg + " (use 'models' to list enabled IDs)"));
          }
        }
      } else if (/^provider\s*$/i.test(cmdLine)) {
        const models = listModels().filter((c) => c.enabled);
        const providers = [...new Set(models.map((c) => c.metadata.provider).filter(Boolean))].sort();
        const isAuto = sessionModelOverride === "__auto__";
        const effectiveId = isAuto ? undefined : (sessionModelOverride ?? interactiveCfg.defaultModel);
        const current = effectiveId ? getModel(effectiveId)?.metadata.provider : undefined;
        if (isAuto) console.log(chalk.cyan("Mode: auto — routing picks model each run. Set: provider <name> or model <id> to fix."));
        if (providers.length === 0) {
          console.log(chalk.dim("No enabled models. Run: gtd models enable <id>"));
        } else {
          console.log(chalk.bold("Providers (enabled):"));
          for (const p of providers) console.log("  " + (p === current ? chalk.cyan(p + " (current)") : p));
        }
      } else if (/^provider\s+(.+)\s*$/i.test(cmdLine)) {
        const m = cmdLine.match(/^provider\s+(.+)\s*$/i);
        const name = m?.[1]?.trim().toLowerCase();
        if (name === "auto") {
          sessionModelOverride = "__auto__";
          console.log(chalk.green("Session: auto — routing will pick model each run."));
        } else if (name) {
          const models = listModels().filter((c) => c.enabled && (c.metadata.provider?.toLowerCase() === name));
          const first = models[0];
          if (first) {
            sessionModelOverride = first.metadata.id;
            console.log(chalk.green("Session model: " + first.metadata.id + " (" + first.metadata.provider + ")"));
          } else {
            console.log(chalk.yellow("No enabled model for provider \"" + name + "\". Use: models to list, then model <id>"));
          }
        }
      } else if (/^permissions\s*$/i.test(cmdLine)) {
        console.log(chalk.dim("Session permission: " + (sessionPermissionOverride ?? "(config: " + (interactiveCfg.permissionMode ?? "default") + "). Set: permissions default|plan|accept-edits|dont-ask|bypass")));
      } else if (/^permissions\s+(\S+)\s*$/i.test(cmdLine)) {
        const m = cmdLine.match(/^permissions\s+(\S+)\s*$/i);
        if (m?.[1]) {
          sessionPermissionOverride = m[1].trim() || undefined;
          console.log(chalk.green("Session permission: " + (sessionPermissionOverride ?? "use config default")));
        }
      } else if (/^personality\s*$/i.test(cmdLine)) {
        const eff = sessionPersonality ?? (interactiveCfg.persona ? PRESET_PERSONAS[interactiveCfg.persona] : undefined);
        console.log(chalk.dim("Session style: " + (eff ?? "none. Set: personality minimal | professional | poetic | <custom> or persona minimal|professional|poetic|clear")));
      } else if (/^personality\s+(.+)\s*$/i.test(cmdLine)) {
        const m = cmdLine.match(/^personality\s+(.+)\s*$/i);
        if (m?.[1]) {
          const v = m[1].trim().toLowerCase();
          if (v === "clear" || v === "none" || !v) {
            sessionPersonality = undefined;
            console.log(chalk.green("Session personality: cleared"));
          } else if (PRESET_PERSONAS[v]) {
            sessionPersonality = PRESET_PERSONAS[v];
            console.log(chalk.green("Session personality: " + v));
          } else {
            sessionPersonality = m[1].trim();
            console.log(chalk.green("Session personality: " + (sessionPersonality.slice(0, 50) + (sessionPersonality.length > 50 ? "…" : ""))));
          }
        }
      } else if (/^persona\s*$/i.test(cmdLine)) {
        console.log(chalk.dim("Config persona: " + (interactiveCfg.persona ?? "none") + ". Session style: " + (sessionPersonality ?? "none. Use: persona minimal | professional | poetic | clear")));
      } else if (/^persona\s+(\S+)\s*$/i.test(cmdLine)) {
        const m = cmdLine.match(/^persona\s+(\S+)\s*$/i);
        if (m?.[1]) {
          const v = m[1].trim().toLowerCase();
          if (v === "clear" || v === "none") {
            sessionPersonality = undefined;
            console.log(chalk.green("Session persona: cleared"));
          } else if (PRESET_PERSONAS[v]) {
            sessionPersonality = PRESET_PERSONAS[v];
            console.log(chalk.green("Session persona: " + v));
          } else {
            console.log(chalk.yellow("Unknown persona. Use: minimal | professional | poetic | clear"));
          }
        }
      } else if (/^agent\s*$/i.test(cmdLine)) {
        runAgent();
      } else if (/^ps\s*$/i.test(cmdLine)) {
        await runPs();
      } else if (/^experimental\s*$/i.test(cmdLine)) {
        const flag = (interactiveCfg as { experimental?: boolean }).experimental;
        console.log(chalk.dim("Experimental: " + (flag ? "on (config.experimental)" : "off. Set config.experimental or gtd config set experimental true.")));
      } else if (/^fork\s*$/i.test(cmdLine)) {
        const forkTag = "fork-" + Date.now();
        await runChatSave(forkTag);
        console.log(chalk.green(`Fork saved as "${forkTag}". New conversation here; chat resume ${forkTag} to return.`));
      } else if (/^statusline\s*$/i.test(cmdLine)) {
        const parts: string[] = [];
        if (sessionProfileName?.trim()) parts.push(`Profile: ${sessionProfileName.trim()}`);
        const personaName = interactiveCfg.persona?.trim();
        if (personaName) parts.push(`Persona: ${personaName}`);
        if (parts.length) console.log(chalk.dim(parts.join(" | ")));
        console.log(chalk.dim("Status line: footer shows recent tasks (TUI). Config statuslineItems planned for customization."));
      } else if (/^queue\s*$/i.test(cmdLine)) {
        console.log(chalk.dim("Queued for next task: " + (sessionQueue ?? "(nothing). Use: queue <text> or queue clear")));
      } else if (/^queue\s+clear\s*$/i.test(cmdLine)) {
        sessionQueue = undefined;
        console.log(chalk.green("Queue cleared."));
      } else if (/^queue\s+(.+)\s*$/i.test(cmdLine)) {
        const m = cmdLine.match(/^queue\s+(.+)\s*$/i);
        if (m?.[1]) {
          sessionQueue = m[1].trim();
          console.log(chalk.green("Queued for next task: " + (sessionQueue.slice(0, 50) + (sessionQueue.length > 50 ? "…" : ""))));
        }
      } else if (/^sandbox-add-read-dir\s*$/i.test(cmdLine)) {
        if (platform() === "win32") {
          console.log(chalk.yellow("Sandbox add-read-dir is not supported on Windows; sandbox is Linux/macOS only. Use --add-dir for writable dirs."));
        } else {
          const dirs = getSandboxExtraReadDirs();
          if (dirs.length === 0) console.log(chalk.dim("No extra read-only dirs. Use: sandbox-add-read-dir <path> (Linux bwrap only)"));
          else console.log(chalk.cyan("Extra read-only dirs: ") + dirs.join(", "));
        }
      } else if (/^sandbox-add-read-dir\s+(.+)\s*$/i.test(cmdLine)) {
        const m = cmdLine.match(/^sandbox-add-read-dir\s+(.+)\s*$/i);
        if (m?.[1]) {
          if (platform() === "win32") {
            console.log(chalk.yellow("Sandbox add-read-dir is not supported on Windows; sandbox is Linux/macOS only."));
          } else {
            const pathArg = resolve(m[1].trim());
            addSandboxExtraReadDir(pathArg);
            console.log(chalk.green("Added read-only dir: " + pathArg + " (used by bwrap on Linux)"));
          }
        }
      } else if (/^edit\s*$/i.test(cmdLine)) {
        if (!lastTaskDesc) {
          console.log(chalk.yellow("No previous task to edit. Run a task first."));
        } else {
          const editor = process.env.EDITOR || process.env.VISUAL;
          if (!editor) {
            console.log(chalk.dim("Last task: " + lastTaskDesc.slice(0, 80) + (lastTaskDesc.length > 80 ? "…" : "")));
            console.log(chalk.yellow("Set EDITOR or VISUAL to edit in editor, or re-run: task \"...\""));
          } else {
            const { writeFile, readFile } = await import("fs/promises");
            const { spawnSync } = await import("child_process");
            const { tmpdir } = await import("os");
            const tmpPath = join(tmpdir(), `gtd-edit-${Date.now()}.txt`);
            await writeFile(tmpPath, lastTaskDesc, "utf-8");
            spawnSync(editor, [tmpPath], { stdio: "inherit" });
            const edited = (await readFile(tmpPath, "utf-8")).trim();
            try {
              const { unlink } = await import("fs/promises");
              await unlink(tmpPath);
            } catch {
              // ignore
            }
            if (edited) {
              lastTaskDesc = edited;
              const roots = sessionDirectories.length > 0 ? sessionDirectories.map((p) => (p.startsWith("/") || /^[A-Za-z]:/.test(p) ? p : resolve(process.cwd(), p))) : undefined;
              const attEdit = sessionAttachments.length ? [...sessionAttachments] : undefined;
              if (attEdit) sessionAttachments.length = 0;
              await runTask(edited, { useProgressBar: true, workspaceRoots: roots, profile: sessionProfileName ?? undefined, model: sessionModelOverride, permissionMode: sessionPermissionOverride, sessionMemory: sessionSessionMemory.length ? sessionSessionMemory.join("\n") : undefined, mode: sessionChatMode, gitCommitVerify: sessionGitCommitVerify, autoLint: sessionAutoLint, lintCmd: sessionLintCmd, autoTest: sessionAutoTest, testCmd: sessionTestCmd, attachments: attEdit, onLintFailure: (out, structured) => { sessionQueue = structured ? formatVerifyForModel(structured, "lint") : "[Lint failed]\n```\n" + out.trim().slice(0, 12000) + (out.length > 12000 ? "\n…" : "") + "\n```"; }, onTestFailure: (out, structured) => { sessionQueue = structured ? formatVerifyForModel(structured, "test") : "[Test failed]\n```\n" + out.trim().slice(0, 12000) + (out.length > 12000 ? "\n…" : "") + "\n```"; } });
            } else {
              console.log(chalk.dim("Empty description; not running."));
            }
          }
        }
      } else if (/^chat\s+delete\s+(\S+)\s*$/i.test(cmdLine)) {
        const m = cmdLine.match(/^chat\s+delete\s+(\S+)\s*$/i);
        if (m?.[1]) await runChatDelete(m[1]);
      } else if (/^chat\s+share\s*$/i.test(cmdLine)) {
        await runChatShare();
      } else if (/^chat\s+share\s+(.+)\s*$/i.test(cmdLine)) {
        const m = cmdLine.match(/^chat\s+share\s+(.+)\s*$/i);
        if (m?.[1]) await runChatShare(m[1].trim());
      } else if (/^help\s+(.+)\s*$/i.test(cmdLine)) {
        const m = cmdLine.match(/^help\s+(.+)\s*$/i);
        const cmd = m?.[1]?.trim().toLowerCase().replace(/^\//, "");
        const desc = cmd ? REPL_HELP[cmd] : undefined;
        if (desc) console.log(chalk.cyan("  " + cmd + " — " + desc));
        else console.log(chalk.yellow("Unknown command: " + (cmd ?? "") + ". Type 'help' for full list."));
      } else if (/^help\s*$/i.test(cmdLine)) {
        console.log("  task \"<description>\"  Run a task");
        console.log("  status [id]         Show task status (or list recent)");
        console.log("  show <id>           Show full task details");
        console.log("  inbox               Show pending and recent tasks");
        console.log("  search [query]      Search tasks");
        console.log("  history             Show completed/failed tasks");
        console.log("  approve <id>        Approve blocked task");
        console.log("  retry <id> [step] [\"follow-up\"]  Retry failed task; optional step and follow-up instruction");
        console.log("  cancel <id>         Request cancel of in-progress task");
        console.log("  delete <id>         Delete a task");
        console.log("  refresh             Refresh task list and MCP tools (TUI)");
        console.log("  clear               Clear screen; new conversation hint");
        console.log("  reset               Drop all session files and clear context");
        console.log("  copy [id]            Copy last (or given) task deliverable to clipboard");
        console.log("  run <cmd>            Run shell command (same as ! <cmd>)");
        console.log("  test <cmd>           Run test command; on failure output queued for next task");
        console.log("  lint                 Lint (GTD_LINT_CMD or npm run lint); on failure output queued");
        console.log("  edit-line            Open $EDITOR with empty buffer; saved content runs as next command (Ctrl-X Ctrl-E style)");
        console.log("  compose              Open $EDITOR to write prompt, then run it");
        console.log("  ok [args]            Run last task again; optional args appended to description");
        console.log("  reasoning-effort [v] Set reasoning effort (low|medium|high|clear); used when model supports it");
        console.log("  think-tokens [v]     Set thinking token budget (e.g. 8k, 0.5M, 0|clear); used when supported");
        console.log("  voice                Voice input (GTD_VOICE_CMD or paste/type)");
        console.log("  web <url>            Fetch URL, strip HTML, queue for next task (GTD_WEB_MAX_CHARS)");
        console.log("  paste [name]         Paste clipboard text; optional name for reference (GTD_PASTE_MAX_CHARS)");
        console.log("  tokens               Show token usage (last 30 tasks)");
        console.log("  report [headline]    Open bug report URL");
        console.log("  models [query]       List enabled models (optional search)");
        console.log("  editor-model [id]    Show or set editor model (architect/editor role)");
        console.log("  weak-model [id]      Show or set weak model (e.g. commit messages)");
        console.log("  tools [desc|nodesc] List tools with or without descriptions");
        console.log("  mcp desc            List MCP servers and tools with descriptions");
        console.log("  mcp schema          List MCP tools with JSON input schema");
        console.log("  privacy             Privacy notice and telemetry");
        console.log("  extensions          List loaded plugins");
        console.log("  settings            Print current merged config (redacted)");
        console.log("  config              Same as settings");
        console.log("  setup               Run first-run/on-demand setup wizard");
        console.log("  bug [headline]       Open bug report URL (set config.bugReportUrl or GTD_BUG_REPORT_URL)");
        console.log("  editor               Show EDITOR/VISUAL (used by settings)");
        console.log("  copy <id>            Copy task deliverable to clipboard");
        console.log("  theme                Show theme/color settings");
        console.log("  auth                 Show API key hints");
        console.log("  model [id]           Show or set session model for next task(s)");
        console.log("  models [query]       List enabled models by provider; optional search");
        console.log("  provider [name]      List providers or set session model to first enabled model of provider");
        console.log("  permissions [preset] Show or set session permission (default|plan|accept-edits|dont-ask|bypass)");
        console.log("  personality [style]  Show or set communication style (minimal|professional|poetic|<custom>)");
        console.log("  persona [preset]     Show or set session persona (minimal|professional|poetic|clear)");
        console.log("  agent                Show pipeline roles (scout→builder→reviewer); plan-only: task --mode architect");
        console.log("  ps                   List in-progress, blocked, and recent tasks");
        console.log("  experimental         Show or hint for experimental features (config.experimental)");
        console.log("  fork                 Save checkpoint and start new thread (chat resume <tag> to return)");
        console.log("  statusline           Show status line / footer hint (TUI)");
        console.log("  queue [text]         Queue text for next task (prepended); queue clear to clear");
        console.log("  edit                 Edit last task in $EDITOR and re-run");
        console.log("  inject <instruction> While task runs: queue follow-up. Or type any line (no command) to inject.");
        console.log("  sandbox-add-read-dir [path]  (Linux/macOS) Add or list extra read-only dirs for sandbox");
        console.log("  directory show       Show workspace roots (session + GTD_WORKSPACE_ROOTS)");
        console.log("  directory add <path> Add path to session workspace roots");
        console.log("  chat save [tag]     Save recent task as checkpoint (tag default: default)");
        console.log("  chat list           List saved chat checkpoints");
        console.log("  chat resume <tag>   Show task (use 'last' for most recent save)");
        console.log("  chat delete <tag>   Remove saved checkpoint");
        console.log("  new                New conversation (start with task \"...\")");
        console.log("  chat-mode [mode]   Show or set chat mode: code | ask | architect | help");
        console.log("  code               Next message in code mode (then revert)");
        console.log("  ask                Next message in ask mode (discuss only, no edits)");
        console.log("  architect          Next message in architect mode (plan only)");
        console.log("  help-mode          Next message in help mode (answers about gtd/skate)");
        console.log("  diff               Show git diff (working tree and staged)");
        console.log("  undo               Undo last commit if it was made by gtd");
        console.log("  commit [message]   Commit all dirty changes (optional message)");
        console.log("  git <args>         Run raw git command (e.g. git status)");
        console.log("  add <path> [path]  Add file(s) to session (Aider-style)");
        console.log("  drop <path> [path] Remove file(s) from session");
        console.log("  read-only <path>   Add or mark as reference-only (do not edit)");
        console.log("  ls                 List session files and read-only status");
        console.log("  map                Print repo map (symbols; token cap GTD_MAP_TOKENS)");
        console.log("  map-refresh        Clear repo map cache; next task or /map rebuilds");
        console.log("  copy-context       Copy session context (files + repo map + last task) to clipboard");
        console.log("  load <file>        Load and execute commands from file (one per line; # = comment)");
        console.log("  save <file>        Save commands to reconstruct session (add + read-only + last task)");
        console.log("  memory             Show MEMORY.md; memory add <text> | edit | trim [chars] | session add | session clear");
        console.log("  multiline-mode     Toggle: Enter = newline, type \".\" alone to submit");
        console.log("  logout             Clear stored API keys (data dir env file)");
        console.log("  chat share [file]  Export conversation (recent task to file.json, or show help)");
        console.log("  ! <command>        Run shell command (or type ! alone to toggle shell mode)");
        console.log("  help [command]      Show this help or help for one command");
        console.log("  exit, quit          Exit (optional save session when TTY)");
        console.log(chalk.dim("  Prefix with / for slash style (e.g. /help, /exit). MCP: gtd mcp list, gtd mcp tools [id]. Workspace: cwd + session."));
        if (tuiState) console.log(chalk.dim("  Shortcuts: Tab = complete, Ctrl+C = cancel, Ctrl+R = reverse history search. See docs/reference/keyboard-shortcuts.md"));
      } else if (/^(exit|quit)\s*$/i.test(cmdLine)) {
        if (process.stdin.isTTY && process.stdout.isTTY) {
          const saveAns = await question(chalk.yellow("Save session before exit? (y/n): "));
          if (saveAns?.toLowerCase() === "y" || saveAns === "Y") {
            const { writeFile } = await import("fs/promises");
            const defaultPath = join(cwd, ".gtd-session-saved");
            const lines: string[] = ["# Skate session — run with: load .gtd-session-saved", ""];
            for (const p of sessionFiles) {
              lines.push("add " + p);
              const abs = resolve(cwd, p);
              if (sessionReadOnly.has(abs) || sessionReadOnly.has(p)) lines.push("read-only " + p);
            }
            if (lastTaskDesc) {
              lines.push("");
              lines.push('task "' + lastTaskDesc.replace(/"/g, '\\"').slice(0, 200) + (lastTaskDesc.length > 200 ? "…" : "") + '"');
            }
            try {
              await writeFile(defaultPath, lines.join("\n") + "\n", "utf-8");
              console.log(chalk.green("Saved to " + defaultPath));
            } catch (e) {
              console.log(chalk.red("Save failed: " + (e instanceof Error ? e.message : String(e))));
            }
          }
        }
        rl?.close();
        process.exit(0);
      } else if (line) {
        console.log(chalk.yellow("Unknown command. Type 'help' for commands."));
      }
      }
      await printSuggestions();
      if (tuiState) {
        tuiState.history.push("> " + line);
        if (tuiState.history.length > 20) tuiState.history = tuiState.history.slice(-20);
        await refreshTUIState();
        drawLiveTUI(tuiState);
      }
      return loop();
    };
    if (!sessionNoGit && !isGitRepo(process.cwd()) && process.stdin.isTTY) {
      const ans = await question(chalk.yellow("Not a git repo. Run git init? (y/n): "));
      if (ans.toLowerCase() === "y" || ans === "") {
        try {
          const { execSync } = await import("child_process");
          execSync("git init", { cwd: process.cwd(), encoding: "utf-8" });
          console.log(chalk.green("Initialized git repo."));
        } catch {
          console.log(chalk.red("git init failed."));
        }
      }
    }
    const initMemory = await loadProjectMemory(process.cwd());
    if (initMemory.trim()) console.log(chalk.dim("Project memory: MEMORY.md (" + initMemory.length + " chars). Use: memory, memory add, memory edit."));
    await loop();
  });

program
  .command("templates")
  .description("List available task templates")
  .option("-f, --format <fmt>", "Output format: text | json", "text")
  .action(async function (this: { opts: () => { format?: string } }) {
    const opts = this.opts();
    const cfg = await loadConfig();
    const templates = await getMergedTemplates(cfg);
    const format = (opts.format ?? "text").toLowerCase();
    if (format === "json") {
      console.log(JSON.stringify(templates, null, 2));
      return;
    }
    console.log(renderBanner());
    const keys = Object.keys(templates).sort();
    if (keys.length === 0) {
      console.log("\nNo templates. Add to config.json templates or ~/.skate/templates.json");
      return;
    }
    console.log(`\nTemplates (use :key, e.g. gtd task :${keys[0]}):`);
    for (const k of keys) {
      const desc = templates[k];
      const preview = desc.length > 60 ? desc.slice(0, 60) + "…" : desc;
      console.log(`  ${chalk.cyan(":" + k)}  ${chalk.dim(preview)}`);
    }
  });

/** Shared runTask opts for code subcommands (79–83). */
async function codeRunTaskOpts(opts: { mode?: string; profile?: string; permissionMode?: string; autoLint?: boolean; autoTest?: boolean }) {
  const taskCfg = await loadConfig();
  const taskCwd = process.cwd();
  const { inferLintCmd } = await import("./lint-infer.js");
  const effectiveLintCmd = process.env.GTD_LINT_CMD ?? taskCfg.lintCmd ?? await inferLintCmd(taskCwd, taskCfg);
  return {
    version: pkg.version,
    mode: opts.mode,
    permissionMode: opts.permissionMode ?? taskCfg.permissionMode,
    profile: opts.profile?.trim() || undefined,
    autoLint: opts.autoLint,
    lintCmd: effectiveLintCmd,
    autoTest: opts.autoTest,
    testCmd: process.env.GTD_TEST_CMD ?? taskCfg.testCmd,
  };
}

const codeCmd = program
  .command("code")
  .description("Code actions for IDE or CLI: explain, fix, generate-tests, generate-docs, refactor, diagram. Pass file path or pipe content via stdin.");

codeCmd
  .command("explain [path]")
  .description("Explain the selected code or file (79)")
  .option("--mode <name>", "architect | debug | ask | orchestrator", "ask")
  .option("--profile <name>", "Use named profile")
  .option("--permission-mode <mode>", "default | plan | accept-edits | dont-ask | bypass")
  .action(async (path: string | undefined, opts: { mode?: string; profile?: string; permissionMode?: string }) => {
    const content = await readFileOrStdin(path);
    if (!content.trim()) {
      console.error(chalk.red("No content: provide a file path or pipe code via stdin."));
      process.exitCode = 1;
      return;
    }
    const desc = `Explain the following code.\n\n\`\`\`\n${content}\n\`\`\``;
    const runOpts = await codeRunTaskOpts({ ...opts, mode: opts.mode ?? "ask" });
    await runTask(desc, runOpts);
  });

codeCmd
  .command("fix [path] [error]")
  .description("Fix error in selection or file (80). Optionally pass error message as second argument.")
  .option("--mode <name>", "architect | debug | ask | orchestrator", "ask")
  .option("--profile <name>", "Use named profile")
  .option("--permission-mode <mode>", "default | plan | accept-edits | dont-ask | bypass")
  .option("--auto-lint", "Run lint after task")
  .option("--auto-test", "Run tests after task")
  .action(async (path: string | undefined, errorArg: string | undefined, opts: { mode?: string; profile?: string; permissionMode?: string; autoLint?: boolean; autoTest?: boolean }) => {
    const content = await readFileOrStdin(path);
    if (!content.trim()) {
      console.error(chalk.red("No content: provide a file path or pipe code via stdin."));
      process.exitCode = 1;
      return;
    }
    const err = (errorArg ?? "").trim() || "See code and context below.";
    const desc = `Fix the following bug.\n\nError: ${err}\n\nCode:\n\`\`\`\n${content}\n\`\`\``;
    const runOpts = await codeRunTaskOpts({ ...opts, autoLint: opts.autoLint, autoTest: opts.autoTest });
    await runTask(desc, runOpts);
  });

codeCmd
  .command("generate-tests [path]")
  .description("Generate tests for the selected code or file (81)")
  .option("--mode <name>", "architect | debug | ask | orchestrator", "ask")
  .option("--profile <name>", "Use named profile")
  .option("--permission-mode <mode>", "default | plan | accept-edits | dont-ask | bypass")
  .option("--auto-test", "Run tests after generating")
  .action(async (path: string | undefined, opts: { mode?: string; profile?: string; permissionMode?: string; autoTest?: boolean }) => {
    const content = await readFileOrStdin(path);
    if (!content.trim()) {
      console.error(chalk.red("No content: provide a file path or pipe code via stdin."));
      process.exitCode = 1;
      return;
    }
    const desc = `Generate unit tests for the following code.\n\n\`\`\`\n${content}\n\`\`\``;
    const runOpts = await codeRunTaskOpts({ ...opts, autoTest: opts.autoTest });
    await runTask(desc, runOpts);
  });

codeCmd
  .command("generate-docs [path]")
  .description("Generate or extend docs for the selected code or file (82)")
  .option("--mode <name>", "architect | debug | ask | orchestrator", "ask")
  .option("--profile <name>", "Use named profile")
  .option("--permission-mode <mode>", "default | plan | accept-edits | dont-ask | bypass")
  .action(async (path: string | undefined, opts: { mode?: string; profile?: string; permissionMode?: string }) => {
    const content = await readFileOrStdin(path);
    if (!content.trim()) {
      console.error(chalk.red("No content: provide a file path or pipe code via stdin."));
      process.exitCode = 1;
      return;
    }
    const desc = `Generate or extend documentation for the following code.\n\n\`\`\`\n${content}\n\`\`\``;
    const runOpts = await codeRunTaskOpts(opts);
    await runTask(desc, runOpts);
  });

codeCmd
  .command("refactor [path] [instruction]")
  .description("Refactor selection or file; optional instruction (83). Confirm/apply via mode.")
  .option("--mode <name>", "architect | debug | ask | orchestrator", "ask")
  .option("--profile <name>", "Use named profile")
  .option("--permission-mode <mode>", "default | plan | accept-edits | dont-ask | bypass")
  .option("--auto-lint", "Run lint after task")
  .action(async (path: string | undefined, instruction: string | undefined, opts: { mode?: string; profile?: string; permissionMode?: string; autoLint?: boolean }) => {
    const content = await readFileOrStdin(path);
    if (!content.trim()) {
      console.error(chalk.red("No content: provide a file path or pipe code via stdin."));
      process.exitCode = 1;
      return;
    }
    const instr = (instruction ?? "").trim() || "Improve clarity and structure.";
    const desc = `Refactor as follows: ${instr}\n\n\`\`\`\n${content}\n\`\`\``;
    const runOpts = await codeRunTaskOpts({ ...opts, autoLint: opts.autoLint });
    await runTask(desc, runOpts);
  });

codeCmd
  .command("diagram [description]")
  .description("Generate ER, state machine, or flowchart from code/description (84). Use --template diagram or pipe content.")
  .option("--mode <name>", "architect | debug | ask | orchestrator", "ask")
  .option("--profile <name>", "Use named profile")
  .option("--permission-mode <mode>", "default | plan | accept-edits | dont-ask | bypass")
  .action(async (description: string | undefined, opts: { mode?: string; profile?: string; permissionMode?: string }) => {
    let body = (description ?? "").trim();
    if (!body && !process.stdin.isTTY) {
      try {
        body = await readStdin();
      } catch {
        // ignore
      }
    }
    if (!body) {
      console.error(chalk.red("Provide a description as argument or pipe content (e.g. code or requirements)."));
      process.exitCode = 1;
      return;
    }
    const desc = `Output a Mermaid or ASCII diagram for: ${body}`;
    const runOpts = await codeRunTaskOpts(opts);
    await runTask(desc, runOpts);
  });

/** Shared runTask opts for data subcommands (89–92); uses profile "data" when available. */
async function dataRunTaskOpts(opts: { mode?: string; profile?: string; permissionMode?: string; autoLint?: boolean; autoTest?: boolean }) {
  const taskCfg = await loadConfig();
  const taskCwd = process.cwd();
  const { inferLintCmd } = await import("./lint-infer.js");
  const effectiveLintCmd = process.env.GTD_LINT_CMD ?? taskCfg.lintCmd ?? await inferLintCmd(taskCwd, taskCfg);
  const profile = opts.profile?.trim() || (taskCfg.profiles?.data ? "data" : undefined);
  return {
    version: pkg.version,
    mode: opts.mode ?? "ask",
    permissionMode: opts.permissionMode ?? taskCfg.permissionMode,
    profile,
    autoLint: opts.autoLint,
    lintCmd: effectiveLintCmd,
    autoTest: opts.autoTest,
    testCmd: process.env.GTD_TEST_CMD ?? taskCfg.testCmd,
  };
}

const dataCmd = program
  .command("data")
  .description("Data & code mode (89–96): analyze data files, generate scripts, charts. Supports CSV, Excel, Parquet, JSON. Use --profile data for a data-tuned profile.");

dataCmd
  .command("analyze [path] [instruction]")
  .description("Analyze a data file (CSV, Excel, Parquet, JSON); optional instruction (89–90). Agent can use sample_tabular for large files.")
  .option("--mode <name>", "architect | debug | ask | orchestrator", "ask")
  .option("--profile <name>", "Use named profile (default: data if configured)")
  .option("--permission-mode <mode>", "default | plan | accept-edits | dont-ask | bypass")
  .action(async (path: string | undefined, instruction: string | undefined, opts: { mode?: string; profile?: string; permissionMode?: string }) => {
    const p = (path ?? "").trim();
    const instr = (instruction ?? "").trim() || "Summarize structure, columns, and suggest analyses or visualizations.";
    let desc: string;
    if (p) {
      desc = `Data analysis task. File: ${p}\n\nInstruction: ${instr}\n\nUse read_file or sample_tabular to inspect the file; then summarize, analyze, or suggest next steps. Supported formats: CSV, Excel, Parquet, JSON.`;
    } else if (!process.stdin.isTTY) {
      try {
        const content = await readStdin();
        desc = `Data analysis task.\n\nInstruction: ${instr}\n\nData or description:\n${content}`;
      } catch {
        desc = `Data analysis task. Instruction: ${instr}`;
      }
    } else {
      console.error(chalk.red("Provide a file path or pipe data/description via stdin. Example: gtd data analyze data.csv \"show summary\""));
      process.exitCode = 1;
      return;
    }
    const runOpts = await dataRunTaskOpts(opts);
    await runTask(desc, runOpts);
  });

dataCmd
  .command("script <description>")
  .description("Generate a runnable script from natural language (91). Prefer Python; use Node or R if requested.")
  .option("--mode <name>", "architect | debug | ask | orchestrator", "ask")
  .option("--profile <name>", "Use named profile (default: data if configured)")
  .option("--permission-mode <mode>", "default | plan | accept-edits | dont-ask | bypass")
  .action(async (description: string, opts: { mode?: string; profile?: string; permissionMode?: string }) => {
    const desc = `Generate a runnable script (Python preferred, or Node/R if requested) that: ${description}`;
    const runOpts = await dataRunTaskOpts(opts);
    await runTask(desc, runOpts);
  });

dataCmd
  .command("chart [path] [instruction]")
  .description("Generate chart/plot code from data or description (92). Output runnable code (e.g. matplotlib, Node).")
  .option("--mode <name>", "architect | debug | ask | orchestrator", "ask")
  .option("--profile <name>", "Use named profile (default: data if configured)")
  .option("--permission-mode <mode>", "default | plan | accept-edits | dont-ask | bypass")
  .action(async (path: string | undefined, instruction: string | undefined, opts: { mode?: string; profile?: string; permissionMode?: string }) => {
    const p = (path ?? "").trim();
    const instr = (instruction ?? "").trim() || "Produce a clear visualization.";
    let desc: string;
    if (p) {
      desc = `Generate code to produce a chart or plot from the given data or description. Data file: ${p}\n\nInstruction: ${instr}\n\nOutput runnable code (e.g. Python matplotlib/seaborn or Node chart library) and how to run it.`;
    } else if (!process.stdin.isTTY) {
      try {
        const content = await readStdin();
        desc = `Generate code to produce a chart or plot. Instruction: ${instr}\n\nData or description:\n${content}`;
      } catch {
        desc = `Generate code to produce a chart or plot. Instruction: ${instr}`;
      }
    } else {
      desc = `Generate code to produce a chart or plot from the given data or description. Instruction: ${instr}\n\nOutput runnable code (e.g. Python matplotlib/seaborn or Node) and how to run it.`;
    }
    const runOpts = await dataRunTaskOpts(opts);
    await runTask(desc, runOpts);
  });

program
  .command("serve")
  .description("Start messaging bots (Telegram, Slack, WhatsApp, Signal, Discord) and optional webhook")
  .option("--telegram", "Start Telegram bot only")
  .option("--slack", "Start Slack bot only")
  .option("--whatsapp", "Start WhatsApp webhook only")
  .option("--signal", "Start Signal bot only")
  .option("--discord", "Start Discord bot only")
  .option("--webhook", "Start generic webhook server (POST /webhook)")
  .option("--api", "Enable HTTP API (GET/POST /api/tasks, GET /api/tasks/:id, POST /api/tasks/:id/inject, POST /api/approvals/:id/approve). Use GTD_API_KEY for auth.")
  .option("--approval-ui", "Serve approval dashboard (GET /approvals, POST /approvals/:id/approve, GET /approvals/dashboard)")
  .option("--dev-ui", "Serve dev/debug UI at /dev (task list + run form; requires --api)")
  .option("--email", "Start email connector (IMAP polling)")
  .option("--matrix", "Start Matrix bot only")
  .action(async (opts: { telegram?: boolean; slack?: boolean; whatsapp?: boolean; signal?: boolean; discord?: boolean; webhook?: boolean; api?: boolean; approvalUi?: boolean; devUi?: boolean; email?: boolean; matrix?: boolean }) => {
    console.log(renderBanner());
    const hasTelegram = !!process.env.TELEGRAM_BOT_TOKEN;
    const hasSlack = !!process.env.SLACK_BOT_TOKEN && (!!process.env.SLACK_APP_TOKEN || !!process.env.SLACK_SIGNING_SECRET);
    const hasWhatsApp = !!process.env.WHATSAPP_ACCESS_TOKEN && !!process.env.WHATSAPP_PHONE_NUMBER_ID;
    const hasSignal = !!process.env.SIGNAL_BRIDGE_URL && !!process.env.SIGNAL_NUMBER;
    const hasDiscord = !!process.env.DISCORD_BOT_TOKEN;
    const hasEmail = !!(process.env.EMAIL_IMAP_HOST && process.env.EMAIL_IMAP_USER && process.env.EMAIL_IMAP_PASS);
    const hasMatrix = !!(process.env.MATRIX_HOMESERVER_URL && process.env.MATRIX_ACCESS_TOKEN);
    const runTelegram = opts.telegram ?? (!opts.slack && !opts.whatsapp && !opts.signal && !opts.discord && !opts.webhook && !opts.email && !opts.matrix && hasTelegram);
    const runSlack = opts.slack ?? (!opts.telegram && !opts.whatsapp && !opts.signal && !opts.discord && !opts.webhook && !opts.email && !opts.matrix && hasSlack);
    const runWhatsApp = opts.whatsapp ?? (!opts.telegram && !opts.slack && !opts.signal && !opts.discord && !opts.webhook && !opts.email && !opts.matrix && hasWhatsApp);
    const runSignal = opts.signal ?? (!opts.telegram && !opts.slack && !opts.whatsapp && !opts.discord && !opts.webhook && !opts.email && !opts.matrix && hasSignal);
    const runDiscord = opts.discord ?? (!opts.telegram && !opts.slack && !opts.whatsapp && !opts.signal && !opts.webhook && !opts.email && !opts.matrix && hasDiscord);
    const runWebhook = !!opts.webhook;
    const runApi = !!opts.api;
    const runApprovalUi = !!opts.approvalUi;
    const runDevUi = !!opts.devUi;
    const runEmail = opts.email ?? (!opts.telegram && !opts.slack && !opts.whatsapp && !opts.signal && !opts.discord && !opts.webhook && !opts.api && !opts.approvalUi && !opts.devUi && !opts.matrix && hasEmail);
    const runMatrix = opts.matrix ?? (!opts.telegram && !opts.slack && !opts.whatsapp && !opts.signal && !opts.discord && !opts.webhook && !opts.email && hasMatrix);

    const toRun: Promise<void>[] = [];
    if (runTelegram) toRun.push(startTelegramBot());
    if (runSlack) toRun.push(startSlackBot());
    if (runWhatsApp) toRun.push(startWhatsAppBot());
    if (runSignal) toRun.push(startSignalBot());
    if (runDiscord) toRun.push(startDiscordBot());
    if (runWebhook) toRun.push(startWebhookServer());
    if (runEmail) toRun.push(startEmailConnector());
    if (runMatrix) toRun.push(startMatrixBot());

    if (toRun.length > 0 || runApprovalUi || runApi || runDevUi) {
      const healthPort = parseInt(process.env.HEALTH_PORT ?? "3099", 10) || 3099;
      const apiKey = process.env.GTD_API_KEY?.trim();
      const apiPublic = process.env.GTD_API_PUBLIC === "1" || process.env.GTD_API_PUBLIC === "true";
      const checkApiAuth = (req: import("http").IncomingMessage): boolean => {
        if (apiPublic) return true;
        if (!apiKey) return false;
        const auth = req.headers.authorization;
        const bearer = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : null;
        const xKey = req.headers["x-api-key"];
        const key = bearer ?? (typeof xKey === "string" ? xKey : null);
        return key === apiKey;
      };
      const readJsonBody = (req: import("http").IncomingMessage): Promise<Record<string, unknown>> =>
        new Promise((resolve, reject) => {
          const chunks: Buffer[] = [];
          req.on("data", (c) => chunks.push(c));
          req.on("end", () => {
            try {
              const raw = Buffer.concat(chunks).toString("utf-8");
              resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
            } catch (e) {
              reject(e);
            }
          });
          req.on("error", reject);
        });
      const { createServer } = await import("http");
      const escapeHtml = (s: string) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
      const idempotencyMap = new Map<string, string>();
      const idempotencyMax = 500;
      const injectedInstructionsByTask = new Map<string, string>();
      let serverShuttingDown = false;
      const apiRequestTimeoutMs = parseInt(process.env.GTD_API_REQUEST_TIMEOUT_MS ?? "0", 10) || 0;
      const healthServer = createServer(async (req, res) => {
        if (serverShuttingDown) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Server shutting down" }));
          return;
        }
        const url = req.url ?? "/";
        const path = url.split("?")[0];
        const pathQuery = url.includes("?") ? url.slice(url.indexOf("?")) : "";
        /** Normalize /api/v1/... to /api/... for route matching; future v2 can be added. */
        const pathNorm = path.startsWith("/api/v1/") ? "/api" + path.slice(8) : path === "/api/v1" ? "/api" : path;
        const traceId = uuidv4();
        const rateLimitRemaining = 999;
        const apiHeaders = (extra?: Record<string, string>) => ({
          "Content-Type": "application/json",
          "X-Trace-Id": traceId,
          "X-RateLimit-Limit": "1000",
          "X-RateLimit-Remaining": String(rateLimitRemaining),
          "X-API-Version": "1",
          ...extra,
        });
        if ((path === "/health" || path === "/health/") && req.method === "GET") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "ok", bots: "running" }));
          return;
        }
        if ((path === "/api/health" || path === "/api/health/") && req.method === "GET") {
          res.writeHead(200, apiHeaders());
          res.end(JSON.stringify({ status: "ok", version: pkg.version }));
          return;
        }
        if (runApi && (path.startsWith("/api/") || path.startsWith("/api/v1"))) {
          if (!checkApiAuth(req)) {
            res.writeHead(401, apiHeaders());
            res.end(JSON.stringify({ error: "Unauthorized" }));
            return;
          }
          if ((pathNorm === "/api/capabilities" || pathNorm === "/api/capabilities/") && req.method === "GET") {
            const caps = getCapabilities(pkg.version);
            res.writeHead(200, apiHeaders());
            res.end(JSON.stringify(caps));
            return;
          }
          if ((pathNorm === "/api/tasks" || pathNorm === "/api/tasks/") && req.method === "GET") {
            const params = new URLSearchParams(pathQuery);
            const statusParam = params.get("status");
            const status = ["pending", "in_progress", "blocked", "completed", "failed", "cancelled"].includes(statusParam ?? "") ? statusParam as "pending" | "in_progress" | "blocked" | "completed" | "failed" | "cancelled" : undefined;
            const limit = Math.min(50, parseInt(params.get("limit") ?? "20", 10) || 20);
            const tasks = await listTasks({ status, limit });
            res.writeHead(200, apiHeaders());
            res.end(JSON.stringify({ tasks: tasks.map((t) => ({ id: t.id, description: t.description, status: t.status, createdAt: t.createdAt })) }));
            return;
          }
          const streamMatch = pathNorm.match(/^\/api\/tasks\/([^/]+)\/stream\/?$/);
          if (streamMatch && req.method === "GET") {
            const id = decodeURIComponent(streamMatch[1]);
            res.writeHead(200, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
              "X-Trace-Id": traceId,
            });
            const send = (event: { phase?: string; role?: string; status?: string; output?: string }) => {
              res.write(`data: ${JSON.stringify(event)}\n\n`);
            };
            send({ phase: "connected", status: "streaming" });
            const unsub = streamSubscribe(id, send);
            req.on("close", () => unsub());
            return;
          }
          const taskIdMatch = pathNorm.match(/^\/api\/tasks\/([^/]+)\/?$/);
          if (taskIdMatch && req.method === "GET") {
            const id = decodeURIComponent(taskIdMatch[1]);
            const params = new URLSearchParams(pathQuery);
            const handoffQuery = params.get("handoff");
            const task = await getTask(id);
            if (!task) {
              res.writeHead(404, apiHeaders());
              res.end(JSON.stringify({ error: "Task not found" }));
              return;
            }
            if (handoffQuery === "1" || handoffQuery === "true") {
              const handoff = { version: 1, cliVersion: pkg.version, taskId: task.id, description: task.description, status: task.status, plan: task.plan, outputs: task.outputs ?? {}, error: task.error, createdAt: task.createdAt, hint: "Import via POST /api/handoff or gtd handoff-import <file>; then gtd retry <id>." };
              res.writeHead(200, apiHeaders());
              res.end(JSON.stringify(handoff));
              return;
            }
            const payload: Record<string, unknown> = { id: task.id, description: task.description, status: task.status, plan: task.plan, outputs: task.outputs, error: task.error, createdAt: task.createdAt, updatedAt: task.updatedAt };
            if (task.usage) payload.usage = task.usage;
            if (task.usageByModel && Object.keys(task.usageByModel).length > 0) payload.usageByModel = task.usageByModel;
            if (task.toolCalls && Object.keys(task.toolCalls).length > 0) payload.toolCalls = task.toolCalls;
            const estCost = estimateTaskCost(task);
            if (estCost !== undefined) payload.estimatedCost = estCost;
            const rulesPreview = await loadProjectRules(process.cwd()).then((r) => (r ? r.slice(0, 500) : undefined));
            if (rulesPreview) payload.projectRulesPreview = rulesPreview;
            res.writeHead(200, apiHeaders());
            res.end(JSON.stringify(payload));
            return;
          }
          const injectMatch = pathNorm.match(/^\/api\/tasks\/([^/]+)\/inject\/?$/);
          if (injectMatch && req.method === "POST") {
            const id = decodeURIComponent(injectMatch[1]);
            let body: { instruction?: string };
            try {
              body = (await readJsonBody(req)) as { instruction?: string };
            } catch {
              res.writeHead(400, apiHeaders());
              res.end(JSON.stringify({ error: "Invalid JSON body" }));
              return;
            }
            const instruction = typeof body.instruction === "string" ? body.instruction.trim() : "";
            if (!instruction) {
              res.writeHead(400, apiHeaders());
              res.end(JSON.stringify({ error: "Missing instruction" }));
              return;
            }
            injectedInstructionsByTask.set(id, instruction);
            res.writeHead(200, apiHeaders());
            res.end(JSON.stringify({ ok: true, taskId: id }));
            return;
          }
          if ((pathNorm === "/api/tasks" || pathNorm === "/api/tasks/") && req.method === "POST") {
            let body: {
              description?: string;
              taskId?: string;
              stepTimeoutMs?: number;
              workspaceRoots?: string[];
              attachments?: Array<{ type: "image_url"; image_url: { url: string } } | { type: "image"; data: string; mimeType?: string }>;
              qualityProfile?: string;
              permissionMode?: string;
              timeout?: number;
              container?: boolean;
              dryRun?: boolean;
              format?: string;
              containerVolumes?: string[];
              mode?: string;
            };
            try {
              body = (await readJsonBody(req)) as typeof body;
            } catch {
              res.writeHead(400, apiHeaders());
              res.end(JSON.stringify({ error: "Invalid JSON body" }));
              return;
            }
            const description = typeof body.description === "string" ? body.description.trim() : "";
            if (!description) {
              res.writeHead(400, apiHeaders());
              res.end(JSON.stringify({ error: "Missing description" }));
              return;
            }
            const idempotencyKey = req.headers["idempotency-key"] as string | undefined;
            if (idempotencyKey && typeof idempotencyKey === "string") {
              const existing = idempotencyMap.get(idempotencyKey);
              if (existing) {
                res.writeHead(200, apiHeaders());
                res.end(JSON.stringify({ taskId: existing }));
                return;
              }
            }
            const taskId = typeof body.taskId === "string" && body.taskId ? body.taskId : uuidv4();
            await saveTask(toStored({ id: taskId, description, source: "webhook", status: "pending" }));
            const runOpts: Parameters<typeof runTask>[1] = {
              taskId,
              auto: true,
              quiet: true,
              onProgress: (phase, role, status, output) => streamEmit(taskId, { phase, role, status, output }),
              version: pkg.version,
              getInjectedInstruction: () => {
                const v = injectedInstructionsByTask.get(taskId);
                if (v != null) {
                  injectedInstructionsByTask.delete(taskId);
                  return v;
                }
                return undefined;
              },
            };
            if (typeof body.stepTimeoutMs === "number" && body.stepTimeoutMs > 0) runOpts.stepTimeoutMs = body.stepTimeoutMs;
            if (Array.isArray(body.workspaceRoots) && body.workspaceRoots.length > 0) runOpts.workspaceRoots = body.workspaceRoots;
            if (Array.isArray(body.attachments) && body.attachments.length > 0) runOpts.attachments = body.attachments;
            if (typeof body.qualityProfile === "string" && body.qualityProfile.trim()) runOpts.quality = body.qualityProfile.trim();
            if (typeof body.permissionMode === "string" && body.permissionMode.trim()) runOpts.permissionMode = body.permissionMode.trim();
            if (typeof body.timeout === "number" && body.timeout > 0) runOpts.timeout = body.timeout;
            if (body.container === true) runOpts.container = true;
            if (body.dryRun === true) runOpts.dryRun = true;
            if (typeof body.format === "string" && body.format.trim()) runOpts.format = body.format.trim().toLowerCase();
            if (Array.isArray(body.containerVolumes) && body.containerVolumes.length > 0) runOpts.containerVolumes = body.containerVolumes;
            const modeVal = typeof body.mode === "string" ? body.mode.trim().toLowerCase() : "";
            if (["architect", "debug", "ask", "orchestrator"].includes(modeVal)) runOpts.mode = modeVal;
            runTask(description, runOpts).catch(() => {});
            if (idempotencyKey && typeof idempotencyKey === "string") {
              if (idempotencyMap.size >= idempotencyMax) idempotencyMap.clear();
              idempotencyMap.set(idempotencyKey, taskId);
            }
            res.writeHead(200, apiHeaders());
            res.end(JSON.stringify({ taskId }));
            return;
          }
          const runStepMatch = pathNorm.match(/^\/api\/tasks\/([^/]+)\/run-step\/?$/);
          if (runStepMatch && req.method === "POST") {
            const id = decodeURIComponent(runStepMatch[1]);
            let body: { stepIndex?: number };
            try {
              body = (await readJsonBody(req)) as { stepIndex?: number };
            } catch {
              res.writeHead(400, apiHeaders());
              res.end(JSON.stringify({ error: "Invalid JSON body" }));
              return;
            }
            const task = await getTask(id);
            if (!task) {
              res.writeHead(404, apiHeaders());
              res.end(JSON.stringify({ error: "Task not found" }));
              return;
            }
            if (!task.plan?.steps?.length || !task.outputs) {
              res.writeHead(400, apiHeaders());
              res.end(JSON.stringify({ error: "Task must have a plan and outputs (run or dry-run first)" }));
              return;
            }
            const stepIndex = typeof body.stepIndex === "number" ? body.stepIndex : parseInt(String(body.stepIndex), 10);
            if (!Number.isFinite(stepIndex) || stepIndex < 1 || stepIndex > task.plan.steps.length) {
              res.writeHead(400, apiHeaders());
              res.end(JSON.stringify({ error: `stepIndex must be 1–${task.plan.steps.length}` }));
              return;
            }
            const step = task.plan.steps[stepIndex - 1];
            const roleOrder = ["scout", "planner", "builder", "reviewer", "documenter"];
            const roleIdx = roleOrder.indexOf(step.assignedRole);
            if (roleIdx < 0) {
              res.writeHead(400, apiHeaders());
              res.end(JSON.stringify({ error: `Step role ${step.assignedRole} not supported for run-step` }));
              return;
            }
            const outputsBefore: Record<string, string> = {};
            for (let i = 0; i < roleIdx; i++) {
              const r = roleOrder[i];
              if (task.outputs[r]) outputsBefore[r] = task.outputs[r];
            }
            await loadAndApplyModelsConfig();
            const cfg = await loadConfig();
            try {
              const result = await runOrchestration({
                taskId: task.id,
                taskDescription: task.description,
                qualityProfile: task.qualityProfile ?? "balanced",
                approvalPolicy: "auto",
                resumeFrom: { outputs: outputsBefore, plan: task.plan },
                runOnlyStepIndex: stepIndex,
                modelOverrides: cfg.modelOverrides,
                toolPolicy: resolvePolicy({ mode: "dont-ask" }, null),
              });
              const outputsRecord = Object.fromEntries(result.outputs);
              const mergedOutputs = { ...task.outputs, ...outputsRecord };
              await saveTask(toStored({
                id: result.taskId,
                description: task.description,
                source: task.source,
                sourceId: task.sourceId,
                qualityProfile: task.qualityProfile,
                approvalPolicy: task.approvalPolicy,
                status: result.status,
                plan: result.plan ?? task.plan,
              }, {
                completedAt: new Date().toISOString(),
                error: result.error,
                outputs: mergedOutputs,
                usage: result.usage,
                usageByModel: result.usageByModel,
              }));
              res.writeHead(200, apiHeaders());
              res.end(JSON.stringify({ success: result.status === "completed", taskId: result.taskId, stepIndex, role: step.assignedRole, status: result.status, error: result.error ?? undefined }));
            } catch (e) {
              const err = e instanceof Error ? e.message : String(e);
              res.writeHead(500, apiHeaders());
              res.end(JSON.stringify({ success: false, error: err }));
            }
            return;
          }
          if (pathNorm.match(/^\/api\/approvals\/([^/]+)\/approve\/?$/) && req.method === "POST") {
            const id = decodeURIComponent(pathNorm.replace(/^\/api\/approvals\/([^/]+)\/approve\/?$/, "$1"));
            let approveBody: {
              reason?: string;
              reject?: boolean;
              rejectFeedback?: string;
              editedArgs?: Record<string, unknown>;
            };
            try {
              approveBody = (await readJsonBody(req)) as typeof approveBody;
            } catch {
              approveBody = {};
            }
            await loadAndApplyModelsConfig();
            let pendingToolApproval: import("../agents/runner.js").ToolApprovalResult | undefined;
            if (approveBody.reject === true) {
              pendingToolApproval = {
                choice: "reject",
                rejectFeedback:
                  typeof approveBody.rejectFeedback === "string" ? approveBody.rejectFeedback.trim() : undefined,
              };
            } else if (
              approveBody.editedArgs != null &&
              typeof approveBody.editedArgs === "object" &&
              !Array.isArray(approveBody.editedArgs)
            ) {
              pendingToolApproval = { choice: "allow", editedArgs: approveBody.editedArgs };
            }
            const result = await approveTask(id, {
              quiet: true,
              reason: typeof approveBody.reason === "string" ? approveBody.reason : undefined,
              pendingToolApproval,
            });
            const alreadyApproved = result.success && result.status !== "blocked" && result.status !== undefined;
            res.writeHead(200, apiHeaders());
            res.end(JSON.stringify({ success: result.success, taskId: result.taskId, status: result.status, error: result.error, alreadyApproved }));
            return;
          }
          if ((pathNorm === "/api/allow" || pathNorm === "/api/allow/") && req.method === "GET") {
            const cwd = process.cwd();
            const sessionSet = getSessionAllow();
            const projectSet = await loadProjectAllow(cwd);
            const toEntries = (set: Set<string>) =>
              Array.from(set).map((k) => {
                const [tool, category] = k.split(":");
                return { tool: tool ?? "", category: category ?? "" };
              });
            res.writeHead(200, apiHeaders());
            res.end(JSON.stringify({ session: toEntries(sessionSet), project: toEntries(projectSet) }));
            return;
          }
          if ((pathNorm === "/api/allow" || pathNorm === "/api/allow/") && req.method === "POST") {
            let allowBody: { tool?: string; category?: string; scope?: "session" | "project"; cwd?: string };
            try {
              allowBody = (await readJsonBody(req)) as typeof allowBody;
            } catch {
              res.writeHead(400, apiHeaders());
              res.end(JSON.stringify({ error: "Invalid JSON body" }));
              return;
            }
            const tool = typeof allowBody.tool === "string" ? allowBody.tool.trim() : "";
            const category = typeof allowBody.category === "string" ? allowBody.category.trim() : "";
            const scope = allowBody.scope === "project" ? "project" : "session";
            if (!tool || !category) {
              res.writeHead(400, apiHeaders());
              res.end(JSON.stringify({ error: "Missing tool or category" }));
              return;
            }
            const cwd = typeof allowBody.cwd === "string" && allowBody.cwd ? allowBody.cwd : process.cwd();
            if (scope === "session") {
              addToSessionAllow(tool, category);
            } else {
              await addToProjectAllow(cwd, tool, category);
            }
            audit({ type: "allow_list_extended", message: `scope=${scope} tool=${tool} category=${category} cwd=${cwd}` });
            res.writeHead(200, apiHeaders());
            res.end(JSON.stringify({ ok: true, scope, tool, category }));
            return;
          }
          if ((pathNorm === "/api/handoff" || pathNorm === "/api/handoff/") && req.method === "POST") {
            let body: { taskId?: string; description?: string; status?: string; plan?: unknown; outputs?: Record<string, string>; error?: string; createdAt?: string };
            try {
              body = (await readJsonBody(req)) as typeof body;
            } catch {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Invalid JSON body" }));
              return;
            }
            const taskId = body?.taskId;
            if (!taskId || typeof taskId !== "string") {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Handoff bundle missing taskId" }));
              return;
            }
            const status = ["pending", "in_progress", "blocked", "completed", "failed", "cancelled"].includes(body.status ?? "") ? body.status as "pending" | "in_progress" | "blocked" | "completed" | "failed" | "cancelled" : "blocked";
            const stored = toStored({
              id: taskId,
              description: body.description ?? "",
              source: "webhook",
              qualityProfile: "balanced",
              approvalPolicy: "hybrid",
              status,
              plan: body.plan as Parameters<typeof toStored>[0]["plan"],
              createdAt: body.createdAt ? new Date(body.createdAt) : new Date(),
            }, { error: body.error, outputs: body.outputs });
            await saveTask(stored);
            const pathUrl = new URL(url, "http://localhost");
            const run = pathUrl.searchParams.get("run") === "1" || pathUrl.searchParams.get("run") === "true";
            if (run && (status === "blocked" || status === "failed")) {
              if (status === "blocked") {
                loadAndApplyModelsConfig().then(() => approveTask(taskId, { quiet: true })).catch(() => {});
              } else {
                const { spawn } = await import("child_process");
                const cliPath = process.argv[1] ?? join(process.cwd(), "dist/cli/index.js");
                spawn(process.execPath, [cliPath, "retry", taskId], { stdio: "ignore", env: process.env, cwd: process.cwd() }).unref();
              }
            }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ taskId, imported: true, run: run }));
            return;
          }
          res.writeHead(404, apiHeaders());
          res.end(JSON.stringify({ error: "Not found", path: pathNorm }));
          return;
        }
        if (runDevUi && runApi && (path === "/dev" || path === "/dev/") && req.method === "GET") {
          const devHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Skate – Dev</title></head><body>
<h1>Dev / Debug</h1>
<p><a href="/api/tasks">API: tasks</a></p>
<h2>Recent tasks</h2>
<div id="tasks">Loading…</div>
<h2>Run task</h2>
<form id="run" method="post" action="/api/tasks" onsubmit="return runTask(event)">
  <textarea name="description" rows="3" placeholder="Task description" style="width:100%;max-width:600px"></textarea>
  <br><button type="submit">Run</button>
</form>
<script>
function runTask(e) {
  e.preventDefault();
  const form = e.target;
  const desc = (form.description && form.description.value) || '';
  if (!desc.trim()) { alert('Enter a description'); return false; }
  fetch('/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ description: desc.trim() }) })
    .then(r => r.json()).then(d => { alert('Task ID: ' + (d.taskId || d.error)); loadTasks(); form.description.value = ''; }).catch(x => alert(x));
  return false;
}
function loadTasks() {
  fetch('/api/tasks?limit=20').then(r => r.json()).then(d => {
    const el = document.getElementById('tasks');
    if (!d.tasks || d.tasks.length === 0) { el.innerHTML = '<p>No tasks.</p>'; return; }
    el.innerHTML = '<ul>' + d.tasks.map(t => '<li><strong>' + t.id.slice(0,8) + '</strong> ' + t.status + ' ' + (t.description || '').slice(0,60) + ' <a href="/api/tasks/' + t.id + '">View</a></li>').join('') + '</ul>';
  }).catch(() => { document.getElementById('tasks').innerHTML = '<p>Failed to load (auth?).</p>'; });
}
loadTasks();
</script></body></html>`;
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(devHtml);
          return;
        }
        if (runApprovalUi && path.startsWith("/approvals")) {
          if (path === "/approvals" || path === "/approvals/") {
            if (req.method === "GET") {
              const blocked = await listTasks({ status: "blocked", limit: 50 });
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ blocked: blocked.map((t) => ({ id: t.id, description: t.description })) }));
              return;
            }
          } else if (path.match(/^\/approvals\/([^/]+)\/approve\/?$/) && req.method === "POST") {
            const id = decodeURIComponent(path.replace(/^\/approvals\/([^/]+)\/approve\/?$/, "$1"));
            let body: { reject?: boolean; rejectFeedback?: string; editedArgs?: Record<string, unknown> } = {};
            try {
              const raw = await new Promise<string>((resolve, reject) => {
                const chunks: Buffer[] = [];
                req.on("data", (c) => chunks.push(c));
                req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
                req.on("error", reject);
              });
              if (raw.trim()) body = JSON.parse(raw) as typeof body;
            } catch {
              /* ignore */
            }
            await loadAndApplyModelsConfig();
            let pendingToolApproval: import("../agents/runner.js").ToolApprovalResult | undefined;
            if (body.reject === true) {
              pendingToolApproval = {
                choice: "reject",
                rejectFeedback: typeof body.rejectFeedback === "string" ? body.rejectFeedback.trim() : undefined,
              };
            } else if (
              body.editedArgs != null &&
              typeof body.editedArgs === "object" &&
              !Array.isArray(body.editedArgs)
            ) {
              pendingToolApproval = { choice: "allow", editedArgs: body.editedArgs };
            }
            const result = await approveTask(id, { quiet: true, pendingToolApproval });
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: result.success, taskId: result.taskId, status: result.status, error: result.error }));
            return;
          } else if ((path === "/approvals/dashboard" || path === "/approvals/dashboard/") && req.method === "GET") {
            const blocked = await listTasks({ status: "blocked", limit: 50 });
            const listHtml =
              blocked.length === 0
                ? "<p>No blocked tasks.</p>"
                : "<ul>" +
                  blocked
                    .map(
                      (t) =>
                        `<li><strong>${escapeHtml(t.id.slice(0, 8))}</strong> ${escapeHtml(t.description.slice(0, 80))}<br>` +
                        `<input type="text" placeholder="Edit args (JSON)" id="edit-${escapeHtml(t.id)}" style="width:200px;margin:2px"> ` +
                        `<input type="text" placeholder="Reject feedback" id="reject-${escapeHtml(t.id)}" style="width:200px;margin:2px"><br>` +
                        `<button onclick="approve('${escapeHtml(t.id)}')">Approve</button> ` +
                        `<button onclick="reject('${escapeHtml(t.id)}')">Reject</button></li>`
                    )
                    .join("") +
                  "</ul>";
            const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Skate – Approvals</title></head><body><h1>Blocked tasks</h1>${listHtml}<script>
function approve(id) {
  const editEl = document.getElementById('edit-' + id);
  const body = editEl && editEl.value.trim() ? (function(){ try { return JSON.stringify({ editedArgs: JSON.parse(editEl.value) }); } catch(e) { alert('Invalid JSON'); return null; } })() : null;
  fetch('/approvals/' + encodeURIComponent(id) + '/approve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body || '{}' })
    .then(r => r.json()).then(d => { alert(d.success ? 'Approved' : (d.error || 'Failed')); if (d.success) location.reload(); });
}
function reject(id) {
  const fbEl = document.getElementById('reject-' + id);
  const body = JSON.stringify({ reject: true, rejectFeedback: fbEl ? fbEl.value.trim() : '' });
  fetch('/approvals/' + encodeURIComponent(id) + '/approve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
    .then(r => r.json()).then(d => { alert(d.success === false ? (d.error || 'Rejected') : 'Done'); location.reload(); });
}
</script></body></html>`;
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(html);
            return;
          }
        }
        res.writeHead(404);
        res.end();
      });
      if (apiRequestTimeoutMs > 0) {
        (healthServer as import("http").Server & { requestTimeout?: number }).requestTimeout = apiRequestTimeoutMs;
      }
      healthServer.listen(healthPort, () => {
        console.log(chalk.dim(`Health: http://localhost:${healthPort}/health`));
        if (runApi) {
          const apiMsg = apiKey ? `API: http://localhost:${healthPort}/api/tasks (auth: GTD_API_KEY)` : apiPublic ? `API: http://localhost:${healthPort}/api/tasks (public; set GTD_API_KEY to require auth)` : `API: http://localhost:${healthPort}/api/tasks (set GTD_API_KEY for auth, or GTD_API_PUBLIC=1 for trusted networks)`;
          console.log(chalk.dim(apiMsg));
        }
        if (runApprovalUi) console.log(chalk.dim(`Approval UI: http://localhost:${healthPort}/approvals/dashboard`));
        if (runDevUi) console.log(chalk.dim(`Dev UI: http://localhost:${healthPort}/dev`));
      });
      const shutdown = () => {
        if (serverShuttingDown) return;
        serverShuttingDown = true;
        console.log(chalk.dim("Shutting down… (finishing in-flight requests)"));
        healthServer.close(() => {
          process.exit(0);
        });
        setTimeout(() => process.exit(0), 15000);
      };
      process.on("SIGTERM", shutdown);
      process.on("SIGINT", shutdown);
      if (toRun.length > 0) {
        await Promise.all(toRun);
      } else {
        await loadAndApplyModelsConfig();
      }
      await new Promise(() => {}); // Keep alive
    } else {
      console.error(chalk.red("No connector configured. Use --api, --webhook, --approval-ui, --email, --matrix for HTTP/API/dashboard, or set TELEGRAM_BOT_TOKEN, SLACK_BOT_TOKEN, WHATSAPP_ACCESS_TOKEN + WHATSAPP_PHONE_NUMBER_ID, SIGNAL_BRIDGE_URL + SIGNAL_NUMBER, DISCORD_BOT_TOKEN, or MATRIX_HOMESERVER_URL + MATRIX_ACCESS_TOKEN."));
      process.exit(1);
    }
  });

program
  .command("inbox")
  .description("Show pending tasks and approval requests")
  .option("-n, --limit <n>", "Max items to show", "10")
  .option("-t, --tag <tag>", "Filter by tag (repeatable)", collectTag, [])
  .option("-f, --format <fmt>", "Output format: text | json", "text")
  .action(async function (this: { opts: () => { limit?: string; tag?: string[]; format?: string } }) {
    const opts = this.opts();
    const tasks = await listTasks({
      status: undefined,
      tags: opts.tag?.length ? opts.tag : undefined,
      limit: parseInt(opts.limit ?? "10", 10) || 10,
    });
    const pending = tasks.filter((t) => t.status === "pending" || t.status === "blocked" || t.status === "in_progress");
    const recent = tasks.filter((t) => t.status === "completed" || t.status === "failed").slice(0, 5);
    const format = (opts.format ?? "text").toLowerCase();
    if (format === "json") {
      console.log(JSON.stringify({ pending, recent }, null, 2));
      return;
    }
    console.log(renderBanner());
    if (pending.length === 0 && recent.length === 0) {
      console.log("\nInbox: No tasks.");
      return;
    }
    const tagStr = (t: { tags?: string[] }) => (t.tags?.length ? chalk.dim(` [${t.tags.join(", ")}]`) : "");
    if (pending.length > 0) {
      console.log("\nPending / In progress:");
      for (const t of pending) {
        console.log(`  ${chalk.cyan(t.id.slice(0, 8))} ${t.status} ${t.description.slice(0, 50)}${t.description.length > 50 ? "…" : ""}${tagStr(t)}`);
      }
    }
    if (recent.length > 0) {
      console.log("\nRecent:");
      for (const t of recent) {
        const statusColor = t.status === "completed" ? chalk.green : chalk.red;
        console.log(`  ${chalk.cyan(t.id.slice(0, 8))} ${statusColor(t.status)} ${t.description.slice(0, 50)}${t.description.length > 50 ? "…" : ""}${tagStr(t)}`);
      }
    }
  });

program
  .command("approvals")
  .description("List blocked tasks awaiting approval; use -i to select and approve one")
  .option("-i, --interactive", "Interactive: select a task to approve")
  .option("-f, --format <fmt>", "Output format: text | json", "text")
  .action(async function (this: { opts: () => { format?: string; interactive?: boolean } }) {
    const opts = this.opts();
    const format = (opts.format ?? "text").toLowerCase();
    await loadAndApplyModelsConfig();
    const tasks = await listTasks({ status: "blocked", limit: 50 });
    if (format === "json") {
      console.log(JSON.stringify({ blocked: tasks.map((t) => ({ id: t.id, description: t.description })) }, null, 2));
      return;
    }
    if (tasks.length === 0) {
      console.log(chalk.dim("No blocked tasks. Run a task with approval policy (e.g. hybrid) to get blocked steps."));
      return;
    }
    console.log(renderBanner());
    console.log(chalk.bold("\nBlocked tasks:\n"));
    tasks.forEach((t, i) => {
      console.log(`  ${chalk.cyan(String(i + 1))}. ${chalk.cyan(t.id.slice(0, 8))} ${t.description.slice(0, 60)}${t.description.length > 60 ? "…" : ""}`);
    });
    console.log(chalk.dim("\nRun gtd approve <id> to approve and resume, or gtd approvals -i to select interactively.\n"));
    if (!opts.interactive) return;
    const { createInterface } = await import("readline");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const question = (p: string) => new Promise<string>((resolve) => rl.question(p, (a) => resolve((a ?? "").trim())));
    const raw = await question(chalk.cyan("Number or task id to approve (or Enter to skip): "));
    rl.close();
    if (!raw) return;
    const idArg = /^\d+$/.test(raw) ? tasks[Number(raw) - 1]?.id : raw;
    if (!idArg) {
      console.log(chalk.red("Invalid selection."));
      return;
    }
    console.log(chalk.cyan(`\nApproving ${idArg}…`));
    const result = await approveTask(idArg, {
      onProgress: (role, status) => {
        if (status === "done") console.log(chalk.green(`✓ ${role} done`));
        else if (status === "running") console.log(chalk.cyan(`… ${role} running…`));
      },
    });
    if (result.success && result.deliverable) {
      console.log(chalk.bold("\n--- Deliverable ---"));
      console.log(result.deliverable);
    } else if (result.success) {
      console.log(chalk.green("\n✓ Task completed."));
    } else {
      console.log(chalk.red("\n" + (result.error ?? "Approval failed.")));
      process.exitCode = 1;
    }
  });

program
  .command("approve <id>")
  .description("Approve a blocked task and resume execution")
  .option("-f, --format <fmt>", "Output format: text | json", "text")
  .action(async function (this: { opts: () => { format?: string } }, idArg: string) {
    const opts = this.opts();
    const format = (opts.format ?? "text").toLowerCase();
    if (format !== "json") console.log(renderBanner());
    await loadAndApplyModelsConfig();
    const result = await approveTask(idArg, {
      onProgress: (role, status) => {
        if (format === "json") return;
        if (role && status === "done") console.log(chalk.green(`✓ ${role} done`));
        else if (role && status === "running") console.log(chalk.cyan(`… ${role} running…`));
      },
    });
    if (result.error && !result.taskId) {
      if (format === "json") {
        console.log(JSON.stringify({ success: false, error: result.error }, null, 2));
        process.exitCode = 1;
      } else {
        console.log(chalk.red(`\n${result.error}`));
        process.exitCode = 1;
      }
      return;
    }
    if (!result.success && result.error) {
      if (format === "json") {
        console.log(JSON.stringify({ success: false, taskId: result.taskId, status: result.status, error: result.error }, null, 2));
        process.exitCode = 1;
      } else {
        console.log(chalk.yellow("\n" + result.error));
        process.exitCode = 1;
      }
      return;
    }
    if (result.success) {
      if (format === "json") {
        console.log(JSON.stringify({ success: true, taskId: result.taskId, status: result.status, deliverable: result.deliverable }, null, 2));
      } else if (result.deliverable) {
        console.log(chalk.bold("\n--- Deliverable ---"));
        console.log(result.deliverable);
      } else {
        console.log(chalk.green("\n✓ Task completed."));
      }
    } else {
      if (format === "json") {
        console.log(JSON.stringify({ success: false, taskId: result.taskId, status: result.status, error: result.error ?? "Task failed" }, null, 2));
        process.exitCode = 1;
      } else {
        console.log(chalk.red("\n✗ " + (result.error ?? "Task failed")));
        process.exitCode = 1;
      }
    }
  });

program
  .command("delete <id>")
  .description("Delete a task")
  .option("-f, --force", "Skip confirmation")
  .option("--format <fmt>", "Output format: text | json", "text")
  .action(async function (this: { opts: () => { force?: boolean; format?: string } }, idArg: string) {
    const opts = this.opts();
    const format = (opts.format ?? "text").toLowerCase();
    let task = await getTask(idArg);
    if (!task) {
      const tasks = await listTasks({ limit: 50 });
      task = tasks.find((t) => t.id.startsWith(idArg) || t.id === idArg);
    }
    if (!task) {
      if (format === "json") {
        console.log(JSON.stringify({ success: false, error: `Task ${idArg} not found` }, null, 2));
      } else {
        console.log(chalk.red(`Task ${idArg} not found.`));
      }
      process.exitCode = 1;
      return;
    }
    if (!opts.force) {
      const { createInterface } = await import("readline");
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise<string>((resolve) => {
        rl.question(`Delete task ${task!.id}? (y/N): `, (a) => {
          rl.close();
          resolve((a ?? "").trim().toLowerCase());
        });
      });
      if (answer !== "y" && answer !== "yes") {
        if (format === "json") {
          console.log(JSON.stringify({ success: false, error: "Cancelled" }, null, 2));
        } else {
          console.log("Cancelled.");
        }
        return;
      }
    }
    const ok = await deleteTask(task.id);
    if (ok) {
      if (format === "json") {
        console.log(JSON.stringify({ success: true, taskId: task.id }, null, 2));
      } else {
        console.log(chalk.green(`Deleted task ${task.id}`));
      }
    } else {
      if (format === "json") {
        console.log(JSON.stringify({ success: false, error: `Failed to delete ${task.id}` }, null, 2));
      } else {
        console.log(chalk.red(`Failed to delete ${task.id}`));
      }
      process.exitCode = 1;
    }
  });

program
  .command("cancel <id>")
  .description("Request cancellation of an in-progress task (from another terminal)")
  .option("--format <fmt>", "Output format: text | json", "text")
  .action(async function (this: { opts: () => { format?: string } }, idArg: string) {
    const opts = this.opts();
    const format = (opts.format ?? "text").toLowerCase();
    let task = await getTask(idArg);
    if (!task) {
      const tasks = await listTasks({ limit: 50 });
      task = tasks.find((t) => t.id.startsWith(idArg) || t.id === idArg);
    }
    if (!task) {
      if (format === "json") {
        console.log(JSON.stringify({ success: false, error: `Task ${idArg} not found` }, null, 2));
        process.exitCode = 1;
      } else {
        console.log(chalk.red(`Task ${idArg} not found.`));
      }
      return;
    }
    if (task.status !== "in_progress") {
      if (format === "json") {
        console.log(JSON.stringify({ success: false, error: `Task ${task.id} is not in progress (status: ${task.status})` }, null, 2));
        process.exitCode = 1;
      } else {
        console.log(chalk.yellow(`Task ${task.id} is not in progress (status: ${task.status}).`));
      }
      return;
    }
    await requestCancel(task.id);
    if (format === "json") {
      console.log(JSON.stringify({ success: true, taskId: task.id }, null, 2));
    } else {
      console.log(chalk.green(`Cancel requested for ${task.id}. The task will stop at the next checkpoint.`));
    }
  });

program
  .command("usage")
  .description("Show token usage across tasks")
  .option("-n, --limit <n>", "Max tasks to include", "100")
  .option("-a, --after <date>", "Tasks created after date (ISO format)")
  .option("--by-task", "Show per-task token/cost breakdown")
  .option("-f, --format <fmt>", "Output format: text | json", "text")
  .action(async function (this: { opts: () => { limit?: string; after?: string; format?: string; byTask?: boolean } }) {
    const opts = this.opts();
    const limit = parseInt(opts.limit ?? "100", 10) || 100;
    const format = (opts.format ?? "text").toLowerCase();
    const byTask = opts.byTask === true;

    if (byTask) {
      const tasks = await listTasks({ limit, after: opts.after });
      const withUsage = tasks.filter((t) => t.usage || (t.usageByModel && Object.keys(t.usageByModel).length > 0) || (t.toolCalls && Object.keys(t.toolCalls).length > 0));
      if (format === "json") {
        console.log(
          JSON.stringify(
            withUsage.map((t) => ({
              id: t.id,
              description: t.description.slice(0, 80),
              status: t.status,
              usage: t.usage,
              usageByModel: t.usageByModel,
              toolCalls: t.toolCalls,
            })),
            null,
            2
          )
        );
        return;
      }
      console.log(renderBanner());
      if (withUsage.length === 0) {
        console.log("\nNo per-task usage data. Run tasks to track token usage.");
        return;
      }
      console.log(`\nUsage by task (${withUsage.length} task(s)):\n`);
      for (const t of withUsage) {
        const p = t.usage?.promptTokens ?? 0;
        const c = t.usage?.completionTokens ?? 0;
        let cost = 0;
        if (t.usageByModel) {
          for (const [model, u] of Object.entries(t.usageByModel)) {
            const est = estimateCost(model, u.promptTokens, u.completionTokens);
            if (est !== undefined) cost += est;
          }
        } else if (t.usage) {
          const est = estimateCost("unknown", t.usage.promptTokens, t.usage.completionTokens);
          if (est !== undefined) cost += est;
        }
        const costStr = cost > 0 ? chalk.dim(` ~ $${cost.toFixed(4)}`) : "";
        console.log(`  ${chalk.cyan(t.id.slice(0, 8))} ${t.status} ${(p + c).toLocaleString()} tokens${costStr}`);
        if (t.toolCalls && Object.keys(t.toolCalls).length > 0) {
          console.log(chalk.dim(`    tools: ${Object.entries(t.toolCalls).map(([n, c]) => `${n}(${c})`).join(", ")}`));
        }
        console.log(chalk.dim(`    ${t.description.slice(0, 60)}${t.description.length > 60 ? "…" : ""}`));
      }
      return;
    }

    const summary = await getUsageSummary({ limit, after: opts.after });
    if (format === "json") {
      console.log(JSON.stringify(summary, null, 2));
      return;
    }
    console.log(renderBanner());
    if (summary.totalTasks === 0) {
      console.log("\nNo usage data. Run tasks to track token usage.");
      return;
    }
    const total = summary.totalPromptTokens + summary.totalCompletionTokens;
    let totalCost: number | undefined;
    console.log(`\nToken usage (${summary.totalTasks} task(s)):`);
    console.log(`  Prompt:     ${summary.totalPromptTokens.toLocaleString()}`);
    console.log(`  Completion: ${summary.totalCompletionTokens.toLocaleString()}`);
    console.log(`  Total:      ${total.toLocaleString()}`);
    if (Object.keys(summary.byModel).length > 0) {
      console.log("\nBy model:");
      const byModelSorted = Object.entries(summary.byModel).sort(
        (a, b) => (b[1].promptTokens + b[1].completionTokens) - (a[1].promptTokens + a[1].completionTokens)
      );
      totalCost = 0;
      for (const [model, u] of byModelSorted) {
        const mTotal = u.promptTokens + u.completionTokens;
        const tasksLabel = u.tasks === 1 ? "task" : "tasks";
        const costStr = formatEstimatedCost(model, u.promptTokens, u.completionTokens);
        const cost = estimateCost(model, u.promptTokens, u.completionTokens);
        if (cost !== undefined) totalCost += cost;
        console.log(`  ${model}: ${mTotal.toLocaleString()} (${u.promptTokens.toLocaleString()} in / ${u.completionTokens.toLocaleString()} out) - ${u.tasks} ${tasksLabel}${costStr}`);
      }
      if (totalCost !== undefined && totalCost > 0) {
        console.log(chalk.dim(`\n  Est. total: ~ $${totalCost.toFixed(2)}`));
      }
    }
  });

const ROLE_ORDER = ["scout", "planner", "builder", "reviewer", "documenter"] as const;

function truncateOutputsForStep(outputs: Record<string, string>, fromStep: string): Record<string, string> {
  const idx = (ROLE_ORDER as readonly string[]).indexOf(fromStep);
  if (idx <= 0) return {};
  const keep = new Set(ROLE_ORDER.slice(0, idx) as string[]);
  return Object.fromEntries(Object.entries(outputs).filter(([k]) => keep.has(k)));
}

program
  .command("replay <id>")
  .description("Show timeline of what happened for a task (audit + telemetry)")
  .option("-f, --format <fmt>", "Output format: text | json", "text")
  .action(async function (this: { opts: () => { format?: string } }, idArg: string) {
    const opts = this.opts();
    const format = (opts.format ?? "text").toLowerCase();
    let task = await getTask(idArg);
    if (!task) {
      const tasks = await listTasks({ limit: 50 });
      task = tasks.find((t) => t.id.startsWith(idArg) || t.id === idArg);
    }
    if (!task) {
      if (format === "json") {
        console.log(JSON.stringify({ error: `Task ${idArg} not found` }, null, 2));
        process.exitCode = 1;
      } else {
        console.log(chalk.red(`Task ${idArg} not found.`));
        process.exitCode = 1;
      }
      return;
    }
    const taskId = task.id;
    const [auditEvents, metricEvents] = await Promise.all([
      getAuditLogByTaskId(taskId),
      getMetricsByTaskId(taskId),
    ]);
    type TimelineEntry = { ts: string; kind: "audit" | "metric"; type: string; message?: string; latencyMs?: number; step?: string; modelId?: string };
    const timeline: TimelineEntry[] = [];
    for (const e of auditEvents) {
      timeline.push({
        ts: e.timestamp,
        kind: "audit",
        type: e.type,
        message: e.message,
      });
    }
    for (const e of metricEvents) {
      timeline.push({
        ts: e.timestamp,
        kind: "metric",
        type: e.type,
        latencyMs: e.latencyMs,
        step: e.step ?? e.role,
        modelId: e.modelId,
      });
    }
    timeline.sort((a, b) => a.ts.localeCompare(b.ts));
    if (format === "json") {
      console.log(
        JSON.stringify(
          { taskId, description: task.description, status: task.status, timeline },
          null,
          2
        )
      );
      return;
    }
    console.log(renderBanner());
    console.log(`\nReplay: ${taskId} — ${task.description.slice(0, 60)}${task.description.length > 60 ? "…" : ""}`);
    console.log(`Status: ${task.status}\n`);
    if (timeline.length === 0) {
      console.log(chalk.dim("No audit or metric events for this task."));
      return;
    }
    console.log("Timeline:");
    for (const e of timeline) {
      const time = e.ts.replace("T", " ").slice(0, 19);
      const part = e.kind === "audit" ? `${e.type}${e.message ? `: ${e.message}` : ""}` : `${e.type}${e.step ? ` ${e.step}` : ""}${e.latencyMs != null ? ` ${e.latencyMs}ms` : ""}${e.modelId ? ` (${e.modelId})` : ""}`;
      console.log(`  ${chalk.dim(time)} ${e.kind === "audit" ? chalk.cyan(e.type) : chalk.magenta(e.type)} ${part}`);
    }
  });

program
  .command("retry <id>")
  .description("Retry a failed task from the last completed step (optionally with a follow-up instruction)")
  .option("-s, --from-step <role>", "Retry from specific step: scout | planner | builder | reviewer | documenter")
  .option("--follow-up <text>", "Append follow-up instruction to the task (e.g. \"Fix the timeout\")")
  .option("-f, --format <fmt>", "Output format: text | json", "text")
  .action(async function (this: { opts: () => { fromStep?: string; format?: string; followUp?: string } }, idArg: string) {
    const opts = this.opts();
    const format = (opts.format ?? "text").toLowerCase();
    if (format !== "json") console.log(renderBanner());
    let task = await getTask(idArg);
    if (!task) {
      const tasks = await listTasks({ limit: 50 });
      task = tasks.find((t) => t.id.startsWith(idArg) || t.id === idArg);
    }
    if (!task) {
      if (format === "json") {
        console.log(JSON.stringify({ success: false, error: `Task ${idArg} not found` }, null, 2));
        process.exitCode = 1;
      } else {
        console.log(chalk.red(`\nTask ${idArg} not found.`));
      }
      return;
    }
    if (task.status !== "failed") {
      if (format === "json") {
        console.log(JSON.stringify({ success: false, error: `Task ${task.id} is not failed (status: ${task.status})` }, null, 2));
        process.exitCode = 1;
      } else {
        console.log(chalk.yellow(`\nTask ${shortTaskId(task.id)} is not failed (status: ${task.status}). Use 'gtd approve' for blocked tasks.`));
      }
      return;
    }
    if (!task.outputs || !task.plan) {
      if (format === "json") {
        console.log(JSON.stringify({ success: false, error: "Failed task missing outputs or plan" }, null, 2));
        process.exitCode = 1;
      } else {
        console.log(chalk.red("\nFailed task missing outputs or plan. Cannot retry."));
      }
      return;
    }

    let resumeOutputs = task.outputs;
    if (opts.fromStep) {
      const validSteps = ["scout", "planner", "builder", "reviewer", "documenter"];
      if (!validSteps.includes(opts.fromStep.toLowerCase())) {
        if (format === "json") {
          console.log(JSON.stringify({ success: false, error: `Invalid --from-step. Use: ${validSteps.join(" | ")}` }, null, 2));
          process.exitCode = 1;
        } else {
          console.log(chalk.red(`\nInvalid --from-step. Use: ${validSteps.join(" | ")}`));
        }
        return;
      }
      resumeOutputs = truncateOutputsForStep(task.outputs, opts.fromStep.toLowerCase());
      if (format !== "json") console.log(chalk.dim(`Retrying from step: ${opts.fromStep}`));
    }

    if (format !== "json") console.log(chalk.cyan(`\nRetrying task ${task.id}: ${task.description.slice(0, 50)}…`));
    const taskDescription = opts.followUp ? `${task.description}\n\nFollow-up: ${opts.followUp}` : task.description;
    if (opts.followUp && format !== "json") console.log(chalk.dim(`Follow-up: ${opts.followUp.slice(0, 60)}${opts.followUp.length > 60 ? "…" : ""}`));

    try {
      const result = await runOrchestration({
        taskId: task.id,
        taskDescription,
        qualityProfile: task.qualityProfile,
        approvalPolicy: "auto",
        resumeFrom: { outputs: resumeOutputs, plan: task.plan },
        modelOverrides: (await loadConfig()).modelOverrides,
        onProgress: (_phase, role, status, _output) => {
          if (format === "json") return;
          if (role && status === "done") {
            console.log(chalk.green(`✓ ${role} done`));
          } else if (role && status === "running") {
            console.log(chalk.cyan(`… ${role} running…`));
          }
        },
      });

      const outputsRecord = Object.fromEntries(result.outputs);
      await saveTask(toStored({
        id: result.taskId,
        description: task.description,
        source: task.source,
        sourceId: task.sourceId,
        qualityProfile: task.qualityProfile,
        approvalPolicy: task.approvalPolicy,
        status: result.status,
        plan: result.plan,
      }, {
        completedAt: new Date().toISOString(),
        error: result.error,
        outputs: outputsRecord,
        usage: result.usage,
        usageByModel: result.usageByModel,
        toolCalls: result.toolCalls,
      }));

      if (result.status === "completed") {
        const builderOut = result.outputs.get("builder");
        if (format === "json") {
          console.log(JSON.stringify({ success: true, taskId: result.taskId, status: result.status, deliverable: builderOut ?? undefined }, null, 2));
        } else if (builderOut) {
          console.log(chalk.bold("\n--- Deliverable ---"));
          console.log(builderOut);
        } else {
          console.log(chalk.green("\n✓ Task completed."));
        }
      } else {
        if (format === "json") {
          console.log(JSON.stringify({ success: false, taskId: result.taskId, status: result.status, error: result.error ?? "Task failed" }, null, 2));
          process.exitCode = 1;
        } else {
          console.log(chalk.red("\n✗ " + (result.error ?? "Task failed")));
        }
      }
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      if (format === "json") {
        console.log(JSON.stringify({ success: false, error: err }, null, 2));
        process.exitCode = 1;
      } else {
        console.log(chalk.red("\n✗ Error: " + err));
      }
    }
  });

function runStatusTask(taskIdArg: string, format: string): Promise<void> {
  return (async () => {
    let task = await getTask(taskIdArg);
    if (!task) {
      const tasks = await listTasks({ limit: 50 });
      task = tasks.find((t) => t.id.startsWith(taskIdArg) || t.id === taskIdArg);
    }
    if (!task) {
      if (format === "json") {
        console.log(JSON.stringify({ error: "Not found", taskId: taskIdArg }, null, 2));
      } else {
        console.log(renderBanner());
        console.log(`\nStatus for task ${taskIdArg}: Not found.`);
      }
      process.exitCode = 1;
      return;
    }
    if (format === "json") {
      console.log(JSON.stringify(task, null, 2));
      return;
    }
    console.log(renderBanner());
    const t = task;
    console.log(`\nTask ${t.id}`);
    console.log(`  Description: ${t.description}`);
    console.log(`  Status: ${t.status}`);
    if (t.tags?.length) console.log(`  Tags: ${t.tags.join(", ")}`);
    if (t.usage) console.log(`  Tokens: ${t.usage.promptTokens} prompt / ${t.usage.completionTokens} completion`);
    if (t.usageByModel && Object.keys(t.usageByModel).length > 0) {
      console.log("  By model:");
      let taskCost = 0;
      for (const [model, u] of Object.entries(t.usageByModel)) {
        const costStr = formatEstimatedCost(model, u.promptTokens, u.completionTokens);
        const cost = estimateCost(model, u.promptTokens, u.completionTokens);
        if (cost !== undefined) taskCost += cost;
        console.log(`    ${model}: ${u.promptTokens} in / ${u.completionTokens} out${costStr}`);
      }
      if (taskCost > 0) console.log(chalk.dim(`  Est. cost: ~ $${taskCost.toFixed(4)}`));
    }
    if (t.toolCalls && Object.keys(t.toolCalls).length > 0) {
      console.log("  Tool calls: " + Object.entries(t.toolCalls).map(([name, count]) => `${name} (${count})`).join(", "));
    }
    console.log(`  Created: ${t.createdAt}`);
    if (t.completedAt) {
      console.log(`  Completed: ${t.completedAt}`);
      const created = t.createdAt ? new Date(t.createdAt).getTime() : NaN;
      const completed = new Date(t.completedAt).getTime();
      if (Number.isFinite(created) && Number.isFinite(completed) && completed >= created) {
        console.log(`  Duration: ${formatDuration(completed - created)}`);
      }
    }
    if (t.error) console.log(`  Error: ${t.error}`);
    if (t.outputs?.builder) console.log(`\n--- Builder output ---\n${t.outputs.builder.slice(0, 500)}${t.outputs.builder.length > 500 ? "…" : ""}`);
  })();
}

program
  .command("show <id>")
  .description("Show full details of a task")
  .option("-f, --format <fmt>", "Output format: text | json", "text")
  .action(async function (this: { opts: () => { format?: string } }, id: string) {
    const format = (this.opts().format ?? "text").toLowerCase();
    await runStatusTask(id, format);
  });

program
  .command("status [task-id]")
  .description("Show status of task(s)")
  .option("-t, --tag <tag>", "Filter by tag (repeatable)", collectTag, [])
  .option("-n, --limit <n>", "Max tasks when listing (no id)", "10")
  .option("-f, --format <fmt>", "Output format: text | json", "text")
  .action(async function (this: { opts: () => { tag?: string[]; limit?: string; format?: string } }, taskIdArg?: string) {
    const o = this.opts();
    const format = (o.format ?? "text").toLowerCase();
    if (taskIdArg) {
      await runStatusTask(taskIdArg, format);
    } else {
      const limit = parseInt(o.limit ?? "10", 10) || 10;
      const tasks = await listTasks({ limit, tags: o.tag?.length ? o.tag : undefined });
      if (format === "json") {
        console.log(JSON.stringify(tasks, null, 2));
        return;
      }
      console.log(renderBanner());
      if (tasks.length === 0) {
        console.log("\nNo tasks.");
        return;
      }
      console.log("\nRecent tasks:");
      const tagStr = (t: { tags?: string[] }) => (t.tags?.length ? chalk.dim(` [${t.tags.join(", ")}]`) : "");
      for (const t of tasks) {
        const statusColor = t.status === "completed" ? chalk.green : t.status === "failed" ? chalk.red : chalk.yellow;
        console.log(`  ${chalk.cyan(t.id.slice(0, 8))} ${statusColor(t.status)} ${t.description.slice(0, 40)}${t.description.length > 40 ? "…" : ""}${tagStr(t)}`);
      }
    }
  });

program
  .command("search [query]")
  .description("Search tasks by description, status, or date")
  .option("-s, --status <status>", "Filter by status (pending|in_progress|blocked|completed|failed)")
  .option("-t, --tag <tag>", "Filter by tag (repeatable)", collectTag, [])
  .option("-a, --after <date>", "Tasks created after date (ISO format)")
  .option("-n, --limit <n>", "Max results", "50")
  .option("-f, --format <fmt>", "Output format: text | json", "text")
  .action(async (query?: string, opts?: { status?: string; tag?: string[]; after?: string; limit?: string; format?: string }) => {
    const o = opts ?? {};
    const limit = parseInt(o.limit ?? "50", 10) || 50;
    const tasks = await searchTasks({
      query: query || undefined,
      status: o.status as "pending" | "in_progress" | "blocked" | "completed" | "failed" | undefined,
      tags: o.tag?.length ? o.tag : undefined,
      after: o.after,
      limit,
    });
    const format = (o.format ?? "text").toLowerCase();
    if (format === "json") {
      console.log(JSON.stringify(tasks, null, 2));
      return;
    }
    console.log(renderBanner());
    if (tasks.length === 0) {
      console.log("\nNo matching tasks.");
      return;
    }
    console.log(`\n${tasks.length} task(s):`);
    const tagStr = (t: { tags?: string[] }) => (t.tags?.length ? chalk.dim(` [${t.tags.join(", ")}]`) : "");
    for (const t of tasks) {
      const statusColor = t.status === "completed" ? chalk.green : t.status === "failed" ? chalk.red : chalk.yellow;
      console.log(`  ${chalk.cyan(t.id.slice(0, 8))} ${statusColor(t.status)} ${t.description.slice(0, 50)}${t.description.length > 50 ? "…" : ""}${tagStr(t)}`);
    }
  });

program
  .command("history")
  .description("Show completed and failed tasks")
  .option("-n, --limit <n>", "Max tasks to show", "20")
  .option("-t, --tag <tag>", "Filter by tag (repeatable)", collectTag, [])
  .option("-f, --format <fmt>", "Output format: text | json", "text")
  .action(async function (this: { opts: () => { limit?: string; tag?: string[]; format?: string } }) {
    const opts = this.opts();
    const limit = parseInt(opts.limit ?? "20", 10) || 20;
    const tags = opts.tag?.length ? opts.tag : undefined;
    const completed = await listTasks({ status: "completed", tags, limit });
    const failed = await listTasks({ status: "failed", tags, limit });
    const all = [...completed, ...failed].sort(
      (a, b) => new Date(b.completedAt ?? b.createdAt).getTime() - new Date(a.completedAt ?? a.createdAt).getTime()
    ).slice(0, limit);
    const format = (opts.format ?? "text").toLowerCase();
    if (format === "json") {
      console.log(JSON.stringify(all, null, 2));
      return;
    }
    console.log(renderBanner());
    if (all.length === 0) {
      console.log("\nNo completed or failed tasks.");
      return;
    }
    console.log("\nHistory:");
    const tagStr = (t: { tags?: string[] }) => (t.tags?.length ? chalk.dim(` [${t.tags.join(", ")}]`) : "");
    for (const t of all) {
      const statusColor = t.status === "completed" ? chalk.green : chalk.red;
      const date = t.completedAt ?? t.createdAt;
      console.log(`  ${chalk.cyan(t.id.slice(0, 8))} ${statusColor(t.status)} ${t.description.slice(0, 45)}${t.description.length > 45 ? "…" : ""}${tagStr(t)} (${date})`);
    }
  });

program
  .command("import <path>")
  .description("Import tasks from a JSON file")
  .option("-m, --mode <mode>", "merge (default) or replace", "merge")
  .option("-d, --dry-run", "Validate only, do not write")
  .option("-f, --format <fmt>", "Output format: text | json", "text")
  .action(async function (this: { opts: () => { mode?: string; dryRun?: boolean; format?: string } }, path: string) {
    const opts = this.opts();
    try {
      const mode = (opts.mode === "replace" ? "replace" : "merge") as "merge" | "replace";
      const result = await importTasks(path, { mode, dryRun: opts.dryRun });
      const format = (opts.format ?? "text").toLowerCase();
      if (format === "json") {
        console.log(JSON.stringify({ imported: result.imported, skipped: result.skipped, errors: result.errors }, null, 2));
        return;
      }
      if (opts.dryRun) {
        console.log(chalk.yellow(`Dry-run: ${result.imported} valid, ${result.skipped} skipped`));
        if (result.errors.length) console.log(chalk.red(result.errors.join("\n")));
      } else {
        console.log(chalk.green(`Imported ${result.imported} task(s), skipped ${result.skipped}`));
        if (result.errors.length) console.log(chalk.yellow(result.errors.join("\n")));
      }
    } catch (e) {
      const format = (opts.format ?? "text").toLowerCase();
      if (format === "json") {
        console.log(JSON.stringify({ imported: 0, skipped: 0, errors: [e instanceof Error ? e.message : String(e)] }, null, 2));
        process.exitCode = 1;
      } else {
        console.log(chalk.red("Import failed: " + (e instanceof Error ? e.message : String(e))));
      }
    }
  });

program
  .command("export [path]")
  .description("Export tasks to JSON file (default: stdout)")
  .option("-n, --limit <n>", "Max tasks to export", "100")
  .option("-s, --status <status>", "Filter by status (pending|in_progress|blocked|completed|failed)")
  .option("-t, --tag <tag>", "Filter by tag (repeatable)", collectTag, [])
  .option("-a, --after <date>", "Tasks created after date (ISO format)")
  .option("-q, --query <query>", "Filter by description substring")
  .option("-f, --format <fmt>", "Output format: text | json (affects summary when writing to file)", "text")
  .action(async function (this: { opts: () => { limit?: string; status?: string; tag?: string[]; after?: string; query?: string; format?: string } }, pathArg?: string) {
    const opts = this.opts();
    const limit = parseInt(opts.limit ?? "100", 10) || 100;
    const hasFilters = opts.query || opts.status || (opts.tag?.length ?? 0) > 0 || opts.after;
    const tasks = hasFilters
      ? await searchTasks({
          query: opts.query || undefined,
          status: opts.status as "pending" | "in_progress" | "blocked" | "completed" | "failed" | undefined,
          tags: opts.tag?.length ? opts.tag : undefined,
          after: opts.after,
          limit,
        })
      : await listTasks({ limit });
    const json = JSON.stringify(tasks, null, 2);
    const format = (opts.format ?? "text").toLowerCase();
    if (pathArg) {
      const { writeFile, mkdir } = await import("fs/promises");
      const { dirname } = await import("path");
      const dir = dirname(pathArg);
      if (dir) await mkdir(dir, { recursive: true });
      await writeFile(pathArg, json, "utf-8");
      if (format === "json") {
        console.log(JSON.stringify({ path: pathArg, count: tasks.length }, null, 2));
      } else {
        console.log(`Exported ${tasks.length} tasks to ${pathArg}`);
      }
    } else {
      console.log(json);
    }
  });

program
  .command("backup [path]")
  .description("Backup data dir to a timestamped archive")
  .option("-f, --format <fmt>", "Output format: text | json", "text")
  .action(async function (this: { opts: () => { format?: string } }, path?: string) {
    const opts = this.opts();
    try {
      const out = await doBackup(path);
      const format = (opts.format ?? "text").toLowerCase();
      if (format === "json") {
        console.log(JSON.stringify({ path: out }, null, 2));
        return;
      }
      console.log(chalk.green(`Backup saved: ${out}`));
    } catch (e) {
      const format = (opts.format ?? "text").toLowerCase();
      if (format === "json") {
        console.log(JSON.stringify({ path: null, error: e instanceof Error ? e.message : String(e) }, null, 2));
        process.exitCode = 1;
      } else {
        console.log(chalk.red("Backup failed: " + (e instanceof Error ? e.message : String(e))));
      }
    }
  });

program
  .command("restore <path>")
  .description("Restore from a backup archive")
  .option("-f, --force", "Overwrite without confirmation")
  .option("--format <fmt>", "Output format: text | json", "text")
  .action(async function (this: { opts: () => { force?: boolean; format?: string } }, path: string) {
    const opts = this.opts();
    try {
      await doRestore(path, opts.force);
      const format = (opts.format ?? "text").toLowerCase();
      if (format === "json") {
        console.log(JSON.stringify({ success: true }, null, 2));
        return;
      }
      console.log(chalk.green("Restore complete."));
    } catch (e) {
      const format = (opts.format ?? "text").toLowerCase();
      if (format === "json") {
        console.log(JSON.stringify({ success: false, error: e instanceof Error ? e.message : String(e) }, null, 2));
        process.exitCode = 1;
        return;
      }
      console.log(chalk.red("Restore failed: " + (e instanceof Error ? e.message : String(e))));
    }
  });

program
  .command("doctor")
  .description("Run health checks (config, data dir, models, MCP, env)")
  .option("-f, --format <fmt>", "Output format: text | json", "text")
  .option("-o, --output <path>", "Write report to file (for support/debug)")
  .option("--ping-models", "Ping enabled models (can be slow)")
  .action(async function (this: { opts: () => { format?: string; output?: string; pingModels?: boolean } }) {
    const opts = this.opts();
    const format = (opts.format ?? "text").toLowerCase();
    const report: Record<string, unknown> = { version: pkg.version, nodeVersion: process.version, config: "ok", dataDir: "", enabledModels: 0, mcpServers: 0, env: {} as Record<string, boolean> };
    const envReport = report.env as Record<string, boolean>;
    let cfgForSecrets: Awaited<ReturnType<typeof loadConfig>> | null = null;
    try {
      cfgForSecrets = await loadConfig();
      (report as Record<string, unknown>).configPath = process.env.GTD_ENV ? `config.${process.env.GTD_ENV}.json` : "config";
    } catch (e) {
      report.config = (e as Error).message;
    }
    const dataDir = getDataDir();
    report.dataDir = dataDir;
    await loadAndApplyModelsConfig();
    const enabledIds = getEnabledModelIds();
    report.enabledModels = enabledIds.length;
    (report as Record<string, unknown>).enabledModelIds = enabledIds;
    const mcpServers = await listMcpServers();
    report.mcpServers = mcpServers.length;
    envReport.GTD_ENV = !!process.env.GTD_ENV;
    envReport.GTD_DATA_DIR = !!process.env.GTD_DATA_DIR;
    const mechanism = getSandboxMechanism();
    (report as Record<string, unknown>).sandboxEnabled = mechanism !== "none";
    (report as Record<string, unknown>).sandboxMechanism = mechanism;
    const projectSandboxProfile = mechanism === "sandbox-exec" ? await loadSandboxProfileFromProject(process.cwd()) : undefined;
    (report as Record<string, unknown>).sandboxProfile = projectSandboxProfile ?? process.env.GTD_SANDBOX_PROFILE ?? "(default)";
    if (projectSandboxProfile) (report as Record<string, unknown>).sandboxProfileSource = "project";
    (report as Record<string, unknown>).sandboxNetworkDefault = "deny";
    envReport.ANTHROPIC_API_KEY = !!process.env.ANTHROPIC_API_KEY;
    envReport.OPENAI_API_KEY = !!process.env.OPENAI_API_KEY;
    envReport.GOOGLE_GENAI_API_KEY = !!process.env.GOOGLE_GENAI_API_KEY;
    envReport.GITHUB_TOKEN = !!process.env.GITHUB_TOKEN;
    envReport.GH_TOKEN = !!process.env.GH_TOKEN;
    if (opts.pingModels && enabledIds.length > 0) {
      const pingResults: Array<{ id: string; ok: boolean; latencyMs?: number; error?: string }> = [];
      for (const id of enabledIds) {
        const r = await pingModel(id);
        pingResults.push({ id, ok: r.ok, latencyMs: r.latencyMs, error: r.error });
      }
      (report as Record<string, unknown>).modelPing = pingResults;
    }
    if (cfgForSecrets) {
      const secretsResult = checkConfigSecrets(cfgForSecrets);
      (report as Record<string, unknown>).configSecrets = secretsResult.ok ? "ok" : "issues";
    }
    const outPath = opts.output;
    let textOut = "";
    const write = (s: string) => {
      if (outPath) textOut += s + "\n";
      else console.log(s);
    };
    if (format === "json") {
      const jsonStr = JSON.stringify(report, null, 2);
      if (outPath) {
        const { writeFile } = await import("fs/promises");
        await writeFile(outPath, jsonStr, "utf-8");
        console.log(chalk.green(`Report written to ${outPath}`));
      } else {
        console.log(jsonStr);
      }
      return;
    }
    write(renderBanner());
    write(chalk.bold("\nDoctor (health check)\n"));
    write("  Version:   gtd " + pkg.version + ", Node " + process.version);
    write("  Config:    " + (report.config === "ok" ? chalk.green("OK") : chalk.red(String(report.config))));
    const configSecrets = (report as Record<string, unknown>).configSecrets as string | undefined;
    if (configSecrets !== undefined) {
      write("  Secrets:   " + (configSecrets === "ok" ? chalk.green("OK") : chalk.yellow("issues — run gtd governance secrets-check")));
    }
    write("  Data dir:  " + dataDir);
    write("  Models:    " + (enabledIds.length ? chalk.green(`${enabledIds.length} enabled`) : chalk.yellow("0 enabled")));
    if (enabledIds.length) write(chalk.dim("    ") + enabledIds.join(", "));
    write("  MCP:       " + (mcpServers.length ? `${mcpServers.length} server(s)` : chalk.dim("none")));
    const sandboxProfile = (report as Record<string, unknown>).sandboxProfile as string | undefined;
    const sandboxOn = (report as Record<string, unknown>).sandboxEnabled as boolean;
    const sandboxProfileSource = (report as Record<string, unknown>).sandboxProfileSource as string | undefined;
    const profileLabel = sandboxProfileSource === "project" ? `${sandboxProfile} (from .gtd/sandbox.json)` : (sandboxProfile ?? "(default)");
    write("  Sandbox:   " + (sandboxOn ? chalk.cyan((report as Record<string, unknown>).sandboxMechanism + " — " + profileLabel) : chalk.dim("none")) + (sandboxOn ? chalk.dim(" (network deny by default)") : ""));
    write("  Env:       " + [
      process.env.GTD_ENV ? "GTD_ENV" : "",
      process.env.GTD_DATA_DIR ? "GTD_DATA_DIR" : "",
      process.env.ANTHROPIC_API_KEY ? "ANTHROPIC_API_KEY" : "",
      process.env.OPENAI_API_KEY ? "OPENAI_API_KEY" : "",
      process.env.GOOGLE_GENAI_API_KEY ? "GOOGLE_GENAI_API_KEY" : "",
      process.env.GITHUB_TOKEN ? "GITHUB_TOKEN" : "",
      process.env.GH_TOKEN ? "GH_TOKEN" : "",
    ].filter(Boolean).join(", ") || chalk.dim("none set"));
    if ((report as Record<string, unknown>).modelPing) {
      const pingResults = (report as Record<string, unknown>).modelPing as Array<{ id: string; ok: boolean; latencyMs?: number; error?: string }>;
      write("\n  Model ping:");
      for (const r of pingResults) {
        if (r.ok) write(chalk.green(`    ✓ ${r.id}`) + chalk.dim(` ${r.latencyMs}ms`));
        else write(chalk.red(`    ✗ ${r.id}: ${r.error}`));
      }
    }
    if (outPath) {
      const { writeFile } = await import("fs/promises");
      await writeFile(outPath, textOut, "utf-8");
      console.log(chalk.green(`Report written to ${outPath}`));
    }
  });

const orgCmd = program
  .command("org")
  .description("Org/team switching (list orgs, set current org)");

orgCmd
  .command("list")
  .description("List org ids from org config (org.json or GTD_ORG_CONFIG)")
  .option("-f, --format <fmt>", "Output format: text | json", "text")
  .action(async function (this: { opts: () => { format?: string } }) {
    const opts = this.opts();
    const ids = await listOrgIds();
    const format = (opts.format ?? "text").toLowerCase();
    if (format === "json") {
      console.log(JSON.stringify({ orgs: ids }, null, 2));
      return;
    }
    if (ids.length === 0) {
      console.log("No org config found (org.json or GTD_ORG_CONFIG). Add orgs to switch.");
      return;
    }
    const cfg = await loadConfig();
    const current = cfg.currentOrg ?? ids[0];
    console.log("Orgs:");
    for (const id of ids) {
      console.log(`  ${id === current ? chalk.green(`* ${id}`) : `  ${id}`}`);
    }
  });

orgCmd
  .command("use <id>")
  .description("Set current org (persisted in config)")
  .option("-f, --format <fmt>", "Output format: text | json", "text")
  .action(async function (this: { opts: () => { format?: string } }, id: string) {
    const opts = this.opts();
    const ids = await listOrgIds();
    if (!ids.includes(id)) {
      if ((opts.format ?? "text").toLowerCase() === "json") {
        console.log(JSON.stringify({ success: false, error: `Org ${id} not found. Use 'gtd org list' to see available orgs.` }, null, 2));
      } else {
        console.log(chalk.red(`Org ${id} not found. Use 'gtd org list' to see available orgs.`));
      }
      process.exitCode = 1;
      return;
    }
    await saveConfig({ currentOrg: id });
    const format = (opts.format ?? "text").toLowerCase();
    if (format === "json") {
      console.log(JSON.stringify({ success: true, currentOrg: id }, null, 2));
    } else {
      console.log(chalk.green(`Current org: ${id}`));
    }
  });

const configCmd = program
  .command("config")
  .description("View and set defaults (quality, approval policy, default model)")
  .action(async () => {
    console.log(renderBanner());
    const env = process.env.GTD_ENV;
    if (env) {
      console.log(chalk.dim(`\nEnvironment: GTD_ENV=${env} (using config.${env}.json when present)`));
    }
    const cfg = await loadConfig();
    console.log("\nConfig:");
    console.log(`  qualityProfile: ${cfg.qualityProfile ?? "balanced"}`);
    console.log(`  approvalPolicy: ${cfg.approvalPolicy ?? "hybrid"}`);
    console.log(`  defaultModel:   ${cfg.defaultModel ?? "(none)"}`);
    console.log(`  defaultMode:     ${(cfg as { defaultMode?: string }).defaultMode ?? "(none)"}`);
    console.log(`  localFirst:      ${cfg.localFirst === true ? "true" : "false"}`);
    if (cfg.currentOrg) console.log(`  currentOrg:      ${cfg.currentOrg}`);
  });

configCmd
  .command("path")
  .description("Print path to active config file (for EDITOR, scripts). Config dir: GTD_DATA_DIR or ~/.skate.")
  .action(() => {
    console.log(getActiveConfigPath());
  });

configCmd
  .command("export")
  .description("Export current config as JSON (redacted for sharing/support)")
  .option("-f, --format <fmt>", "Output format: text | json", "json")
  .action(async function (this: { opts: () => { format?: string } }) {
    const opts = this.opts();
    const cfg = await loadConfig();
    const redacted = { ...cfg } as Record<string, unknown>;
    for (const key of Object.keys(redacted)) {
      if (/key|secret|token|password/i.test(key)) redacted[key] = "(redacted)";
    }
    if ((opts.format ?? "json").toLowerCase() === "json") {
      console.log(JSON.stringify({ configPath: getActiveConfigPath(), configDir: getConfigDir(), ...redacted }, null, 2));
    } else {
      console.log("Config dir: " + getConfigDir());
      console.log("Config file: " + getActiveConfigPath());
      console.log(JSON.stringify(redacted, null, 2));
    }
  });

configCmd
  .command("get <key>")
  .description("Get a config value (for scripting)")
  .option("-f, --format <fmt>", "Output format: text | json", "text")
  .action(async function (this: { opts: () => { format?: string } }, key: string) {
    const opts = this.opts();
    const format = (opts.format ?? "text").toLowerCase();
    const cfg = await loadConfig();
    const k = key as keyof typeof cfg;
    if (!(k in cfg)) {
      if (format === "json") {
        console.log(JSON.stringify({ error: `Unknown key: ${key}` }, null, 2));
        process.exitCode = 1;
      } else {
        console.log(chalk.red(`Unknown key: ${key}`));
        process.exitCode = 1;
      }
      return;
    }
    const v = cfg[k];
    if (format === "json") {
      console.log(JSON.stringify({ key, value: v ?? null }, null, 2));
      return;
    }
    if (v === undefined || v === null) {
      console.log("");
      return;
    }
    if (typeof v === "object") {
      console.log(JSON.stringify(v));
    } else {
      console.log(String(v));
    }
  });

configCmd
  .command("list")
  .alias("show")
  .description("Show current config")
  .option("-f, --format <fmt>", "Output format: text | json", "text")
  .action(async function (this: { opts: () => { format?: string } }) {
    const opts = this.opts();
    const cfg = await loadConfig();
    const format = (opts.format ?? "text").toLowerCase();
    if (format === "json") {
      console.log(JSON.stringify(cfg, null, 2));
      return;
    }
    console.log(renderBanner());
    console.log("\nConfig:");
    console.log(`  qualityProfile: ${cfg.qualityProfile ?? "balanced"}`);
    console.log(`  approvalPolicy: ${cfg.approvalPolicy ?? "hybrid"}`);
    console.log(`  defaultModel:   ${cfg.defaultModel ?? "(none)"}`);
    console.log(`  defaultMode:     ${(cfg as { defaultMode?: string }).defaultMode ?? "(none)"}`);
  });

configCmd
  .command("reset")
  .description("Reset config to defaults")
  .option("-a, --all", "Also clear tasks (tasks.json) and models config (models.json)")
  .option("-y, --yes", "Skip confirmation when using --all (for scripts)")
  .option("-f, --format <fmt>", "Output format: text | json", "text")
  .action(async function (this: { opts: () => { all?: boolean; yes?: boolean; format?: string } }) {
    const opts = this.opts();
    if (opts.all && !opts.yes) {
      const readline = await import("readline");
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise<string>((resolve) => rl.question("This will clear all tasks and models config. Continue? [y/N] ", resolve));
      rl.close();
      if (!/^y(es)?$/i.test(answer.trim())) {
        console.log("Aborted.");
        return;
      }
    }
    await resetConfig({ all: opts.all });
    const format = (opts.format ?? "text").toLowerCase();
    if (format === "json") {
      console.log(JSON.stringify({ success: true, all: !!opts.all }, null, 2));
    } else if (opts.all) {
      console.log("Config, tasks, and models reset to defaults.");
    } else {
      console.log("Config reset to defaults.");
    }
  });

configCmd
  .command("set <key> <value>")
  .description("Set a config value (qualityProfile|approvalPolicy|defaultModel|defaultMode|permissionMode|defaultProfile|persona|localFirst)")
  .option("-f, --format <fmt>", "Output format: text | json", "text")
  .option("--force", "Override config lock")
  .action(async function (this: { opts: () => { format?: string; force?: boolean } }, key: string, value: string) {
    const opts = this.opts();
    const format = (opts.format ?? "text").toLowerCase();
    const validKeys = ["qualityProfile", "approvalPolicy", "defaultModel", "defaultMode", "permissionMode", "defaultProfile", "persona", "localFirst"] as const;
    if (!validKeys.includes(key as (typeof validKeys)[number])) {
      if (format === "json") {
        console.log(JSON.stringify({ success: false, error: `Invalid key. Use: ${validKeys.join(", ")}` }, null, 2));
        process.exitCode = 1;
      } else {
        console.log(`Invalid key. Use: ${validKeys.join(", ")}`);
      }
      return;
    }
    if (key === "persona" && value && !["minimal", "professional", "poetic"].includes(value.toLowerCase())) {
      if (format === "json") {
        console.log(JSON.stringify({ success: false, error: "persona must be: minimal, professional, poetic" }, null, 2));
        process.exitCode = 1;
      } else {
        console.log("persona must be: minimal, professional, poetic");
      }
      return;
    }
    if (key === "persona") value = value.toLowerCase();
    if (key === "qualityProfile" && !["fast", "balanced", "max"].includes(value)) {
      if (format === "json") {
        console.log(JSON.stringify({ success: false, error: "qualityProfile must be: fast, balanced, max" }, null, 2));
        process.exitCode = 1;
      } else {
        console.log("qualityProfile must be: fast, balanced, max");
      }
      return;
    }
    if (key === "approvalPolicy" && !["auto", "hybrid", "always"].includes(value)) {
      if (format === "json") {
        console.log(JSON.stringify({ success: false, error: "approvalPolicy must be: auto, hybrid, always" }, null, 2));
        process.exitCode = 1;
      } else {
        console.log("approvalPolicy must be: auto, hybrid, always");
      }
      return;
    }
    if (key === "defaultMode" && !["architect", "debug", "ask", "orchestrator"].includes(value.toLowerCase())) {
      if (format === "json") {
        console.log(JSON.stringify({ success: false, error: "defaultMode must be: architect, debug, ask, orchestrator" }, null, 2));
        process.exitCode = 1;
      } else {
        console.log("defaultMode must be: architect, debug, ask, orchestrator");
      }
      return;
    }
    if (key === "defaultMode") value = value.toLowerCase();
    if (key === "localFirst" && value !== undefined) {
      if (value !== "true" && value !== "1" && value !== "false" && value !== "0") {
        if (format === "json") {
          console.log(JSON.stringify({ success: false, error: "localFirst must be: true, false, 1, or 0" }, null, 2));
          process.exitCode = 1;
        } else {
          console.log("localFirst must be: true, false, 1, or 0");
        }
        return;
      }
    }
    if (key === "permissionMode") {
      const normalized = normalizePermissionMode(value);
      if (!normalized) {
        if (format === "json") {
          console.log(JSON.stringify({ success: false, error: "permissionMode must be: default, plan, accept-edits, dont-ask, bypass (or acceptEdits, dontAsk, bypassPermissions)" }, null, 2));
          process.exitCode = 1;
        } else {
          console.log("permissionMode must be: default, plan, accept-edits, dont-ask, bypass (or acceptEdits, dontAsk, bypassPermissions)");
        }
        return;
      }
      value = normalized;
    }
    try {
      const toSave = key === "localFirst" ? { localFirst: value === "true" || value === "1" } : { [key]: value };
      await saveConfig(toSave, { force: this.opts().force });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (format === "json") {
        console.log(JSON.stringify({ success: false, error: msg }, null, 2));
      } else {
        console.log(chalk.red(msg));
      }
      process.exitCode = 1;
      return;
    }
    if (format === "json") {
      console.log(JSON.stringify({ success: true, key, value }, null, 2));
    } else {
      console.log(`Set ${key} = ${value}`);
    }
  });

configCmd
  .command("lock")
  .description("Lock config (no writes without --force or unlock)")
  .option("-f, --format <fmt>", "Output format: text | json", "text")
  .action(async function (this: { opts: () => { format?: string } }) {
    await setConfigLock(true);
    const format = (this.opts().format ?? "text").toLowerCase();
    if (format === "json") {
      console.log(JSON.stringify({ success: true, locked: true }, null, 2));
    } else {
      console.log(chalk.green("Config locked."));
    }
  });

configCmd
  .command("unlock")
  .description("Remove config lock")
  .option("-f, --format <fmt>", "Output format: text | json", "text")
  .action(async function (this: { opts: () => { format?: string } }) {
    await setConfigLock(false);
    const format = (this.opts().format ?? "text").toLowerCase();
    if (format === "json") {
      console.log(JSON.stringify({ success: true, locked: false }, null, 2));
    } else {
      console.log(chalk.green("Config unlocked."));
    }
  });

const governanceCmd = program
  .command("governance")
  .description("Governance: secrets check, policy bundle");

governanceCmd
  .command("secrets-check")
  .description("Check config for potential exposed secrets")
  .option("-f, --format <fmt>", "Output format: text | json", "text")
  .action(async function (this: { opts: () => { format?: string } }) {
    const opts = this.opts();
    const cfg = await loadConfig();
    const result = checkConfigSecrets(cfg);
    const format = (opts.format ?? "text").toLowerCase();
    if (format === "json") {
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.ok ? 0 : 1;
      return;
    }
    if (result.ok) {
      console.log(chalk.green("No secrets hygiene issues found."));
    } else {
      for (const w of result.warnings) console.log(chalk.yellow(w));
      process.exitCode = 1;
    }
  });

governanceCmd
  .command("org")
  .description("Show org-level restrictions (org.json or GTD_ORG_CONFIG)")
  .option("-f, --format <fmt>", "Output format: text | json", "text")
  .action(async function (this: { opts: () => { format?: string } }) {
    const opts = this.opts();
    const cfg = await loadConfig();
    const org = await loadOrgRestrictions(cfg.currentOrg);
    const format = (opts.format ?? "text").toLowerCase();
    if (format === "json") {
      console.log(JSON.stringify(org ?? { message: "No org restrictions loaded" }, null, 2));
      return;
    }
    console.log(renderBanner());
    if (!org) {
      console.log("\nNo org restrictions (org.json or GTD_ORG_CONFIG not set).");
      return;
    }
    console.log("\nOrg restrictions:");
    if (org.allowedQualityProfiles?.length) {
      console.log(`  allowedQualityProfiles: ${org.allowedQualityProfiles.join(", ")}`);
    }
    if (org.allowedApprovalPolicies?.length) {
      console.log(`  allowedApprovalPolicies: ${org.allowedApprovalPolicies.join(", ")}`);
    }
    if (org.allowedModels?.length) {
      console.log(`  allowedModels: ${org.allowedModels.join(", ")}`);
    }
    if (!org.allowedQualityProfiles?.length && !org.allowedApprovalPolicies?.length && !org.allowedModels?.length) {
      console.log(chalk.dim("  (empty)"));
    }
  });

const modelsCmd = program
  .command("models")
  .description("Manage LLM models (list, add, install, policy)");

modelsCmd
  .command("list")
  .description("List available models")
  .option("-f, --format <fmt>", "Output format: text | json", "text")
  .action(async function (this: { opts: () => { format?: string } }) {
    await loadAndApplyModelsConfig();
    const opts = this.opts();
    const models = listModels();
    const format = (opts.format ?? "text").toLowerCase();
    if (format === "json") {
      console.log(JSON.stringify(models.map((c) => ({ id: c.metadata.id, provider: c.metadata.provider, name: c.metadata.name, enabled: c.enabled })), null, 2));
      return;
    }
    console.log(renderBanner());
    console.log("\nModels:");
    for (const c of models) {
      const status = c.enabled ? "✓" : " ";
      console.log(`  ${status} ${c.metadata.id} (${c.metadata.provider}) - ${c.metadata.name}`);
    }
  });

modelsCmd
  .command("usage")
  .description("Show token usage by model")
  .option("-n, --limit <n>", "Max tasks to include", "100")
  .option("-a, --after <date>", "Tasks created after date (ISO format)")
  .option("-f, --format <fmt>", "Output format: text | json", "text")
  .action(async function (this: { opts: () => { limit?: string; after?: string; format?: string } }) {
    const opts = this.opts();
    const limit = parseInt(opts.limit ?? "100", 10) || 100;
    const summary = await getUsageSummary({ limit, after: opts.after });
    const format = (opts.format ?? "text").toLowerCase();
    if (format === "json") {
      console.log(JSON.stringify(summary, null, 2));
      return;
    }
    console.log(renderBanner());
    if (Object.keys(summary.byModel).length === 0) {
      console.log("\nNo usage data by model. Run tasks to track token usage.");
      return;
    }
    console.log(`\nToken usage by model (${summary.totalTasks} task(s)):`);
    const byModelSorted = Object.entries(summary.byModel).sort(
      (a, b) => (b[1].promptTokens + b[1].completionTokens) - (a[1].promptTokens + a[1].completionTokens)
    );
    let totalCost = 0;
    for (const [model, u] of byModelSorted) {
      const mTotal = u.promptTokens + u.completionTokens;
      const tasksLabel = u.tasks === 1 ? "task" : "tasks";
      const costStr = formatEstimatedCost(model, u.promptTokens, u.completionTokens);
      const cost = estimateCost(model, u.promptTokens, u.completionTokens);
      if (cost !== undefined) totalCost += cost;
      console.log(`  ${model}: ${mTotal.toLocaleString()} (${u.promptTokens.toLocaleString()} in / ${u.completionTokens.toLocaleString()} out) - ${u.tasks} ${tasksLabel}${costStr}`);
    }
    if (totalCost > 0) console.log(chalk.dim(`\n  Est. total: ~ $${totalCost.toFixed(2)}`));
  });

modelsCmd
  .command("enable <id>")
  .description("Enable a model for use")
  .option("-f, --format <fmt>", "Output format: text | json", "text")
  .action(async function (this: { opts: () => { format?: string } }, id: string) {
    const opts = this.opts();
    const format = (opts.format ?? "text").toLowerCase();
    await loadAndApplyModelsConfig();
    const ok = enableModel(id);
    if (ok) {
      await persistModelsConfig();
      if (format === "json") {
        console.log(JSON.stringify({ success: true, modelId: id }, null, 2));
      } else {
        console.log(`Enabled ${id}`);
      }
    } else {
      if (format === "json") {
        console.log(JSON.stringify({ success: false, error: `Model ${id} not found` }, null, 2));
        process.exitCode = 1;
      } else {
        console.log(`Model ${id} not found`);
      }
    }
  });

modelsCmd
  .command("disable <id>")
  .description("Disable a model")
  .option("-f, --format <fmt>", "Output format: text | json", "text")
  .action(async function (this: { opts: () => { format?: string } }, id: string) {
    const opts = this.opts();
    const format = (opts.format ?? "text").toLowerCase();
    await loadAndApplyModelsConfig();
    const ok = disableModel(id);
    if (ok) {
      await persistModelsConfig();
      if (format === "json") {
        console.log(JSON.stringify({ success: true, modelId: id }, null, 2));
      } else {
        console.log(`Disabled ${id}`);
      }
    } else {
      if (format === "json") {
        console.log(JSON.stringify({ success: false, error: `Model ${id} not found` }, null, 2));
        process.exitCode = 1;
      } else {
        console.log(`Model ${id} not found`);
      }
    }
  });

modelsCmd
  .command("ping")
  .description("Health check for enabled models")
  .option("-f, --format <fmt>", "Output format: text | json", "text")
  .action(async function (this: { opts: () => { format?: string } }) {
    await loadAndApplyModelsConfig();
    const opts = this.opts();
    const ids = getEnabledModelIds();
    if (ids.length === 0) {
      if ((opts.format ?? "text").toLowerCase() === "json") {
        console.log(JSON.stringify({ models: [], error: "No models enabled" }, null, 2));
      } else {
        console.log("No models enabled. Run 'gtd models enable <id>' first.");
      }
      return;
    }
    const results: Array<{ id: string; name: string; ok: boolean; latencyMs?: number; error?: string }> = [];
    for (const id of ids) {
      const result = await pingModel(id);
      const m = getModel(id);
      const name = m?.metadata.name ?? id;
      results.push({
        id,
        name,
        ok: result.ok,
        latencyMs: result.latencyMs,
        error: result.error,
      });
    }
    const format = (opts.format ?? "text").toLowerCase();
    if (format === "json") {
      console.log(JSON.stringify({ models: results }, null, 2));
      return;
    }
    console.log(`Pinging ${ids.length} enabled model(s)...\n`);
    for (const r of results) {
      if (r.ok) {
        console.log(chalk.green(`  ✓ ${r.id}`) + chalk.dim(` (${r.name}) ${r.latencyMs}ms`));
      } else {
        console.log(chalk.red(`  ✗ ${r.id}`) + chalk.dim(` (${r.name})`) + chalk.red(`: ${r.error}`));
      }
    }
  });

modelsCmd
  .command("route")
  .description("Show which model would be selected for a task")
  .option("-t, --tools", "Require tool support")
  .option("-v, --vision", "Require vision support")
  .option("-l, --local", "Prefer local models")
  .option("-f, --format <fmt>", "Output format: text | json", "text")
  .action(async function (this: { opts: () => { tools?: boolean; vision?: boolean; local?: boolean; format?: string } }) {
    const opts = this.opts();
    await loadAndApplyModelsConfig();
    const result = routeForTask("balanced", {
      requiresTools: opts.tools,
      requiresVision: opts.vision,
      preferLocal: opts.local,
    });
    const format = (opts.format ?? "text").toLowerCase();
    if (format === "json") {
      if (result) {
        const m = getModel(result.modelId);
        console.log(JSON.stringify({
          modelId: result.modelId,
          reason: result.reason,
          name: m?.metadata.name,
          provider: m?.metadata.provider,
        }, null, 2));
      } else {
        console.log(JSON.stringify({ modelId: null, error: "No enabled model matches" }, null, 2));
      }
      return;
    }
    if (result) {
      const m = getModel(result.modelId);
      console.log(`Selected: ${result.modelId} - ${result.reason}`);
      if (m) console.log(`  ${m.metadata.name} (${m.metadata.provider})`);
    } else {
      console.log("No enabled model matches. Run 'gtd models enable <id>' first.");
    }
  });

program.parse();

// If no command, show banner and help
if (!process.argv.slice(2).length) {
  console.log(renderBanner());
  program.outputHelp();
}
