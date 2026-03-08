# Skate

[![CI](https://github.com/faridjafarlee/scaling-octo-eureka/actions/workflows/ci.yml/badge.svg)](https://github.com/faridjafarlee/scaling-octo-eureka/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Skate — GTD.** Agent orchestration CLI. Skate is the skate (manta ray, the fish); GTD is our slogan.

Plan precisely, execute relentlessly. Role-based agents, configurable LLM routing, hybrid approval gates. Tasks from CLI, Telegram, Slack, WhatsApp, Signal.

**Usage:** [How to use](#how-to-use) (first run, workflows, approval, verify, config, API) · [Commands](#commands) · [docs/README.md](docs/README.md)

## Requirements

- **Node.js** ≥18 (see `engines` in `package.json`). Recommended: current LTS. We follow Node’s LTS schedule; support for older LTS is dropped when we move the minimum (see CONTRIBUTING for CI and upgrade policy).

## Install

**From npm** (global CLI):

```bash
npm install -g skate
gtd start
```

**One-off run** (no install):

```bash
npx skate start
```

**From source**:

```bash
git clone https://github.com/faridjafarlee/scaling-octo-eureka.git
cd scaling-octo-eureka
npm install
npm run build
node dist/cli/index.js start
```

Or with `tsx` for development:

```bash
npm run dev start
```

## Desktop app

The **Skate desktop app** is an Electron GUI for macOS (and optionally Windows/Linux). Run tasks, view history, and manage workspace from a single window; it invokes the `gtd` CLI under the hood.

**Run from source:**

```bash
cd desktop && npm install && npm start
```

Build the CLI first from repo root (`npm run build`) so the app can use `../dist/cli`. Set `GTD_CLI_PATH` to point at a different CLI binary if needed.

**Build installers (macOS):**

```bash
cd desktop && npm run dist:mac
```

Output in `desktop/out/`: `.app`, `.dmg`, and `.zip` (arm64 and x64). Use `npm run dist:mac:universal` for a universal binary.

**Install:** Download the `.dmg` from [GitHub Releases](https://github.com/faridjafarlee/scaling-octo-eureka/releases) when available, or build locally as above. A Homebrew cask (e.g. `brew install --cask skate`) can be added once published.

**Requirements:** macOS 12.0 (Monterey) or later. Node.js 18+ for building. The app works with the same major version of the Skate CLI (e.g. desktop 0.2.x with CLI 0.2.x).

More: [desktop/](desktop/) and [desktop/docs/PLATFORM.md](desktop/docs/PLATFORM.md).

**Documentation:** [docs/README.md](docs/README.md) — index of guides, reference, API, plugins, and planning docs.

## Commands

| Command | Description |
|---------|-------------|
| `gtd start` | Show welcome screen and Skate banner |
| `gtd task "<description>"` | Create and execute a task |
| `gtd task "..." --write` | Write Builder code blocks to files (--auto to apply without prompt) |
| `gtd task "..." --dry-run` | Run Scout + Planner only, show plan without executing |
| `gtd task "..." --output <path>` | Write deliverable to file |
| `gtd task "..." --timeout <sec>` | Abort task after N seconds |
| `gtd task "..." --permission-mode <mode>` | Tool permission: default \| plan \| accept-edits \| dont-ask \| bypass (aliases: acceptEdits, dontAsk, bypassPermissions) |
| `gtd task "..." --mode <name>` | Named mode: architect (plan only) \| debug (fast) \| ask (approval) \| orchestrator (full pipeline) |
| `gtd task "..." --auto-lint` / `--auto-test` | Run lint/test after Builder; failures queued for follow-up |
| `gtd task "..." --iterate-verify <N>` | Re-run up to N times until lint/test pass (see [Gather–Act–Verify](docs/reference/gather-act-verify.md)) |
| `gtd interactive` | REPL mode: task, status, show, inbox, search, history, approve, retry, cancel, delete |
| `gtd interactive --tui` | Same REPL with TUI panel layout |
| `gtd run-parallel "<desc1>" "<desc2>" [desc3] [desc4]` | Run 2–4 tasks in parallel (same repo; **max 4**) |
| `gtd run-parallel "<desc1>" "<desc2>" --worktrees [--merge] [--cleanup]` | Run in git worktrees (isolated); optional merge and cleanup |
| `gtd last` | Show last run summary (most recent task) |
| `gtd inbox` | Show pending and recent tasks |
| `gtd approve <id>` | Approve a blocked task and resume execution |
| `gtd approvals` | List blocked tasks; use `-i` to select and approve one interactively |
| `gtd serve --approval-ui` | Serve approval dashboard at `/approvals/dashboard` (list blocked, approve with one click) |
| `gtd serve --api` | Enable HTTP API: GET/POST /api/tasks, GET /api/tasks/:id, POST /api/approvals/:id/approve, GET/POST /api/allow (scope: session \| project only), POST /api/handoff (optional GTD_API_KEY) |
| `gtd retry <id>` | Retry a failed task (use `--from-step builder` to retry from a step) |
| `gtd show <id>` | Show full task details |
| `gtd status [task-id]` | Show task status (use short id prefix) |
| `gtd search [query]` | Search tasks by description, status, or date |
| `gtd history` | Show completed and failed tasks |
| `gtd delete <id>` | Delete a task |
| `gtd cancel <id>` | Request cancellation of an in-progress task |
| `gtd export [path]` | Export tasks to JSON (file or stdout) |
| `gtd import <path>` | Import tasks from JSON |
| `gtd backup [path]` | Backup ~/.skate to archive |
| `gtd restore <path>` | Restore from backup |
| `gtd config` | Show current config |
| `gtd config set <key> <value>` | Set qualityProfile, approvalPolicy, or defaultModel |
| `gtd config reset` | Reset config (use `--all` to clear tasks and models) |
| `gtd serve` | Start messaging bots (Telegram, Slack, WhatsApp, Signal, Discord, webhook, email, Matrix) |
| `gtd serve --webhook` | Start generic webhook server (POST /webhook) |
| `gtd plugins discover` | List plugins from registry (GTD_PLUGIN_REGISTRY_URL or --registry). |
| `gtd models list` | List available LLM models |
| `gtd models enable <id>` | Enable a model |
| `gtd models disable <id>` | Disable a model |
| `gtd models route` | Show which model would be selected |
| `gtd models ping` | Health check for enabled models |
| `gtd version` | Show version |
| **Capabilities** | |
| `gtd capabilities` | Feature flags and maturity levels (`--format json`) |
| `gtd tools list` | List file/shell/git/web tools |
| `gtd tools run <name> [argsJson]` | Run a tool (e.g. `read_file`, `run_command`) |
| `gtd session list` | List resumable sessions (recent tasks) |
| `gtd session fork <id>` | Fork a task (new task with outputs up to a step) |
| `gtd memory list` / `get <key>` / `set <key> <value>` | Structured memory store |
| `gtd memory project` | Show project MEMORY.md |
| `gtd mode list` / `use <id>` / `clear` | Mode profiles (quality/model/permission presets) |
| `gtd mode export <id>` / `import <path>` | Export/import mode definitions |
| `gtd mcp list` / `register` / `test` / `remove` / `tools` / `resources` / `read-resource` | MCP server management, tool list, and resource read |
| `gtd mcp serve` | Run GTD as an MCP server on stdio (tools: gtd_create_task, gtd_approve, gtd_show, gtd_list_tasks, gtd_retry) for IDE integration |
| `gtd plugins list` / `validate <path>` / `run <pluginId> <commandId>` | Plugin discovery, validation, and command execution |
| `gtd audit list` | Persistent audit log (governance) |
| `gtd telemetry list` | Metrics (step latency, token usage) |
| `gtd git worktree <branch>` / `branch <name>` / `diff` / `status` | Git-native workflows |
| `gtd review` | Review queue: list tasks needing approval (blocked) |
| `gtd session handoff <id> [path]` | Export task state for session handoff |
| `gtd config lock` / `unlock` | Lock config (no writes without `--force` or unlock) |
| `gtd governance secrets-check` | Check config for potential exposed secrets |
| `gtd governance org` | Show org-level restrictions (org.json or GTD_ORG_CONFIG) |
| `gtd replay <id>` | Show timeline of what happened for a task (audit + telemetry) |

- **Org restrictions**: Optional `~/.skate/org.json` or `GTD_ORG_CONFIG` path with `allowedQualityProfiles`, `allowedApprovalPolicies`, `allowedModels`. Effective config is restricted to these lists; `gtd config set` rejects disallowed values. Use `gtd governance org` to show current restrictions.

Set `GTD_POLICY_BUNDLE` to a JSON file path to load a policy bundle for tool runs.

---

## How to use

Below is a concise guide to daily workflows, approval, verify/iterate, configuration, and API. Full reference: [docs/README.md](docs/README.md), [Tutorial](docs/guides/tutorial.md), [Configuration](docs/reference/configuration.md).

### First run

1. **Install and enable a model** (see [Install](#install) and [LLM Providers](#llm-providers)):
   ```bash
   npm install -g skate
   gtd models enable ollama/llama3.2   # or OPENAI_API_KEY + gtd models enable gpt-4o
   ```
2. **Run a task:**
   ```bash
   gtd task "Add a README to this project"
   ```
3. **Write code to files:** use `--write` so Builder code blocks are written to disk; use `--auto` to apply without prompting.
4. **Plan only (no execution):** `gtd task "Refactor module X" --dry-run` or `--mode architect` — runs Scout + Planner and shows the plan.

### Typical workflows

| What you want | What to do |
|---------------|------------|
| Run a task and let it finish | `gtd task "..."` — if it blocks on approval, run `gtd approve <id>` (or use the approval dashboard). |
| Run without any approval prompts | `gtd task "..." --auto` or `--permission-mode dontAsk` (scripts/CI). |
| Interrupt (Ctrl+C) then continue later | After interrupt, run `gtd retry <id>` to resume from the last checkpoint; or `gtd approve <id>` if it was blocked at an approval gate. |
| Change instructions mid-run (when using API) | `POST /api/tasks/:id/inject` with new instructions; the agent sees them at the next step boundary. |
| Run lint/tests after edits and retry on failure | `gtd task "..." --auto-lint --auto-test`; use `--iterate-verify N` to auto-retry up to N times until lint/test pass (see [Gather–Act–Verify](docs/reference/gather-act-verify.md)). |
| Run two tasks in parallel (same repo) | `gtd run-parallel "Task A" "Task B"`. With isolated git worktrees: `gtd run-parallel --worktrees "Task A" "Task B"` (optional `--merge` / `--cleanup`). |
| Continue a task on another machine | `gtd session handoff <id> [path]` to export; on the other machine import and run `gtd retry <id>`. With API: `gtd session handoff <id> --remote <url>` (use `?run=1` to start retry on the remote). |

### Approval and control

- **When a tool needs permission** (write file, run command, network), the CLI prompts: `[y] Allow once  [s] Don't ask again this session  [p] Don't ask again for project`. Choose `s` or `p` to avoid repeated prompts (see [Allow list](#allow-list-dont-ask-again)).
- **Blocked at approval gate:** With `approvalPolicy: "hybrid"` or `"always"`, the run can pause before risky steps. List blocked tasks: `gtd approvals` (use `-i` to pick one). Approve: `gtd approve <id>`; you can pass **edit args** (e.g. adjusted command) or **reject with feedback** so the agent can retry with your message.
- **Permission modes:** `default` (prompt per tool) | `plan` (read-only) | `acceptEdits` (auto-accept file edits) | `dontAsk` (no prompts) | `bypass` (no policy). Example: `gtd task "..." --permission-mode plan` for a safe dry-run style.
- **Approval dashboard:** Run `gtd serve --approval-ui` and open `/approvals/dashboard` in the browser to see blocked tasks and approve with one click.
- **Allow list:** `gtd allow list` shows session and project allow state; project allow is stored in `.gtd/allow.json`.

Details: [Human-in-the-loop & checkpointing](docs/reference/human-in-the-loop-checkpointing.md).

### Verify and iterate

- **Lint/test after Builder:** `--auto-lint` and `--auto-test` (or config `autoLint`, `autoTest`) run `lintCmd` / `testCmd` after the Builder; on failure, the output is queued so the next run or follow-up can fix it.
- **Iterate until lint/test pass:** `--iterate-verify N` (or `GTD_AUTO_ITERATE_VERIFY`) re-runs the task with failure context until lint/test pass or N iterations. See [Gather–Act–Verify](docs/reference/gather-act-verify.md).
- **Retry from a specific step:** `gtd retry <id> --from-step builder` (or step index) to re-run from that step.

### Configuration and context

- **Config file:** `~/.skate/config.json` (or `GTD_DATA_DIR`). View: `gtd config`; set: `gtd config set <key> <value>` (e.g. `qualityProfile`, `approvalPolicy`, `defaultModel`). See [Configuration](docs/reference/configuration.md).
- **Project config:** `.gtd/` in the project root can hold `allow.json`, `policy.json`, `sandbox.json`, `rules.md`. **Rules precedence:** first file found wins: `.gtd/rules.md` → `RULES.md` → `.cursor/AGENTS.md` → `AGENTS.md`; the config `rules` array can override and merge multiple files.
- **Quality profiles:** `fast` (Scout, Planner, Builder) | `balanced` (+ Reviewer, Documenter) | `max` (+ Red Team). Set via config or `--quality-profile`.
- **Named modes:** `--mode architect` (plan only), `--mode debug` (fast), `--mode ask` (approval), `--mode orchestrator` (full pipeline).
- **Templates:** `gtd task "Fix the bug. ..." --template fix-bug` (or `add-feature`, `refactor`, `diagram`); custom templates in config under `templates`.
- **Project memory:** `MEMORY.md` in the project root is included in every task; use `gtd memory project` to view, or REPL `memory add` / `memory edit`.

### API and headless

- **Start API server:** `gtd serve --api` (optional `--approval-ui`). Auth: set `GTD_API_KEY`; requests use `Authorization: Bearer <key>` or `X-API-Key`. Public mode: `GTD_API_PUBLIC=1` (trusted networks only).
- **Create a task:** `POST /api/tasks` with body `{ "description": "...", "taskId?", "dryRun?", ... }`. Use header **`Idempotency-Key`** to avoid duplicate tasks on retry.
- **Poll status:** `GET /api/tasks/:id` until `status` is `completed`, `failed`, or `blocked`. If `blocked`, `POST /api/approvals/:id/approve`. If `failed`, run `gtd retry <taskId>` or handoff with `?run=1`.
- **Inject instructions mid-task:** `POST /api/tasks/:id/inject` with new instructions; the agent sees them at the next step boundary.
- **Stream:** `GET /api/tasks/:id/stream` — SSE events (see [stream-api.md](docs/parity/stream-api.md)).
- **Exit codes (scripting):** `0` = success, `1` = error. See [Exit codes](docs/reference/exit-codes.md). For CI: [CI/CD](docs/reference/cicd.md).

OpenAPI: [docs/api/openapi.yaml](docs/api/openapi.yaml), [docs/api/README.md](docs/api/README.md).

### MCP and plugins

- **Use GTD from an IDE:** Run `gtd mcp serve`; add it as an MCP server in Cursor/Claude Desktop. Tools: `gtd_create_task`, `gtd_approve`, `gtd_show`, `gtd_list_tasks`, `gtd_retry`.
- **Register external MCP servers:** `gtd mcp list` / `gtd mcp register` / `gtd mcp test` / `gtd mcp tools`. URL servers require `GTD_MCP_URL_ALLOWLIST` (comma-separated hostnames).
- **Plugins:** `gtd plugins discover` (registry), `gtd plugins list` / `gtd plugins run <pluginId> <commandId>`. See [Plugins author guide](docs/plugins/author-guide.md).

---

## Security

We keep everything **secure by default**. When a tool needs access (e.g. write a file, run a command, use the network), we **ask the user** to grant it. The user grants access **on their own risk**; we stay **flexible** so that, with the user's permission, they can allow access to anything they need.

- **Sandbox:** Shell and tool runs use a sandbox when available (Linux: bubblewrap, macOS: sandbox-exec). On by default; set `GTD_SANDBOX_DISABLE=1` to opt out. Default profile denies network; use `GTD_SANDBOX_PROFILE=.../scripts/default-network.sb` for tasks that need web.
- **Secrets:** Store API keys and tokens in **environment variables only**, not in config files. `gtd governance secrets-check` and `gtd doctor` flag potential secrets in config.
- **Allow-list:** Session and project allow state is visible via `gtd allow list`; extending the allow-list is audited.
- **Audit:** Approval granted, bypass used, and allow-list changes are logged to `<GTD_DATA_DIR>/audit.jsonl`. Use `gtd audit list` to review.
- **Plugin isolation:** Plugin commands run with restricted env.
- **API:** When using `gtd serve --api`, auth is required (`GTD_API_KEY`) unless `GTD_API_PUBLIC=1`; public mode is for trusted networks only. API responses include **`X-RateLimit-Limit`**, **`X-RateLimit-Remaining`** (C.6), and **`X-API-Version`** (e.g. `1`). Use **`/api/v1/...`** as an alias for **`/api/...`** (e.g. `GET /api/v1/tasks`); when contracts change, new versions can be added (e.g. `/api/v2/`). **OpenAPI 3.0 spec:** [docs/api/openapi.yaml](docs/api/openapi.yaml) and [docs/api/README.md](docs/api/README.md).
- **MCP URL allow-list (A.6):** To register a URL-based MCP server, set **`GTD_MCP_URL_ALLOWLIST`** (comma-separated hostnames, e.g. `localhost,api.example.com`). Registration is rejected if the URL host is not in the list.

See [Security model](docs/guides/architecture.md#security-and-sandbox) and [CONTRIBUTING](CONTRIBUTING.md) for security and sandbox details.

## Allow list (don't ask again)

When a tool would require approval, you can allow it once, for the session, or for the project:

- **Session:** In-memory for the current process. Use **`gtd allow list`** to see current session and project allow state (or `gtd allow list --format json`). Session allow is cleared when the CLI exits. To persist session allow across restarts, set **`GTD_PERSIST_SESSION_ALLOW=1`**; entries are stored in **`~/.skate/session-allow.json`** and loaded on the next run.
- **Project:** Persisted in **`.gtd/allow.json`** in the project directory. Entries apply to that directory and subdirectories. Use the prompt `[p] Don't ask again for project` when approving a tool, or manage via `gtd allow list` to inspect.

Use `gtd allow list` to inspect session and project allow state.

## Data Storage

- `~/.skate/tasks.json` — Task history
- `~/.skate/models.json` — Enabled models (persists across restarts)
- `~/.skate/config.json` — Defaults (quality profile, approval policy, default model). Created on first run.
- `~/.skate/audit.jsonl` — Persistent audit log (trace IDs).
- `~/.skate/metrics.jsonl` — Telemetry (step latency, token usage).
- `~/.skate/memory.json` — Structured memory store.
- `~/.skate/modes.json` — Mode profiles and active mode.
- `~/.skate/mcp.json` — Registered MCP servers (URL transport requires **`GTD_MCP_URL_ALLOWLIST`** — comma-separated hostnames).
- `~/.skate/repl-history` — REPL command history (B.9).

Set `GTD_DATA_DIR` to override.

## Agent Roles

- **Scout** — Explores context, gathers requirements
- **Planner** — Architecture and implementation planning
- **Builder** — Implements plans and produces deliverables
- **Reviewer** — Code review and quality checks
- **Documenter** — Documentation and README generation
- **Red Team** — Security and adversarial testing

## Quality Profiles

- `fast` — Scout, Planner, Builder
- `balanced` — + Reviewer, Documenter
- `max` — + Red Team

## LLM Providers

**Ollama** (local, no API key):

```bash
ollama pull llama3.2
gtd models enable ollama/llama3.2
gtd task "Your task here"
```

**OpenAI** (GPT-4o): Set `OPENAI_API_KEY`, then `gtd models enable gpt-4o`

**Anthropic:** Set `ANTHROPIC_API_KEY`, then `gtd models enable claude-sonnet-4` or `claude-opus-4`

**Google** (Gemini): Set `GEMINI_API_KEY` or `GOOGLE_API_KEY`, then `gtd models enable gemini-2.0-flash`

## Environment

Copy `.env.example` to `.env` and configure:

- `GTD_MODE` — `hybrid` | `auto`
- `GTD_QUALITY_PROFILE` — `fast` | `balanced` | `max`
- `GTD_TASK_COST_CAP` — optional; max estimated cost in USD (e.g. `0.5`). Task stops when aggregate usage reaches this cap.
- `GTD_TASK_COST_WARN_PCT` — optional (e.g. `80`); warn when estimated cost reaches this % of cap (one warning per task).
- `GTD_WORKSPACE_ROOTS` — optional; comma-separated paths (e.g. `packages/api,packages/app`). When set, file and git tools are restricted to these roots (monorepo).
- **Observability:** `GTD_OTEL_EXPORT=true` and `GTD_OTEL_ENDPOINT=<url>` export traces via OTLP (Datadog, Honeycomb, or any OTLP backend).
- `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc. for LLM providers
- **Telegram:** `TELEGRAM_BOT_TOKEN` — Create a bot via [@BotFather](https://t.me/BotFather). Send `/task <description>` to run tasks.
- **Slack:** `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN` (Socket Mode) or `SLACK_SIGNING_SECRET` (HTTP) — Create an app at [api.slack.com/apps](https://api.slack.com/apps). Enable `app_mention` and `message.im` events. Mention the app or DM with `task: <description>`.
- **WhatsApp:** `WHATSAPP_ACCESS_TOKEN` + `WHATSAPP_PHONE_NUMBER_ID` — Meta Cloud API. Requires public HTTPS URL for webhook. Send `task <description>`.
- **Signal:** `SIGNAL_BRIDGE_URL` + `SIGNAL_NUMBER` — Run [signal-cli-rest-api](https://github.com/bbernhard/signal-cli-rest-api) (e.g. Docker). Send `task <description>`.
- **Discord:** `DISCORD_BOT_TOKEN` — Create a bot at [discord.com/developers](https://discord.com/developers/applications). Enable Message Content Intent. Send `task <description>`.

### Reliability and timeouts

- **Graceful shutdown:** On SIGTERM/SIGINT, `gtd serve` stops accepting new requests, allows in-flight requests to finish (up to 15s), then exits with "Shutting down… (finishing in-flight requests)". Long-running CLI task runs can be interrupted with Ctrl+C.
- **Tool timeout:** **`GTD_TOOL_TIMEOUT_MS`** — per-call limit for builder tools (default 30000, min 1000, max 300000 ms). Prevents hung `run_command`, file, or MCP tool calls.
- **Idempotent task save:** Saves use optimistic concurrency (`updatedAt`). On conflict you get `TaskConflictError`; retry the operation (e.g. `gtd retry <id>` or re-submit with the same idempotency key via API).
- **Per-step timeout:** **`GTD_STEP_TIMEOUT_MS`** or **`--step-timeout <seconds>`** — abort the current role step after N ms/s; avoids a single step hanging the whole run.
- **API request timeout:** **`GTD_API_REQUEST_TIMEOUT_MS`** — when set (e.g. 3600000 for 1h), the HTTP server closes connections that exceed this duration (stream/polling). Default 0 = no timeout.
- **Connector task timeout:** **`CONNECTOR_TASK_TIMEOUT_MS`** — used by Telegram, webhook, and other connectors to abort long-running tasks (e.g. 3600000 for 1h).
- **Retries:** **`GTD_RETRY_LLM_MAX`**, **`GTD_RETRY_TOOLS_MAX`** (default 2 = 1 retry), **`GTD_RETRY_BASE_MS`** (default 1000). Exponential backoff applies to transient LLM (rate limit, timeout) and tool (timeout, ECONNRESET) errors.
- **Webhooks:** **`GTD_WEBHOOK_URL`** — POST JSON when a task becomes blocked, completed, or failed. **`GTD_POST_STEP_WEBHOOK_URL`** — POST JSON after each step (payload: phase, taskId, role, stepIndex, totalSteps, outputPreview); 10s timeout, non-blocking.
- **MCP health:** Run **`gtd mcp test <serverId>`** before a task to verify an MCP server is reachable; optional.
- **GTD as MCP server:** **`gtd mcp serve`** runs GTD as an MCP server on stdio. IDEs (e.g. Cursor, Claude Desktop) can add it as an MCP server and use tools: **gtd_create_task** (description, optional taskId, run), **gtd_approve** (task_id), **gtd_show** (task_id), **gtd_list_tasks** (status?, limit?), **gtd_retry** (task_id). Configure the IDE to run `gtd mcp serve` (or `node path/to/dist/cli/index.js mcp serve`) with stdio transport.
- **Plan validation:** Plan steps are validated (schema) before execution; malformed steps produce a clear error.
- **Plan step limit:** **`GTD_MAX_PLAN_STEPS`** (default 20, max 200) — plans with more steps are rejected; simplify the task or increase the limit.
- **Max context size:** **`GTD_MAX_CONTEXT_CHARS`** (default 128000 ≈ 32k tokens) — context sent to the builder is trimmed above this to avoid OOM or API errors; increase or decrease as needed (1000–2000000).
- **Sandbox resource limits:** When using bwrap (Linux) or sandbox-exec (macOS), the sandboxed shell runs with **`ulimit -n`** (max open files) and **`ulimit -u`** (max processes). Set **`GTD_SANDBOX_MAX_OPEN_FILES`** (default 256) and **`GTD_SANDBOX_MAX_PROCESSES`** (default 64) to tune. For additional restrictions, use a custom **`GTD_SANDBOX_PROFILE`** (macOS) or system/cgroup limits (Linux).

### Security and sandbox

- **Sandbox on by default:** Linux uses bwrap when **`GTD_USE_BWRAP=1`**; macOS uses sandbox-exec when **`GTD_USE_SANDBOX=1`**. Set **`GTD_SANDBOX_DISABLE=1`** to disable.
- **Default profile denies network:** **`scripts/default.sb`** (macOS) restricts to cwd and denies network; **`scripts/default-network.sb`** allows network for `web_fetch`/`web_search`. Set **`GTD_SANDBOX_PROFILE`** to the profile path. See [docs/parity/sandbox-profiles.md](docs/parity/sandbox-profiles.md).
- **MCP URL allow-list:** **`GTD_MCP_URL_ALLOWLIST`** — comma-separated URLs; only these hosts are allowed for MCP HTTP connections. See README or security docs.
- **Plugin isolation:** **`GTD_PLUGIN_ENV_ALLOW`** — comma-separated list of env var names (e.g. `PATH,HOME`) that plugins can see; no `GTD_*` secrets unless allowlisted.
- **API auth:** **`GTD_API_KEY`** — when set, `gtd serve --api` requires `Authorization: Bearer <key>` or `X-API-Key: <key>`. **`GTD_API_PUBLIC=1`** disables auth (trusted networks only). Rate-limit headers are returned.
- **Audit log:** Approvals, bypass, and allow-list changes are logged; see **`gtd governance`** and event types in the security/audit docs.
- **Secrets check:** **`gtd governance secrets-check`** — scans config and rules for likely secrets; doc in security section.
- **Path strictness:** File and git tools are restricted to cwd and **`GTD_WORKSPACE_ROOTS`**; writes outside these are denied (tests in place).
- **Sandbox profile per project:** **`.gtd/sandbox.json`** with `{ "profile": "/path/to/profile.sb" }` (or a path relative to project root) overrides **`GTD_SANDBOX_PROFILE`** for that directory. `gtd doctor` shows the effective profile and `(from .gtd/sandbox.json)` when using the project file.

## Try what you built

After a run, you can sanity-check recent features:

- **Tool approval (don't ask again)**: Run a task that triggers a tool that needs approval (e.g. in `default` permission mode, a write or command). At the prompt choose `[s]` or `[p]`; the next run won't ask for that tool again (session or `.gtd/allow.json`).
- **TUI**: `gtd interactive --tui` — panel layout, then same REPL commands.
- **Extension hook**: Set `GTD_EXTENSION_SCRIPT` to a script that logs `TASK_PHASE`; run a task and check it receives `start`, `pre_plan`, and `end`.
- **Parallel**: `gtd run-parallel "list files" "echo hello"` — both tasks run in parallel (same cwd).
- **Capabilities**: `gtd capabilities --format json` — feature list and maturity levels.

## Quick start & cookbook

Full usage: [How to use](#how-to-use). Short recipes:

**Run your first task**

```bash
gtd models enable ollama/llama3.2   # or another model
gtd task "Add a README to this project"
gtd task "Fix login timeout" --template fix-bug   # templates: fix-bug | add-feature | refactor
```

**Approve tools:** At the prompt choose `[s]` or `[p]` so the next run won't ask again (session or project). See [Allow list](#allow-list-dont-ask-again).

**Parallel in worktrees:** `gtd run-parallel --worktrees "Task A" "Task B"` — leaves `worktree-parallel-1` / `worktree-parallel-2`; remove with `git worktree remove <path>` when done.

**Check last run:** `gtd last`

**Permission modes and scriptability**

- Use `gtd task "..." --permission-mode dontAsk` to avoid tool-approval prompts in scripts; use `acceptEdits` to auto-accept file edits. Use **`--permission-mode plan`** for read-only (dry-run style: no file/shell writes). See `gtd task --help` for all modes.
- **Allow list:** **`gtd allow list`** shows session and project allow state (tools you chose "don't ask again" for); use `-f json` for machine-readable output.
- **REPL history:** Interactive session history is stored at **`~/.skate/repl-history`** (or `$GTD_DATA_DIR/repl-history` when set).
- For JSON output in scripts: `gtd task "..." --dry-run --format json` prints a structured plan. Guaranteed fields and stability: [docs/parity/print-json-scriptability.md](docs/parity/print-json-scriptability.md).
- **Named modes**: `gtd task "..." --mode architect` (plan only), `--mode debug` (fast profile), `--mode ask` (require approval), `--mode orchestrator` (full pipeline, default-like). Orchestrator mode runs Scout→Planner→Builder→Reviewer→Documenter with hybrid approval.

**Session handoff (continue elsewhere)**

Export task state and resume on another machine: `gtd session handoff <id> [path]`.

**Health check (when running bots)**

When you run `gtd serve`, a health endpoint is available at `http://localhost:3099/health` (or `HEALTH_PORT`). With `--webhook`, the webhook server also serves `GET /health`.

**Plugins and workspace**

- Run a plugin command: `gtd plugins run <pluginId> <commandId>`. See [docs/plugins/author-guide.md](docs/plugins/author-guide.md) for writing plugins.
- Workspace: GTD uses **cwd + session**; the pipeline is Scout→Planner→Builder→Reviewer→Documenter.

**Run in CI or scripts**

```bash
gtd task "Run tests and report" --auto --no-progress --permission-mode dontAsk
# Or plan-only as JSON:
gtd task "Add feature X" --dry-run --format json | jq '.plan.steps'
```

**Extension hook (post_step)**

Set `GTD_EXTENSION_SCRIPT` to a script path (or `node path/to/script.js`). It is invoked with `TASK_PHASE=start`, `pre_plan`, `post_step` (after each role, with `ROLE=Scout` etc.), and `end`. Use for logging or metrics.

**Run subtasks in isolation**

**Handoff to another machine or API:** `gtd session handoff <id> --remote <url>` POSTs the handoff bundle to a remote GTD API (`gtd serve --api`). Use `?run=1` on the URL to start retry/approve on the remote.

**Use from IDEs / AI agents:** Rules (`.gtd/rules.md`, `RULES.md`, `AGENTS.md`), API (`gtd serve --api`), `gtd permission-modes`, `gtd session id`, `gtd memory refresh`. **Rules precedence:** first file found wins: `.gtd/rules.md` → `RULES.md` → `.cursor/AGENTS.md` → `AGENTS.md`; config `rules` array overrides and merges in order. **Rules precedence:** `.gtd/rules.md` → `RULES.md` → `.cursor/AGENTS.md` → `AGENTS.md` (first file found wins); config `rules` array overrides for multi-file or custom order (dev plan 96). **Agent quickstart:** (1) Create task via `POST /api/tasks` → get `taskId`. (2) Poll `GET /api/tasks/:id` until `status` is `completed`, `failed`, or `blocked`. (3) If `blocked`, `POST /api/approvals/:id/approve`. (4) If `failed`, run `gtd retry <taskId>` or handoff with `?run=1`. **API:** `POST /api/tasks` body: `description` (required), `taskId`, `stepTimeoutMs`, `workspaceRoots`, `attachments`, `qualityProfile`, `permissionMode`, `timeout`, `container`, `dryRun`, `format`, `containerVolumes`, `mode`; header **`Idempotency-Key`** to avoid duplicate tasks on retry. `GET /api/tasks/:id` returns task with `usage`, `estimatedCost`, `projectRulesPreview`; **`?handoff=1`** returns handoff bundle. `POST /api/tasks/:id/run-step` body: `{ "stepIndex": 1 }`. **Stream:** `GET /api/tasks/:id/stream` — SSE events ([stream-api.md](docs/parity/stream-api.md)). **JSON contract:** dry-run and full-task JSON fields are documented in [docs/parity/print-json-scriptability.md](docs/parity/print-json-scriptability.md). See docs/parity/use-from-cursor.md.

After a dry-run, use the plan steps with worktrees: `gtd run-parallel --worktrees "Step 1 desc" "Step 2 desc"` or create worktrees manually.

**Sandbox (macOS / Linux):** See **Security and sandbox** above. macOS: `GTD_USE_SANDBOX=1` and **`GTD_SANDBOX_PROFILE`** (e.g. `scripts/default.sb`). Linux: `GTD_USE_BWRAP=1` uses bubblewrap.

## Dependencies and security

- Run `npm audit` for security advisories. Some optional or transitive dependencies may report findings (e.g. in `matrix-bot-sdk`); update when fixes are available.
- Lockfiles and `package.json` are kept with compatible version ranges; bump as needed for features or security.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Run **smoke tests** after build: `npm test -- --run tests/smoke/cli-smoke.test.ts`. To run **E2E** tests (real task with API), set **`GTD_RUN_E2E=1`** or provide `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`; E2E is skipped in CI when keys are missing. This project adheres to the [Code of Conduct](CODE_OF_CONDUCT.md). For security issues, see [SECURITY.md](SECURITY.md).

## License

MIT. Improvement ideas from [Agent CLI](https://agent-cli.nijho.lt/) (nijho.lt) and [ask](https://github.com/elias-ba/ask) (elias-ba) are tracked in [docs/research/agent-cli-todo.md](docs/research/agent-cli-todo.md) and [docs/research/ask-todo.md](docs/research/ask-todo.md).
