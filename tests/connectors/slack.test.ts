import { describe, it, expect } from "vitest";
import { createSlackAdapter } from "../../src/connectors/slack.js";

describe("Slack connector", () => {
  it("returns adapter with slack channel", () => {
    const adapter = createSlackAdapter();
    expect(adapter.channel).toBe("slack");
  });

  it("receiveTask yields nothing", async () => {
    const adapter = createSlackAdapter();
    const messages: unknown[] = [];
    for await (const m of adapter.receiveTask()) {
      messages.push(m);
    }
    expect(messages).toEqual([]);
  });
});
