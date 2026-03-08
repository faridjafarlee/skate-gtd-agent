import type { ChannelAdapter } from "./types.js";
import type { ConnectorMessage, NotificationEvent } from "../types/index.js";

/**
 * CLI channel adapter - tasks come from stdin/args, output to stdout.
 */
export const cliAdapter: ChannelAdapter = {
  channel: "cli",

  async *receiveTask(): AsyncIterable<ConnectorMessage> {
    // CLI tasks are passed via command args, not this stream
    yield* [];
  },

  async sendMessage(_channelId: string, _userId: string, text: string): Promise<void> {
    console.log(text);
  },

  async sendNotification(event: NotificationEvent): Promise<void> {
    console.log(`[${event.type}] ${event.message}`);
  },

  async requestApproval(_channelId: string, _userId: string, message: string): Promise<boolean> {
    console.log(`[Approval required] ${message}`);
    return false; // Would need readline for interactive approval
  },

  async requestClarification(_channelId: string, _userId: string, message: string): Promise<string | null> {
    console.log(`[Clarification needed] ${message}`);
    return null;
  },
};
