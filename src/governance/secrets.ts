/**
 * Secrets hygiene checks for config and environment.
 */

import type { GTDConfig } from "../storage/config.js";

const SENSITIVE_KEYS = /(?:api[_-]?key|secret|token|password|passwd|auth|credential)/i;

export interface SecretsCheckResult {
  warnings: string[];
  ok: boolean;
}

/**
 * Check config object for values that look like exposed secrets (e.g. keys in plain text).
 * Prefer storing secrets in environment variables, not in config files (A.4).
 */
export function checkConfigSecrets(cfg: GTDConfig): SecretsCheckResult {
  const warnings: string[] = [];
  const walk = (obj: unknown, path: string): void => {
    if (obj == null) return;
    if (typeof obj === "string") {
      if (SENSITIVE_KEYS.test(path) && obj.length > 8) {
        warnings.push(`Config key "${path}" may contain a secret (value length ${obj.length}). Prefer env vars.`);
      }
      return;
    }
    if (Array.isArray(obj)) {
      obj.forEach((v, i) => walk(v, `${path}[${i}]`));
      return;
    }
    if (typeof obj === "object") {
      for (const [k, v] of Object.entries(obj)) {
        walk(v, path ? `${path}.${k}` : k);
      }
    }
  };
  walk(cfg, "");
  return { warnings, ok: warnings.length === 0 };
}
