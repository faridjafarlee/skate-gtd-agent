import { describe, it, expect, beforeEach } from "vitest";
import { listTasks } from "../../src/storage/store.js";
import { parsePlannerSubtasks } from "../../src/orchestrator/loop.js";

describe("Observability and last-run parity", () => {
  it("listTasks with limit 1 returns at most one task (gtd last shape)", async () => {
    const tasks = await listTasks({ limit: 1 });
    expect(Array.isArray(tasks)).toBe(true);
    expect(tasks.length).toBeLessThanOrEqual(1);
    if (tasks.length === 1) {
      const t = tasks[0];
      expect(t).toHaveProperty("id");
      expect(t).toHaveProperty("description");
      expect(t).toHaveProperty("status");
      expect(t).toHaveProperty("createdAt");
    }
  });
});

describe("Planner structured subtasks", () => {
  it("parsePlannerSubtasks extracts steps from JSON code block", () => {
    const planId = "plan-1";
    const taskId = "task-1";
    const output = `
Some text before.
\`\`\`json
[
  { "description": "Add tests", "order": 1 },
  { "description": "Update README", "order": 2 }
]
\`\`\`
After.
`;
    const steps = parsePlannerSubtasks(output, planId, taskId);
    expect(steps).not.toBeNull();
    expect(steps!.length).toBe(2);
    expect(steps![0].description).toBe("Add tests");
    expect(steps![0].order).toBe(1);
    expect(steps![1].description).toBe("Update README");
    expect(steps![1].order).toBe(2);
    expect(steps![0].assignedRole).toBe("builder");
    expect(steps![0].planId).toBe(planId);
    expect(steps![0].status).toBe("pending");
  });

  it("parsePlannerSubtasks extracts from steps key", () => {
    const output = `Plan: {"steps": [{"description": "Implement feature X"}, {"description": "Write docs"}]}`;
    const steps = parsePlannerSubtasks(output, "p1", "t1");
    expect(steps).not.toBeNull();
    expect(steps!.length).toBe(2);
    expect(steps![0].description).toBe("Implement feature X");
    expect(steps![1].description).toBe("Write docs");
  });

  it("parsePlannerSubtasks returns null for empty or invalid input", () => {
    expect(parsePlannerSubtasks("", "p", "t")).toBeNull();
    expect(parsePlannerSubtasks("no json here", "p", "t")).toBeNull();
    expect(parsePlannerSubtasks("```json\n[]\n```", "p", "t")).toBeNull();
  });
});
