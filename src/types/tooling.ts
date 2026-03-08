/**
 * Tool schema and execution contracts for model-invoked tools.
 */

export interface ToolParameter {
  type: "string" | "number" | "boolean" | "array" | "object";
  description?: string;
  enum?: string[];
  default?: unknown;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, ToolParameter>;
  /** Tool category for policy grouping */
  category: "read" | "write" | "command" | "network" | "git" | "browser" | "mcp";
}

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

/** Risk level for tool result (agent-trends 40). */
export type ToolResultRiskLevel = "low" | "medium" | "high" | "critical";

export interface ToolResult {
  success: boolean;
  output?: string;
  error?: string;
  /** When approval is required and not yet granted */
  requiresApproval?: boolean;
  /** Risk level of this tool/call for observability (agent-trends 40). */
  riskLevel?: ToolResultRiskLevel;
  /** Optional safety note (e.g. command was sanitized, or risk classification). */
  safetyNote?: string;
}

export type PermissionMode = "default" | "plan" | "accept-edits" | "dont-ask" | "bypass";

/** Keys are "toolName:category". When present, "ask" is treated as allow (don't ask again). */
export interface ToolAllowList {
  session: Set<string>;
  project: Set<string>;
}

export interface ToolPolicy {
  mode: PermissionMode;
  /** Per-tool overrides: allow | deny | ask */
  toolOverrides?: Record<string, "allow" | "deny" | "ask">;
  /** Don't ask again: session (in-memory) and project (.gtd/allow.json) keys */
  allowList?: ToolAllowList;
  /** Allowed paths for file operations (glob patterns) */
  allowedPaths?: string[];
  /** Denied paths */
  deniedPaths?: string[];
  /** Allowed command patterns (regex or prefix) */
  allowedCommands?: string[];
  /** Denied command patterns */
  deniedCommands?: string[];
}
