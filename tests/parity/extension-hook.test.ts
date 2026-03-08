import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, readFile, mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { runExtensionHook } from "../../src/cli/task-handler.js";
import { setTraceId } from "../../src/audit/events.js";

describe("Extension hook (GTD_EXTENSION_SCRIPT)", () => {
  let tmpDir: string;
  let phaseFile: string;
  let scriptPath: string;
  const originalEnv = process.env.GTD_EXTENSION_SCRIPT;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "gtd-ext-hook-"));
    phaseFile = join(tmpDir, "phases.txt");
    scriptPath = join(tmpDir, "record-phase.js");
    await writeFile(
      scriptPath,
      `require('fs').appendFileSync(process.env.GTD_PHASE_FILE || '', (process.env.TASK_PHASE || '') + '\\n');`,
      "utf-8"
    );
    process.env.GTD_EXTENSION_SCRIPT = `node "${scriptPath}"`;
  });

  afterEach(async () => {
    process.env.GTD_EXTENSION_SCRIPT = originalEnv;
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("invokes script with start, pre_plan, and end phases", async () => {
    await runExtensionHook("start", {
      TASK_PHASE: "start",
      TASK_ID: "tid",
      TASK_DESCRIPTION: "desc",
      GTD_PHASE_FILE: phaseFile,
    });
    await runExtensionHook("pre_plan", {
      TASK_PHASE: "pre_plan",
      TASK_ID: "tid",
      TASK_DESCRIPTION: "desc",
      GTD_PHASE_FILE: phaseFile,
    });
    await runExtensionHook("end", {
      TASK_PHASE: "end",
      TASK_ID: "tid",
      TASK_STATUS: "completed",
      TASK_ERROR: "",
      GTD_PHASE_FILE: phaseFile,
    });
    const content = await readFile(phaseFile, "utf-8");
    expect(content.trim().split("\n")).toEqual(["start", "pre_plan", "end"]);
  });

  it("invokes script with post_step phase (ROLE in env)", async () => {
    await runExtensionHook("post_step", {
      TASK_PHASE: "post_step",
      ROLE: "Scout",
      TASK_ID: "tid",
      TASK_DESCRIPTION: "desc",
      GTD_PHASE_FILE: phaseFile,
    });
    const content = await readFile(phaseFile, "utf-8");
    expect(content.trim()).toBe("post_step");
  });

  it("invokes script with pre_step phase (ROLE in env)", async () => {
    await runExtensionHook("pre_step", {
      TASK_PHASE: "pre_step",
      ROLE: "Builder",
      TASK_ID: "tid",
      TASK_DESCRIPTION: "desc",
      GTD_PHASE_FILE: phaseFile,
    });
    const content = await readFile(phaseFile, "utf-8");
    expect(content.trim()).toBe("pre_step");
  });

  it("does nothing when GTD_EXTENSION_SCRIPT is unset", async () => {
    delete process.env.GTD_EXTENSION_SCRIPT;
    await runExtensionHook("start", {
      TASK_PHASE: "start",
      TASK_ID: "t",
      TASK_DESCRIPTION: "d",
      GTD_PHASE_FILE: phaseFile,
    });
    const content = await readFile(phaseFile, "utf-8").catch(() => "");
    expect(content).toBe("");
  });

  it("passes TASK_PHASE, TASK_ID, ROLE, TRACE_ID in env for extension contract", async () => {
    const envFile = join(tmpDir, "env.json");
    await writeFile(
      join(tmpDir, "record-env.js"),
      `require('fs').writeFileSync(process.env.GTD_ENV_FILE || '', JSON.stringify({
        TASK_PHASE: process.env.TASK_PHASE,
        TASK_ID: process.env.TASK_ID,
        ROLE: process.env.ROLE,
        TRACE_ID: process.env.TRACE_ID,
      }));`,
      "utf-8"
    );
    process.env.GTD_EXTENSION_SCRIPT = `node "${join(tmpDir, "record-env.js")}"`;
    setTraceId("trace-456");
    await runExtensionHook("pre_step", {
      TASK_PHASE: "pre_step",
      ROLE: "Builder",
      TASK_ID: "task-123",
      TASK_DESCRIPTION: "desc",
      TRACE_ID: "trace-456",
      GTD_ENV_FILE: envFile,
    });
    const env = JSON.parse(await readFile(envFile, "utf-8"));
    expect(env.TASK_PHASE).toBe("pre_step");
    expect(env.TASK_ID).toBe("task-123");
    expect(env.ROLE).toBe("Builder");
    expect(env.TRACE_ID).toBe("trace-456");
  });
});
