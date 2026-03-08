import TelegramBot from "node-telegram-bot-api";
import { runOrchestration } from "../orchestrator/loop.js";
import { saveTask, toStored } from "../storage/store.js";
import { loadConfig, getConfigForChannel } from "../storage/config.js";
import { v4 as uuidv4 } from "uuid";
import type { ChannelAdapter } from "./types.js";
import { withTimeout, getConnectorTaskTimeoutMs } from "./timeout.js";

const HELP = `
/task <description> - Run a GTD task
Example: /task Write a hello world in TypeScript

/status - Show recent tasks (from CLI storage)
`;

export async function startTelegramBot(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is required. Create a bot via @BotFather.");
  }

  const bot = new TelegramBot(token, { polling: true });

  bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, "Skate — GTD. Agent orchestration.\n\n" + HELP);
  });

  bot.onText(/\/help/, (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, HELP);
  });

  bot.onText(/\/task(.+)?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const text = (match?.[1] ?? "").trim();
    if (!text) {
      bot.sendMessage(chatId, "Usage: /task <description>\nExample: /task Write a hello world function");
      return;
    }

    const cfg = getConfigForChannel(await loadConfig(), "telegram");
    const qualityProfile = cfg.qualityProfile ?? "balanced";
    const approvalPolicy = cfg.approvalPolicy ?? "auto";

    const taskId = uuidv4();
    await saveTask(toStored({
      id: taskId,
      description: text,
      source: "telegram",
      sourceId: String(chatId),
      qualityProfile,
      approvalPolicy,
      status: "in_progress",
    }));

    const statusMsg = await bot.sendMessage(chatId, `Task received. Running Scout…`);

    try {
      const timeoutMs = getConnectorTaskTimeoutMs();
      const result = await withTimeout(runOrchestration({
        taskId,
        taskDescription: text,
        qualityProfile,
        approvalPolicy,
        modelId: cfg.defaultModel ?? undefined,
        onProgress: async (phase, role, status, output) => {
          if (role && status === "done") {
            const preview = (output ?? "").slice(0, 200) + (output && output.length > 200 ? "…" : "");
            await bot.editMessageText(`${role} done:\n${preview}`, {
              chat_id: chatId,
              message_id: statusMsg.message_id,
            }).catch(() => {});
          } else if (role && status === "running") {
            await bot.editMessageText(`${role} running…`, {
              chat_id: chatId,
              message_id: statusMsg.message_id,
            }).catch(() => {});
          }
        },
      }), timeoutMs);

      const outputsRecord = Object.fromEntries(result.outputs);
      await saveTask(toStored({
        id: result.taskId,
        description: text,
        source: "telegram",
        sourceId: String(chatId),
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
        await bot.editMessageText(reply, {
          chat_id: chatId,
          message_id: statusMsg.message_id,
        }).catch(() => bot.sendMessage(chatId, reply));
      } else {
        await bot.editMessageText(`✗ ${result.status}: ${result.error ?? "Unknown"}`, {
          chat_id: chatId,
          message_id: statusMsg.message_id,
        }).catch(() => bot.sendMessage(chatId, `✗ ${result.status}: ${result.error}`));
      }
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      await bot.editMessageText(`✗ Error: ${err}`, {
        chat_id: chatId,
        message_id: statusMsg.message_id,
      }).catch(() => bot.sendMessage(chatId, `✗ Error: ${err}`));
      await saveTask(toStored({
        id: taskId,
        description: text,
        source: "telegram",
        sourceId: String(chatId),
        qualityProfile,
        approvalPolicy,
        status: "failed",
      }, { error: err, completedAt: new Date().toISOString() }));
    }
  });

  bot.on("polling_error", (err) => {
    console.error("Telegram polling error:", err.message);
  });

  console.log("Telegram bot started. Send /task <description> to run tasks.");
}

/** Stub adapter for unified channel interface. Use startTelegramBot for real integration. */
export function createTelegramAdapter(): ChannelAdapter {
  return {
    channel: "telegram",
    async *receiveTask() { yield* []; },
    async sendMessage(channelId, _userId, text) { console.log(`[Telegram ${channelId}] ${text}`); },
    async sendNotification(event) { console.log(`[Telegram] ${event.type}: ${event.message}`); },
    async requestApproval(_, __, msg) { console.log(`[Telegram approval] ${msg}`); return false; },
    async requestClarification(_, __, msg) { console.log(`[Telegram clarification] ${msg}`); return null; },
  };
}
