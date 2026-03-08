/**
 * Repo map: concise map of repo (classes, functions, key lines) for context.
 * Aider-style; token-budget capped. Used by REPL and task context.
 */

import { readdir, readFile, stat } from "fs/promises";
import { join, relative } from "path";
import { isPathIgnored } from "./store.js";

const SYMBOL_LINE = /^\s*(export\s+)?(async\s+)?(function|class|const|let|var)\s+(\w+)|^\s*def\s+(\w+)|^\s*(\w+)\s*\([^)]*\)\s*[=:{]|^\s*class\s+(\w+)|^\s*interface\s+(\w+)|^\s*type\s+(\w+)/m;
const MAX_FILE_SIZE = 200_000;

function extractSymbolLines(content: string, maxLines = 25): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("*")) continue;
    const m = trimmed.match(SYMBOL_LINE);
    if (m) {
      const key = trimmed.slice(0, 80);
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push("| " + trimmed.slice(0, 120));
      if (lines.length >= maxLines) break;
    }
  }
  return lines;
}

async function walkFiles(
  cwd: string,
  dir: string,
  ignored: (abs: string) => Promise<boolean>,
  out: string[],
  maxFiles: number
): Promise<void> {
  if (out.length >= maxFiles) return;
  let entries: { name: string; isDir: boolean }[];
  try {
    const raw = await readdir(dir, { withFileTypes: true });
    entries = raw.map((e) => ({ name: e.name, isDir: e.isDirectory() }));
  } catch {
    return;
  }
  const sorted = entries
    .filter((e) => !e.name.startsWith(".") && e.name !== "node_modules")
    .sort((a, b) => (a.isDir === b.isDir ? 0 : a.isDir ? 1 : -1));
  for (const e of sorted) {
    if (out.length >= maxFiles) return;
    const abs = join(dir, e.name);
    if (await ignored(abs)) continue;
    if (e.isDir) {
      await walkFiles(cwd, abs, ignored, out, maxFiles);
    } else {
      const ext = e.name.split(".").pop()?.toLowerCase();
      if (["ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rb", "go", "rs", "java", "kt"].includes(ext ?? "")) {
        out.push(abs);
      }
    }
  }
}

const normPath = (p: string) => p.replace(/\\/g, "/");
const pathSegments = (p: string) => normPath(p).split("/").filter(Boolean);

/**
 * Relevance score for graph ranking: lower = more relevant.
 * Prioritized files get 0..N (by depth under prioritized path); others get 1000+ by depth so they sort after.
 */
function relevanceScore(abs: string, prioritizePaths: string[], cwd: string): number {
  const aNorm = normPath(abs);
  const aRel = relative(cwd, abs);
  const aSegs = pathSegments(aRel);
  for (const p of prioritizePaths) {
    const pAbs = join(cwd, p);
    const pNormAbs = normPath(pAbs);
    if (aNorm === pNormAbs || aNorm.startsWith(pNormAbs + "/")) {
      const relFromP = aNorm.slice(pNormAbs.length).replace(/^\//, "") || "";
      const depthUnder = relFromP ? pathSegments(relFromP).length : 0;
      return depthUnder;
    }
  }
  return 1000 + aSegs.length;
}

/**
 * Build a concise repo map (file paths + symbol lines) under a token/char budget.
 * Respects .gitignore / .gtdignore via isPathIgnored.
 * When prioritizePaths is set, files are graph-ranked by relevance (prioritized first, then by directory depth).
 */
export async function buildRepoMap(
  cwd: string,
  options: { maxTokens?: number; respectIgnore?: boolean; prioritizePaths?: string[] } = {}
): Promise<string> {
  const maxChars = Math.min(100_000, (options.maxTokens ?? 1024) * 4);
  const respectIgnore = options.respectIgnore !== false;
  const prioritizePaths = options.prioritizePaths ?? [];
  const ignored = respectIgnore ? (abs: string) => isPathIgnored(cwd, abs) : async () => false;
  const files: string[] = [];
  await walkFiles(cwd, cwd, ignored, files, 150);
  if (prioritizePaths.length > 0) {
    files.sort((a, b) => {
      const scoreA = relevanceScore(a, prioritizePaths, cwd);
      const scoreB = relevanceScore(b, prioritizePaths, cwd);
      return scoreA - scoreB;
    });
  }
  const parts: string[] = [];
  let total = 0;
  for (const abs of files) {
    if (total >= maxChars) break;
    let content: string;
    try {
      const s = await stat(abs);
      if (s.size > MAX_FILE_SIZE) continue;
      content = await readFile(abs, "utf-8");
    } catch {
      continue;
    }
    const rel = relative(cwd, abs).replace(/\\/g, "/");
    const symbolLines = extractSymbolLines(content);
    if (symbolLines.length === 0) continue;
    const block = `${rel}:\n${symbolLines.join("\n")}\n`;
    if (total + block.length > maxChars) {
      parts.push(rel + ":\n  (truncated)\n");
      break;
    }
    parts.push(block);
    total += block.length;
  }
  return parts.length ? parts.join("") : "(No symbol map generated; add files with 'add <path>' or run from project root.)";
}
