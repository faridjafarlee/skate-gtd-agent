import { describe, it, expect } from "vitest";
import { requiresApproval, classifyRisk } from "../../src/orchestrator/approval.js";
import type { Step } from "../../src/types/index.js";

function makeStep(overrides: Partial<Step>): Step {
  return {
    id: "s1",
    planId: "p1",
    order: 1,
    description: "Do something",
    assignedRole: "builder",
    riskLevel: "low",
    status: "pending",
    requiresApproval: false,
    ...overrides,
  };
}

describe("Approval Gate", () => {
  it("always policy requires approval", () => {
    expect(requiresApproval(makeStep({ riskLevel: "low" }), "always")).toBe(true);
  });

  it("auto policy never requires approval", () => {
    expect(requiresApproval(makeStep({ riskLevel: "high" }), "auto")).toBe(false);
  });

  it("hybrid requires approval for high risk", () => {
    expect(requiresApproval(makeStep({ riskLevel: "high" }), "hybrid")).toBe(true);
    expect(requiresApproval(makeStep({ riskLevel: "low" }), "hybrid")).toBe(false);
  });

  it("hybrid requires approval for risky keywords", () => {
    expect(requiresApproval(makeStep({ description: "delete all files" }), "hybrid")).toBe(true);
  });

  it("classifies risk from description", () => {
    expect(classifyRisk("delete everything")).toBe("high");
    expect(classifyRisk("write a function")).toBe("medium");
    expect(classifyRisk("read config")).toBe("low");
  });
});
