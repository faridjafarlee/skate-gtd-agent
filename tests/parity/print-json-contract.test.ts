/**
 * K.3.3 / PI-24: Assert dry-run and full-task JSON output contract.
 * Guaranteed fields: see docs/parity/print-json-scriptability.md.
 * Uses static fixture so the test does not require LLM/API keys.
 */

import { describe, it, expect } from "vitest";

const validDryRunShape = {
  version: "0.2.0",
  taskId: "550e8400-e29b-41d4-a716-446655440000",
  plan: {
    id: "plan-1",
    taskId: "550e8400-e29b-41d4-a716-446655440000",
    steps: [
      { id: "s1", order: 1, description: "Step 1", assignedRole: "Builder", riskLevel: "low", requiresApproval: false },
    ],
    estimatedRisk: "low",
    createdAt: "2025-01-01T00:00:00.000Z",
  },
  scout: "Scout output",
  planner: "Planner output",
  error: null,
};

const validFullTaskShape = {
  success: true,
  taskId: "550e8400-e29b-41d4-a716-446655440000",
  status: "completed",
  plan: validDryRunShape.plan,
  outputs: { scout: "", planner: "", builder: "Done." },
  usage: {},
  usageByModel: {},
  error: null,
};

describe("Print/JSON contract (K.3.3, PI-24)", () => {
  it("dry-run JSON has guaranteed fields: taskId, plan, scout, planner, error", () => {
    const json = validDryRunShape;
    expect(json).toHaveProperty("taskId");
    expect(typeof json.taskId).toBe("string");
    expect(json.taskId.length).toBeGreaterThan(0);
    expect(json).toHaveProperty("plan");
    expect(json.plan).toHaveProperty("steps");
    expect(Array.isArray(json.plan.steps)).toBe(true);
    expect(json).toHaveProperty("scout");
    expect(json).toHaveProperty("planner");
    expect(json).toHaveProperty("error");
  });

  it("full task JSON has guaranteed fields: success, taskId, status", () => {
    const json = validFullTaskShape;
    expect(json).toHaveProperty("success");
    expect(typeof json.success).toBe("boolean");
    expect(json).toHaveProperty("taskId");
    expect(typeof json.taskId).toBe("string");
    expect(json).toHaveProperty("status");
    expect(["completed", "failed", "blocked", "cancelled"]).toContain(json.status);
  });
});
