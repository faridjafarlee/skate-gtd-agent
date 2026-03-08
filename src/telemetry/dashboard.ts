/**
 * Generate a simple HTML dashboard from metrics and audit events.
 */

import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import type { MetricEvent } from "./metrics.js";

export interface AuditEventForDashboard {
  type: string;
  taskId?: string;
  message?: string;
  timestamp: string | Date;
}

function getDataDir(): string {
  return process.env.GTD_DATA_DIR ?? join(homedir(), ".skate");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export async function generateDashboardHtml(
  metrics: MetricEvent[],
  auditEvents: AuditEventForDashboard[],
  outPath?: string
): Promise<string> {
  const path = outPath ?? join(getDataDir(), "telemetry-dashboard.html");
  await mkdir(join(path, ".."), { recursive: true });

  const tokenEvents = metrics.filter((e) => e.type === "token_usage");
  const totalPrompt = tokenEvents.reduce((s, e) => s + (e.promptTokens ?? 0), 0);
  const totalCompletion = tokenEvents.reduce((s, e) => s + (e.completionTokens ?? 0), 0);
  const latencyEvents = metrics.filter((e) => e.type === "step_latency" && e.latencyMs);
  const avgLatency =
    latencyEvents.length > 0
      ? Math.round(latencyEvents.reduce((s, e) => s + (e.latencyMs ?? 0), 0) / latencyEvents.length)
      : 0;

  const rows = metrics.slice(0, 100).map(
    (e) =>
      `<tr><td>${escapeHtml(e.timestamp)}</td><td>${escapeHtml(e.type)}</td><td>${escapeHtml(e.taskId ?? "")}</td><td>${escapeHtml(e.role ?? e.step ?? "")}</td><td>${e.latencyMs ?? ""}</td><td>${e.promptTokens ?? ""}</td><td>${e.completionTokens ?? ""}</td></tr>`
  );
  const auditRows = auditEvents.slice(0, 50).map(
    (e) =>
      `<tr><td>${escapeHtml(typeof e.timestamp === "string" ? e.timestamp : e.timestamp.toISOString())}</td><td>${escapeHtml(e.type)}</td><td>${escapeHtml(e.taskId ?? "")}</td><td>${escapeHtml(e.message ?? "")}</td></tr>`
  );

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Skate Telemetry</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 1rem 2rem; background: #1a1a2e; color: #eee; }
    h1 { color: #7bed9f; }
    .cards { display: flex; gap: 1rem; flex-wrap: wrap; margin: 1rem 0; }
    .card { background: #16213e; padding: 1rem 1.5rem; border-radius: 8px; min-width: 140px; }
    .card h3 { margin: 0 0 0.25rem; font-size: 0.85rem; color: #bdc3c7; }
    .card p { margin: 0; font-size: 1.5rem; }
    table { border-collapse: collapse; width: 100%; margin-top: 0.5rem; font-size: 0.9rem; }
    th, td { text-align: left; padding: 0.4rem 0.6rem; border-bottom: 1px solid #2a2a4a; }
    th { color: #7bed9f; }
    h2 { margin-top: 2rem; color: #3498db; }
  </style>
</head>
<body>
  <h1>Skate Telemetry</h1>
  <p>Generated at ${new Date().toISOString()}</p>
  <div class="cards">
    <div class="card"><h3>Total prompt tokens</h3><p>${totalPrompt.toLocaleString()}</p></div>
    <div class="card"><h3>Total completion tokens</h3><p>${totalCompletion.toLocaleString()}</p></div>
    <div class="card"><h3>Avg step latency</h3><p>${avgLatency} ms</p></div>
    <div class="card"><h3>Metric events</h3><p>${metrics.length}</p></div>
    <div class="card"><h3>Audit events</h3><p>${auditEvents.length}</p></div>
  </div>
  <h2>Recent metrics</h2>
  <table>
    <thead><tr><th>Time</th><th>Type</th><th>Task</th><th>Role/Step</th><th>Latency (ms)</th><th>Prompt</th><th>Completion</th></tr></thead>
    <tbody>${rows.join("")}</tbody>
  </table>
  <h2>Recent audit</h2>
  <table>
    <thead><tr><th>Time</th><th>Type</th><th>Task</th><th>Message</th></tr></thead>
    <tbody>${auditRows.join("")}</tbody>
  </table>
</body>
</html>`;

  await writeFile(path, html, "utf-8");
  return path;
}
