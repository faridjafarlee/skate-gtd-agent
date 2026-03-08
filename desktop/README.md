# Skate Desktop (Electron)

Cross-platform desktop app for **Skate** (mascot: skate / manta ray; slogan: GTD). macOS, Windows, Linux. Uses the existing `skate` / `gtd` CLI from this repo.

## Prerequisites

- Node.js 18+
- Build the CLI from repo root: `npm run build`

## Run (development)

From repo root:

```bash
cd desktop
npm install
npm start
```

The app will use `../dist/cli/index.js` as the `gtd` CLI. Set `GTD_CLI_PATH` to use another path.

## Package (optional)

```bash
cd desktop
npm run dist
```

Output in `desktop/out/`. For a standalone app you’d typically bundle the CLI or document that users must install `gtd` (e.g. `npm i -g skate`) and have it on PATH.

## Features (current)

- Run a task: type description, click Run (or Enter).
- Recent tasks list (from `gtd session list`).
- Working directory follows process cwd (future: project picker).

## Platform and release (items 2–10)

See **[docs/PLATFORM.md](docs/PLATFORM.md)** for:

- **2** macOS target (12+), arch (x64, arm64, universal)
- **3** Invoke CLI (subprocess); optional bundling later
- **4** Signing and notarization plan (Apple Developer ID)
- **5** Auto-update (electron-updater; set `publish` for releases)
- **6** Single-window (current)
- **7** Dock-only (no menu bar icon)
- **8** “Open with Skate” plan (doc)
- **9** Accessibility (VoiceOver, keyboard, reduced motion)
- **10** L10n plan (en first)
