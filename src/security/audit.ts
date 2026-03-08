/**
 * Audit: (1) Governance events via audit() -> audit/events (audit.jsonl).
 * (2) Optional tool/approval stream via GTD_AUDIT_LOG=1 or path.
 */

import { appendFile } from "fs/promises";
import { appendAuditEvent } from "../audit/events.js";
import type { AuditEventType } from "../audit/events.js";

/** Persist governance event to audit.jsonl (task approval, bypass, allow-list, etc.). */
export async function audit(event: { type: AuditEventType; taskId?: string; message?: string; stepId?: string; [k: string]: unknown }): Promise<void> {
  await appendAuditEvent(event);
}

function auditDestination(): "stderr" | string | null {
  const v = process.env.GTD_AUDIT_LOG?.trim();
  if (!v) return null;
  if (v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "stderr") return "stderr";
  return v;
}

function formatLine(fields: Record<string, string | number | boolean | undefined>): string {
  const ts = new Date().toISOString();
  const parts = Object.entries(fields)
    .filter(([, val]) => val !== undefined && val !== "")
    .map(([k, v]) => `${k}=${typeof v === "string" && /[\s=]/.test(v) ? JSON.stringify(v) : v}`);
  return `${ts}\t${parts.join("\t")}\n`;
}

/**
 * Append one audit line. No-op if GTD_AUDIT_LOG is not set.
 */
export async function writeAuditLog(fields: Record<string, string | number | boolean | undefined>): Promise<void> {
  const dest = auditDestination();
  if (!dest) return;
  const line = formatLine(fields);
  if (dest === "stderr") {
    process.stderr.write(line);
    return;
  }
  try {
    await appendFile(dest, line);
  } catch {
    // best-effort; avoid breaking the run
  }
}

/**
 * Log a tool invocation (call after executeTool).
 */
export function logToolCall(params: {
  tool: string;
  category: string;
  outcome: "success" | "failure" | "approval_required";
  error?: string;
  argsSummary?: string;
}): void {
  writeAuditLog({
    event: "tool",
    tool: params.tool,
    category: params.category,
    outcome: params.outcome,
    error: params.error,
    argsSummary: params.argsSummary != null && params.argsSummary.length > 200 ? params.argsSummary.slice(0, 200) + "…" : params.argsSummary,
  }).catch(() => {});
}

/**
 * Log an approval decision (allow / session / project / deny).
 */
export function logApproval(params: {
  tool: string;
  category: string;
  decision: "allow" | "session" | "project" | "deny" | "reject";
}): void {
  writeAuditLog({
    event: "approval",
    tool: params.tool,
    category: params.category,
    decision: params.decision,
  }).catch(() => {});
}
