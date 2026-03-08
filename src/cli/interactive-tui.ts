/**
 * Minimal TUI for gtd interactive (panel layout).
 * No external deps: ANSI only. Use gtd interactive --tui.
 * v2: live-updating panel with current task, history, suggestions, recent tasks, MCP tools.
 */

const PANEL_WIDTH = 72;
const HISTORY_LINES = 6;
const SUGGESTION_LINES = 2;
const RECENT_TASK_LINES = 3;
const MCP_LINES = 4;

function clearScreen(): void {
  process.stdout.write("\u001b[2J\u001b[H");
}

export interface TUIState {
  currentTask?: string;
  history: string[];
  /** e.g. "retry abc | approve xyz" */
  suggestions?: string[];
  /** Recent tasks for quick reference */
  recentTasks?: Array<{ id: string; description: string; status: string }>;
  /** MCP tools: serverId -> tool names */
  mcpTools?: Array<{ serverId: string; name: string }>;
}

function pad(s: string, w: number): string {
  if (s.length >= w) return s.slice(0, w - 1) + "…";
  return s.padEnd(w);
}

/** Draw a static panel (banner + commands). Call once when --tui. */
export function drawStaticTUI(): void {
  clearScreen();
  const top = "╭" + "─".repeat(PANEL_WIDTH - 2) + "╮";
  const bottom = "╰" + "─".repeat(PANEL_WIDTH - 2) + "╯";
  const side = "│";
  const lines = [
    top,
    side + " Skate — Interactive ".padEnd(PANEL_WIDTH - 2) + side,
    side + "─".repeat(PANEL_WIDTH - 2) + side,
    side + " Commands: task \"<desc>\", status, show <id>, approve, retry, refresh, help, exit ".padEnd(PANEL_WIDTH - 2) + side,
    side + " Shortcuts: Tab=complete  Ctrl+C=cancel ".padEnd(PANEL_WIDTH - 2) + side,
    bottom,
  ];
  process.stdout.write(lines.join("\n") + "\n\n");
}

/** Draw live panel: current task, suggestions, recent tasks, MCP tools, history. Call after each command when --tui. */
export function drawLiveTUI(state: TUIState): void {
  clearScreen();
  const top = "╭" + "─".repeat(PANEL_WIDTH - 2) + "╮";
  const bottom = "╰" + "─".repeat(PANEL_WIDTH - 2) + "╯";
  const side = "│";
  const lines: string[] = [
    top,
    side + " Skate — Interactive ".padEnd(PANEL_WIDTH - 2) + side,
    side + "─".repeat(PANEL_WIDTH - 2) + side,
  ];
  const taskLabel = " Current: ";
  const taskWidth = PANEL_WIDTH - 2 - taskLabel.length;
  const taskLine = state.currentTask
    ? side + taskLabel + pad(state.currentTask.slice(0, taskWidth), taskWidth) + side
    : side + " ".repeat(PANEL_WIDTH - 2) + side;
  lines.push(taskLine);
  if (state.suggestions?.length) {
    lines.push(side + " Suggest: " + pad((state.suggestions.slice(0, SUGGESTION_LINES).join(" | ") || "").slice(0, PANEL_WIDTH - 12), PANEL_WIDTH - 12) + side);
  }
  if (state.recentTasks?.length) {
    for (const t of state.recentTasks.slice(0, RECENT_TASK_LINES)) {
      const short = `${t.id.slice(0, 8)} ${t.status} ${t.description.slice(0, 36)}`;
      lines.push(side + " " + pad(short.slice(0, PANEL_WIDTH - 4), PANEL_WIDTH - 4) + " " + side);
    }
  }
  if (state.mcpTools?.length) {
    const toolStrs = state.mcpTools.slice(0, MCP_LINES).map((m) => `${m.serverId}:${m.name}`);
    lines.push(side + " MCP: " + pad(toolStrs.join(", ").slice(0, PANEL_WIDTH - 8), PANEL_WIDTH - 8) + side);
  }
  lines.push(side + "─".repeat(PANEL_WIDTH - 2) + side);
  const recent = state.history.slice(-HISTORY_LINES);
  for (const h of recent) {
    lines.push(side + " " + pad(h.slice(0, PANEL_WIDTH - 4), PANEL_WIDTH - 4) + " " + side);
  }
  for (let i = recent.length; i < HISTORY_LINES; i++) {
    lines.push(side + " ".repeat(PANEL_WIDTH - 2) + side);
  }
  lines.push(bottom);
  process.stdout.write(lines.join("\n") + "\n\n");
}
