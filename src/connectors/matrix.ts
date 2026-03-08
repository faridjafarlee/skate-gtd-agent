import {
  MatrixClient,
  SimpleFsStorageProvider,
  AutojoinRoomsMixin,
} from "matrix-bot-sdk";
import { join } from "path";
import { homedir } from "os";
import { runOrchestration } from "../orchestrator/loop.js";
import { saveTask, toStored } from "../storage/store.js";
import { loadConfig, getConfigForChannel } from "../storage/config.js";
import { loadAndApplyModelsConfig } from "../storage/models-config.js";
import { v4 as uuidv4 } from "uuid";
import type { ChannelAdapter } from "./types.js";

const HELP = `
!task <description> - Run a GTD task
Example: !task Write a hello world in TypeScript

!status - Show recent tasks (from CLI storage)
`;

function extractTaskDescription(body: string): string | null {
  const trimmed = body.trim();
  const patterns = [
    /^!task\s+(.+)/i,
    /^\/task\s+(.+)/i,
    /^task\s+(.+)/i,
  ];
  for (const re of patterns) {
    const m = trimmed.match(re);
    if (m) return m[1].trim();
  }
  return null;
}

export async function startMatrixBot(): Promise<void> {
  const homeserverUrl = process.env.MATRIX_HOMESERVER_URL;
  const accessToken = process.env.MATRIX_ACCESS_TOKEN;

  if (!homeserverUrl || !accessToken) {
    throw new Error(
      "MATRIX_HOMESERVER_URL and MATRIX_ACCESS_TOKEN are required. " +
        "Create a bot account and obtain an access token from your homeserver."
    );
  }

  const dataDir = process.env.GTD_DATA_DIR ?? join(homedir(), ".skate");
  const storage = new SimpleFsStorageProvider(join(dataDir, "matrix-bot.json"));

  const client = new MatrixClient(homeserverUrl, accessToken, storage);
  AutojoinRoomsMixin.setupOnClient(client);

  client.on("room.message", async (roomId: string, event: Record<string, unknown>) => {
    const content = event["content"] as Record<string, unknown> | undefined;
    if (content?.["msgtype"] !== "m.text") return;

    const sender = event["sender"] as string;
    const botUserId = await client.getUserId();
    if (sender === botUserId) return;

    const body = (content["body"] as string) ?? "";
    const description = extractTaskDescription(body);

    if (!description) {
      if (/^!help$/i.test(body.trim()) || /^!start$/i.test(body.trim())) {
        await client.sendText(roomId, "Skate — GTD. Agent orchestration.\n\n" + HELP);
      }
      return;
    }

    await loadAndApplyModelsConfig();
    const cfg = getConfigForChannel(await loadConfig(), "matrix");
    const qualityProfile = (cfg.qualityProfile ?? "balanced") as "fast" | "balanced" | "max";
    const approvalPolicy = cfg.approvalPolicy ?? "auto";

    const taskId = uuidv4();
    const sourceId = `${roomId}:${sender}`;

    await saveTask(toStored({
      id: taskId,
      description,
      source: "matrix",
      sourceId,
      qualityProfile,
      approvalPolicy,
      status: "in_progress",
    }));

    try {
      await client.sendText(roomId, "Task received. Running Scout…");

      const result = await runOrchestration({
        taskId,
        taskDescription: description,
        qualityProfile,
        approvalPolicy,
        modelOverrides: cfg.modelOverrides,
        profileRoles: cfg.profileRoles,
        customAgents: cfg.agents,
        onProgress: async (phase, role, status, output) => {
          if (role && status === "done") {
            const preview = (output ?? "").slice(0, 200) + (output && output.length > 200 ? "…" : "");
            await client.sendText(roomId, `${role} done:\n${preview}`).catch(() => {});
          } else if (role && status === "running") {
            await client.sendText(roomId, `${role} running…`).catch(() => {});
          }
        },
      });

      const outputsRecord = Object.fromEntries(result.outputs);
      await saveTask(toStored({
        id: result.taskId,
        description,
        source: "matrix",
        sourceId,
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
        await client.sendText(roomId, reply);
      } else {
        await client.sendText(roomId, `✗ ${result.status}: ${result.error ?? "Unknown"}`);
      }
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      await client.sendText(roomId, `✗ Error: ${err}`).catch(() => {});
      await saveTask(toStored({
        id: taskId,
        description,
        source: "matrix",
        sourceId,
        qualityProfile,
        approvalPolicy,
        status: "failed",
      }, { error: err, completedAt: new Date().toISOString() }));
    }
  });

  await client.start();
  console.log("Matrix bot started. Send !task <description> in a room to run tasks.");
}

/** Stub adapter for unified channel interface. Use startMatrixBot for real integration. */
export function createMatrixAdapter(): ChannelAdapter {
  return {
    channel: "matrix",
    async *receiveTask() { yield* []; },
    async sendMessage(channelId, _userId, text) { console.log(`[Matrix ${channelId}] ${text}`); },
    async sendNotification(event) { console.log(`[Matrix] ${event.type}: ${event.message}`); },
    async requestApproval(_, __, msg) { console.log(`[Matrix approval] ${msg}`); return false; },
    async requestClarification(_, __, msg) { console.log(`[Matrix clarification] ${msg}`); return null; },
  };
}
