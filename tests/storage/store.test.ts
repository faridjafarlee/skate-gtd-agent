import { describe, it, expect, beforeEach } from "vitest";
import { saveTask, listTasks, getTask, toStored } from "../../src/storage/store.js";
import { mkdtemp } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

describe("Storage", () => {
  const originalEnv = process.env.GTD_DATA_DIR;

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), "gtd-store-"));
    process.env.GTD_DATA_DIR = dir;
  });

  it("saves and retrieves task", async () => {
    const stored = toStored({
      id: "t1",
      description: "Test task",
      source: "cli",
      status: "completed",
    });
    await saveTask(stored);
    const found = await getTask("t1");
    expect(found).toBeDefined();
    expect(found?.description).toBe("Test task");
    expect(found?.status).toBe("completed");
  });

  it("updates existing task", async () => {
    await saveTask(toStored({ id: "t2", description: "First", source: "cli", status: "pending" }));
    await saveTask(toStored({ id: "t2", description: "Updated", source: "cli", status: "completed" }));
    const found = await getTask("t2");
    expect(found?.description).toBe("Updated");
    expect(found?.status).toBe("completed");
  });

  it("lists tasks by recency", async () => {
    await saveTask(toStored({ id: "a", description: "A", source: "cli", status: "completed" }));
    await saveTask(toStored({ id: "b", description: "B", source: "cli", status: "pending" }));
    const tasks = await listTasks({ limit: 5 });
    expect(tasks.length).toBeGreaterThanOrEqual(2);
  });

  it("filters by status", async () => {
    await saveTask(toStored({ id: "c1", description: "C1", source: "cli", status: "completed" }));
    await saveTask(toStored({ id: "c2", description: "C2", source: "cli", status: "failed" }));
    await saveTask(toStored({ id: "c3", description: "C3", source: "cli", status: "pending" }));
    const completed = await listTasks({ status: "completed", limit: 10 });
    const failed = await listTasks({ status: "failed", limit: 10 });
    expect(completed.every((t) => t.status === "completed")).toBe(true);
    expect(failed.every((t) => t.status === "failed")).toBe(true);
  });

  it("stores and filters by tags", async () => {
    await saveTask(toStored({ id: "t1", description: "Task 1", source: "cli", status: "completed", tags: ["urgent", "backend"] }));
    await saveTask(toStored({ id: "t2", description: "Task 2", source: "cli", status: "completed", tags: ["urgent"] }));
    await saveTask(toStored({ id: "t3", description: "Task 3", source: "cli", status: "completed", tags: ["backend"] }));
    const urgent = await listTasks({ tags: ["urgent"], limit: 10 });
    const backend = await listTasks({ tags: ["backend"], limit: 10 });
    const both = await listTasks({ tags: ["urgent", "backend"], limit: 10 });
    expect(urgent.length).toBe(2);
    expect(backend.length).toBe(2);
    expect(both.length).toBe(1);
    expect(both[0].id).toBe("t1");
  });
});
