/**
 * MCP server that exposes Skate as tools (dev plan 100).
 * Run with: skate mcp serve (or gtd mcp serve)
 * Listens on stdio for JSON-RPC: initialize, tools/list, tools/call.
 * Tools: gtd_create_task, gtd_approve, gtd_show, gtd_list_tasks, gtd_retry
 */

import { createInterface } from "readline";
import { getTask, listTasks, saveTask, toStored } from "../storage/store.js";
import { loadConfig } from "../storage/config.js";
import { runOrchestration } from "../orchestrator/loop.js";
import { approveTask, runTask } from "../cli/task-handler.js";
import { v4 as uuidv4 } from "uuid";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_NAME = "skate";
const SERVER_VERSION = "0.2.0";

export const MCP_TOOLS = [
  {
    name: "gtd_create_task",
    description: "Create a new GTD task. Optionally run it in the background.",
    inputSchema: {
      type: "object" as const,
      properties: {
        description: { type: "string", description: "Task description (required)" },
        taskId: { type: "string", description: "Optional task ID (UUID); generated if omitted" },
        run: { type: "boolean", description: "If true, start running the task in the background and return taskId immediately" },
      },
      required: ["description"],
    },
  },
  {
    name: "gtd_approve",
    description: "Approve a blocked task and resume execution.",
    inputSchema: {
      type: "object" as const,
      properties: {
        task_id: { type: "string", description: "Task ID or short prefix (e.g. first 8 chars)" },
      },
      required: ["task_id"],
    },
  },
  {
    name: "gtd_show",
    description: "Get task details by ID (or prefix).",
    inputSchema: {
      type: "object" as const,
      properties: {
        task_id: { type: "string", description: "Task ID or short prefix" },
      },
      required: ["task_id"],
    },
  },
  {
    name: "gtd_list_tasks",
    description: "List tasks with optional status filter.",
    inputSchema: {
      type: "object" as const,
      properties: {
        status: { type: "string", description: "Optional: pending | in_progress | blocked | completed | failed | cancelled" },
        limit: { type: "number", description: "Max tasks to return (default 20)" },
      },
    },
  },
  {
    name: "gtd_retry",
    description: "Retry a failed task from the last completed step.",
    inputSchema: {
      type: "object" as const,
      properties: {
        task_id: { type: "string", description: "Task ID or short prefix" },
      },
      required: ["task_id"],
    },
  },
];

async function resolveTaskId(idArg: string): Promise<{ id: string } | null> {
  let task = await getTask(idArg);
  if (!task) {
    const tasks = await listTasks({ limit: 50 });
    task = tasks.find((t) => t.id.startsWith(idArg) || t.id === idArg) ?? undefined;
  }
  return task ? { id: task.id } : null;
}

async function handleToolCall(name: string, args: Record<string, unknown>): Promise<{ content: string; isError?: boolean }> {
  try {
    switch (name) {
      case "gtd_create_task": {
        const description = typeof args.description === "string" ? args.description.trim() : "";
        if (!description) {
          return { content: JSON.stringify({ success: false, error: "description is required" }), isError: true };
        }
        const taskId = typeof args.taskId === "string" && args.taskId ? args.taskId : uuidv4();
        const run = args.run === true;
        await saveTask(toStored({ id: taskId, description, source: "mcp", status: "pending" }));
        if (run) {
          runTask(description, { taskId, auto: true, quiet: true }).catch(() => {});
        }
        return { content: JSON.stringify({ success: true, taskId, run }) };
      }
      case "gtd_approve": {
        const taskIdArg = typeof args.task_id === "string" ? args.task_id.trim() : "";
        if (!taskIdArg) {
          return { content: JSON.stringify({ success: false, error: "task_id is required" }), isError: true };
        }
        const resolved = await resolveTaskId(taskIdArg);
        if (!resolved) {
          return { content: JSON.stringify({ success: false, error: `Task ${taskIdArg} not found` }), isError: true };
        }
        const result = await approveTask(resolved.id, { quiet: true });
        return {
          content: JSON.stringify({
            success: result.success,
            taskId: result.taskId,
            status: result.status,
            error: result.error,
          }),
          isError: !result.success,
        };
      }
      case "gtd_show": {
        const taskIdArg = typeof args.task_id === "string" ? args.task_id.trim() : "";
        if (!taskIdArg) {
          return { content: JSON.stringify({ success: false, error: "task_id is required" }), isError: true };
        }
        const task = await getTask(taskIdArg);
        const found = task ?? (await listTasks({ limit: 50 })).find((t) => t.id.startsWith(taskIdArg) || t.id === taskIdArg);
        if (!found) {
          return { content: JSON.stringify({ success: false, error: `Task ${taskIdArg} not found` }), isError: true };
        }
        const payload = {
          id: found.id,
          description: found.description,
          status: found.status,
          plan: found.plan,
          outputs: found.outputs,
          error: found.error,
          createdAt: found.createdAt,
          updatedAt: found.updatedAt,
        };
        return { content: JSON.stringify(payload) };
      }
      case "gtd_list_tasks": {
        const statusOpt = typeof args.status === "string" && args.status ? args.status : undefined;
        const validStatuses = ["pending", "in_progress", "blocked", "completed", "failed", "cancelled"] as const;
        const status = statusOpt && validStatuses.includes(statusOpt as typeof validStatuses[number])
          ? (statusOpt as typeof validStatuses[number])
          : undefined;
        const limit = typeof args.limit === "number" && args.limit > 0 ? Math.min(50, args.limit) : 20;
        const tasks = await listTasks({ status, limit });
        const list = tasks.map((t) => ({ id: t.id, description: t.description, status: t.status, createdAt: t.createdAt }));
        return { content: JSON.stringify({ tasks: list }) };
      }
      case "gtd_retry": {
        const taskIdArg = typeof args.task_id === "string" ? args.task_id.trim() : "";
        if (!taskIdArg) {
          return { content: JSON.stringify({ success: false, error: "task_id is required" }), isError: true };
        }
        const resolved = await resolveTaskId(taskIdArg);
        if (!resolved) {
          return { content: JSON.stringify({ success: false, error: `Task ${taskIdArg} not found` }), isError: true };
        }
        const task = await getTask(resolved.id);
        if (!task) {
          return { content: JSON.stringify({ success: false, error: "Task not found" }), isError: true };
        }
        if (task.status === "blocked") {
          const result = await approveTask(resolved.id, { quiet: true });
          return {
            content: JSON.stringify({ success: result.success, taskId: result.taskId, status: result.status, error: result.error }),
            isError: !result.success,
          };
        }
        if (task.status !== "failed") {
          return {
            content: JSON.stringify({ success: false, error: `Task is not failed (status: ${task.status}). Use gtd_approve for blocked.` }),
            isError: true,
          };
        }
        if (!task.outputs || !task.plan) {
          return { content: JSON.stringify({ success: false, error: "Task missing outputs or plan" }), isError: true };
        }
        const cfg = await loadConfig();
        const result = await runOrchestration({
          taskId: task.id,
          taskDescription: task.description,
          qualityProfile: task.qualityProfile,
          approvalPolicy: "auto",
          resumeFrom: { outputs: task.outputs, plan: task.plan },
          modelOverrides: cfg.modelOverrides,
        });
        const outputsRecord = Object.fromEntries(result.outputs);
        await saveTask(toStored({
          id: result.taskId,
          description: task.description,
          source: task.source,
          sourceId: task.sourceId,
          qualityProfile: task.qualityProfile,
          approvalPolicy: task.approvalPolicy,
          status: result.status,
          plan: result.plan,
        }, {
          completedAt: new Date().toISOString(),
          error: result.error,
          outputs: outputsRecord,
          usage: result.usage,
          usageByModel: result.usageByModel,
        }));
        return {
          content: JSON.stringify({
            success: result.status === "completed",
            taskId: result.taskId,
            status: result.status,
            error: result.error,
          }),
          isError: result.status !== "completed",
        };
      }
      default:
        return { content: JSON.stringify({ success: false, error: `Unknown tool: ${name}` }), isError: true };
    }
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    return { content: JSON.stringify({ success: false, error: err }), isError: true };
  }
}

export function runGtdMcpServer(): void {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  const send = (obj: Record<string, unknown>): void => {
    process.stdout.write(JSON.stringify(obj) + "\n");
  };

  rl.on("line", (line) => {
    const raw = line.trim();
    if (!raw) return;
    let msg: { id?: number; method?: string; params?: Record<string, unknown> };
    try {
      msg = JSON.parse(raw) as typeof msg;
    } catch {
      return;
    }
    if (msg.method === "notifications/initialized") return;

    if (msg.method === "initialize" && msg.id != null) {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          capabilities: { tools: {} },
        },
      });
      return;
    }

    if (msg.method === "tools/list" && msg.id != null) {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          tools: MCP_TOOLS.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        },
      });
      return;
    }

    if (msg.method === "tools/call" && msg.id != null) {
      const params = msg.params as { name?: string; arguments?: Record<string, unknown> } | undefined;
      const name = params?.name ?? "";
      const args = (params?.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments))
        ? params.arguments as Record<string, unknown>
        : {};
      handleToolCall(name, args).then(({ content, isError }) => {
        send({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            content: [{ type: "text", text: content }],
            isError: isError === true,
          },
        });
      }).catch((e) => {
        const err = e instanceof Error ? e.message : String(e);
        send({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            content: [{ type: "text", text: JSON.stringify({ success: false, error: err }) }],
            isError: true,
          },
        });
      });
      return;
    }
  });

  rl.on("close", () => process.exit(0));
}
