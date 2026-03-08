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

interface SignalEnvelope {
  envelope?: {
    source?: string;
    sourceNumber?: string;
    dataMessage?: { message?: string };
  };
}

async function sendSignalMessage(
  baseUrl: string,
  number: string,
  recipient: string,
  text: string
): Promise<void> {
  const url = `${baseUrl.replace(/\/$/, "")}/v2/send`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: text,
      number,
      recipients: [recipient.startsWith("+") ? recipient : `+${recipient}`],
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Signal API error ${res.status}: ${err}`);
  }
}

function parseEnvelope(item: unknown): { from: string; text: string } | null {
  let obj = item;
  if (typeof item === "string") {
    try {
      obj = JSON.parse(item) as unknown;
    } catch {
      return null;
    }
  }
  const env = obj as SignalEnvelope;
  const source = env.envelope?.source ?? env.envelope?.sourceNumber ?? "";
  const msg = env.envelope?.dataMessage?.message ?? "";
  return source && msg ? { from: source, text: msg } : null;
}

/** Exported for testing. */
export function extractMessages(payload: unknown): Array<{ from: string; text: string }> {
  const out: Array<{ from: string; text: string }> = [];
  let data = payload;
  if (typeof payload === "string") {
    try {
      data = JSON.parse(payload) as unknown;
    } catch {
      return out;
    }
  }
  if (Array.isArray(data)) {
    for (const item of data) {
      const parsed = parseEnvelope(item);
      if (parsed) out.push(parsed);
    }
  } else {
    const parsed = parseEnvelope(data);
    if (parsed) out.push(parsed);
  }
  return out;
}

async function pollAndProcess(
  baseUrl: string,
  number: string
): Promise<void> {
  const url = `${baseUrl.replace(/\/$/, "")}/v1/receive/${encodeURIComponent(number)}`;
  const res = await fetch(url, { method: "GET" });
  if (!res.ok) return;

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    return;
  }

  const messages = extractMessages(payload);
  for (const { from, text } of messages) {
    const raw = String(text).trim();
    const taskMatch = raw.match(/^task\s*:?\s*(.+)$/is);
    const taskText = taskMatch
      ? taskMatch[1].trim()
      : raw.toLowerCase().startsWith("task ")
        ? raw.slice(5).trim()
        : raw.startsWith("task:")
          ? raw.slice(5).trim()
          : "";

    if (!taskText || taskText.length < 3) {
      if (raw.toLowerCase() === "help" || raw === "?") {
        await sendSignalMessage(baseUrl, number, from, "Skate — GTD. Agent orchestration.\n\n" + HELP);
      }
      continue;
    }

    const cfg = getConfigForChannel(await loadConfig(), "signal");
    const qualityProfile = cfg.qualityProfile ?? "balanced";
    const approvalPolicy = cfg.approvalPolicy ?? "auto";

    const taskId = uuidv4();
    await saveTask(toStored({
      id: taskId,
      description: taskText,
      source: "signal",
      sourceId: from,
      qualityProfile,
      approvalPolicy,
      status: "in_progress",
    }));

    await sendSignalMessage(baseUrl, number, from, "Task received. Running Scout…");

    try {
      const result = await runOrchestration({
        taskId,
        taskDescription: taskText,
        qualityProfile,
        approvalPolicy,
        modelId: cfg.defaultModel ?? undefined,
      });

      const outputsRecord = Object.fromEntries(result.outputs);
      await saveTask(toStored({
        id: result.taskId,
        description: taskText,
        source: "signal",
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
        await sendSignalMessage(baseUrl, number, from, reply);
      } else {
        await sendSignalMessage(baseUrl, number, from, `✗ ${result.status}: ${result.error ?? "Unknown"}`);
      }
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      await sendSignalMessage(baseUrl, number, from, `✗ Error: ${err}`);
      await saveTask(toStored({
        id: taskId,
        description: taskText,
        source: "signal",
        sourceId: from,
        qualityProfile,
        approvalPolicy,
        status: "failed",
      }, { error: err, completedAt: new Date().toISOString() }));
    }
  }
}

export async function startSignalBot(): Promise<void> {
  const baseUrl = process.env.SIGNAL_BRIDGE_URL;
  const number = process.env.SIGNAL_NUMBER;

  if (!baseUrl || !number) {
    throw new Error(
      "SIGNAL_BRIDGE_URL and SIGNAL_NUMBER are required. Run signal-cli-rest-api (e.g. Docker) and register a number."
    );
  }

  const pollIntervalMs = parseInt(process.env.SIGNAL_POLL_INTERVAL ?? "15000", 10) || 15000;

  console.log(`Signal bot started. Polling every ${pollIntervalMs / 1000}s. Send "task <description>" to run tasks.`);

  const poll = async (): Promise<void> => {
    try {
      await pollAndProcess(baseUrl, number);
    } catch (e) {
      console.error("Signal poll error:", e instanceof Error ? e.message : String(e));
    }
    setTimeout(poll, pollIntervalMs);
  };
  setTimeout(poll, 1000);
}

/**
 * Stub adapter for unified channel interface. Use startSignalBot for real integration.
 */
export function createSignalAdapter(): ChannelAdapter {
  return {
    channel: "signal",

    async *receiveTask(): AsyncIterable<ConnectorMessage> {
      yield* [];
    },

    async sendMessage(channelId: string, _userId: string, text: string): Promise<void> {
      console.log(`[Signal ${channelId}] ${text}`);
    },

    async sendNotification(event: NotificationEvent): Promise<void> {
      console.log(`[Signal notification] ${event.type}: ${event.message}`);
    },

    async requestApproval(_channelId: string, _userId: string, message: string): Promise<boolean> {
      console.log(`[Signal approval] ${message}`);
      return false;
    },

    async requestClarification(_channelId: string, _userId: string, message: string): Promise<string | null> {
      console.log(`[Signal clarification] ${message}`);
      return null;
    },
  };
}
