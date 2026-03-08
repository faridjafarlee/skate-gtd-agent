/**
 * Per-language and built-in linters (items 53–54).
 * Infers lint command from config.lintByLanguage, config.lintCmd, or built-in map by primary language.
 */

import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { join } from "path";

/** Built-in default lint commands by primary language (when no config or env is set). */
export const BUILTIN_LINTER_BY_LANG: Record<string, string> = {
  typescript: "npm run lint",
  javascript: "npm run lint",
  python: "ruff check .",
  ruby: "bundle exec rubocop",
  go: "go vet ./...",
  rust: "cargo clippy --no-deps",
  java: "./gradlew lint",
  kotlin: "./gradlew lint",
  php: "composer run lint",
  swift: "swiftlint",
  csharp: "dotnet format --verify-no-changes",
};

/** Detect primary language from cwd (package.json, requirements.txt, go.mod, etc.). */
export async function detectPrimaryLanguage(cwd: string): Promise<string | undefined> {
  if (existsSync(join(cwd, "package.json"))) {
    try {
      const pkg = JSON.parse(await readFile(join(cwd, "package.json"), "utf-8"));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies } as Record<string, string> | undefined;
      if (deps) {
        if (deps.typescript) return "typescript";
        if (deps["@types/node"]) return "typescript";
        return "javascript";
      }
      return "javascript";
    } catch {
      return "javascript";
    }
  }
  if (existsSync(join(cwd, "requirements.txt")) || existsSync(join(cwd, "pyproject.toml"))) return "python";
  if (existsSync(join(cwd, "go.mod"))) return "go";
  if (existsSync(join(cwd, "Cargo.toml"))) return "rust";
  if (existsSync(join(cwd, "Gemfile"))) return "ruby";
  if (existsSync(join(cwd, "build.gradle.kts")) || existsSync(join(cwd, "build.gradle"))) return "java";
  if (existsSync(join(cwd, "composer.json"))) return "php";
  return undefined;
}

export interface LintInferConfig {
  lintCmd?: string;
  lintByLanguage?: Partial<Record<string, string>>;
}

/**
 * Infer the lint command for the given cwd and config.
 * Order: config.lintByLanguage[primaryLang] ?? config.lintCmd ?? BUILTIN_LINTER_BY_LANG[primaryLang] ?? "npm run lint".
 */
export async function inferLintCmd(cwd: string, config: LintInferConfig): Promise<string> {
  const primary = await detectPrimaryLanguage(cwd);
  if (primary && config.lintByLanguage?.[primary]) return config.lintByLanguage[primary];
  if (config.lintCmd) return config.lintCmd;
  if (primary && BUILTIN_LINTER_BY_LANG[primary]) return BUILTIN_LINTER_BY_LANG[primary];
  return "npm run lint";
}
