import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { runOrchestration } from "../orchestrator/loop.js";
import { saveTask, toStored } from "../storage/store.js";
import { loadConfig, getConfigForChannel } from "../storage/config.js";
import { loadAndApplyModelsConfig } from "../storage/models-config.js";
import { v4 as uuidv4 } from "uuid";
import { withTimeout, getConnectorTaskTimeoutMs } from "./timeout.js";

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

export async function startWebhookServer(): Promise<void> {
  const port = parseInt(process.env.WEBHOOK_PORT ?? process.env.PORT ?? "3002", 10) || 3002;
  const apiKey = process.env.GTD_WEBHOOK_API_KEY;

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://localhost`);
    if (url.pathname === "/health" || url.pathname === "/health/") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", service: "gtd-webhook" }));
      return;
    }
    if (url.pathname !== "/webhook" && url.pathname !== "/webhook/") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }

    if (apiKey) {
      const auth = req.headers.authorization;
      const token = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : null;
      if (token !== apiKey) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
    }

    let body: string;
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Bad request" }));
      return;
    }

    let payload: { description?: string; source?: string };
    try {
      payload = JSON.parse(body) as { description?: string; source?: string };
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    const description = payload.description?.trim();
    if (!description) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing description" }));
      return;
    }

    const source: "webhook" | "cli" | "telegram" | "slack" | "whatsapp" | "signal" | "discord" | "matrix" | "email" =
      (payload.source && ["cli", "telegram", "slack", "whatsapp", "signal", "discord", "matrix", "webhook", "email"].includes(payload.source))
        ? payload.source as "webhook" | "cli" | "telegram" | "slack" | "whatsapp" | "signal" | "discord" | "matrix" | "email"
        : "webhook";

    const taskId = uuidv4();
    res.writeHead(202, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ accepted: true, message: "Task queued", taskId }));

    (async () => {
      await loadAndApplyModelsConfig();
      const cfg = getConfigForChannel(await loadConfig(), "webhook");
      const qualityProfile = (cfg.qualityProfile ?? "balanced") as "fast" | "balanced" | "max";
      const approvalPolicy = cfg.approvalPolicy ?? "hybrid";

      await saveTask(toStored({
        id: taskId,
        description,
        source,
        qualityProfile,
        approvalPolicy,
        status: "in_progress",
      }));

      try {
        const timeoutMs = getConnectorTaskTimeoutMs();
        const result = await withTimeout(runOrchestration({
          taskId,
          taskDescription: description,
          qualityProfile,
          approvalPolicy,
          dryRun: false,
        }), timeoutMs);

        const outputsRecord = Object.fromEntries(result.outputs);
        await saveTask(toStored({
          id: result.taskId,
          description,
          source,
          qualityProfile,
          approvalPolicy,
          status: result.status,
          plan: result.plan,
        }, {
          completedAt: new Date().toISOString(),
          error: result.error,
          outputs: outputsRecord,
          usage: result.usage,
          usageByModel: result.usageByModel,
        }));
      } catch (e) {
        await saveTask(toStored({
          id: taskId,
          description,
          source,
          qualityProfile,
          approvalPolicy,
          status: "failed",
        }, {
          error: e instanceof Error ? e.message : String(e),
          completedAt: new Date().toISOString(),
        }));
      }
    })();
  });

  server.listen(port, () => {
    console.log(`Webhook server: http://localhost:${port}/webhook`);
  });
}
