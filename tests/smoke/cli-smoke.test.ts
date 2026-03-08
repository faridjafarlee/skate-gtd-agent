/**
 * Smoke tests: CLI responds to --version and --help.
 * Run after build. Optional E2E (gtd task "echo ok" --auto) skipped when no API keys in CI.
 */

import { describe, it, expect } from "vitest";
import { execSync } from "child_process";
import { join } from "path";

const projectRoot = join(__dirname, "../..");
const cliPath = join(projectRoot, "dist/cli/index.js");

function runCli(
  args: string[],
  env: Record<string, string> = {},
  timeoutMs = 15_000
): { stdout: string; stderr: string; code: number } {
  try {
    const out = execSync(`node "${cliPath}" ${args.map((a) => `"${a}"`).join(" ")}`, {
      encoding: "utf-8",
      env: { ...process.env, ...env },
      timeout: timeoutMs,
    });
    return { stdout: out, stderr: "", code: 0 };
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: Buffer; stderr?: Buffer };
    return {
      stdout: (err.stdout ?? "")?.toString?.() ?? "",
      stderr: (err.stderr ?? "")?.toString?.() ?? "",
      code: err.status ?? 1,
    };
  }
}

describe("CLI smoke", () => {
  it("gtd --version exits 0 and prints version", () => {
    const r = runCli(["--version"]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("gtd task --help exits 0 and shows permission-mode", () => {
    const r = runCli(["task", "--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("permission-mode");
    expect(r.stdout).toMatch(/dont-ask|accept-edits/);
  });

  it("gtd tools run --help shows permission example", () => {
    const r = runCli(["tools", "run", "--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("dont-ask");
  });

  it("gtd run-step --help exits 0 and shows run-step usage (dev plan 35)", () => {
    const r = runCli(["run-step", "--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("run-step");
    expect(r.stdout).toMatch(/taskId|stepIndex/);
  });
});

const hasE2EEnv =
  process.env.GTD_RUN_E2E === "1" ||
  (typeof process.env.OPENAI_API_KEY === "string" && process.env.OPENAI_API_KEY.length > 0) ||
  (typeof process.env.ANTHROPIC_API_KEY === "string" && process.env.ANTHROPIC_API_KEY.length > 0);

describe("E2E real task (CI-conditional, J.5.2)", () => {
  it(
    "gtd task \"echo ok\" --auto --format json exits 0 and outputs valid JSON with success and taskId when API keys present",
    async () => {
      const r = runCli(["task", "echo ok", "--auto", "--format", "json"], {}, 120_000);
      expect(r.code).toBe(0);
      const lastLine = r.stdout.trim().split("\n").filter(Boolean).pop();
      expect(lastLine).toBeDefined();
      const out = JSON.parse(lastLine!);
      expect(out).toHaveProperty("success");
      expect(out).toHaveProperty("taskId");
      expect(typeof out.taskId).toBe("string");
      expect(out.taskId.length).toBeGreaterThan(0);
      if (out.success) expect(out.status).toBe("completed");
    },
    hasE2EEnv ? 125_000 : undefined
  );

  it(
    "gtd task \"echo ok\" --auto --quiet exits 0 when API keys present (minimal E2E)",
    async () => {
      const r = runCli(["task", "echo ok", "--auto", "--quiet"], {}, 120_000);
      expect(r.code).toBe(0);
    },
    hasE2EEnv ? 125_000 : undefined
  );
}, hasE2EEnv ? {} : { skip: true });
