/**
 * Optional blessed-based TUI for gtd interactive --tui.
 * Used when optionalDependency "blessed" is installed; otherwise CLI falls back to interactive-tui (ANSI).
 * When blessed is used, input is collected in an input box at the bottom instead of readline overlay.
 */

import { createRequire } from "module";
import type { TUIState } from "./interactive-tui.js";

const require = createRequire(import.meta.url);
type Blessed = {
  screen: (opts: object) => BlessedScreen;
  box: (opts: object) => BlessedNode;
  textbox: (opts: object) => BlessedInput;
};
type BlessedScreen = { render: () => void; append: (n: BlessedNode) => void };
type BlessedNode = { destroy: () => void; setContent: (c: string) => void; top: number; height: number };
type BlessedInput = BlessedNode & {
  focus: () => void; setValue: (v: string) => void; getValue: () => string; submit: () => void;
  on: (ev: string, fn: () => void) => void; key: (keys: string[], fn: () => void) => void;
  inputOnFocus: boolean;
};

let blessed: Blessed | null = null;
try {
  blessed = require("blessed");
} catch {
  // optional dep not installed
}

/** True when optional dependency "blessed" is available. */
export const useBlessed = !!blessed;

const PANEL_WIDTH = 72;
const HISTORY_LINES = 6;
const INPUT_HEIGHT = 3;

function pad(s: string, w: number): string {
  if (s.length >= w) return s.slice(0, w - 1) + "…";
  return s.padEnd(w);
}

let screen: BlessedScreen | null = null;
let mainBox: BlessedNode | null = null;
let inputBox: BlessedInput | null = null;
let inputResolve: ((value: string) => void) | null = null;

/** Draw a static panel (banner + commands) and an input box at the bottom. Call once when --tui. */
export function drawStaticTUI(): void {
  if (!blessed) return;
  screen = blessed.screen({ smartCSR: true, fullUnicode: true });
  mainBox = blessed.box({
    parent: screen,
    top: 0,
    left: 0,
    width: PANEL_WIDTH,
    height: 6,
    border: { type: "line" },
    style: { border: { fg: "cyan" }, fg: "white" },
    content: " Skate — Interactive\n" + "─".repeat(PANEL_WIDTH - 2) + "\n Commands: task \"<desc>\", status, show <id>, approve, retry, help, exit ",
  });
  inputBox = blessed.textbox({
    parent: screen,
    bottom: 0,
    left: 0,
    width: PANEL_WIDTH,
    height: INPUT_HEIGHT,
    border: { type: "line" },
    style: { border: { fg: "yellow" }, fg: "white" },
    label: " gtd> ",
    inputOnFocus: true,
  });
  inputBox.key(["enter"], () => {
    if (inputResolve) {
      const v = (inputBox?.getValue() ?? "").trim();
      inputBox?.setValue("");
      inputResolve(v);
      inputResolve = null;
    }
    screen?.render();
  });
  screen.render();
}

/** Draw live panel: current task, suggestions, recent tasks, MCP tools, history. Updates only the main box; keeps input at bottom. */
export function drawLiveTUI(state: TUIState): void {
  if (!blessed || !screen || !mainBox) return;
  const parts: string[] = [
    " Skate — Interactive",
    "─".repeat(PANEL_WIDTH - 2),
    state.currentTask ? " Current: " + pad(state.currentTask.slice(0, PANEL_WIDTH - 14), PANEL_WIDTH - 14) : "",
  ];
  if (state.suggestions?.length) {
    parts.push(" Suggest: " + (state.suggestions.slice(0, 2).join(" | ") || "").slice(0, PANEL_WIDTH - 12));
  }
  if (state.recentTasks?.length) {
    for (const t of state.recentTasks.slice(0, 3)) {
      parts.push(" " + pad(`${t.id.slice(0, 8)} ${t.status} ${t.description.slice(0, 36)}`.slice(0, PANEL_WIDTH - 4), PANEL_WIDTH - 4));
    }
  }
  if (state.mcpTools?.length) {
    parts.push(" MCP: " + state.mcpTools.slice(0, 4).map((m) => `${m.serverId}:${m.name}`).join(", ").slice(0, PANEL_WIDTH - 8));
  }
  parts.push("─".repeat(PANEL_WIDTH - 2));
  parts.push(...state.history.slice(-HISTORY_LINES).map((h) => " " + pad(h.slice(0, PANEL_WIDTH - 4), PANEL_WIDTH - 4)));
  mainBox.setContent(parts.filter(Boolean).join("\n"));
  screen.render();
}

/**
 * Ask for one line of input using the blessed input box at the bottom.
 * Use this instead of readline when useBlessed is true so input stays in the TUI.
 */
export function askInput(_prompt: string): Promise<string> {
  return new Promise((resolve) => {
    if (!inputBox || !screen) {
      resolve("");
      return;
    }
    inputBox.setValue("");
    inputResolve = resolve;
    inputBox.focus();
    screen.render();
  });
}
