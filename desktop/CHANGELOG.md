# Changelog — Skate Desktop App

Desktop-specific changes. For the CLI and API, see the [main repo CHANGELOG](../CHANGELOG.md) (if present) or [releases](https://github.com/faridjafarlee/scaling-octo-eureka/releases).

## [0.2.0] — 2025-03

### Added

- Single-window Electron app: sidebar (Tasks, History, Settings), composer, transcript view.
- Task run: stream output, cancel, completion/failure notifications, retry and approve.
- History: filter by status, pagination, open in folder, export transcript (MD/JSON).
- Workspace: folder picker, drag folder onto dock to set workspace, last-used cwd.
- Deep link: `skate://open`, `skate://task/<id>` to focus app or open a task.
- CLI integration: `open skate://open` or `open skate://task/<id>` from terminal/scripts.
- Login: save API key (encrypted in prefs), validate, logout; key exposed to CLI via env only.
- Secure transport: non-HTTPS navigation blocked (except localhost).
- Report issue: Settings → Debug → Report issue (pre-filled GitHub issue with env summary).
- Build: `npm run dist:mac` / `dist:mac:universal`; CI workflow for macOS artifacts.

### Requirements

- macOS 12.0 (Monterey) or later. Compatible with Skate CLI same major version (e.g. 0.2.x).

### Known limitations

- CLI is invoked as subprocess; use `GTD_CLI_PATH` or bundle CLI in app resources for packaged builds.
- OAuth/device flow is a placeholder until backend supports it.
