# Skate Desktop — Platform and release (items 2–20)

## 2. Target macOS version and architecture

- **Minimum macOS:** 12.0 (Monterey). Set in `package.json` → `build.mac.minimumSystemVersion`.
- **Architectures:** Build for **x64** (Intel) and **arm64** (Apple Silicon) separately by default. For a **universal** binary (single .app with both archs), run:
  ```bash
  npm run dist:mac:universal
  ```
- **Outputs:** `out/` — `.dmg` and `.zip` per architecture (or one universal .app when using `--universal`).

---

## 3. Bundle vs invoke existing CLI

- **Current choice:** **Invoke** the existing `skate` / `gtd` CLI as a subprocess. The app does not embed Node or the CLI inside the .app bundle.
- **How it works:** At runtime the app resolves the CLI via:
  1. `GTD_CLI_PATH` (env), or
  2. Packaged: `resources/dist/cli/index.js` if the CLI was bundled into the app, or
  3. Development: `../dist/cli/index.js` (repo root).
- **Bundling (optional later):** To ship a fully standalone app, bundle the built CLI into the Electron app (e.g. copy `dist/` into `resources/` in the build) and point `getGtdPath()` at it. Until then, users need `skate` or `gtd` on PATH or set `GTD_CLI_PATH`.

---

## 4. App signing and notarization (Apple Developer ID)

- **Signing:** To distribute outside the Mac App Store you need an **Apple Developer ID** certificate. In electron-builder, set:
  - `CSC_LINK` — path to your .p12 or certificate
  - `CSC_KEY_PASSWORD` — password for the certificate
  - Or use `CSC_NAME` with a keychain identity.
- **Notarization:** After signing, submit the .app or .dmg to Apple for notarization so macOS Gatekeeper allows it. Use `electron-builder`’s `afterSign` hook to run `electron-notarize` (or the built-in notarize option in newer electron-builder) with your Apple ID and app-specific password.
- **Hardened Runtime:** `build.mac.hardenedRuntime: true` is set. For notarization you may need a custom `entitlements.mac.plist` (e.g. `com.apple.security.automation.apple-events` if you use AppleScript). Add `build/entitlements.mac.plist` and reference it in `build.mac.entitlements` when you sign.
- **Docs:** [Apple Notarization](https://developer.apple.com/documentation/security/notarizing_mac_software_before_distribution), [electron-builder Code Signing](https://www.electron.build/code-signing).

---

## 5. Auto-update mechanism

- **Implemented:** `electron-updater` is added as a dependency. To enable updates:
  1. Publish builds to a URL (GitHub Releases, S3, or any static server).
  2. Set `publish` in `package.json` → `build` (e.g. `{ "provider": "github", "owner": "…", "repo": "…" }`).
  3. In `main.js`, call `autoUpdater.checkForUpdates()` after `app.whenReady()` and handle `update-available` / `update-downloaded` (e.g. prompt user to restart).
- **Alternative:** Manual updates — users download a new .dmg/.zip from releases. Document the current version and link to releases in the app (e.g. Help → Check for updates).

---

## 6. Single-window vs multi-window

- **Current choice:** **Single-window.** One main window (task input, output, recent tasks). Settings and history are in the same window or can be added as panels/tabs later.
- **Multi-window (future):** If we add separate windows (e.g. Settings, or a second task view), they will be secondary windows; the main window remains the primary entry point.

---

## 7. Menu bar vs dock-only

- **Current choice:** **Dock-only.** The app appears in the dock and has no menu bar icon (no “menu bar extra”). The standard macOS application menu (Skate → About, Quit, etc.) is provided by Electron. We do not create a separate menu bar item.

---

## 8. “Open with Skate” (e.g. .gtd projects)

- **Intended behavior:** When the user associates a file type (e.g. `.gtd` project or folder) with Skate, opening that file/folder launches the app and optionally sets the working directory to that folder.
- **Implementation (future):** On macOS, register a document type or URL scheme in `Info.plist` (via electron-builder `build.mac.extendInfo`). Handle `open-file` / `open-url` in the main process and pass the path to the renderer so the app can set cwd or open the project. Not implemented yet; this doc serves as the plan.

---

## 9. Accessibility (VoiceOver, keyboard nav, reduced motion)

- **Implemented in UI:**
  - **Landmarks and roles:** Main content has `role="main"` and `aria-label` where useful; the task input and Run button are focusable and labeled.
  - **Keyboard:** Tab through task input → Run button; Enter in the input submits the task. Focus order is logical.
  - **Reduced motion:** CSS `@media (prefers-reduced-motion: reduce)` is applied so animations/transitions can be disabled for users who prefer reduced motion.
- **VoiceOver:** Semantic HTML and ARIA labels improve screen reader support. Test with VoiceOver (macOS) and adjust labels as needed.
- **Future:** Ensure all interactive elements are focusable and have visible focus indicators; add skip links if the UI grows.

---

## 10. Localization (L10n) plan

- **Current:** **English only.** All strings in the desktop app and this doc are in English.
- **Plan:** En first; no i18n framework yet. When adding L10n:
  1. Extract user-facing strings (UI labels, placeholders, messages) into a single module or JSON per locale.
  2. Use a minimal approach (e.g. `en.json`, `de.json`) and a small runtime loader, or integrate `electron-i18n` / similar.
  3. Set locale from system (e.g. `app.getLocale()`) and fall back to `en`.
  4. Keep CLI output and log messages in English for consistency with the `skate` CLI.

---

## Shell and environment (11–20)

### 11. Default shell and PATH when running tasks

- **Current behavior:** Tasks run by spawning the CLI as a subprocess with **minimal env** (no login shell). The child receives:
  - A copy of the main process `process.env`
  - Env merged from `~/.skate/env` and project `cwd/.env` (see §13).
- **PATH:** Inherited from the Electron process (so whatever PATH the user had when launching the app). For a **login shell** (e.g. to pick up `.zprofile` / `.bash_profile`), we do not run via `/bin/bash -l -c`; that can be added later if needed.
- **Documented:** Users who need a full login environment can run `skate` from a terminal instead.

### 12. Working directory: project picker or “last used” per workspace

- **Implemented:** The app stores a **last-used workspace** in `prefs.json` (under `app.getPath('userData')`). A “Change folder” button opens a directory picker; the chosen path is saved and used as `cwd` for all CLI invocations (run task, list tasks) until changed.
- **Single workspace:** One active workspace per app instance; no per-window workspace yet.

### 13. Env vars: load from `.env`, `~/.skate/env`, or UI config

- **Implemented:** Before each CLI run, env is built as:
  1. Base: `process.env`
  2. Then merged: `~/.skate/env` (KEY=value per line, same format as CLI `gtd auth` storage)
  3. Then merged: `<cwd>/.env` (project-local)
- **UI config:** No UI for editing env yet; use `~/.skate/env` or project `.env` files.

### 14. API keys: secure storage (Keychain) vs env-only

- **Current:** **Env-only.** API keys are read from `process.env` (including values loaded from `~/.skate/env` and `.env`). The desktop app does not write to the system Keychain.
- **Future:** Keychain (or Electron `safeStorage`) can be used to store API keys and inject them into child env; for now we rely on the same file-based auth as the CLI (`~/.skate/env`).

### 15. `GTD_SESSION_ID` and session persistence across app restarts

- **Implemented:** A persistent **session ID** is generated on first use and stored in `prefs.json`. It is passed to the CLI as `GTD_SESSION_ID` in the child process env so that the same logical session is used across app restarts until the user clears prefs or the file is removed.

### 16. Config file precedence: app dir vs `~/.skate` vs project `.gtd`

- **CLI behavior (documented for desktop users):** The `skate` CLI resolves config in this order (see repo `src/storage/config.ts` and data dir from `GTD_DATA_DIR` or `~/.skate`):
  1. **Project:** `<cwd>/.gtd/` (e.g. extension config, project-specific settings)
  2. **User:** `~/.skate/` — `config.json`, `org.json`, `env`, etc.
  3. **Env:** `GTD_ENV` can select `config.${env}.json` under `~/.skate/`.
- **Desktop app:** Does not override `GTD_DATA_DIR`; the CLI child uses the same precedence. Project `.gtd` is used when `cwd` is set to that project.

### 17. Sandbox (macOS app sandbox)

- **Current:** The app is **not** running with the macOS App Sandbox enabled (no `com.apple.security.app-sandbox` entitlement in the built app by default). If you enable it for distribution:
  - **File access:** Allow read/write to **user-selected directories** via `dialog.showOpenDialog` and optionally **bookmark** access (Security-Scoped Bookmark) for the chosen workspace so it survives restarts.
  - **Data dir:** `~/.skate` is inside the user’s home directory; sandboxed apps can access it if “User Selected File” or home read/write is allowed.
- **Doc:** When turning on sandbox, add the required entitlements and test folder picker and CLI `cwd` access.

### 18. Network: allow outbound for API and MCP

- **Current:** No sandbox, so outbound network is allowed. If you enable the app sandbox (§17), add **outgoing network (client)** entitlement so the CLI (and any MCP/API calls) can reach the internet. No special desktop code for this beyond entitlements.

### 19. No elevated privileges; “run in terminal” for admin needs

- **Principle:** The desktop app does **not** request admin or elevated privileges. It runs as the current user.
- **Admin tasks:** For operations that require sudo or system-wide changes, document that users should run the `skate` CLI from a terminal (e.g. Terminal.app or iTerm) where they can elevate as needed.

### 20. CLI path: prefer bundled `gtd` or `PATH` / `GTD_CLI_PATH`

- **Implemented in `getGtdPath()`:** Resolution order:
  1. **`GTD_CLI_PATH`** (env) — explicit path to the CLI binary or `dist/cli/index.js`
  2. **Packaged:** `resources/dist/cli/index.js` if the CLI was bundled into the app
  3. **Development:** `../dist/cli/index.js` (repo root)
  4. **Fallback:** `node_modules/.bin/gtd` if present
- **Bundling:** To ship a fully standalone app, bundle the built CLI into the Electron app and rely on (2); see §3.

---

## Main window and layout (21–30)

### 21. Main window: sidebar (tasks, history, settings) + main content

- **Implemented:** The main window has a **sidebar** (Tasks, History, Settings) and a **main content** area. The sidebar shows nav links and a switchable pane: Recent tasks, History placeholder, or Settings (workspace, theme, font size). Main content is always the task composer and transcript.

### 22. Sidebar: collapsible; persist width in app prefs

- **Implemented:** Sidebar can be **collapsed** via a toggle (icon only when collapsed). **Width** is resizable via a drag handle; both `sidebarWidth` and `sidebarCollapsed` are stored in `prefs.json` and restored on launch.

### 23. Content area: task input (composer) at top or bottom

- **Implemented:** The **composer** (task input + Run button) is at the **top** of the main content area; the transcript is below it.

### 24. Conversation / transcript view: scrollable, copy-friendly

- **Implemented:** The transcript is in a scrollable container with `overflow: auto`. A **Copy** button in the transcript toolbar copies the full transcript text to the clipboard.

### 25. Syntax-highlighted code blocks and diffs in transcript

- **Implemented:** Plain-text output is parsed for fenced **code blocks** (```` ```lang ... ``` ````); they are rendered in a `.code-block` style (monospace, bordered). Lines that look like **diffs** (starting with `+` or `-`) are wrapped in `.diff-add` / `.diff-remove` for color. No full syntax highlighter (e.g. Prism) yet; structure only.

### 26. Responsive layout: min width/height; support window resize

- **Implemented:** Window has **minWidth: 600**, **minHeight: 400**. Window **bounds** (width, height, x, y) are saved on resize/move and restored when the app is reopened.

### 27. Dark/light theme following system or override

- **Implemented:** **System** theme follows `prefers-color-scheme`. User can override to **Dark** or **Light** in Settings; choice is stored in prefs and applied via `data-theme` on the document root.

### 28. Font: monospace for code, system for UI; user-configurable size

- **Implemented:** CSS variables `--font-ui` (system) and `--font-mono` (ui-monospace) are used. **Font size** is configurable in Settings (12–20px) and persisted; it updates `--font-size` for the whole app.

### 29. “New task” FAB or Cmd+N; focus composer

- **Implemented:** **Cmd+N** (Mac) / **Ctrl+N** (Windows/Linux) focuses the task input (composer). No FAB; keyboard shortcut only.

### 30. Window title: current task or “Skate”

- **Implemented:** While a task is running, the window title is set to the task description (truncated to 50 chars). On completion or idle, the title is reset to **Skate**. Implemented via IPC `set-window-title`.

---

## Task lifecycle (31–40)

### 31. Start task: composer submit → invoke `gtd task "…"`

- **Implemented:** Composer submit (Run task button or Enter) invokes `gtd task "<description>"` via IPC `run-task`. The CLI is run in the workspace cwd with env from §13.

### 32. Show running state: spinner, step name, progress if available

- **Implemented:** While a task is running, a **spinner** and **step name** (current task description, truncated) are shown in a `.running-state` bar. Progress from the CLI is not parsed; the step name is the submitted description.

### 33. Stream output: append to transcript

- **Implemented:** The main process runs the CLI with `runGtdStream`, which sends `task-stream-chunk` (stdout/stderr chunks) to the renderer. The renderer subscribes via `onTaskChunk` and appends each chunk to the transcript so output appears incrementally. On process exit, the full output is set again and completion/failure UI is shown.

### 34. Cancel: send SIGINT so run stops gracefully

- **Implemented:** A **Cancel** button is visible while a task is running. It invokes `cancel-task` IPC; the main process sends **SIGINT** to the current child process. The transcript appends `[Cancelled]` when cancel is used.

### 35. On completion: show deliverable, “Written files”, task ID

- **Implemented:** On successful exit (code 0), a **completion summary** block is shown below the transcript. It displays **Task ID** (parsed from stdout/stderr or from the most recent session list entry) and **Written** files (parsed from stdout patterns like “written: …” / “wrote: …”). Summary is formatted in `completion-summary` and hidden on next run or failure.

### 36. On failure: show error, “Retry” and “Approve” actions

- **Implemented:** On non-zero exit or throw, the transcript shows the error and a **failure actions** bar with **Retry** (re-run the same description) and **Approve** (dismiss the bar). Retry re-fills the composer and triggers run again.

### 37. Task list: recent tasks from store (`gtd session list`)

- **Implemented:** The Tasks pane uses **`gtd session list --format json`** (IPC `list-tasks`). Recent tasks (id, description, status) are shown; list is refreshed after each run and when the workspace changes.

### 38. Click task → load transcript and allow follow-up

- **Implemented:** Each task in the list is clickable. Clicking loads that task’s **saved transcript** (stored by task id when a run completes) into the main transcript view. If no transcript exists, a short message is shown. The composer placeholder can show “Follow-up for: …” to encourage follow-up input.

### 39. Resume last: “Continue last task” from current workspace

- **Implemented:** When a last run exists (description and optional task id stored in prefs), a **“Continue last task”** link is shown below the composer. Clicking it fills the composer with the last task description and focuses the input. Visibility is updated after each run and on load.

### 40. Fork task: duplicate and open in new thread

- **Implemented:** Each task in the list has a **Fork** button. Clicking Fork copies that task’s description into the composer and focuses it, so the user can start a new run (new “thread”) from the same prompt.

---

## Task lifecycle (41–45) and Composer (46–50)

### 41. Approve blocked task: show diff/plan, Approve/Reject buttons

- **Implemented:** When CLI output indicates a blocked state (e.g. “blocked”, “approval required”, “awaiting approval”), a **blocked-approval** section is shown with **Approve** and **Reject**. The transcript already shows the diff/plan. Approve re-runs the last task; Reject dismisses the section.

### 42. Attachments: paste image or pick file; pass to task

- **Implemented:** **Attach** button opens a file picker (multi-select). **Paste** (e.g. Ctrl+V) in the composer: if the clipboard contains files or an image, they are written to a temp file and added to attachments. Chosen and pasted paths are listed below the composer with a remove (×) control. The final description includes “Attachments: path1, path2” at the end.

### 43. Templates: dropdown or `/template:name` in composer

- **Implemented:** A **Template** dropdown lists templates from prefs (default: Default, Plan, Review). Selecting one inserts that template’s body into the composer. Typing **/template:name** (e.g. `/template:plan rest of prompt`) at the start of the composer expands to the template body plus the rest of the text before running.

### 44. Quality profile and approval policy selectors (optional UI)

- **Implemented:** In **Settings**, **Quality profile** (Default / Fast / Balanced / Thorough) and **Approval policy** (Auto / Always ask / Never) dropdowns are available. Selections are stored in prefs and passed to the CLI via **GTD_QUALITY_PROFILE** and **GTD_APPROVAL_POLICY** in the task process env when present.

### 45. Ephemeral run: “Don’t save to history” checkbox

- **Implemented:** A **“Don’t save to history”** checkbox in the composer toolbar, when checked, causes the run not to update last-run state, task transcripts, or draft history (no `setLastRun`, no `setTaskTranscript`, and the description is not pushed to draft history).

### 46. Composer: multiline text area with Enter to send (or Cmd+Enter)

- **Implemented:** The composer is a **textarea** (multiline). **Enter** adds a new line. **Cmd+Enter** (Mac) / **Ctrl+Enter** (Windows/Linux) submits the task. Placeholder: “Describe your task… (Cmd+Enter to run)”.

### 47. Placeholder: “Describe your task…”

- **Implemented:** The composer placeholder is “Describe your task… (Cmd+Enter to run)” (with send hint).

### 48. Draft history: Up/Down to cycle previous drafts

- **Implemented:** The last 20 submitted descriptions (after building from slash/template/attachments) are kept. When the composer is focused and the cursor is at the start, **Arrow Up** cycles to older drafts and **Arrow Down** to newer; the textarea value is replaced with the selected draft.

### 49. @-mentions: @path, @file to attach context

- **Implemented:** An **@path** button opens the file picker; the chosen file path is inserted at the cursor as `@path:<path> ` so the task description can reference a file. No inline @-autocomplete; button-only for now.

### 50. Slash commands: /diff, /plan, /review, etc. (optional)

- **Implemented:** If the composer text starts with **/plan …**, **/review …**, or **/diff …**, it is expanded before run: e.g. “/plan add tests” → “Create a step-by-step plan: add tests”, “/review this code” → “Review the following and suggest improvements: this code”, “/diff file” → “Show diff for: file”. Other slash commands can be added the same way.

---

## Composer and input (51–55)

### 51. Paste image: insert inline or as attachment

- **Implemented:** Pasting an image (or file) in the composer adds it to attachments (via temp file) and inserts an inline marker `[image: filename]` at the cursor so the run receives both the attachment paths and a reference in the text.

### 52. Character/word count or token estimate (optional)

- **Implemented:** A **composer-meta** line below the composer shows **chars**, **words**, and **~tokens** (chars/4). It updates on input.

### 53. Disable send while task is running (or queue)

- **Implemented:** While a task is running, the Run button is disabled and the Cancel button is shown; the user cannot submit another task until the run finishes or is cancelled.

### 54. Clear composer after send; optional “Keep draft”

- **Implemented:** A **“Keep draft”** checkbox in the composer toolbar is persisted in prefs. When unchecked (default), the composer and attachments are cleared after a successful run. When checked, the text and attachments are left for editing or re-run.

### 55. Keyboard: Esc to blur, Cmd+K for command palette (optional)

- **Implemented:** **Escape** in the composer blurs the input. **Cmd+K** / **Ctrl+K** opens a **command palette**: filterable list (Run task, New task, Open Settings, Open Tasks, Continue last task, Change folder, Copy transcript). Arrow Up/Down to select, Enter to run, Escape to close.

---

## Models and config (56–60)

### 56. Model selector: dropdown (from config / capabilities)

- **Implemented:** In **Settings**, a **Model** dropdown (Default, GPT-4o, GPT-4o mini, Claude 3.5 Sonnet, Claude 3 Haiku) is available. The selection is stored in prefs and passed to the CLI as **GTD_MODEL** in the task process env.

### 57. Switch model mid-session without restart

- **Implemented:** Changing the model in Settings applies to the **next** task run; no app restart. The chosen model is read from prefs when building the task env.

### 58. Profile selector: load GTD_ENV / config profile

- **Implemented:** In **Settings**, a **Profile (GTD_ENV)** dropdown (default, dev, prod) is available. The selection is stored in prefs and passed to the CLI as **GTD_ENV** in the task process env.

### 59. Settings pane: config file path, edit raw JSON or form

- **Implemented:** **Config path** shows the Skate config directory (`~/.skate`). **Open config folder** opens it in the system file manager. **Config (raw JSON)** textarea loads and displays the contents of `~/.skate/config.json` when the Settings pane is opened; **Save config** writes the textarea content back to that file.

### 60. Feature flags / experimental toggles

- **Implemented:** In **Settings**, **Feature flags** checkboxes (**Streaming**, **MCP**) are available. Selections are stored in prefs under `featureFlags` and passed to the CLI as **GTD_STREAMING** and **GTD_MCP** when set.

### 61. MCP: list servers, enable/disable, add from UI

- **Implemented:** In **Settings**, **MCP servers** lists entries from prefs (`mcpServers`). Each row has a checkbox to enable/disable and a remove (×) button. **Add** plus a text input (name or URL) appends a new server (id, name, url, enabled). Stored in prefs; CLI can read from config or env when MCP is used.

### 62. Rules: show project rules path, “Reload”

- **Implemented:** **Rules path** in Settings shows the project rules path for the current workspace: `<cwd>/.gtd/rules` if it exists, else `<cwd>/.skate/rules`. **Reload** re-reads the path (e.g. after changing cwd) and updates the display.

### 63. Debug: “Show config layers”, “Export diagnostics”

- **Implemented:** **Show config layers** writes to the transcript a JSON list of config layers (prefs path, config path, userData path, existence). **Export diagnostics** opens a save dialog and writes a JSON file (version, sessionId, model, profile, cwd, prefs path, config path) for support/debugging.

### 64. Theme/NO_COLOR: preview and save

- **Implemented:** **Theme** (system/dark/light) is applied immediately via `data-theme` and saved in prefs. **NO_COLOR** checkbox in Settings is saved in prefs and passed to the CLI as **NO_COLOR=1** in the task env so CLI output is non-colored.

### 65. Status line: model, context size, session ID (optional)

- **Implemented:** A **status line** in the main window footer shows **Model** (from prefs or “Default”), **Context** (context size in tokens, e.g. 32k / 128k / 1M, or “—” if not set), and **Session** (first 8 chars of session ID). In **Settings**, a **Context size** dropdown (Default, 32k, 128k, 200k, 1M) persists the value in prefs and passes it to the CLI as **GTD_CONTEXT_SIZE** when set. The status line is updated on load, when opening Settings, and after each task run.

---

## Sessions and history (66–70)

### 66. Saved chats: list by workspace and time

- **Implemented:** The **History** pane lists “saved chats”: current workspace tasks from `gtd session list` plus last run per other workspace from `lastRunByWorkspace` prefs. Each run updates `setLastRunByWorkspace(cwd, summary)` so workspaces appear in the list.

### 67. Resume session: pick from list, load transcript

- **Implemented:** Clicking a session in the History list loads that task’s transcript (via `getTaskTranscript`), switches workspace if the session was from another cwd, and switches to the Tasks pane. Transcript is shown in the main area.

### 68. “Resume last” and “Resume all” (all workspaces)

- **Implemented:** **Continue last task** (below composer) resumes the single last run. **Resume all** in the History pane reloads the history list (current workspace tasks + last run per other workspace) so the user can pick any.

### 69. Session picker: search by task description or ID

- **Implemented:** The History pane has a **search** input. Typing filters the list by task description or task ID (case-insensitive substring).

### 70. Delete or archive session

- **Implemented:** Each session in the History list has an **Archive** button. Archiving adds the session’s task ID to `archivedSessions` in prefs; archived sessions are hidden from the list. No “unarchive” in UI yet; prefs can be edited to clear the list.

---

## Sessions and history (71–75)

### 71. Export transcript to file (JSON or markdown)

- **Implemented:** In the transcript toolbar, **Export (MD)** and **Export (JSON)** open a save dialog and write the current transcript as Markdown or as JSON (`{ transcript, exportedAt }`). Implemented via IPC `export-transcript-to-file`.

### 72. Share session (e.g. copy link or export for handoff)

- **Implemented:** **Share** in the transcript toolbar copies the transcript as markdown (with a “# Skate session” header) to the clipboard for pasting into docs or handoff. Export to file (§71) provides file-based handoff.

### 73. Cwd override when resuming (e.g. “Open in folder…”)

- **Implemented:** Each item in the History list has an **Open in folder** button (when the session has a cwd). Clicking it opens that folder in the system file manager (`shell.openPath`). Resuming a session from another workspace already sets the app workspace to that cwd when you click the row.

### 74. History: filter by status (completed, failed, cancelled)

- **Implemented:** The History pane has a **Filter by status** dropdown (All, Completed, Failed, Cancelled). The list is filtered by `s.status` before search and archive filtering.

### 75. Pagination or “Load more” for large history

- **Implemented:** History is shown in pages of `HISTORY_PAGE_SIZE` (20). A **Load more** button appears when there are more sessions than the current limit; clicking it increases the visible count by 20 and re-renders.

---

## Integrations and CLI (76–80)

### 76. “Open in Terminal”: open Terminal.app at project with `gtd` ready

- **Implemented:** In Settings, **Open in Terminal** opens the system terminal (on macOS via AppleScript “Terminal”, `cd` to current workspace). The user can then run `gtd` commands in that folder. IPC `open-in-terminal`.

### 77. “Run in terminal”: copy one-liner (e.g. `gtd retry <id>`)

- **Implemented:** **Copy command** in the transcript toolbar copies a one-liner to the clipboard: `gtd task "<description>"` using the last run description or the current composer text. User can paste into a terminal to re-run. Command palette includes “Open in Terminal”.

### 78. Handoff: “Apply cloud task to local” (handoff-apply) from UI

- **Implemented:** **Import handoff bundle** is in the command palette (Cmd+K). It opens a file picker for a JSON handoff bundle and runs `gtd handoff-import <file>` in the current workspace. After import, the user can run `gtd retry <id>` (e.g. via Copy command with the task id, or from terminal). IPC `handoff-import-file`.

### 79. Git: show branch, “Open diff” (external or in-app)

- **Implemented:** When the Settings pane is opened, if the current workspace is a git repo, a **Git branch** row appears with the current branch name and an **Open diff** button. **Open diff** runs `git diff` in the workspace and shows the output in the transcript. IPC `get-git-branch`, `open-diff`.

### 80. Notifications: “Task completed” / “Task failed” (macOS notifications)

- **Implemented:** On task completion (success or failure), the app shows a system notification via Electron’s `Notification` API: “Task completed” with the task description (truncated), or “Task failed” with the description or error. IPC `show-notification`.

### 81. Dock badge: count of running tasks (optional)

- **Implemented:** When a task is running, the macOS dock shows badge “1”; when the task ends, the badge is cleared. Uses `app.dock.setBadge` (macOS only).

### 82. Deep link: `skate://task/<id>` to open task in app

- **Implemented:** The app registers as the default handler for the `skate://` protocol (`app.setAsDefaultProtocolClient('skate')` before ready). On macOS, `open-url` is handled: `skate://task/<id>` focuses the window and sends the task id to the renderer, which loads that task’s transcript and shows it. `skate://open` just focuses the window.

### 83. CLI integration: `gtd --desktop` or env to open app with context

- **Implemented:** The CLI (or any script) can open the app with context by opening the URL: `open skate://open` (focus app) or `open skate://task/<id>` (open and show that task). No plaintext env needed; the app is opened via the OS. Document in CLI docs that `open skate://open` opens the desktop app.

### 84. Drag-and-drop: drop folder to set workspace

- **Implemented:** On macOS, when the user drops a folder onto the app icon in the dock, the `open-file` event is handled: if the path is a directory, it is set as the workspace (`lastCwd`), the window is focused, and the renderer is notified via `workspace-dropped` so the cwd display and task list refresh.

### 85. Quick Look / preview for generated files (optional)

- **Implemented:** When the completion summary shows a “Written: …” path, a **Preview** button is shown that opens macOS Quick Look (`qlmanage -p`) for that path (resolved against the current workspace if relative). IPC `open-quicklook`.

---

## Auth and security (86–92)

### 86. API keys: store in Keychain, expose via env to CLI

- **Implemented:** The app stores an API key in encrypted form in user prefs (AES-256-CBC with a key derived from `userData` path via `crypto.scrypt`). When building env for the CLI (`buildEnvForTask`), the decrypted key is set as `OPENAI_API_KEY` so the CLI can call the backend. No system Keychain dependency; encryption provides safe storage.

### 87. “Login” flow: add API key, validate, save to Keychain

- **Implemented:** In Settings, an **API key (login)** section: user can paste an API key, click **Save key** to store it encrypted, and **Validate** to run a quick CLI check (e.g. `gtd session list`) with that key. IPC: `login-save-key`, `validate-api-key`, `get-login-status`.

### 88. “Logout”: remove key from Keychain, clear session

- **Implemented:** When logged in (key stored), Settings shows **Logged in (key stored)** and a **Logout** button. **Logout** removes the stored encrypted key and clears the session. IPC `logout-remove-key`.

### 89. OAuth/device flow: if supported by backend, add in-app browser

- **Placeholder:** Settings shows the hint: “OAuth/device flow: can be added when the backend supports it (in-app browser).” In-app browser / device flow will be implemented when the backend exposes an OAuth or device-code endpoint.

### 90. No plaintext keys in config when using Keychain

- **Implemented:** When the user saves an API key via the app’s Login flow, the key is only stored encrypted in prefs. It is never written to `~/.skate/env` or any config file. The CLI receives the key only via the environment when the desktop app spawns it.

### 91. Secure transport only (HTTPS, no mixed content)

- **Implemented:** The main window’s session uses `webRequest.onBeforeRequest` to block non-HTTPS navigation. Requests to `http://*/*` are cancelled except for `localhost` and `127.0.0.1` (for local dev or future in-app tools). This avoids mixed content and ensures any future web views or links use HTTPS.

### 92. Permissions: explain sandbox and “Full Disk” if needed

- **Implemented:** In Settings → Debug, a short note explains that the app does not use macOS App Sandbox or Full Disk Access and only accesses its own data, the chosen workspace, and `~/.skate`. Full details are in this section.
- **Sandbox:** The app is **not** currently built with the macOS App Sandbox entitlement. So it has the same file and network access as a normal app (user’s home, chosen workspace, outbound network). If you enable App Sandbox later for distribution, you will need:
  - **File access:** “User Selected File” (or Security-Scoped Bookmark) for the workspace chosen via the folder picker or drag-drop.
  - **Network:** “Outgoing network (client)” so the CLI and APIs can reach the internet.
- **Full Disk:** The desktop app does **not** request Full Disk Access. It only reads/writes: (1) its own prefs and data under `app.getPath('userData')`, (2) the user-selected workspace directory, and (3) `~/.skate` (config, tasks). If a user runs the **CLI** in a terminal and that CLI needs access to other directories, that is outside the desktop app; the desktop app does not prompt for Full Disk.
- **Doc:** See §17 and §18 in this doc for sandbox and network. When enabling sandbox, add the required entitlements and document any permission prompts (e.g. “Skate would like to access the folder you selected”) in install or help.

---

## Build, release, docs (93–100)

### 93. Build script: produce .app (and optionally .dmg)

- **Implemented:** In `desktop/`, run:
  - `npm run dist` — build for current platform (macOS: .app + .dmg + .zip; Windows: NSIS; Linux: AppImage).
  - `npm run dist:mac` — macOS only.
  - `npm run dist:mac:universal` — universal binary (x64 + arm64 in one .app).
- **Output:** `desktop/out/` — e.g. `Skate-0.2.0-arm64.dmg`, `Skate-0.2.0-arm64-mac.zip`, and the unpacked .app. See §2 for architectures.

### 94. CI: build on macOS runner, sign and notarize

- **Implemented:** A GitHub Actions workflow (`.github/workflows/desktop-build.yml`) builds the desktop app on a macOS runner and produces unsigned artifacts. To **sign and notarize** in CI, set secrets: `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `CSC_LINK` (base64 .p12), `CSC_KEY_PASSWORD`, and optionally `CSC_NAME`. The workflow can be extended with an `afterSign` step using `@electron/notarize` when those secrets are present. See §4 for signing and notarization details.

### 95. Versioning: align with CLI version or separate app version

- **Current:** The desktop app version is in `desktop/package.json` (`version`). It is kept in sync with the main Skate CLI version (root `package.json`) when doing a release — e.g. both `0.2.0`. The app shows its version in Settings → Debug (diagnostics) and in the feedback issue body. For a separate app version in the future, bump only `desktop/package.json` and document the compatibility matrix (e.g. “Desktop 0.3.x requires CLI ≥ 0.2.0”).

### 96. Changelog and release notes for desktop app

- **Implemented:** `desktop/CHANGELOG.md` tracks desktop-specific changes. For each release, add a section with version and date; link from GitHub Releases or the main repo CHANGELOG. Release notes can summarize: new features (e.g. deep link, login flow), fixes, and known limitations (e.g. CLI must be on PATH unless bundled).

### 97. Docs: “Desktop app” section in main README

- **Implemented:** The main repo README includes a **Desktop app** section that describes the Electron app, how to run it from source, how to build installers, install options (download, Homebrew if applicable), and links to `desktop/` and `desktop/docs/PLATFORM.md`.

### 98. Docs: install (download, Homebrew cask if applicable)

- **Implemented:** Documented in the main README Desktop app section: install from source (`cd desktop && npm install && npm start`), build .dmg/.app (`npm run dist:mac`), and optional Homebrew cask (e.g. `brew install --cask skate` when a cask is published). Until a cask exists, users can download the .dmg from GitHub Releases or build locally.

### 99. Docs: requirements (macOS version, CLI compatibility)

- **Implemented:** Documented in README and PLATFORM.md: **macOS** 12.0 (Monterey) or later; **Node.js** for building (e.g. 18+); **CLI** — the desktop app invokes the `gtd` / `skate` CLI; compatible with the same major version (e.g. desktop 0.2.x with CLI 0.2.x). The app uses `GTD_CLI_PATH` or the bundled path when the CLI is shipped inside the app.

### 100. Feedback: “Report issue” / “Send feedback” link with env summary

- **Implemented:** In Settings → Debug, a **Report issue** button opens the default browser to a new GitHub issue with a pre-filled body: “Desktop app feedback”, environment summary (version, platform, arch, release, cwd) in a code block, and a description section. The URL is configurable via `FEEDBACK_ISSUES_BASE` in `main.js`. IPC: `open-feedback-url`.
