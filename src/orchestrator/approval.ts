import type { RiskLevel, Step } from "../types/index.js";

const HIGH_RISK_ACTIONS = [
  "delete",
  "rm ",
  "drop table",
  "transfer",
  "payment",
  "send money",
  "execute",
  "eval(",
];

/**
 * Determines if a step requires user approval based on risk and policy.
 */
export function requiresApproval(
  step: Step,
  policy: "auto" | "hybrid" | "always"
): boolean {
  if (policy === "always") return true;
  if (policy === "auto") return false;

  // Hybrid: require approval for high/critical risk
  if (step.riskLevel === "high" || step.riskLevel === "critical") return true;
  if (step.requiresApproval) return true;

  // Check description for risky keywords
  const lower = step.description.toLowerCase();
  if (HIGH_RISK_ACTIONS.some((kw) => lower.includes(kw))) return true;

  return false;
}

/**
 * Classifies risk level from step description (heuristic).
 */
export function classifyRisk(description: string): RiskLevel {
  const lower = description.toLowerCase();
  if (HIGH_RISK_ACTIONS.some((kw) => lower.includes(kw))) return "high";
  if (lower.includes("write") || lower.includes("modify") || lower.includes("create")) return "medium";
  return "low";
}
