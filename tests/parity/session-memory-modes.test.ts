import { describe, it, expect, beforeEach } from "vitest";
import {
  getMemoryEntries,
  setMemoryEntry,
  getMemoryEntry,
  deleteMemoryEntry,
  loadProjectMemory,
} from "../../src/memory/store.js";
import {
  listModes,
  getMode,
  setMode,
  deleteMode,
  getActiveMode,
  setActiveMode,
} from "../../src/modes/store.js";
import type { ModeDefinition } from "../../src/modes/store.js";
import { saveTask, getTask, toStored, listTasks } from "../../src/storage/store.js";

describe("Session/Memory/Modes parity", () => {
  beforeEach(async () => {
    // Clear active mode between tests
    await setActiveMode(undefined);
  });

  describe("Session (task store for fork)", () => {
    it("task with outputs and plan is retrievable for fork", async () => {
      const id = `fork-test-${Date.now()}`;
      const stored = toStored(
        {
          id,
          description: "Fork test task",
          source: "cli",
          qualityProfile: "balanced",
          approvalPolicy: "auto",
          status: "completed",
          plan: {
            id: "p1",
            taskId: id,
            steps: [{ id: "s1", planId: "p1", order: 1, description: "Step", assignedRole: "builder", riskLevel: "low", status: "completed", requiresApproval: false }],
            estimatedRisk: "low",
            createdAt: new Date(),
          },
          createdAt: new Date(),
        },
        { outputs: { scout: "ok", planner: "plan" } }
      );
      await saveTask(stored);
      const task = await getTask(id);
      expect(task).toBeDefined();
      expect(task?.outputs).toBeDefined();
      expect(task?.plan).toBeDefined();
      expect(Object.keys(task!.outputs!).length).toBeGreaterThanOrEqual(2);
      const sessions = await listTasks({ limit: 5 });
      expect(sessions.some((t) => t.id === id)).toBe(true);
    });
  });

  describe("Memory store", () => {
    it("lists memory entries", async () => {
      const entries = await getMemoryEntries();
      expect(Array.isArray(entries)).toBe(true);
    });

    it("sets and gets memory entry", async () => {
      await setMemoryEntry("test_key", "test_value");
      const val = await getMemoryEntry("test_key");
      expect(val).toBe("test_value");
      await deleteMemoryEntry("test_key");
    });

    it("loads project MEMORY.md when present", async () => {
      const content = await loadProjectMemory(process.cwd());
      expect(typeof content).toBe("string");
    });
  });

  describe("Mode store", () => {
    it("lists modes", async () => {
      const modes = await listModes();
      expect(Array.isArray(modes)).toBe(true);
    });

    it("sets and gets mode", async () => {
      const def: ModeDefinition = {
        id: "parity-test",
        name: "Parity Test Mode",
        qualityProfile: "fast",
        approvalPolicy: "auto",
      };
      await setMode(def);
      const m = await getMode("parity-test");
      expect(m).toBeDefined();
      expect(m?.name).toBe("Parity Test Mode");
      expect(m?.qualityProfile).toBe("fast");
      await deleteMode("parity-test");
    });

    it("sets and gets active mode", async () => {
      const def: ModeDefinition = {
        id: "active-test",
        name: "Active Test",
      };
      await setMode(def);
      await setActiveMode("active-test");
      const active = await getActiveMode();
      expect(active).toBe("active-test");
      await setActiveMode(undefined);
      await deleteMode("active-test");
    });
  });
});
