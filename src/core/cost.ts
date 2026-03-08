/**
 * Approximate cost per 1M tokens for usage estimation.
 * Input/output prices in USD. Update as provider pricing changes.
 */

/** input $/1M, output $/1M */
const PRICE_PER_1M: Record<string, { in: number; out: number }> = {
  "gpt-4o": { in: 2.5, out: 10 },
  "gpt-4o-mini": { in: 0.15, out: 0.6 },
  "gpt-4-turbo": { in: 10, out: 30 },
  "gpt-3.5-turbo": { in: 0.5, out: 1.5 },
  "claude-sonnet-4": { in: 3, out: 15 },
  "claude-sonnet-4-6": { in: 3, out: 15 },
  "claude-opus-4": { in: 5, out: 25 },
  "claude-opus-4-6": { in: 5, out: 25 },
  "claude-3-5-sonnet": { in: 3, out: 15 },
  "claude-3-haiku": { in: 0.25, out: 1.25 },
  "gemini-1.5-pro": { in: 1.25, out: 5 },
  "gemini-1.5-flash": { in: 0.075, out: 0.3 },
  "gemini-2.0-flash": { in: 0.1, out: 0.4 },
};

function getPrice(modelId: string): { in: number; out: number } | undefined {
  if (PRICE_PER_1M[modelId]) return PRICE_PER_1M[modelId];
  if (modelId.startsWith("gpt-4o-mini")) return PRICE_PER_1M["gpt-4o-mini"];
  if (modelId.startsWith("gpt-4o")) return PRICE_PER_1M["gpt-4o"];
  if (modelId.startsWith("claude-sonnet")) return PRICE_PER_1M["claude-sonnet-4"];
  if (modelId.startsWith("claude-opus")) return PRICE_PER_1M["claude-opus-4"];
  if (modelId.startsWith("claude-3-5-sonnet")) return PRICE_PER_1M["claude-3-5-sonnet"];
  if (modelId.startsWith("claude-3-haiku")) return PRICE_PER_1M["claude-3-haiku"];
  if (modelId.startsWith("gemini-1.5-pro")) return PRICE_PER_1M["gemini-1.5-pro"];
  if (modelId.startsWith("gemini-1.5-flash")) return PRICE_PER_1M["gemini-1.5-flash"];
  if (modelId.startsWith("gemini-2.0-flash")) return PRICE_PER_1M["gemini-2.0-flash"];
  return undefined;
}

/**
 * Estimate cost in USD for given token counts. Returns undefined if model has no price.
 */
export function estimateCost(
  modelId: string,
  promptTokens: number,
  completionTokens: number
): number | undefined {
  const price = getPrice(modelId);
  if (!price) return undefined;
  const inCost = (promptTokens / 1_000_000) * price.in;
  const outCost = (completionTokens / 1_000_000) * price.out;
  return inCost + outCost;
}

/**
 * Format estimated cost for display (e.g. "$0.12" or "" when unknown).
 */
export function formatEstimatedCost(
  modelId: string,
  promptTokens: number,
  completionTokens: number
): string {
  const cost = estimateCost(modelId, promptTokens, completionTokens);
  if (cost === undefined) return "";
  return ` ~ $${cost.toFixed(2)}`;
}
/** Token usage shape for task-level cost. */
export interface TaskUsageLike {
  usage?: { promptTokens: number; completionTokens: number };
  usageByModel?: Record<string, { promptTokens: number; completionTokens: number }>;
}
/** Estimate total cost in USD for a task from its usage/usageByModel. */
export function estimateTaskCost(task: TaskUsageLike): number | undefined {
  let total: number | undefined;
  if (task.usageByModel && Object.keys(task.usageByModel).length > 0) {
    total = 0;
    for (const [modelId, u] of Object.entries(task.usageByModel)) {
      const c = estimateCost(modelId, u.promptTokens, u.completionTokens);
      if (c !== undefined) total += c;
    }
  } else if (task.usage) {
    total = estimateCost("unknown", task.usage.promptTokens, task.usage.completionTokens);
  }
  return total;
}
