import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { runBeforeTaskHooks, runAfterTaskHooks } from "../../src/plugins/hooks-runner.js";

describe("Plugin hooks parity (beforeTask / afterTask)", () => {
  const originalDir = process.env.GTD_PLUGINS_DIR;

  afterEach(() => {
    if (originalDir !== undefined) process.env.GTD_PLUGINS_DIR = originalDir;
    else delete process.env.GTD_PLUGINS_DIR;
  });

  it("runBeforeTaskHooks does not throw when no plugins", async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), "gtd-plugins-empty-"));
    try {
      process.env.GTD_PLUGINS_DIR = emptyDir;
      await expect(runBeforeTaskHooks({ TASK_ID: "t1", TASK_DESCRIPTION: "desc" })).resolves.toBeUndefined();
    } finally {
      await rm(emptyDir, { recursive: true, force: true });
    }
  });

  it("runAfterTaskHooks does not throw when no plugins", async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), "gtd-plugins-empty-"));
    try {
      process.env.GTD_PLUGINS_DIR = emptyDir;
      await expect(
        runAfterTaskHooks({
          TASK_ID: "t1",
          TASK_DESCRIPTION: "desc",
          TASK_STATUS: "completed",
        })
      ).resolves.toBeUndefined();
    } finally {
      await rm(emptyDir, { recursive: true, force: true });
    }
  });

  it("runBeforeTaskHooks invokes plugin with beforeTask script when present", async () => {
    const parentDir = await mkdtemp(join(tmpdir(), "gtd-plugins-parent-"));
    const pluginDir = join(parentDir, "gtd-test-hook");
    await mkdir(pluginDir, { recursive: true });
    const recordFile = join(pluginDir, "record.txt");
    await writeFile(
      join(pluginDir, "before.js"),
      `require('fs').appendFileSync(process.env.GTD_RECORD_FILE || '', 'beforeTask:' + (process.env.TASK_ID || '') + '\\n');`,
      "utf-8"
    );
    await writeFile(
      join(pluginDir, "package.json"),
      JSON.stringify({
        name: "gtd-test-hook",
        version: "1.0.0",
        gtdMantis: {
          id: "gtd-test-hook",
          name: "Test Hook",
          version: "1.0.0",
          hooks: { beforeTask: "before.js" },
        },
      }),
      "utf-8"
    );
    try {
      process.env.GTD_PLUGINS_DIR = parentDir;
      process.env.GTD_RECORD_FILE = recordFile;
      await runBeforeTaskHooks({ TASK_ID: "task-123", TASK_DESCRIPTION: "test" });
      const { readFile } = await import("fs/promises");
      const content = await readFile(recordFile, "utf-8").catch(() => "");
      expect(content).toContain("beforeTask:task-123");
    } finally {
      delete process.env.GTD_RECORD_FILE;
      await rm(parentDir, { recursive: true, force: true });
    }
  }, 10000);
});
