/**
 * Session primitives for resume/fork and headless run.
 */

export interface Session {
  id: string;
  taskId: string;
  description: string;
  status: "pending" | "in_progress" | "blocked" | "completed" | "failed" | "cancelled";
  createdAt: string;
  /** Last active timestamp */
  updatedAt?: string;
  /** For fork: parent session id */
  forkedFrom?: string;
}
