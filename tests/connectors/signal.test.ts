import { describe, it, expect } from "vitest";
import { extractMessages, createSignalAdapter } from "../../src/connectors/signal.js";

describe("Signal connector", () => {
  describe("extractMessages", () => {
    it("parses single envelope object", () => {
      const payload = {
        envelope: {
          source: "+1234567890",
          dataMessage: { message: "hello" },
        },
      };
      expect(extractMessages(payload)).toEqual([{ from: "+1234567890", text: "hello" }]);
    });

    it("parses array of envelopes", () => {
      const payload = [
        { envelope: { source: "+111", dataMessage: { message: "a" } } },
        { envelope: { sourceNumber: "+222", dataMessage: { message: "b" } } },
      ];
      expect(extractMessages(payload)).toEqual([
        { from: "+111", text: "a" },
        { from: "+222", text: "b" },
      ]);
    });

    it("parses JSON string", () => {
      const payload = JSON.stringify({
        envelope: { source: "+999", dataMessage: { message: "hi" } },
      });
      expect(extractMessages(payload)).toEqual([{ from: "+999", text: "hi" }]);
    });

    it("returns empty for invalid or empty payload", () => {
      expect(extractMessages([])).toEqual([]);
      expect(extractMessages("not json")).toEqual([]);
      expect(extractMessages({ envelope: {} })).toEqual([]);
    });
  });

  describe("createSignalAdapter", () => {
    it("returns adapter with signal channel", () => {
      const adapter = createSignalAdapter();
      expect(adapter.channel).toBe("signal");
    });

    it("receiveTask yields nothing", async () => {
      const adapter = createSignalAdapter();
      const messages: unknown[] = [];
      for await (const m of adapter.receiveTask()) {
        messages.push(m);
      }
      expect(messages).toEqual([]);
    });
  });
});
