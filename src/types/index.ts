/**
 * Core type contracts for Skate orchestration.
 */

export type RiskLevel = "low" | "medium" | "high" | "critical";

export type ApprovalPolicy = "auto" | "hybrid" | "always";

export type QualityProfile = "fast" | "balanced" | "max";

export type AgentStatus = "idle" | "running" | "done" | "error";

export type OrchestratorPhase =
  | "ingest"
  | "classify"
  | "select_roles"
  | "draft_plan"
  | "approval_gate"
  | "execute"
  | "verify"
  | "report";

export interface Task {
  id: string;
  description: string;
  source: "cli" | "telegram" | "slack" | "whatsapp" | "signal" | "discord" | "matrix" | "webhook" | "email" | "mcp";
  sourceId?: string;
  tags?: string[];
  createdAt: Date;
  qualityProfile: QualityProfile;
  approvalPolicy: ApprovalPolicy;
  status: "pending" | "in_progress" | "blocked" | "completed" | "failed" | "cancelled";
  plan?: Plan;
}

export interface Plan {
  id: string;
  taskId: string;
  steps: Step[];
  estimatedRisk: RiskLevel;
  createdAt: Date;
}

export interface Step {
  id: string;
  planId: string;
  order: number;
  description: string;
  assignedRole: AgentRole;
  riskLevel: RiskLevel;
  status: "pending" | "approved" | "running" | "done" | "failed";
  requiresApproval: boolean;
  /** Optional 0-based index into workspace roots (K-25). When set, Builder can run this step's work in that root. */
  workspaceRootIndex?: number;
}

export type AgentRole =
  | "scout"
  | "planner"
  | "builder"
  | "reviewer"
  | "documenter"
  | "red_team";

export interface AgentRoleDef {
  id: AgentRole;
  name: string;
  description: string;
  capabilities: string[];
}

export interface NotificationEvent {
  type: "milestone" | "approval_required" | "clarification_needed" | "error";
  taskId: string;
  message: string;
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

export interface ConnectorMessage {
  channel: "cli" | "telegram" | "slack" | "whatsapp" | "signal" | "matrix";
  channelId: string;
  userId: string;
  text: string;
  timestamp: Date;
}
