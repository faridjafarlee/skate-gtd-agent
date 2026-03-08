/**
 * Persistent audit event log with trace IDs.
 * Replaces in-memory audit for governance and compliance.
 */

import { readFile, appendFile, mkdir } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { v4 as uuidv4 } from "uuid";

function getDataDir(): string {
  return process.env.GTD_DATA_DIR ?? join(homedir(), ".skate");
}

function getAuditPath(): string {
  return join(getDataDir(), "audit.jsonl");
}

export type AuditEventType =
  | "approval_request"
  | "approval_granted"
  | "approval_denied"
  | "action_executed"
  | "allow_list_extended"
  | "task_completed"
  | "task_started"
  | "task_failed"
  | "tool_invoked"
  | "tool_denied"
  | "model_used"
  | "memory_write";

export interface AuditEvent {
  id: string;
  traceId?: string;
  type: AuditEventType;
  taskId?: string;
  stepId?: string;
  userId?: string;
  channel?: string;
  message?: string;
  /** Latency in ms */
  latencyMs?: number;
  /** Token usage */
  usage?: { promptTokens: number; completionTokens: number };
  /** Extra metadata */
  meta?: Record<string, unknown>;
  timestamp: string;
}

let currentTraceId: string | undefined;

export function setTraceId(id: string | undefined): void {
  currentTraceId = id;
}

export function getTraceId(): string | undefined {
  return currentTraceId;
}

export function newTraceId(): string {
  const id = uuidv4();
  currentTraceId = id;
  return id;
}

export async function appendAuditEvent(event: Omit<AuditEvent, "id" | "timestamp">): Promise<void> {
  const full: AuditEvent = {
    ...event,
    id: `audit_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    traceId: event.traceId ?? currentTraceId,
    timestamp: new Date().toISOString(),
  };
  await mkdir(getDataDir(), { recursive: true });
  await appendFile(getAuditPath(), JSON.stringify(full) + "\n", "utf-8");
}

export async function getAuditLog(limit = 100): Promise<AuditEvent[]> {
  try {
    const raw = await readFile(getAuditPath(), "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);
    const events = lines
      .map((line) => {
        try {
          return JSON.parse(line) as AuditEvent;
        } catch {
          return null;
        }
      })
      .filter((e): e is AuditEvent => e !== null);
    return events.reverse().slice(0, limit);
  } catch {
    return [];
  }
}

/** Get audit events for a specific task (for replay). */
export async function getAuditLogByTaskId(taskId: string, limit = 200): Promise<AuditEvent[]> {
  try {
    const raw = await readFile(getAuditPath(), "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);
    const events = lines
      .map((line) => {
        try {
          return JSON.parse(line) as AuditEvent;
        } catch {
          return null;
        }
      })
      .filter((e): e is AuditEvent => e !== null && e.taskId === taskId);
    return events.reverse().slice(0, limit);
  } catch {
    return [];
  }
}
