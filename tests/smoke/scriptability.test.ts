/**
 * Scriptability: assert dry-run JSON output is parseable and has required fields.
 * Runs only when API keys or GTD_RUN_E2E=1 (dry-run still calls Scout/Planner).
 * Use in CI to validate pipeline contract (see docs/parity/print-json-scriptability.md).
 */
import { describe, it, expect } from "vitest";
import { execSync } from "child_process";
import { join } from "path";

const hasE2EEnv =
  process.env.GTD_RUN_E2E === "1" ||
  (typeof process.env.OPENAI_API_KEY === "string" && process.env.OPENAI_API_KEY.length > 0) ||
  (typeof process.env.ANTHROPIC_API_KEY === "string" && process.env.ANTHROPIC_API_KEY.length > 0);

const projectRoot = join(__dirname, "../..");
const cliPath = join(projectRoot, "dist/cli/index.js");

function runCli(args: string[], timeoutMs = 90_000): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execSync(`node "${cliPath}" ${args.map((a) => `"${a}"`).join(" ")}`, {
      encoding: "utf-8",
      env: process.env,
      timeout: timeoutMs,
    });
    return { code: 0, stdout, stderr: "" };
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: Buffer; stderr?: Buffer };
    return {
      code: err.status ?? 1,
      stdout: (err.stdout ?? "")?.toString?.() ?? "",
      stderr: (err.stderr ?? "")?.toString?.() ?? "",
    };
  }
}

describe("Scriptability (dry-run JSON)", () => {
  it(
    "gtd task noop --dry-run --format json outputs valid JSON with taskId and plan shape",
    async () => {
      const r = runCli(["task", "noop", "--dry-run", "--format", "json"]);
      expect(r.code).toBe(0);
      const lastLine = r.stdout.trim().split("\n").filter(Boolean).pop();
      expect(lastLine).toBeDefined();
      const data = JSON.parse(lastLine!);
      expect(data).toHaveProperty("taskId");
      expect(typeof data.taskId).toBe("string");
      expect(data.plan === null || typeof data.plan === "object").toBe(true);
      if (data.plan && data.plan.steps) {
        for (const step of data.plan.steps) {
          expect(step).toHaveProperty("description");
          expect(step).toHaveProperty("assignedRole");
          expect(["riskLevel", "requiresApproval"].some((k) => k in step)).toBe(true);
        }
      }
    },
    95_000
  );
}, hasE2EEnv ? {} : { skip: true });
