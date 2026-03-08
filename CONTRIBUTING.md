# Contributing to Skate

Thanks for your interest in contributing.

## Development Setup

```bash
git clone https://github.com/faridjafarlee/scaling-octo-eureka.git
cd scaling-octo-eureka
npm install
npm run build
```

## Node and supply chain

- **Supported Node:** See `engines` in `package.json` (currently ≥18). We align with Node LTS; the minimum is raised when we drop support for an older LTS.
- **CI:** `npm audit --audit-level=high` runs in CI and fails on high/critical vulnerabilities (A.12).
- **Known transitive findings:** Some optional connectors (e.g. `matrix-bot-sdk`, `discord.js`) pull in deps with advisories and no non-breaking fix. We do not run `npm audit fix --force` to avoid breaking changes; update those packages when upstream fixes are available.

## Scripts

- `npm run build` — Compile TypeScript
- `npm run dev start` — Run with tsx (no build step)
- `npm run test` — Run tests
- `npm run test:watch` — Run tests in watch mode
- `npm run test:coverage` — Run tests with coverage report

**Before submitting:** Run `npm run build`, `npm run lint`, and `npm test`. After building, run **smoke tests** to verify the CLI: `npm test -- --run tests/smoke/cli-smoke.test.ts` (or `npm run ci` for build + lint + test). Run **`gtd doctor`** to verify config and security-related env (sandbox, secrets check). Optionally run **E2E** when API keys are set: `GTD_RUN_E2E=1 npm test -- --run tests/smoke/` (or set `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`; E2E is skipped when keys are missing). In CI, the **e2e** job runs on manual trigger (Actions → CI → Run workflow); set `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` in repo secrets to run E2E and scriptability tests there. To validate plugin manifests in CI, run **`gtd plugins validate`** (or `gtd plugins validate <dir>`). **Next steps / roadmap:** [improvement.txt](improvement.txt).

Pre-commit hooks (Husky + lint-staged) run lint and tests automatically. Use `git commit --no-verify` to skip.
- `npm run lint` — Run ESLint
- `npm run ci` — Build, lint, and test

## Adding Features

1. Create a branch from `main`
2. Add tests for new behavior
3. Run `npm run ci` before pushing
4. Open a pull request

## Releasing

1. Update **CHANGELOG.md**: add entries under [Unreleased] with **Added** / **Changed** / **Fixed** per release; link phase or task IDs where relevant. Keep changelog discipline (one section per release, no mixed “misc” dumps).
2. Commit, then `git tag v0.1.0 && git push origin v0.1.0`
3. With `NPM_TOKEN` in GitHub secrets, the release workflow publishes to npm

## Code Style

- TypeScript with strict mode
- ESLint for linting
- Prefer async/await over raw promises
