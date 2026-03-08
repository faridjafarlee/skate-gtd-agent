import { App } from "@slack/bolt";
import { runOrchestration } from "../orchestrator/loop.js";
import { saveTask, toStored } from "../storage/store.js";
import { loadConfig, getConfigForChannel } from "../storage/config.js";
import { v4 as uuidv4 } from "uuid";
import type { ChannelAdapter } from "./types.js";

export async function startSlackBot(): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN;
  const appToken = process.env.SLACK_APP_TOKEN;
  const signingSecret = process.env.SLACK_SIGNING_SECRET;

  if (!token) {
    throw new Error("SLACK_BOT_TOKEN is required. Create an app at api.slack.com/apps");
  }

  const useSocketMode = !!appToken;
  if (!useSocketMode && !signingSecret) {
    throw new Error("SLACK_SIGNING_SECRET required for HTTP mode, or use SLACK_APP_TOKEN for Socket Mode");
  }
  const app = useSocketMode
    ? new App({ token, appToken, socketMode: true })
    : new App({ token, signingSecret: signingSecret! });

  async function runTask(text: string, channelId: string, userId: string, respond: (msg: string) => Promise<unknown>) {
    const cfg = getConfigForChannel(await loadConfig(), "slack");
    const qualityProfile = cfg.qualityProfile ?? "balanced";
    const approvalPolicy = cfg.approvalPolicy ?? "auto";

    const taskId = uuidv4();
    await saveTask(toStored({
      id: taskId,
      description: text,
      source: "slack",
      sourceId: channelId,
      qualityProfile,
      approvalPolicy,
      status: "in_progress",
    }));

    await respond("Task received. Running…");

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
        source: "slack",
        sourceId: channelId,
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
        await respond(reply);
      } else {
        await respond(`✗ ${result.status}: ${result.error ?? "Unknown"}`);
      }
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      await respond(`✗ Error: ${err}`);
      await saveTask(toStored({
        id: taskId,
        description: text,
        source: "slack",
        sourceId: channelId,
        qualityProfile,
        approvalPolicy,
        status: "failed",
      }, { error: err, completedAt: new Date().toISOString() }));
    }
  }

  app.event("app_mention", async ({ event, say }) => {
    const text = event.text.replace(/<@[A-Z0-9]+>/g, "").trim();
    if (!text) {
      await say("Usage: @SkateBot <task description>\nExample: @SkateBot Write a hello world in TypeScript");
      return;
    }
    const channel = event.channel ?? "";
    const userId = event.user ?? "";
    if (!channel || !userId) return;
    await runTask(text, channel, userId, (msg) => say(msg));
  });

  app.message(async ({ message, say }) => {
    const channel = message.channel;
    if (message.channel_type !== "im" || message.subtype === "bot_message" || !channel) return;
    const userId = "user" in message ? message.user : undefined;
    if (!userId) return;
    const raw = "text" in message ? String(message.text ?? "").trim() : "";
    const text = raw.startsWith("task:") ? raw.slice(5).trim() : raw.startsWith("task ") ? raw.slice(5).trim() : "";
    if (!text || text.length < 3) return;
    await runTask(text, channel, userId, (msg) => say(msg));
  });

  if (useSocketMode) {
    await app.start();
  } else {
    const port = parseInt(process.env.PORT ?? "3000", 10) || 3000;
    await app.start(port);
  }
  console.log("Slack bot started. Mention the app or DM it with a task.");
}

/** Stub adapter for unified channel interface. Use startSlackBot for real integration. */
export function createSlackAdapter(): ChannelAdapter {
  return {
    channel: "slack",
    async *receiveTask() { yield* []; },
    async sendMessage(channelId, _userId, text) { console.log(`[Slack ${channelId}] ${text}`); },
    async sendNotification(event) { console.log(`[Slack] ${event.type}: ${event.message}`); },
    async requestApproval(_, __, msg) { console.log(`[Slack approval] ${msg}`); return false; },
    async requestClarification(_, __, msg) { console.log(`[Slack clarification] ${msg}`); return null; },
  };
}
