import { describe, it, expect } from "vitest";
import { createTelegramAdapter } from "../../src/connectors/telegram.js";

describe("Telegram connector", () => {
  it("returns adapter with telegram channel", () => {
    const adapter = createTelegramAdapter();
    expect(adapter.channel).toBe("telegram");
  });

  it("receiveTask yields nothing", async () => {
    const adapter = createTelegramAdapter();
    const messages: unknown[] = [];
    for await (const m of adapter.receiveTask()) {
      messages.push(m);
    }
    expect(messages).toEqual([]);
  });
});
