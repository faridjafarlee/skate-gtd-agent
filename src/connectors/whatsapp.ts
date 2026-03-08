import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { runOrchestration } from "../orchestrator/loop.js";
import { saveTask, toStored } from "../storage/store.js";
import { loadConfig, getConfigForChannel } from "../storage/config.js";
import { v4 as uuidv4 } from "uuid";
import type { ChannelAdapter } from "./types.js";
import type { ConnectorMessage, NotificationEvent } from "../types/index.js";

const HELP = `
Send: task <description>
Example: task Write a hello world in TypeScript
`;

async function sendWhatsAppMessage(
  accessToken: string,
  phoneNumberId: string,
  to: string,
  text: string
): Promise<void> {
  const url = `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: to.replace(/\D/g, ""),
      type: "text",
      text: { preview_url: false, body: text },
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`WhatsApp API error ${res.status}: ${err}`);
  }
}

/** Exported for testing. Parses WhatsApp webhook payload into messages. */
export function extractWhatsAppMessages(payload: unknown): Array<{ from: string; text: string }> {
  const obj = payload as { object?: string; entry?: Array<{ changes?: Array<{ value?: { messages?: Array<{ from?: string; type?: string; text?: { body?: string } }> } }> }> };
  if (obj.object !== "whatsapp_business_account" || !Array.isArray(obj.entry)) return [];
  const out: Array<{ from: string; text: string }> = [];
  for (const entry of obj.entry) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      if (!value?.messages) continue;
      for (const msg of value.messages) {
        if (msg.type !== "text" || !msg.text?.body) continue;
        out.push({ from: msg.from ?? "", text: String(msg.text.body).trim() });
      }
    }
  }
  return out;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

export async function startWhatsAppBot(): Promise<void> {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN ?? "skate-verify";

  if (!accessToken || !phoneNumberId) {
    throw new Error(
      "WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID are required. Set up at developers.facebook.com."
    );
  }

  const port = parseInt(process.env.WHATSAPP_WEBHOOK_PORT ?? process.env.PORT ?? "3001", 10) || 3001;

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://localhost`);
    if (url.pathname !== "/webhook" && url.pathname !== "/webhook/") {
      res.writeHead(404);
      res.end();
      return;
    }

    if (req.method === "GET") {
      const mode = url.searchParams.get("hub.mode");
      const token = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");
      if (mode === "subscribe" && token === verifyToken && challenge) {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(challenge);
      } else {
        res.writeHead(403);
        res.end();
      }
      return;
    }

    if (req.method === "POST") {
      let body: string;
      try {
        body = await readBody(req);
      } catch {
        res.writeHead(400);
        res.end();
        return;
      }

      res.writeHead(200);
      res.end();

      let payload: unknown;
      try {
        payload = JSON.parse(body);
      } catch {
        return;
      }

      const messages = extractWhatsAppMessages(payload);
      for (const { from, text: raw } of messages) {
            const taskMatch = raw.match(/^task\s*:?\s*(.+)$/is);
            const text = taskMatch ? taskMatch[1].trim() : raw.toLowerCase().startsWith("task ") ? raw.slice(5).trim() : raw.startsWith("task:") ? raw.slice(5).trim() : "";
            if (!text || text.length < 3) {
              if (raw.toLowerCase() === "help" || raw === "?") {
                await sendWhatsAppMessage(accessToken, phoneNumberId, from, "Skate — GTD. Agent orchestration.\n\n" + HELP);
              }
              continue;
            }

            const cfg = getConfigForChannel(await loadConfig(), "whatsapp");
            const qualityProfile = cfg.qualityProfile ?? "balanced";
            const approvalPolicy = cfg.approvalPolicy ?? "auto";

            const taskId = uuidv4();
            await saveTask(toStored({
              id: taskId,
              description: text,
              source: "whatsapp",
              sourceId: from,
              qualityProfile,
              approvalPolicy,
              status: "in_progress",
            }));

            await sendWhatsAppMessage(accessToken, phoneNumberId, from, "Task received. Running Scout…");

            try {
              const result = await runOrchestration({
                taskId,
                taskDescription: text,
                qualityProfile,
                approvalPolicy,
                modelId: cfg.defaultModel ?? undefined,
              });

              const outputsRecord = Object.fromEntries(result.outputs);
              await saveTask(toStored({
                id: result.taskId,
                description: text,
                source: "whatsapp",
                sourceId: from,
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

              if (result.status === "completed") {
                const builderOut = result.outputs.get("builder");
                const reply = builderOut
                  ? `✓ Done.\n\n--- Deliverable ---\n${builderOut.slice(0, 3500)}${builderOut.length > 3500 ? "\n…" : ""}`
                  : "✓ Task completed.";
                await sendWhatsAppMessage(accessToken, phoneNumberId, from, reply);
              } else {
                await sendWhatsAppMessage(accessToken, phoneNumberId, from, `✗ ${result.status}: ${result.error ?? "Unknown"}`);
              }
            } catch (e) {
              const err = e instanceof Error ? e.message : String(e);
              await sendWhatsAppMessage(accessToken, phoneNumberId, from, `✗ Error: ${err}`);
              await saveTask(toStored({
                id: taskId,
                description: text,
                source: "whatsapp",
                sourceId: from,
                qualityProfile,
                approvalPolicy,
                status: "failed",
              }, { error: err, completedAt: new Date().toISOString() }));
            }
      }
    } else {
      res.writeHead(405);
      res.end();
    }
  });

  server.listen(port, () => {
    console.log(`WhatsApp webhook listening on port ${port}. Configure Meta webhook: https://your-domain/webhook, verify token: ${verifyToken}`);
  });
}

/**
 * Stub adapter for unified channel interface. Use startWhatsAppBot for real integration.
 */
export function createWhatsAppAdapter(): ChannelAdapter {
  return {
    channel: "whatsapp",

    async *receiveTask(): AsyncIterable<ConnectorMessage> {
      yield* [];
    },

    async sendMessage(channelId: string, _userId: string, text: string): Promise<void> {
      console.log(`[WhatsApp ${channelId}] ${text}`);
    },

    async sendNotification(event: NotificationEvent): Promise<void> {
      console.log(`[WhatsApp notification] ${event.type}: ${event.message}`);
    },

    async requestApproval(_channelId: string, _userId: string, message: string): Promise<boolean> {
      console.log(`[WhatsApp approval] ${message}`);
      return false;
    },

    async requestClarification(_channelId: string, _userId: string, message: string): Promise<string | null> {
      console.log(`[WhatsApp clarification] ${message}`);
      return null;
    },
  };
}
