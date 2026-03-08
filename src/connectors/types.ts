/**
 * Unified channel adapter interface for messaging platforms.
 */

import type { ConnectorMessage, NotificationEvent } from "../types/index.js";

export type ChannelType = "cli" | "telegram" | "slack" | "whatsapp" | "signal" | "discord" | "matrix";

export interface ChannelAdapter {
  readonly channel: ChannelType;
  receiveTask(): AsyncIterable<ConnectorMessage>;
  sendMessage(channelId: string, userId: string, text: string): Promise<void>;
  sendNotification(event: NotificationEvent): Promise<void>;
  requestApproval(channelId: string, userId: string, message: string): Promise<boolean>;
  requestClarification(channelId: string, userId: string, message: string): Promise<string | null>;
}
