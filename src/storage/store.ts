import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import type { Task, Plan } from "../types/index.js";

function getDataDirPath(): string {
  return process.env.GTD_DATA_DIR ?? join(homedir(), ".skate");
}

function getTasksFilePath(): string {
  return join(getDataDirPath(), "tasks.json");
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface StoredTask {
  id: string;
  description: string;
  source: Task["source"];
  sourceId?: string;
  tags?: string[];
  createdAt: string;
  updatedAt?: string;
  qualityProfile: Task["qualityProfile"];
  approvalPolicy: Task["approvalPolicy"];
  status: Task["status"];
  plan?: Plan;
  completedAt?: string;
  error?: string;
  outputs?: Record<string, string>;
  usage?: TokenUsage;
  usageByModel?: Record<string, TokenUsage>;
  /** Tool name -> call count (Builder phase; CC-21). */
  toolCalls?: Record<string, number>;
}

/** Thrown when saveTask detects a concurrent update (optimistic concurrency). */
export class TaskConflictError extends Error {
  constructor(public readonly taskId: string) {
    super(`Task ${taskId} was modified by another process; retry or refresh.`);
    this.name = "TaskConflictError";
  }
}

async function ensureDir(): Promise<void> {
  await mkdir(getDataDirPath(), { recursive: true });
}

async function readTasks(): Promise<StoredTask[]> {
  await ensureDir();
  try {
    const raw = await readFile(getTasksFilePath(), "utf-8");
    const data = JSON.parse(raw) as StoredTask[];
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function writeTasks(tasks: StoredTask[]): Promise<void> {
  await ensureDir();
  await writeFile(getTasksFilePath(), JSON.stringify(tasks, null, 2), "utf-8");
}

/** Clear all tasks (tasks.json). */
export async function clearTasks(): Promise<void> {
  await writeTasks([]);
}

export function toStored(
  task: Partial<Task> & { id: string },
  extras?: { completedAt?: string; error?: string; outputs?: Record<string, string>; usage?: TokenUsage; usageByModel?: Record<string, TokenUsage>; toolCalls?: Record<string, number> }
): StoredTask {
  return {
    id: task.id,
    description: task.description ?? "",
    source: task.source ?? "cli",
    sourceId: task.sourceId,
    tags: task.tags?.length ? task.tags : undefined,
    createdAt: (task.createdAt instanceof Date ? task.createdAt : new Date()).toISOString(),
    qualityProfile: task.qualityProfile ?? "balanced",
    approvalPolicy: task.approvalPolicy ?? "hybrid",
    status: task.status ?? "pending",
    plan: task.plan,
    completedAt: extras?.completedAt,
    error: extras?.error,
    outputs: extras?.outputs,
    usage: extras?.usage,
    usageByModel: extras?.usageByModel,
    toolCalls: extras?.toolCalls,
  };
}

export interface SaveTaskOptions {
  /** If set, save fails when the existing task's updatedAt differs (optimistic concurrency). */
  expectedUpdatedAt?: string;
}

export async function saveTask(stored: StoredTask, options?: SaveTaskOptions): Promise<void> {
  const tasks = await readTasks();
  const idx = tasks.findIndex((t) => t.id === stored.id);
  const now = new Date().toISOString();
  if (idx >= 0) {
    const existing = tasks[idx];
    if (options?.expectedUpdatedAt != null && existing.updatedAt != null && existing.updatedAt !== options.expectedUpdatedAt) {
      throw new TaskConflictError(stored.id);
    }
    tasks[idx] = { ...stored, updatedAt: now };
  } else {
    tasks.push({ ...stored, updatedAt: now });
  }
  await writeTasks(tasks);
}

export async function getTask(id: string): Promise<StoredTask | undefined> {
  const tasks = await readTasks();
  return tasks.find((t) => t.id === id);
}

/** Delete a task by id. Returns true if deleted, false if not found. */
export async function deleteTask(id: string): Promise<boolean> {
  const tasks = await readTasks();
  const idx = tasks.findIndex((t) => t.id === id);
  if (idx < 0) return false;
  tasks.splice(idx, 1);
  await writeTasks(tasks);
  return true;
}

export async function listTasks(opts?: {
  status?: StoredTask["status"];
  tags?: string[];
  limit?: number;
  after?: string;
}): Promise<StoredTask[]> {
  let tasks = await readTasks();
  if (opts?.status) {
    tasks = tasks.filter((t) => t.status === opts.status);
  }
  if (opts?.tags?.length) {
    tasks = tasks.filter((t) => {
      const tTags = t.tags ?? [];
      return opts!.tags!.every((tag) => tTags.some((tt) => tt.toLowerCase() === tag.toLowerCase()));
    });
  }
  if (opts?.after) {
    const afterMs = new Date(opts.after).getTime();
    tasks = tasks.filter((t) => new Date(t.createdAt).getTime() >= afterMs);
  }
  tasks.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  if (opts?.limit) {
    tasks = tasks.slice(0, opts.limit);
  }
  return tasks;
}

export interface SearchOptions {
  query?: string;
  status?: StoredTask["status"];
  tags?: string[];
  after?: string;
  limit?: number;
}

export async function searchTasks(opts: SearchOptions): Promise<StoredTask[]> {
  let tasks = await readTasks();
  if (opts.query) {
    const q = opts.query.toLowerCase();
    tasks = tasks.filter((t) => t.description.toLowerCase().includes(q));
  }
  if (opts.status) {
    tasks = tasks.filter((t) => t.status === opts.status);
  }
  if (opts.tags?.length) {
    tasks = tasks.filter((t) => {
      const tTags = t.tags ?? [];
      return opts.tags!.every((tag) => tTags.some((tt) => tt.toLowerCase() === tag.toLowerCase()));
    });
  }
  if (opts.after) {
    const afterMs = new Date(opts.after).getTime();
    tasks = tasks.filter((t) => new Date(t.createdAt).getTime() >= afterMs);
  }
  tasks.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const limit = opts.limit ?? 50;
  return tasks.slice(0, limit);
}

export function getDataDir(): string {
  return getDataDirPath();
}

export interface UsageSummary {
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTasks: number;
  byModel: Record<string, { promptTokens: number; completionTokens: number; tasks: number }>;
}

export async function getUsageSummary(opts?: { limit?: number; after?: string }): Promise<UsageSummary> {
  let tasks = await readTasks();
  if (opts?.after) {
    const afterMs = new Date(opts.after).getTime();
    tasks = tasks.filter((t) => new Date(t.createdAt).getTime() >= afterMs);
  }
  tasks.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  if (opts?.limit) tasks = tasks.slice(0, opts.limit);

  const summary: UsageSummary = {
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalTasks: 0,
    byModel: {},
  };

  for (const t of tasks) {
    if (!t.usage && !t.usageByModel) continue;
    summary.totalTasks++;
    if (t.usage) {
      summary.totalPromptTokens += t.usage.promptTokens;
      summary.totalCompletionTokens += t.usage.completionTokens;
    }
    if (t.usageByModel) {
      for (const [model, u] of Object.entries(t.usageByModel)) {
        const existing = summary.byModel[model];
        if (existing) {
          existing.promptTokens += u.promptTokens;
          existing.completionTokens += u.completionTokens;
          existing.tasks++;
        } else {
          summary.byModel[model] = { promptTokens: u.promptTokens, completionTokens: u.completionTokens, tasks: 1 };
        }
      }
    }
  }

  return summary;
}

function isValidStoredTask(obj: unknown): obj is StoredTask {
  if (!obj || typeof obj !== "object") return false;
  const o = obj as Record<string, unknown>;
  const tagsOk = o.tags === undefined || (Array.isArray(o.tags) && o.tags.every((x) => typeof x === "string"));
  const usageOk = o.usage === undefined || (typeof o.usage === "object" && o.usage !== null && typeof (o.usage as Record<string, unknown>).promptTokens === "number" && typeof (o.usage as Record<string, unknown>).completionTokens === "number");
  const usageByModelOk = o.usageByModel === undefined || (typeof o.usageByModel === "object" && o.usageByModel !== null && !Array.isArray(o.usageByModel));
  const updatedAtOk = o.updatedAt === undefined || typeof o.updatedAt === "string";
  return (
    typeof o.id === "string" &&
    typeof o.description === "string" &&
    updatedAtOk &&
    ["cli", "telegram", "slack", "whatsapp", "signal", "discord", "matrix"].includes(String(o.source ?? "cli")) &&
    tagsOk &&
    usageOk &&
    usageByModelOk &&
    typeof o.createdAt === "string" &&
    ["fast", "balanced", "max"].includes(String(o.qualityProfile ?? "balanced")) &&
    ["auto", "hybrid", "always"].includes(String(o.approvalPolicy ?? "hybrid")) &&
    ["pending", "in_progress", "blocked", "completed", "failed", "cancelled"].includes(String(o.status ?? "pending"))
  );
}

export interface ImportResult {
  imported: number;
  skipped: number;
  errors: string[];
}

export async function importTasks(
  filePath: string,
  opts: { mode?: "merge" | "replace"; dryRun?: boolean }
): Promise<ImportResult> {
  const { readFile } = await import("fs/promises");
  const raw = await readFile(filePath, "utf-8");
  const data = JSON.parse(raw);
  if (!Array.isArray(data)) {
    throw new Error("Import file must contain a JSON array of tasks");
  }

  const result: ImportResult = { imported: 0, skipped: 0, errors: [] };
  const valid: StoredTask[] = [];

  for (let i = 0; i < data.length; i++) {
    if (!isValidStoredTask(data[i])) {
      result.errors.push(`Task ${i + 1}: invalid structure (missing id, description, or invalid fields)`);
      result.skipped++;
      continue;
    }
    valid.push(data[i] as StoredTask);
  }

  if (opts.dryRun) {
    result.imported = valid.length;
    return result;
  }

  const existingIds = new Set((await readTasks()).map((t) => t.id));
  const toWrite = opts.mode === "replace" ? [] : await readTasks();

  for (const t of valid) {
    if (opts.mode === "merge" && existingIds.has(t.id)) {
      result.skipped++;
      continue;
    }
    if (opts.mode === "merge") existingIds.add(t.id);
    toWrite.push(t);
    result.imported++;
  }

  if (opts.mode === "replace" || result.imported > 0) {
    toWrite.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    await writeTasks(toWrite);
  }

  return result;
}
