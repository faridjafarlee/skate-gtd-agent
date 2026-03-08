import chalk from "chalk";

export type AgentPanelState = {
  role: string;
  status: "idle" | "running" | "done" | "error";
  progress: number;
  description: string;
  duration?: string;
};

const STATUS_SYMBOLS = {
  idle: "o",
  running: "…",
  done: "✓",
  error: "✗",
};

/**
 * Renders a single agent panel (like the screenshot grid).
 */
export function renderAgentPanel(state: AgentPanelState, useColor = true): string {
  const sym = STATUS_SYMBOLS[state.status];
  const barLen = 5;
  const filled = state.progress >= 100 ? barLen : state.progress > 0 ? Math.max(1, Math.round((state.progress / 100) * barLen)) : 0;
  const bar = "[" + "#".repeat(filled) + "-".repeat(barLen - filled) + "]";

  const c = useColor && process.stdout.isTTY && !process.env.NO_COLOR
    ? {
        role: chalk.hex("#7bed9f").bold,
        idle: chalk.hex("#f1c40f"),
        done: chalk.hex("#2ecc71"),
        error: chalk.hex("#e74c3c"),
        bar: chalk.hex("#3498db"),
        desc: chalk.hex("#bdc3c7"),
      }
    : { role: (s: string) => s, idle: (s: string) => s, done: (s: string) => s, error: (s: string) => s, bar: (s: string) => s, desc: (s: string) => s };

  const statusColor = state.status === "done" ? c.done : state.status === "error" ? c.error : c.idle;
  const statusText = state.status === "done" && state.duration ? `${sym} done ${state.duration}` : `${sym} ${state.status}`;

  const lines = [
    c.role(state.role),
    `  ${statusColor(statusText)}`,
    `  ${c.bar(bar)} ${state.progress}%`,
    `  ${c.desc(state.description.slice(0, 50) + (state.description.length > 50 ? "…" : ""))}`,
  ];

  return lines.join("\n");
}

/**
 * Renders a 2x3 grid of agent panels.
 */
export function renderAgentGrid(panels: AgentPanelState[]): string {
  const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
  const rendered = panels.map((p) => renderAgentPanel(p, useColor));

  // Simple vertical stack for now; could use column layout later
  return rendered.join("\n\n");
}
