/**
 * Session/context compaction to stay within token limits.
 * When context exceeds a threshold, truncate with a note or (optional) summarize via LLM.
 */

const DEFAULT_MAX_CHARS = 24_000;
const DEFAULT_MAX_CONTEXT_CHARS = 128_000; // ~32k tokens; safe default to avoid OOM/API errors
const SUMMARIZE_MAX_WORDS = 800;

/** Safe default max context size (chars). Set GTD_MAX_CONTEXT_CHARS to override; context above this is trimmed before send. */
export function getMaxContextChars(): number {
  const v = process.env.GTD_MAX_CONTEXT_CHARS;
  if (v === undefined || v === "") return DEFAULT_MAX_CONTEXT_CHARS;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 1000 && n <= 2_000_000 ? n : DEFAULT_MAX_CONTEXT_CHARS;
}

/**
 * Compaction trigger in chars. When GTD_COMPACT_TRIGGER_PERCENT is set (1–100), trigger at that % of max context;
 * otherwise trigger at getMaxContextChars() (same as cap).
 */
export function getCompactTriggerChars(): number {
  const maxChars = getMaxContextChars();
  const pct = process.env.GTD_COMPACT_TRIGGER_PERCENT;
  if (pct === undefined || pct === "") return maxChars;
  const n = parseInt(pct, 10);
  if (!Number.isFinite(n) || n < 1 || n > 100) return maxChars;
  return Math.floor((maxChars * n) / 100);
}

/**
 * Compact long context: truncate to maxChars and append a note.
 * Set GTD_SESSION_COMPACT_MAX to override default (chars).
 */
export function compactContext(text: string, maxChars?: number): string {
  const limit = maxChars ?? (parseInt(process.env.GTD_SESSION_COMPACT_MAX ?? String(DEFAULT_MAX_CHARS), 10) || DEFAULT_MAX_CHARS);
  if (text.length <= limit) return text;
  const keep = Math.floor(limit * 0.8);
  return text.slice(0, keep) + "\n\n[... context truncated for length ...]";
}

/**
 * Apply compaction to context only when GTD_SESSION_COMPACT=1 or GTD_SESSION_COMPACT=summarize.
 */
export function compactContextIfEnabled(text: string, maxChars?: number): string {
  if (process.env.GTD_SESSION_COMPACT !== "1" && process.env.GTD_SESSION_COMPACT !== "true") return text;
  return compactContext(text, maxChars);
}

/**
 * When GTD_SESSION_COMPACT=summarize and context is over limit, summarize via LLM. Otherwise truncate.
 * Pass modelId from orchestrator (e.g. planner model). If no modelId, falls back to truncation.
 * When GTD_SESSION_COMPACT_PERSIST=1 and cwd is set, appends the summary to project MEMORY.md (long-term store).
 */
export async function compactContextAsync(
  text: string,
  maxChars?: number,
  modelId?: string,
  cwd?: string
): Promise<string> {
  const limit = maxChars ?? (parseInt(process.env.GTD_SESSION_COMPACT_MAX ?? String(DEFAULT_MAX_CHARS), 10) || DEFAULT_MAX_CHARS);
  if (text.length <= limit) return text;
  if (process.env.GTD_SESSION_COMPACT === "summarize" && modelId) {
    try {
      const { complete } = await import("../core/llm/client.js");
      const { getEnabledModelIds } = await import("../core/models/index.js");
      const ids = getEnabledModelIds();
      const mid = modelId && ids.includes(modelId) ? modelId : ids[0];
      if (!mid) return compactContext(text, maxChars);
      const systemPrompt = `Summarize the following context in under ${SUMMARIZE_MAX_WORDS} words. Preserve key facts, decisions, and implementation details. Output only the summary.`;
      const response = await complete(
        { modelId: mid, systemPrompt, temperature: 0.3 },
        text.slice(0, limit)
      );
      const summary = (response.content ?? "").trim();
      const result = summary ? summary.slice(0, limit) : compactContext(text, maxChars);
      if (
        result !== text &&
        process.env.GTD_SESSION_COMPACT_PERSIST === "1" &&
        cwd
      ) {
        try {
          const { appendProjectMemory } = await import("./store.js");
          const heading = "\n\n---\n## Context summary (compaction)\n";
          await appendProjectMemory(cwd, heading + result);
        } catch {
          // non-fatal: in-memory compaction still applied
        }
      }
      return result;
    } catch {
      return compactContext(text, maxChars);
    }
  }
  return compactContext(text, maxChars);
}
