/**
 * CC-5: Webhook on task state change.
 * When GTD_WEBHOOK_URL is set, POST JSON when a task becomes blocked, completed, or failed.
 * When GTD_POST_STEP_WEBHOOK_URL is set, POST JSON after each step (post_step phase).
 */

export type TaskStateChangeStatus = "blocked" | "completed" | "failed";

export interface TaskStateChangePayload {
  taskId: string;
  status: TaskStateChangeStatus;
  outputs?: Record<string, string>;
  error?: string;
}

/** Payload sent to GTD_POST_STEP_WEBHOOK_URL after each step. */
export interface PostStepPayload {
  phase: "post_step";
  taskId: string;
  taskDescription: string;
  role: string;
  stepIndex: number;
  totalSteps: number;
  outputPreview?: string;
  planStepId?: string;
}

export async function notifyTaskStateChange(payload: TaskStateChangePayload): Promise<void> {
  const url = process.env.GTD_WEBHOOK_URL;
  if (!url || typeof url !== "string" || !url.startsWith("http")) return;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      console.error(`[GTD] Webhook ${url} returned ${res.status}`);
    }
  } catch (e) {
    console.error("[GTD] Webhook failed:", e instanceof Error ? e.message : String(e));
  }
}

/** POST to GTD_POST_STEP_WEBHOOK_URL after each step; no-op if unset. Fire-and-forget with 10s timeout. */
export async function notifyPostStep(payload: PostStepPayload): Promise<void> {
  const url = process.env.GTD_POST_STEP_WEBHOOK_URL;
  if (!url || typeof url !== "string" || !url.startsWith("http")) return;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      console.error(`[GTD] Post-step webhook ${url} returned ${res.status}`);
    }
  } catch (e) {
    console.error("[GTD] Post-step webhook failed:", e instanceof Error ? e.message : String(e));
  }
}
