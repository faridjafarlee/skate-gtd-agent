/**
 * "Don't ask again" allow list for tool approval.
 * Session: in-memory for the process; optional persist to ~/.skate/session-allow.json when GTD_PERSIST_SESSION_ALLOW=1.
 * Project: persisted in .gtd/allow.json.
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { homedir } from "os";

function getDataDir(): string {
  return process.env.GTD_DATA_DIR ?? join(homedir(), ".skate");
}

const SESSION_KEYS = new Set<string>();
const SESSION_ALLOW_FILE = "session-allow.json";

export function allowListKey(toolName: string, category: string): string {
  return `${toolName}:${category}`;
}

/** Load session allow from disk (when GTD_PERSIST_SESSION_ALLOW=1). Call once at startup. */
export async function loadPersistedSessionAllow(): Promise<void> {
  if (process.env.GTD_PERSIST_SESSION_ALLOW !== "1" && process.env.GTD_PERSIST_SESSION_ALLOW !== "true") return;
  try {
    const path = join(getDataDir(), SESSION_ALLOW_FILE);
    const raw = await readFile(path, "utf-8");
    const data = JSON.parse(raw) as { allow?: { tool: string; category: string }[] };
    const arr = Array.isArray(data?.allow) ? data.allow : [];
    arr.forEach((e) => SESSION_KEYS.add(allowListKey(e.tool, e.category)));
  } catch {
    // no file or invalid
  }
}

/** Session allow: in-memory; cleared when process exits (unless persisted). */
export function getSessionAllow(): Set<string> {
  return SESSION_KEYS;
}

export function addToSessionAllow(toolName: string, category: string): void {
  const key = allowListKey(toolName, category);
  SESSION_KEYS.add(key);
  if (process.env.GTD_PERSIST_SESSION_ALLOW === "1" || process.env.GTD_PERSIST_SESSION_ALLOW === "true") {
    persistSessionAllow().catch(() => {});
  }
}

async function persistSessionAllow(): Promise<void> {
  try {
    const dir = getDataDir();
    await mkdir(dir, { recursive: true });
    const path = join(dir, SESSION_ALLOW_FILE);
    const allow = Array.from(SESSION_KEYS).map((k) => {
      const [tool, category] = k.split(":");
      return { tool: tool ?? "", category: category ?? "" };
    });
    await writeFile(path, JSON.stringify({ allow }, null, 2), "utf-8");
  } catch {
    // ignore
  }
}

export function isInSessionAllow(toolName: string, category: string): boolean {
  return SESSION_KEYS.has(allowListKey(toolName, category));
}

/** Project allow: .gtd/allow.json in cwd. */
export interface AllowListEntry {
  tool: string;
  category: string;
}

const ALLOW_FILE = ".gtd/allow.json";

export async function loadProjectAllow(cwd: string): Promise<Set<string>> {
  try {
    const path = join(cwd, ALLOW_FILE);
    const raw = await readFile(path, "utf-8");
    const data = JSON.parse(raw) as { allow?: AllowListEntry[] };
    const arr = Array.isArray(data?.allow) ? data.allow : [];
    return new Set(arr.map((e) => allowListKey(e.tool, e.category)));
  } catch {
    return new Set();
  }
}

export async function addToProjectAllow(cwd: string, toolName: string, category: string): Promise<void> {
  const path = join(cwd, ALLOW_FILE);
  const dir = join(cwd, ".gtd");
  await mkdir(dir, { recursive: true });
  let allow: AllowListEntry[] = [];
  try {
    const raw = await readFile(path, "utf-8");
    const data = JSON.parse(raw) as { allow?: AllowListEntry[] };
    allow = Array.isArray(data?.allow) ? data.allow : [];
  } catch {
    // file missing or invalid
  }
  const key = allowListKey(toolName, category);
  if (allow.some((e) => allowListKey(e.tool, e.category) === key)) return;
  allow.push({ tool: toolName, category });
  await writeFile(path, JSON.stringify({ allow }, null, 2), "utf-8");
}

export function isInProjectAllow(projectSet: Set<string>, toolName: string, category: string): boolean {
  return projectSet.has(allowListKey(toolName, category));
}
