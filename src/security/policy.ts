/**
 * Permission modes and policy enforcement for tool execution.
 */

import { readFile } from "fs/promises";
import type { ToolPolicy, PermissionMode } from "../types/tooling.js";

const DEFAULT_POLICY: ToolPolicy = {
  mode: "default",
};

/**
 * Load a policy bundle from JSON file (toolOverrides, allowedPaths, deniedPaths, etc.).
 */
export async function loadPolicyBundle(path: string): Promise<ToolPolicy | null> {
  try {
    const raw = await readFile(path, "utf-8");
    const data = JSON.parse(raw) as Partial<ToolPolicy>;
    if (!data || typeof data !== "object") return null;
    return {
      mode: data.mode ?? "default",
      toolOverrides: data.toolOverrides,
      allowedPaths: data.allowedPaths,
      deniedPaths: data.deniedPaths,
      allowedCommands: data.allowedCommands,
      deniedCommands: data.deniedCommands,
    };
  } catch {
    return null;
  }
}

/**
 * Resolve effective policy from optional bundle, then runtime overrides.
 */
export function resolvePolicy(overrides?: Partial<ToolPolicy>, bundle?: ToolPolicy | null): ToolPolicy {
  const base = bundle ? { ...DEFAULT_POLICY, ...bundle } : DEFAULT_POLICY;
  return { ...base, ...overrides };
}

function allowListKey(toolName: string, category: string): string {
  return `${toolName}:${category}`;
}

/**
 * Check if a tool is allowed under the given policy.
 * Returns: "allow" | "deny" | "ask"
 */
export function checkToolPermission(
  toolName: string,
  category: "read" | "write" | "command" | "network" | "git" | "browser" | "mcp",
  policy: ToolPolicy
): "allow" | "deny" | "ask" {
  const override = policy.toolOverrides?.[toolName];
  if (override) return override;

  const key = allowListKey(toolName, category);
  if (policy.allowList?.session?.has(key) || policy.allowList?.project?.has(key)) return "allow";

  switch (policy.mode) {
    case "plan":
      return category === "read" ? "allow" : "deny";
    case "accept-edits":
      return category === "read" || category === "write" ? "allow" : "ask";
    case "dont-ask":
    case "bypass":
      return "allow";
    case "default":
    default:
      if (category === "browser" || category === "mcp") return "ask";
      return category === "read" ? "allow" : "ask";
  }
}

/**
 * Check if a file path is allowed under policy.
 */
export function checkPathPermission(path: string, policy: ToolPolicy, _operation: "read" | "write"): boolean {
  const normalized = path.replace(/\\/g, "/");
  if (policy.deniedPaths?.some((p) => matchGlob(normalized, p))) return false;
  if (policy.allowedPaths?.length && !policy.allowedPaths.some((p) => matchGlob(normalized, p))) return false;
  return true;
}

/**
 * Check if a shell command is allowed under policy.
 */
export function checkCommandPermission(command: string, policy: ToolPolicy): "allow" | "deny" | "ask" {
  const trimmed = command.trim();
  if (policy.deniedCommands?.some((p) => trimmed.startsWith(p) || new RegExp(p).test(trimmed))) return "deny";
  if (policy.allowedCommands?.length && !policy.allowedCommands.some((p) => trimmed.startsWith(p) || new RegExp(p).test(trimmed))) return "ask";
  return "allow";
}

function matchGlob(path: string, pattern: string): boolean {
  const re = pattern
    .replace(/\\/g, "/")
    .replace(/\*\*/g, "{{GLOBSTAR}}")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\{\{GLOBSTAR\}\}/g, ".*");
  return new RegExp(`^${re}$`).test(path);
}

export type { ToolPolicy, PermissionMode };
