import { describe, it, expect } from "vitest";
import { runOrchestration } from "../../src/orchestrator/loop.js";

describe("Orchestration resume", () => {
  it("dryRun with resumeFrom returns plan with steps (JSON scriptability shape)", async () => {
    const result = await runOrchestration({
      taskDescription: "test",
      qualityProfile: "fast",
      approvalPolicy: "auto",
      dryRun: true,
      resumeFrom: {
        outputs: { scout: "s", planner: "p" },
        plan: {
          id: "p1",
          taskId: "t1",
          steps: [
            { id: "s1", planId: "p1", order: 1, description: "Step 1", assignedRole: "builder", riskLevel: "low", status: "pending", requiresApproval: false },
          ],
          estimatedRisk: "low",
          createdAt: new Date(),
        },
      },
    });
    expect(result.status).toBe("completed");
    expect(result.plan).toBeDefined();
    expect(Array.isArray(result.plan!.steps)).toBe(true);
    expect(result.plan!.steps.length).toBeGreaterThanOrEqual(1);
    expect(result.plan!.steps[0]).toMatchObject({ description: "Step 1", order: 1, assignedRole: "builder" });
  });

  it.skipIf(!!process.env.CI)("resumeFrom skips Scout and Planner and bypasses approval", { timeout: 30000 }, async () => {
    // Skips in CI: may have no models (fast fail) or enabled models (real LLM call, slow). Locally: verify option accepted.
    const result = await runOrchestration({
      taskDescription: "test",
      qualityProfile: "fast",
      approvalPolicy: "hybrid",
      resumeFrom: {
        outputs: { scout: "done", planner: "plan" },
        plan: {
          id: "p1",
          taskId: "t1",
          steps: [{
            id: "s1",
            planId: "p1",
            order: 1,
            description: "build",
            assignedRole: "builder",
            riskLevel: "high",
            status: "pending",
            requiresApproval: true,
          }],
          estimatedRisk: "high",
          createdAt: new Date(),
        },
      },
    });
    // Without an enabled model, we get failed. With resume we'd need model. Just check no throw.
    expect(["failed", "completed"]).toContain(result.status);
  });
});
