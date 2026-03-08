/**
 * Structured memory store for project/user context.
 * MEMORY.md and structured notes.
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { join, isAbsolute, relative } from "path";
import { homedir } from "os";

/** Load ignore patterns from .gtdignore and .gitignore in cwd (respect .gitignore / .gtdignore when scanning context). */
async function loadIgnorePatterns(cwd: string): Promise<string[]> {
  const patterns: string[] = [];
  for (const name of [".gtdignore", ".gitignore"]) {
    const path = join(cwd, name);
    try {
      const raw = await readFile(path, "utf-8");
      for (const line of raw.split(/\r?\n/)) {
        const p = line.replace(/#.*/, "").trim();
        if (p) patterns.push(p);
      }
    } catch {
      // file missing
    }
  }
  return patterns;
}

/** Return true if the given absolute path is ignored by .gtdignore or .gitignore in cwd. */
export async function isPathIgnored(cwd: string, absolutePath: string): Promise<boolean> {
  const patterns = await loadIgnorePatterns(cwd);
  if (patterns.length === 0) return false;
  let rel = relative(cwd, absolutePath).replace(/\\/g, "/");
  if (rel.startsWith("..")) return false; // outside cwd
  if (!rel) rel = ".";
  const segments = rel.split("/");
  for (const pattern of patterns) {
    if (pattern.endsWith("/")) {
      const dir = pattern.slice(0, -1);
      if (segments.includes(dir) || segments.some((s) => s === dir || s.startsWith(dir))) return true;
    } else if (pattern.includes("*")) {
      const suffix = pattern.startsWith("*") ? pattern.slice(1) : null;
      if (suffix && rel.endsWith(suffix)) return true;
      if (pattern === "*") return true;
    } else {
      if (segments.some((s) => s === pattern || s.startsWith(pattern))) return true;
    }
  }
  return false;
}

function getDataDir(): string {
  return process.env.GTD_DATA_DIR ?? join(homedir(), ".skate");
}

function getMemoryPath(): string {
  return join(getDataDir(), "memory.json");
}

export interface MemoryEntry {
  id: string;
  key: string;
  value: string;
  createdAt: string;
  updatedAt?: string;
}

export interface MemoryStore {
  entries: MemoryEntry[];
  /** Project MEMORY.md path (if loaded) */
  projectMemoryPath?: string;
}

async function readMemory(): Promise<MemoryStore> {
  try {
    const raw = await readFile(getMemoryPath(), "utf-8");
    const data = JSON.parse(raw) as MemoryStore;
    return data && Array.isArray(data.entries) ? data : { entries: [] };
  } catch {
    return { entries: [] };
  }
}

async function writeMemory(store: MemoryStore): Promise<void> {
  await mkdir(getDataDir(), { recursive: true });
  await writeFile(getMemoryPath(), JSON.stringify(store, null, 2), "utf-8");
}

export async function getMemoryEntries(): Promise<MemoryEntry[]> {
  const store = await readMemory();
  return store.entries;
}

export async function setMemoryEntry(key: string, value: string): Promise<void> {
  const store = await readMemory();
  const existing = store.entries.find((e) => e.key === key);
  const now = new Date().toISOString();
  if (existing) {
    existing.value = value;
    existing.updatedAt = now;
  } else {
    store.entries.push({
      id: `mem_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      key,
      value,
      createdAt: now,
      updatedAt: now,
    });
  }
  await writeMemory(store);
}

export async function getMemoryEntry(key: string): Promise<string | undefined> {
  const store = await readMemory();
  return store.entries.find((e) => e.key === key)?.value;
}

export async function deleteMemoryEntry(key: string): Promise<boolean> {
  const store = await readMemory();
  const idx = store.entries.findIndex((e) => e.key === key);
  if (idx < 0) return false;
  store.entries.splice(idx, 1);
  await writeMemory(store);
  return true;
}

/**
 * Load global context file from data dir (hierarchical context; see rules-add).
 * Path: <GTD_DATA_DIR>/global-rules.md.
 */
export async function loadGlobalRules(): Promise<string> {
  const path = join(getDataDir(), "global-rules.md");
  try {
    return await readFile(path, "utf-8");
  } catch {
    return "";
  }
}

const PROJECT_MEMORY_FILENAME = "MEMORY.md";

/** Path to project MEMORY.md for the given cwd. */
export function getProjectMemoryPath(cwd: string): string {
  return join(cwd, PROJECT_MEMORY_FILENAME);
}

/**
 * Load MEMORY.md from project root (cwd).
 */
export async function loadProjectMemory(cwd: string): Promise<string> {
  try {
    return await readFile(getProjectMemoryPath(cwd), "utf-8");
  } catch {
    return "";
  }
}

/**
 * Append text to project MEMORY.md (creates file if missing). Adds newline before the block.
 */
export async function appendProjectMemory(cwd: string, text: string): Promise<void> {
  const path = getProjectMemoryPath(cwd);
  const existing = await loadProjectMemory(cwd);
  const block = (existing && !existing.endsWith("\n") ? "\n\n" : "") + (text.startsWith("\n") ? text : "\n" + text.trim());
  await writeFile(path, existing + block, "utf-8");
}

/**
 * Trim MEMORY.md to at most maxChars (keeps the end). No-op if file is shorter.
 */
export async function trimProjectMemory(cwd: string, maxChars: number): Promise<{ trimmed: boolean; before: number; after: number }> {
  const path = getProjectMemoryPath(cwd);
  let content: string;
  try {
    content = await readFile(path, "utf-8");
  } catch {
    return { trimmed: false, before: 0, after: 0 };
  }
  const before = content.length;
  if (before <= maxChars || maxChars < 100) return { trimmed: false, before, after: before };
  const note = "\n\n---\n[... trimmed for length; older content removed ...]\n";
  const keepLen = maxChars - note.length;
  const trimmed = content.slice(-keepLen) + note;
  await writeFile(path, trimmed, "utf-8");
  return { trimmed: true, before, after: trimmed.length };
}

/**
 * Load project-level rules/instructions (prepended to agent context).
 * Tries .gtd/rules.md, RULES.md, .cursor/AGENTS.md, then AGENTS.md.
 * First file found wins; use loadProjectRulesFromConfig for multi-file or custom order.
 */
export async function loadProjectRules(cwd: string): Promise<string> {
  const paths = [
    join(cwd, ".gtd", "rules.md"),
    join(cwd, "RULES.md"),
    join(cwd, ".cursor", "AGENTS.md"),
    join(cwd, "AGENTS.md"),
  ];
  for (const p of paths) {
    if (await isPathIgnored(cwd, p)) continue;
    try {
      return await readFile(p, "utf-8");
    } catch {
      continue;
    }
  }
  return "";
}

/**
 * Load rules from config.rules paths (relative to cwd). Merged in order.
 * When config.rules is absent, uses rulesDefaultNames (e.g. ["CONTEXT.md"]) resolved to cwd, then falls back to loadProjectRules(cwd).
 */
export async function loadProjectRulesFromConfig(
  cwd: string,
  rulesPaths?: string[],
  rulesDefaultNames?: string[]
): Promise<string> {
  const paths: string[] = [];
  if (rulesPaths?.length) {
    paths.push(...rulesPaths.map((r) => (isAbsolute(r) ? r : join(cwd, r))));
  } else if (rulesDefaultNames?.length) {
    paths.push(...rulesDefaultNames.map((n) => (isAbsolute(n) ? n : join(cwd, n))));
  }
  if (paths.length) {
    const parts: string[] = [];
    for (const p of paths) {
      if (await isPathIgnored(cwd, p)) continue;
      try {
        parts.push(await readFile(p, "utf-8"));
      } catch {
        continue;
      }
    }
    if (parts.length) return parts.join("\n\n");
  }
  return loadProjectRules(cwd);
}

/** Role name to config key (e.g. builder -> rules.builder). */
type RoleRulesKey = "scout" | "planner" | "builder" | "reviewer" | "documenter" | "red_team";

/**
 * Load role-specific rules (CC-10). Uses config.rulesByRole[role] if set, else tries .gtd/rules.<role>.md.
 */
export async function loadProjectRulesForRole(
  cwd: string,
  role: RoleRulesKey,
  rulesByRole?: Partial<Record<string, string[]>>
): Promise<string> {
  const paths = rulesByRole?.[role];
  if (paths?.length) {
    const parts: string[] = [];
    for (const r of paths) {
      const p = isAbsolute(r) ? r : join(cwd, r);
      try {
        parts.push(await readFile(p, "utf-8"));
      } catch {
        continue;
      }
    }
    if (parts.length) return parts.join("\n\n");
  }
  const fallback = join(cwd, ".gtd", `rules.${role}.md`);
  try {
    return await readFile(fallback, "utf-8");
  } catch {
    return "";
  }
}
