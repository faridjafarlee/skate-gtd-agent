/**
 * Retry with exponential backoff for LLM and tool calls.
 * GTD_RETRY_MAX (default 2 = 1 retry), GTD_RETRY_BASE_MS (default 1000).
 */

const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_BASE_MS = 1000;

function getRetryMax(envKey: string): number {
  const v = process.env[envKey];
  if (v === undefined || v === "") return DEFAULT_MAX_ATTEMPTS;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 1 ? n : DEFAULT_MAX_ATTEMPTS;
}

function getBaseMs(envKey: string): number {
  const v = process.env[envKey];
  if (v === undefined || v === "") return DEFAULT_BASE_MS;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_BASE_MS;
}

export interface RetryOptions {
  maxAttempts?: number;
  baseMs?: number;
  /** If set, only retry when this returns true (e.g. rate limit, network). */
  isRetryable?: (err: unknown) => boolean;
}

/**
 * Run fn up to maxAttempts times with exponential backoff. Throws last error if all fail.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? getRetryMax("GTD_RETRY_MAX");
  const baseMs = options.baseMs ?? getBaseMs("GTD_RETRY_BASE_MS");
  const isRetryable = options.isRetryable ?? (() => true);
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (attempt === maxAttempts || !isRetryable(e)) throw e;
      const delay = baseMs * Math.pow(2, attempt - 1);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}

/** Options for LLM retries (GTD_RETRY_LLM_MAX, GTD_RETRY_BASE_MS). */
export function llmRetryOptions(): RetryOptions {
  return {
    maxAttempts: getRetryMax("GTD_RETRY_LLM_MAX"),
    baseMs: getBaseMs("GTD_RETRY_BASE_MS"),
    isRetryable(e) {
      const msg = e instanceof Error ? e.message : String(e);
      return /rate limit|timeout|ECONNRESET|ETIMEDOUT|503|429/i.test(msg);
    },
  };
}

/** Options for tool retries (GTD_RETRY_TOOLS_MAX, GTD_RETRY_BASE_MS). */
export function toolRetryOptions(): RetryOptions {
  return {
    maxAttempts: getRetryMax("GTD_RETRY_TOOLS_MAX"),
    baseMs: getBaseMs("GTD_RETRY_BASE_MS"),
    isRetryable(e) {
      const msg = e instanceof Error ? e.message : String(e);
      return /timeout|ECONNRESET|ETIMEDOUT|temporarily|eagain/i.test(msg);
    },
  };
}
