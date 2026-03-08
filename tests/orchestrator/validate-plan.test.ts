import { describe, it, expect } from "vitest";
import { validatePlanSteps } from "../../src/orchestrator/loop.js";
import type { Plan, Step } from "../../src/types/index.js";

function validStep(overrides: Partial<Step> = {}): Step {
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

function validPlan(steps: Step[]): Plan {
  return {
    id: "p1",
    taskId: "t1",
    steps,
    estimatedRisk: "low",
    createdAt: new Date(),
  };
}

describe("validatePlanSteps", () => {
  it("accepts a valid plan with one step", () => {
    const plan = validPlan([validStep()]);
    expect(() => validatePlanSteps(plan)).not.toThrow();
  });

  it("accepts a valid plan with multiple steps", () => {
    const plan = validPlan([
      validStep({ id: "s1", order: 1 }),
      validStep({ id: "s2", order: 2 }),
    ]);
    expect(() => validatePlanSteps(plan)).not.toThrow();
  });

  it("throws when plan has no steps array", () => {
    const plan = validPlan([validStep()]) as Plan & { steps: unknown };
    plan.steps = null;
    expect(() => validatePlanSteps(plan)).toThrow("Plan has no steps array");
  });

  it("throws when a step is missing id", () => {
    const step = validStep();
    (step as { id: string }).id = "";
    const plan = validPlan([step]);
    expect(() => validatePlanSteps(plan)).toThrow(/Plan step 1: missing or invalid id/);
  });

  it("throws when a step has invalid assignedRole", () => {
    const plan = validPlan([validStep({ assignedRole: "invalid" as "builder" })]);
    expect(() => validatePlanSteps(plan)).toThrow(/assignedRole must be one of/);
  });

  it("throws when plan has more steps than GTD_MAX_PLAN_STEPS", () => {
    const prev = process.env.GTD_MAX_PLAN_STEPS;
    process.env.GTD_MAX_PLAN_STEPS = "2";
    try {
      const plan = validPlan([
        validStep({ id: "s1", order: 1 }),
        validStep({ id: "s2", order: 2 }),
        validStep({ id: "s3", order: 3 }),
      ]);
      expect(() => validatePlanSteps(plan)).toThrow(/Plan has 3 steps; maximum allowed is 2/);
    } finally {
      if (prev !== undefined) process.env.GTD_MAX_PLAN_STEPS = prev;
      else delete process.env.GTD_MAX_PLAN_STEPS;
    }
  });
});
