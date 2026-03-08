import { Client, Events, GatewayIntentBits } from "discord.js";
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

function parseTaskText(raw: string): string | null {
  const trimmed = raw.trim();
  const taskMatch = trimmed.match(/^task\s*:?\s*(.+)$/is);
  if (taskMatch) return taskMatch[1].trim();
  if (trimmed.toLowerCase().startsWith("task ")) return trimmed.slice(5).trim();
  if (trimmed.startsWith("task:")) return trimmed.slice(5).trim();
  return null;
}

export async function startDiscordBot(): Promise<void> {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    throw new Error("DISCORD_BOT_TOKEN is required. Create a bot at discord.com/developers/applications");
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
  });

  client.on(Events.ClientReady, () => {
    console.log(`Discord bot ready as ${client.user?.tag}. Send "task <description>" to run tasks.`);
  });

  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;

    const text = parseTaskText(message.content);
    if (!text) {
      if (message.content.trim().toLowerCase() === "help" || message.content.trim() === "?") {
        await message.reply("Skate — GTD. Agent orchestration.\n\n" + HELP);
      }
      return;
    }
    if (text.length < 3) return;

    const channelId = message.channelId;

    const cfg = getConfigForChannel(await loadConfig(), "discord");
    const qualityProfile = cfg.qualityProfile ?? "balanced";
    const approvalPolicy = cfg.approvalPolicy ?? "auto";

    const taskId = uuidv4();
    await saveTask(toStored({
      id: taskId,
      description: text,
      source: "discord",
      sourceId: channelId,
      qualityProfile,
      approvalPolicy,
      status: "in_progress",
    }));

    const statusMsg = await message.reply("Task received. Running Scout…");

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
        source: "discord",
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
        await statusMsg.edit(reply);
      } else {
        await statusMsg.edit(`✗ ${result.status}: ${result.error ?? "Unknown"}`);
      }
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      await statusMsg.edit(`✗ Error: ${err}`);
      await saveTask(toStored({
        id: taskId,
        description: text,
        source: "discord",
        sourceId: channelId,
        qualityProfile,
        approvalPolicy,
        status: "failed",
      }, { error: err, completedAt: new Date().toISOString() }));
    }
  });

  await client.login(token);
}

/** Stub adapter for unified channel interface. Use startDiscordBot for real integration. */
export function createDiscordAdapter(): ChannelAdapter {
  return {
    channel: "discord",
    async *receiveTask(): AsyncIterable<ConnectorMessage> {
      yield* [];
    },
    async sendMessage(channelId: string, _userId: string, text: string): Promise<void> {
      console.log(`[Discord ${channelId}] ${text}`);
    },
    async sendNotification(event: NotificationEvent): Promise<void> {
      console.log(`[Discord notification] ${event.type}: ${event.message}`);
    },
    async requestApproval(_channelId: string, _userId: string, message: string): Promise<boolean> {
      console.log(`[Discord approval] ${message}`);
      return false;
    },
    async requestClarification(_channelId: string, _userId: string, message: string): Promise<string | null> {
      console.log(`[Discord clarification] ${message}`);
      return null;
    },
  };
}
