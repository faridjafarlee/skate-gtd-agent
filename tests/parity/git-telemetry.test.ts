import { describe, it, expect } from "vitest";
import {
  createWorktree,
  createBranch,
  getCurrentBranch,
  getDiffStats,
  isGitRepo,
} from "../../src/git/workflows.js";
import { appendAuditEvent, getAuditLog } from "../../src/audit/events.js";
import { recordMetric, getMetrics } from "../../src/telemetry/metrics.js";

describe("Git workflows and telemetry parity", () => {
  describe("Git workflows", () => {
    it("detects git repo", () => {
      // This repo is a git repo
      const cwd = process.cwd();
      expect(isGitRepo(cwd)).toBe(true);
    });

    it("gets current branch", () => {
      const branch = getCurrentBranch(process.cwd());
      expect(typeof branch).toBe("string");
      expect(branch!.length).toBeGreaterThan(0);
    });

    it("gets diff stats", () => {
      const result = getDiffStats(process.cwd());
      expect(result.success).toBe(true);
      expect(typeof result.output).toBe("string");
    });
  });

  describe("Audit events", () => {
    it("appends and retrieves audit events", async () => {
      await appendAuditEvent({
        type: "action_executed",
        message: "parity test",
      });
      const events = await getAuditLog(10);
      expect(Array.isArray(events)).toBe(true);
      expect(events.some((e) => e.message === "parity test")).toBe(true);
    });
  });

  describe("Telemetry metrics", () => {
    it("records and retrieves metrics", async () => {
      await recordMetric({
        type: "step_latency",
        step: "scout",
        latencyMs: 100,
      });
      const events = await getMetrics(10);
      expect(Array.isArray(events)).toBe(true);
      expect(events.some((e) => e.type === "step_latency" && e.latencyMs === 100)).toBe(true);
    });
  });
});
