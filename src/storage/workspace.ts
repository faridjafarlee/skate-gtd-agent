/**
 * Optional per-project workspace config (.gtd/workspace.json).
 * K-26: When present, CLI applies roots and defaultMode for tasks in this directory.
 */

import { readFile } from "fs/promises";
import { join } from "path";

export interface WorkspaceConfig {
  /** Human-readable name for the workspace. */
  name?: string;
  /** Paths to workspace roots (relative to dir containing .gtd, or absolute). Used as GTD_WORKSPACE_ROOTS / opts.workspaceRoots. */
  roots?: string[];
  /** Default named mode when --mode is not passed: architect | debug | ask | orchestrator. */
  defaultMode?: string;
}

const FILENAME = "workspace.json";
const DIR = ".gtd";

/**
 * Load workspace config from .gtd/workspace.json in the given directory.
 * Returns null if the file is missing or invalid.
 */
export async function loadWorkspaceConfig(cwd: string): Promise<WorkspaceConfig | null> {
  const path = join(cwd, DIR, FILENAME);
  try {
    const raw = await readFile(path, "utf-8");
    const data = JSON.parse(raw) as Record<string, unknown>;
    if (!data || typeof data !== "object") return null;
    const roots = Array.isArray(data.roots)
      ? (data.roots as unknown[]).map((r) => (typeof r === "string" ? r : String(r))).filter(Boolean)
      : undefined;
    const defaultMode = typeof data.defaultMode === "string" ? data.defaultMode.trim() : undefined;
    const name = typeof data.name === "string" ? data.name.trim() : undefined;
    if (!roots?.length && !defaultMode && !name) return null;
    return { name, roots, defaultMode };
  } catch {
    return null;
  }
}
