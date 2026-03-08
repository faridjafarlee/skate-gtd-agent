import { describe, it, expect } from "vitest";
import { createDiscordAdapter } from "../../src/connectors/discord.js";

describe("Discord connector", () => {
  it("returns adapter with discord channel", () => {
    const adapter = createDiscordAdapter();
    expect(adapter.channel).toBe("discord");
  });

  it("receiveTask yields nothing", async () => {
    const adapter = createDiscordAdapter();
    const messages: unknown[] = [];
    for await (const m of adapter.receiveTask()) {
      messages.push(m);
    }
    expect(messages).toEqual([]);
  });
});
