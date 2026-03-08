/**
 * Client for remote GTD serve --api (cloud tasks).
 * Set GTD_CLOUD_URL (e.g. https://gtd.example.com) and optionally GTD_CLOUD_API_KEY for auth.
 */

export interface CloudTaskSummary {
  id: string;
  description: string;
  status: string;
  createdAt?: string;
}

export interface CloudTaskDetail extends CloudTaskSummary {
  plan?: unknown;
  outputs?: Record<string, string>;
  error?: string;
  updatedAt?: string;
  usage?: unknown;
  usageByModel?: unknown;
  toolCalls?: Record<string, number>;
  estimatedCost?: number;
}

function getBaseUrl(): string {
  const url = process.env.GTD_CLOUD_URL?.trim();
  if (!url) throw new Error("GTD_CLOUD_URL is not set. Set it to the cloud API base URL (e.g. https://gtd.example.com).");
  return url.replace(/\/$/, "");
}

function getAuthHeaders(): Record<string, string> {
  const key = process.env.GTD_CLOUD_API_KEY?.trim() || process.env.GTD_API_KEY?.trim();
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (key) h["Authorization"] = `Bearer ${key}`;
  return h;
}

async function cloudFetch<T>(path: string, options?: { method?: string; body?: string; headers?: Record<string, string> }): Promise<{ data?: T; status: number; error?: string }> {
  const base = getBaseUrl();
  const url = path.startsWith("http") ? path : `${base}${path.startsWith("/") ? path : "/" + path}`;
  const headers = { ...getAuthHeaders(), ...options?.headers };
  try {
    const res = await fetch(url, {
      method: options?.method ?? "GET",
      headers,
      body: options?.body,
    });
    const text = await res.text();
    let data: T | undefined;
    if (text) {
      try {
        data = JSON.parse(text) as T;
      } catch {
        return { status: res.status, error: text || res.statusText };
      }
    }
    if (!res.ok) {
      const err = data && typeof data === "object" && "error" in data ? String((data as { error: string }).error) : text || res.statusText;
      return { status: res.status, error: err };
    }
    return { data, status: res.status };
  } catch (e) {
    return { status: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * List tasks from the cloud API.
 */
export async function cloudListTasks(opts?: { limit?: number; status?: string }): Promise<{ tasks: CloudTaskSummary[] }> {
  const limit = Math.min(50, opts?.limit ?? 20);
  const status = opts?.status;
  const q = new URLSearchParams();
  q.set("limit", String(limit));
  if (status) q.set("status", status);
  const { data, error, status: code } = await cloudFetch<{ tasks: CloudTaskSummary[] }>(`/api/tasks?${q.toString()}`);
  if (error || !data) throw new Error(error ?? `Request failed (${code})`);
  return { tasks: data.tasks ?? [] };
}

/**
 * Get one task by ID from the cloud API.
 */
export async function cloudGetTask(taskId: string): Promise<CloudTaskDetail> {
  const { data, error, status: code } = await cloudFetch<CloudTaskDetail>(`/api/tasks/${encodeURIComponent(taskId)}`);
  if (error || !data) throw new Error(error ?? `Request failed (${code})`);
  if ("error" in data && typeof (data as { error?: string }).error === "string") throw new Error((data as { error: string }).error);
  return data;
}

export interface CloudExecOptions {
  env?: string;
  taskId?: string;
}

/**
 * Create and run a task on the cloud API. Returns taskId.
 */
export async function cloudExecTask(description: string, opts?: CloudExecOptions): Promise<{ taskId: string }> {
  const body: Record<string, unknown> = { description };
  if (opts?.taskId) body.taskId = opts.taskId;
  if (opts?.env) body.env = opts.env;
  const headers = getAuthHeaders();
  if (opts?.env) (headers as Record<string, string>)["X-GTD-Env"] = opts.env;
  const { data, error, status: code } = await cloudFetch<{ taskId: string }>("/api/tasks", {
    method: "POST",
    body: JSON.stringify(body),
    headers,
  });
  if (error || !data) throw new Error(error ?? `Request failed (${code})`);
  if (!data.taskId) throw new Error("Cloud API did not return taskId");
  return { taskId: data.taskId };
}

export function getCloudUrl(): string | undefined {
  return process.env.GTD_CLOUD_URL?.trim() || undefined;
}
