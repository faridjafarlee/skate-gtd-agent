/**
 * Metrics and usage telemetry.
 * Per-step latency, tool usage, model fallback paths, cost/token attribution.
 */

import { readFile, appendFile, mkdir } from "fs/promises";
import { join } from "path";
import { homedir } from "os";

function getDataDir(): string {
  return process.env.GTD_DATA_DIR ?? join(homedir(), ".skate");
}

function getMetricsPath(): string {
  return join(getDataDir(), "metrics.jsonl");
}

export interface MetricEvent {
  type: "step_latency" | "tool_usage" | "model_fallback" | "token_usage" | "cost";
  taskId?: string;
  step?: string;
  role?: string;
  /** Latency in ms */
  latencyMs?: number;
  /** Tool name */
  tool?: string;
  /** Model ID */
  modelId?: string;
  /** Fallback chain */
  fallbackChain?: string[];
  /** Token counts */
  promptTokens?: number;
  completionTokens?: number;
  /** Cost estimate (USD) */
  costUsd?: number;
  /** Extra metadata */
  meta?: Record<string, unknown>;
  timestamp: string;
}

export async function recordMetric(event: Omit<MetricEvent, "timestamp">): Promise<void> {
  const full: MetricEvent = {
    ...event,
    timestamp: new Date().toISOString(),
  };
  await mkdir(getDataDir(), { recursive: true });
  await appendFile(getMetricsPath(), JSON.stringify(full) + "\n", "utf-8");
}

export async function getMetrics(limit = 500): Promise<MetricEvent[]> {
  try {
    const raw = await readFile(getMetricsPath(), "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);
    const events = lines
      .map((line) => {
        try {
          return JSON.parse(line) as MetricEvent;
        } catch {
          return null;
        }
      })
      .filter((e): e is MetricEvent => e !== null);
    return events.reverse().slice(0, limit);
  } catch {
    return [];
  }
}

/** Get metric events for a specific task (for replay). */
export async function getMetricsByTaskId(taskId: string, limit = 500): Promise<MetricEvent[]> {
  try {
    const raw = await readFile(getMetricsPath(), "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);
    const events = lines
      .map((line) => {
        try {
          return JSON.parse(line) as MetricEvent;
        } catch {
          return null;
        }
      })
      .filter((e): e is MetricEvent => e !== null && e.taskId === taskId);
    return events.reverse().slice(0, limit);
  } catch {
    return [];
  }
}
