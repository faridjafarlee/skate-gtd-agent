/**
 * Structured verify output (agent-trends 49): parse lint/test stdout into pass/fail + violations.
 */

export interface VerifyViolation {
  file?: string;
  line?: number;
  column?: number;
  message: string;
  rule?: string;
}

export interface VerifyOutput {
  passed: boolean;
  violations: VerifyViolation[];
  raw: string;
}

/**
 * Parse lint or test output into structured form for reliable parsing.
 * Tries ESLint JSON (--format json), then line-based patterns (file:line: message).
 */
export function parseVerifyOutput(raw: string): VerifyOutput {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { passed: true, violations: [], raw };
  }

  // Try ESLint JSON format
  try {
    const data = JSON.parse(trimmed) as unknown;
    if (Array.isArray(data)) {
      const violations: VerifyViolation[] = (data as Array<{ filePath?: string; line?: number; column?: number; message?: string; ruleId?: string }>).map(
        (e) => ({
          file: e.filePath,
          line: e.line,
          column: e.column,
          message: e.message ?? "Lint error",
          rule: e.ruleId,
        })
      );
      return { passed: violations.length === 0, violations, raw };
    }
    if (data && typeof data === "object" && "results" in data && Array.isArray((data as { results: unknown }).results)) {
      const results = (data as { results: Array<{ filePath?: string; messages?: Array<{ line?: number; column?: number; message?: string; ruleId?: string }> }> }).results;
      const violations: VerifyViolation[] = [];
      for (const r of results) {
        for (const m of r.messages ?? []) {
          violations.push({
            file: r.filePath,
            line: m.line,
            column: m.column,
            message: m.message ?? "Lint error",
            rule: m.ruleId,
          });
        }
      }
      return { passed: violations.length === 0, violations, raw };
    }
  } catch {
    // not JSON, try line-based
  }

  // Line-based: path:line:col? message or path(line,col): message
  const violations: VerifyViolation[] = [];
  const lineRe = /^(.+?):(\d+)(?::(\d+))?\s*:?\s*(.+)$/;
  for (const line of trimmed.split(/\r?\n/)) {
    const m = line.match(lineRe);
    if (m) {
      violations.push({
        file: m[1],
        line: parseInt(m[2], 10),
        column: m[3] ? parseInt(m[3], 10) : undefined,
        message: m[4].trim(),
        rule: undefined,
      });
    }
  }

  return {
    passed: violations.length === 0,
    violations,
    raw,
  };
}

/** Format structured verify output for model consumption (agent-trends 49). */
export function formatVerifyForModel(verify: VerifyOutput, kind: "lint" | "test"): string {
  if (verify.passed) return `[${kind}] passed.`;
  const header = `[${kind}] failed. passed: false, violations: ${verify.violations.length}`;
  const lines = verify.violations.slice(0, 50).map((v) => {
    const loc = [v.file, v.line, v.column].filter((x) => x != null).join(":");
    return loc ? `${loc} ${v.message}` : v.message;
  });
  return `${header}\n${lines.join("\n")}${verify.violations.length > 50 ? "\n... (more)" : ""}\n\nRaw output:\n${verify.raw.slice(0, 4000)}`;
}
