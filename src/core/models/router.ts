import type { RoutingPolicy } from "./types.js";
import { listModels } from "./registry.js";

export interface TaskContext {
  complexity?: "low" | "medium" | "high";
  requiresTools?: boolean;
  requiresVision?: boolean;
  maxCost?: number;
  preferLocal?: boolean;
}

export interface RoutingResult {
  modelId: string;
  reason: string;
}

/**
 * Selects the best model for a task based on policy and context.
 * Balanced: weighs quality, cost, and latency.
 */
export function routeForTask(
  policy: RoutingPolicy,
  context: TaskContext
): RoutingResult | null {
  const models = listModels().filter((c) => c.enabled);
  if (models.length === 0) {
    return null;
  }

  let scored = models.map((c) => ({
    config: c,
    score: scoreModel(c, policy, context),
  }));

  scored = scored.filter((s) => s.score >= 0);
  scored.sort((a, b) => b.score - a.score);

  const top = scored[0];
  if (!top) return null;

  return {
    modelId: top.config.metadata.id,
    reason: policy === "balanced"
      ? "Balanced quality/cost/latency"
      : `Policy: ${policy}`,
  };
}

/**
 * Returns ordered list of models for fallback (primary first).
 */
export function getModelsForTask(policy: RoutingPolicy, context: TaskContext): string[] {
  const models = listModels().filter((c) => c.enabled);
  if (models.length === 0) return [];

  let scored = models.map((c) => ({
    config: c,
    score: scoreModel(c, policy, context),
  }));
  scored = scored.filter((s) => s.score >= 0);
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.config.metadata.id);
}

function scoreModel(
  config: { metadata: import("./types.js").ModelMetadata },
  policy: RoutingPolicy,
  context: TaskContext
): number {
  const m = config.metadata;
  let score = 100;

  if (context.requiresTools && !m.supportsTools) return -1;
  if (context.requiresVision && !m.supportsVision) return -1;
  if (context.preferLocal && m.privacyLevel !== "local") score -= 30;

  switch (policy) {
    case "quality":
      score += (m.reliabilityScore ?? 0.8) * 20;
      score += m.contextWindow / 10000;
      break;
    case "cost": {
      const cost = (m.costPer1kInput ?? 0) + (m.costPer1kOutput ?? 0);
      score -= cost * 1000;
      break;
    }
    case "latency":
      score += m.latencyClass === "fast" ? 30 : m.latencyClass === "medium" ? 15 : 0;
      break;
    case "balanced":
      score += (m.reliabilityScore ?? 0.8) * 10;
      score -= ((m.costPer1kInput ?? 0) + (m.costPer1kOutput ?? 0)) * 500;
      score += m.latencyClass === "fast" ? 15 : m.latencyClass === "medium" ? 8 : 0;
      break;
  }

  return score;
}
