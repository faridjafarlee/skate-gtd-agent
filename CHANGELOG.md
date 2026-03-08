# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **README usage:** New **How to use** section: first run, typical workflows (approve, retry, inject, iterate-verify, parallel, handoff), approval and control, verify and iterate (`--auto-lint`, `--auto-test`, `--iterate-verify N`), configuration and context, API and headless (inject, Idempotency-Key, stream), MCP and plugins. Commands table extended with `--auto-lint` / `--auto-test` and `--iterate-verify <N>`. Quick start & cookbook shortened and linked to How to use.

### Changed

- **CONTRIBUTING:** Removed all references to the `docs/` folder (architecture, parity, development, planning links). Next steps point only to `improvement.txt`; changelog step no longer links to parity docs.

### Added

- **Development plan 100 (reliability, security, CLI, API, docs)**:
  - **Reliability:** Plan step validation (`validatePlanSteps`) and configurable step limit `GTD_MAX_PLAN_STEPS` (default 20, max 200). Max context size `GTD_MAX_CONTEXT_CHARS` (default 128k) with automatic trim. API request timeout `GTD_API_REQUEST_TIMEOUT_MS` for `gtd serve`. README Reliability and timeouts section (graceful shutdown, tool/step/connector/retry/MCP/plan).
  - **Security:** README Security and sandbox section (sandbox default, profiles, MCP allow-list, plugin isolation, API auth, audit, secrets check, path strictness, sandbox per project). Per-project sandbox profile via `.gtd/sandbox.json` (`{ "profile": "path/to/profile.sb" }`) overrides `GTD_SANDBOX_PROFILE`; `gtd doctor` shows effective profile and `(from .gtd/sandbox.json)` when used.
  - **CLI:** `gtd config` shows `currentOrg` when set. Human-readable duration in `gtd last` and `gtd show`. Task description max length 10000 with clear error. `gtd config reset --all` prompts for confirmation unless `--yes`. Short task id (8 chars) in all retry/approve suggestions. One-line permission summary in `gtd task --help`. Docs: plan mode, `gtd allow list`, REPL history path.
  - **API:** README documents POST body fields, Idempotency-Key, handoff, run-step, stream SSE events, JSON contract link.
  - **Docs:** `docs/adding-a-tool.md` (steps, schema, runtime registration). CONTRIBUTING: CHANGELOG discipline, link to adding-a-tool.
- **Parity / PLAN:** Tier mapping doc ([docs/parity/tiered-permissions.md](docs/parity/tiered-permissions.md)); feature matrix tier row links to it. PLAN.md Phase A/B/D items marked done (permission aliases, org, web search, sandbox, TUI, plugin doc, extension hook, container, Kilo modes/subtasks/worktrees, D.11 feature matrix + reference alignment, D.12 parity tests). **C.9** MCP resources (listMcpResources, `gtd mcp resources [id]`, readMcpResource) and **C.10** Gemini tool calling (completeGoogleWithTools) marked done — already implemented.
- **J.1.1 / K.1.1** Sandbox profiles: [docs/parity/sandbox-profiles.md](docs/parity/sandbox-profiles.md) documents default (network deny) and default-network.sb; README links to it.
- **J.5.2** E2E: Full-task JSON now includes `success` (true when status is completed). Smoke test has two E2E cases when API keys present: (1) `gtd task "echo ok" --auto --format json` → exit 0, valid JSON with success and taskId; (2) `gtd task "echo ok" --auto --quiet` → exit 0 (minimal E2E). Both skipped in CI when no keys; set `GTD_RUN_E2E=1` or provide API keys to run.
- **J.2.2** REPL suggestions: TUI/REPL now suggests "Run: gtd show \<id\>" when last task is completed and "Run: gtd status \<id\>" when in progress (in addition to retry/approve for failed/blocked). Uses short task id (8 chars) consistently.
- **K.2.2** Plugin run doc: [docs/parity/plugin-execution.md](docs/parity/plugin-execution.md) documents `gtd plugins run <pluginId> <commandId>`, env isolation (A.5), `GTD_PLUGIN_ENV_ALLOW`, exit code propagation, and example handler. Author guide links to it.
- **K.4.3** Handoff bundle schema: [docs/parity/session-handoff.md](docs/parity/session-handoff.md) now includes a **Bundle schema** table (version, cliVersion, taskId, description, status, plan, outputs, error, createdAt, hint) for scriptability and import/API use.
- **K.7.3** Feature matrix refresh: Reference alignment table in [docs/parity/feature-matrix.md](docs/parity/feature-matrix.md) updated with links to print-json-scriptability.md, session-handoff bundle schema, plugin-execution.md, and doctor --output. New capability `json-contract` in capabilities.ts.
- **Dev plan 35** Smoke test for `gtd run-step --help` (CLI smoke suite) to guard run-step command presence and usage.
- **Dev plan 47** Stream API events documented: [docs/parity/stream-api.md](docs/parity/stream-api.md) describes `GET /api/tasks/:id/stream` SSE payload (phase, role, status, output), sequence, and example usage. README links to it.
- **Dev plan 96** Rules precedence documented in README: load order `.gtd/rules.md` → `RULES.md` → `.cursor/AGENTS.md` → `AGENTS.md` (first found wins); config `rules` overrides and merges.
- **Dev plan 91** Smoke and E2E documented in README: smoke test command and **`GTD_RUN_E2E=1`** (or API keys) for E2E; skipped in CI when no keys.
- **Dev plan item 8** MCP health check: `gtd mcp register <id> ... --test` pings the server after register and exits non-zero if unreachable; `gtd mcp test <id>` already existed for on-demand checks.
- **Dev plan item 99** Plugin registry doc: [docs/plugins/registry.md](docs/plugins/registry.md) documents discovery (GTD_PLUGINS_DIR, gtd-* / keywords), validation (gtd plugins validate, schema), curated list, and reserved GTD_PLUGIN_REGISTRY_URL. Author guide links to it.
- **Dev plan item 50** Webhook on phase: **`GTD_POST_STEP_WEBHOOK_URL`** — when set, POST JSON after each step (phase: post_step; payload: taskId, taskDescription, role, stepIndex, totalSteps, outputPreview, planStepId). 10s timeout; README Reliability and timeouts documents it with GTD_WEBHOOK_URL.
- **Dev plan item 48** API versioning: **`/api/v1/...`** is supported as an alias for **`/api/...`** (e.g. `GET /api/v1/tasks`). All API JSON responses include **`X-API-Version: 1`**. README documents versioning for future contract changes.
- **Dev plan item 49** OpenAPI/Swagger: [docs/api/openapi.yaml](docs/api/openapi.yaml) — OpenAPI 3.0 spec for all API endpoints (health, capabilities, tasks, run-step, approvals, allow, handoff). [docs/api/README.md](docs/api/README.md) summarizes endpoints and how to view the spec (Swagger UI, Redoc).
- **Dev plan item 72** Parallel tool calls in Builder: Already implemented (CC-15 in `src/agents/runner.ts` — `Promise.all` over `response.toolCalls`). Documented in [docs/adding-a-tool.md](docs/adding-a-tool.md) (Tool execution section). OpenAI, Anthropic, and Google providers return multiple tool_calls; Builder executes them in parallel and appends results in order.
- **Dev plan item 12** Sandbox resource limits: When bwrap (Linux) or sandbox-exec (macOS) is used, the sandboxed shell runs with **ulimit -n** (max open files) and **ulimit -u** (max processes). **`GTD_SANDBOX_MAX_OPEN_FILES`** (default 256) and **`GTD_SANDBOX_MAX_PROCESSES`** (default 64). Documented in README and [docs/parity/sandbox-profiles.md](docs/parity/sandbox-profiles.md).
- **Dev plan item 100** GTD as MCP server: **`gtd mcp serve`** runs GTD as an MCP server on stdio. Tools: **gtd_create_task**, **gtd_approve**, **gtd_show**, **gtd_list_tasks**, **gtd_retry**. For IDE integration (Cursor, Claude Desktop). [docs/integrations/mcp-server.md](docs/integrations/mcp-server.md).
- **Dev plan 96** Rules precedence documented in README: load order `.gtd/rules.md` → `RULES.md` → `.cursor/AGENTS.md` → `AGENTS.md` (first found wins); config `rules` overrides.

- **Security & docs (A.1–A.12, C–D)**:
  - **A.1** Sandbox on by default (Linux bwrap, macOS sandbox-exec); `GTD_SANDBOX_DISABLE=1` to opt out; fallback to exec when bwrap not installed.
  - **A.2** sandbox-macos.md: default Seatbelt profile (network deny), `scripts/default.sb` / `default-network.sb` documented.
  - **A.4** `gtd doctor` shows config secrets check; secrets only in env documented in security-model.md.
  - **A.8** POST /api/allow accepts `scope: "session" | "project"` only; documented in README.
  - **A.9** Audit: `allow_list_extended` event on POST /api/allow; audit log location and event types documented in security-model.md.
  - **A.10** Extension script timeout: SIGTERM on timeout, stderr message; documented in extension-phases.md.
  - **A.12** CI: `npm audit --audit-level=high` (fail on high/critical).
  - **D.1** README Security section: sandbox, secrets, allow-list, audit, plugin isolation, API auth.
  - **D.2** docs/architecture.md: Security and sandbox subsection; key files for sandbox, policy, audit.
  - **D.3** CONTRIBUTING: run `gtd doctor` for config and security env.
  - **D.5** feature-matrix.md: Security defaults row; sandbox row updated (on by default).
- **Remaining (A.3, A.5, A.6, B, C)**:
  - **A.3** Path strictness tests: write_file, edit_file, apply_patch outside cwd/workspace (tests/parity/tool-runtime.test.ts).
  - **A.5** Plugin run isolation: `gtd plugins run` uses restricted env (no GTD_* secrets or API keys unless in GTD_PLUGIN_ENV_ALLOW); documented in plugin-execution.md.
  - **A.6** MCP URL allow-list: `gtd mcp register --transport url --url <url>` requires **GTD_MCP_URL_ALLOWLIST** (comma-separated hostnames); host must be in list.
  - **B/C** Docs: REPL history path in README Data Storage; `gtd allow list` linked from security-model (C.2); help shows MCP tools and workspace-session doc (B.7, B.8); TUI MCP refresh documented (B.12); bypass audit and rate-limit headers documented (C.5, C.6).
  - **B.4** After task fails or is blocked, CLI prints "Run: gtd retry \<id\>" or "Run: gtd approve \<id\>" (consistent suggestion).
  - **A.12** Node and supply chain: README and CONTRIBUTING document supported Node range (engines) and upgrade policy; CI npm audit already in place.

- **Phase K (product maturity)**:
  - **K.5.3** Graceful shutdown: SIGTERM handler alongside SIGINT; task cancellation message "Exiting gracefully."
  - **K.5.2** Builder tool timeout: `GTD_TOOL_TIMEOUT_MS` (default 30000, min 1s, max 300s) for sandbox, fetch, and Playwright.
  - **K.1.2** Permission summary in `gtd task --help`: table for default / plan / accept-edits / dont-ask / bypass.
  - **K.3.1 / K.3.2** Extension phases `post_plan` (after plan built) and `approval` (when blocked); doc in extension-phases.md.
  - **K.3.3** JSON output contract: [docs/parity/print-json-scriptability.md](docs/parity/print-json-scriptability.md) documents guaranteed fields for full-task and dry-run `--format json`, version field, and stability. Contract test in tests/parity/print-json-contract.test.ts; README links to doc.
  - **K.1.1** Seatbelt: `scripts/default-network.sb` (network allowed); sandbox-macos.md documents both profiles.
  - **K.6.1** Trace ID in extension hook env: `TRACE_ID` set for all phases (taskId used as trace).
  - **K.1.3** `gtd allow list` — show session and project allow state (text or JSON).
  - **K.6.2** `gtd doctor --output <path>` — write health report to file (text or JSON). Report now includes gtd and Node version for support/debug.
  - CONTRIBUTING: smoke test command and links to architecture and parity docs.

## [0.2.0] - 2025-03-03

### Added

- **Tool approval UX (don't ask again)**:
  - When a tool would require approval and stdin/stdout are TTY, the CLI prompts: `[y] Allow once  [s] Don't ask again this session  [p] Don't ask again for project`. Session allow is in-memory; project allow is persisted in `.gtd/allow.json`. Skips prompt when `--auto` or non-TTY.
- **Interactive TUI**: `gtd interactive --tui` — draws a simple panel layout (no extra deps). Use with REPL commands as usual.
- **TUI v2**: Live-updating panel with current task and last 8 command lines; redraws after each command.
- **Extension phase**: `pre_plan` — `GTD_EXTENSION_SCRIPT` is now invoked with `TASK_PHASE=pre_plan` right before Scout/Planner (in addition to `start` and `end`).
- **Parallel tasks**: `gtd run-parallel "<desc1>" "<desc2>"` — runs two tasks in parallel in the same repo (for isolated runs use `gtd git worktree` then run in each).
- **Parallel worktrees**: `gtd run-parallel "<desc1>" "<desc2>" --worktrees` — creates two git worktrees, runs one task per worktree in parallel, then reports (worktrees left for manual merge/remove).
- **Production hardening**: Stricter validation and clearer errors for `gtd task` (description required), `gtd mcp register` (id required), `gtd plugins run` (plugin id and command id required). Connector task timeout via `CONNECTOR_TASK_TIMEOUT_MS` (Telegram, webhook). Health endpoint: `gtd serve` exposes `GET /health` on `HEALTH_PORT` (default 3099); webhook server also serves `GET /health` when running.
- **Observability**: `gtd last` — shows last run summary (most recent task: id, status, description, completedAt). Use with `gtd capabilities --format json` and `gtd replay <id>` for full inspection.
- **Quick start & cookbook**: README section with examples: first task, approve and don’t ask again, run two tasks in worktrees, `gtd last`, health check.

- **E.3 / G.3**: Permission mode and `--mode` in README; JSON scriptability doc linked; test for dry-run plan JSON shape.
- **H.3 / F.2 / F.3**: Session handoff, plugin execution, workspace/session docs linked from README.
- **I.2 / I.3**: Parity tests (last-run, parsePlannerSubtasks); feature matrix and capabilities updated; reference alignment refreshed.
- **H.1**: Planner structured subtasks — parsePlannerSubtasks() from Planner output; plan steps from JSON when present.
- **E.2**: GTD_SANDBOX_PROFILE for custom macOS sandbox profile; doc and sandbox.ts updated.
- **H.4 / I.1**: Orchestrator mode and MCP read-resource documented in README.
- **Cookbook**: Run in CI example (--auto, --dry-run --format json).
- **Extension hook (I.2)**: Test suite for `GTD_EXTENSION_SCRIPT` — verifies script is invoked with `start`, `pre_plan`, `post_step`, `end`; `runExtensionHook` exported for tests.
- **Post-step phase (G.2)**: `GTD_EXTENSION_SCRIPT` is now invoked after each agent step with `TASK_PHASE=post_step`, `ROLE` (Scout, Planner, Builder, Reviewer, Documenter), `OUTPUT_PREVIEW`. Documented in [docs/parity/extension-phases.md](docs/parity/extension-phases.md).
- **Run subtasks in isolation**: [docs/parity/subtasks-isolation.md](docs/parity/subtasks-isolation.md) — run plan steps in separate worktrees; cookbook link in README.
- **Plugin author guide**: [docs/plugins/author-guide.md](docs/plugins/author-guide.md) — manifest, commands, handler env, schema, publishing.
- **TUI doc**: [docs/parity/tui-interactive.md](docs/parity/tui-interactive.md) updated — current `--tui` behavior (live panel); optional blessed/ink for richer TUI.
- **README cookbook**: Extension hook (post_step) and subtasks-isolation examples.

- **CLI capabilities**:
  - `gtd capabilities` — Feature flags and parity maturity (`--format json`).
  - **Tool runtime**: `gtd tools list`, `gtd tools run <name> [argsJson]` — file, shell, git, web tools with permission modes (`default`, `plan`, `accept-edits`, `dont-ask`, `bypass`) and sandbox policy.
  - **Sessions**: `gtd session list`, `gtd session fork <id>` — list resumable tasks, fork with outputs up to a step.
  - **Memory**: `gtd memory list/get/set`, `gtd memory project` — structured store + project MEMORY.md; memory injected into orchestration context.
  - **Modes**: `gtd mode list/use/clear/export/import` — per-mode quality/model/permission presets; active mode applied to task runs.
  - **MCP**: `gtd mcp list/register/test/remove` — MCP server management (stdio/url).
  - **Plugins**: `gtd plugins list`, `gtd plugins validate <path>` — plugin discovery and manifest validation; `schemas/plugin.schema.json`.
  - **Audit**: `gtd audit list` — persistent JSONL audit log with trace IDs.
  - **Telemetry**: `gtd telemetry list` — metrics (step latency, token usage).
  - **Git**: `gtd git worktree/branch/diff/status` — git-native workflows.
- **Phase 5/6 extensions**:
  - `gtd review` — review queue (blocked tasks needing approval).
  - `gtd session handoff <id> [path]` — export task state for session handoff.
  - `gtd config lock` / `unlock` — managed config lock; `gtd config set --force` to override.
  - Policy bundles: `loadPolicyBundle()`, `GTD_POLICY_BUNDLE` env for tool policy.
  - `gtd governance secrets-check` — secrets hygiene check.
  - `gtd replay <id>` — run replay: timeline of audit and telemetry for a task.
  - **Org-level restrictions**: Optional `org.json` or `GTD_ORG_CONFIG` with `allowedQualityProfiles`, `allowedApprovalPolicies`, `allowedModels`. Effective config is restricted; `gtd config set` validates against org. `gtd governance org` shows current restrictions.
- **Parity docs**: `docs/parity/feature-matrix.md`, `roadmap.md`, `terminology.md` with confidence rubric (exact/close/partial).
- **Interactive mode**: `gtd interactive` / `gtd repl` — REPL with `task "..."`, `status`, `show`, `inbox`, `search`, `history`, `approve`, `retry`, `cancel`, `delete`, `help`, `exit`
- **Progress bar**: Phase-based progress during runs (disable with `--no-progress`)
- **`gtd task --interactive`**: Prompts "Proceed? (y/n/edit)" before running
- **`gtd config reset --all`**: Clears config, tasks.json, and models.json
- **Parallel steps**: Reviewer and Documenter run in parallel
- **Webhook source**: `source: "webhook"`; `taskId` in 202 response
- **Task exit codes**: `process.exitCode = 0` on success, `1` on failure
- **`gtd retry --from-step <role>`**: Retry from scout, planner, builder, reviewer, or documenter
- **Orchestrator**: Skips roles that already have output when resuming
- **Templates**: `getMergedTemplates()` loads `~/.skate/templates.json`
- **`gtd delete <id>`**: Delete a task (with `--force` to skip confirmation)
- **`gtd task --output <path>`**: Write deliverable to file
- **`gtd task --timeout <seconds>`**: Abort task after N seconds
- **`gtd show <id>`**: Show full task details (alias for `status <id>`)
- **`gtd version`**: Show version (with `--format json`)
- **`--format json`** on: status, search, history, inbox, usage, export, import, backup, restore, approve, retry, cancel, delete, config get/set/reset, templates, models list/usage/enable/disable/ping/route
- **Webhook API key**: `GTD_WEBHOOK_API_KEY` for Bearer auth
- **Environment-specific config**: `GTD_ENV` loads `config.${env}.json`
- **Per-channel config**: `channels.telegram`, `channels.cli`, etc.
- **Fallback models**: Router returns ordered list; runAgent tries until one succeeds
- **Streaming**: `--stream` for Builder output in real time
- **Step-level model override**: `modelOverrides.scout`, `modelOverrides.builder` in config

### Fixed

- **Loop-resume test**: Skip in CI to avoid timeout when models are enabled

## [0.1.0] - 2025-03-03

### Added

- CLI with task orchestration (Scout → Planner → Builder → Reviewer → Documenter → Red Team)
- Configurable LLM routing (OpenAI, Anthropic, Google Gemini, Ollama)
- Quality profiles: fast, balanced, max
- Hybrid approval gates for risky actions
- `gtd config` and `gtd config set` for defaults (quality, approval policy, default model)
- Config file (`~/.skate/config.json`) created on first run
- Messaging connectors: Telegram, Slack, WhatsApp (Cloud API), Signal (signal-cli-rest-api)
- `gtd serve` with `--telegram`, `--slack`, `--whatsapp`, `--signal` options
- Task triggers: CLI `gtd task`, Telegram `/task`, Slack `@mention` / DM `task:`, WhatsApp/Signal `task <description>`
- Connectors use config defaults (quality, approval, default model)
- Blocked tasks include task ID in approval message for `gtd approve <id>`
- CONTRIBUTING.md with development setup and scripts
- npx one-off run documented in README
- npm overrides for esbuild to fix audit vulnerabilities
- Connector tests (Signal extractMessages, WhatsApp extractWhatsAppMessages, adapter stubs)
- Husky + lint-staged pre-commit hooks
- Release workflow (publish on tag push; set NPM_TOKEN secret)
- `gtd history` — Show completed and failed tasks
- `gtd export [path]` — Export tasks to JSON
- Store listTasks status filter test
- `--write` flag to write Builder code blocks to files
- ESLint and 39 tests (config, storage, approval, router, connectors, etc.)
- GitHub Actions CI (build, lint, test)
