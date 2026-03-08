import { describe, it, expect } from "vitest";
import { extractWhatsAppMessages, createWhatsAppAdapter } from "../../src/connectors/whatsapp.js";

describe("WhatsApp connector", () => {
  describe("extractWhatsAppMessages", () => {
    it("parses webhook payload with text message", () => {
      const payload = {
        object: "whatsapp_business_account",
        entry: [
          {
            changes: [
              {
                value: {
                  messages: [
                    { from: "1234567890", type: "text", text: { body: "hello" } },
                  ],
                },
              },
            ],
          },
        ],
      };
      expect(extractWhatsAppMessages(payload)).toEqual([
        { from: "1234567890", text: "hello" },
      ]);
    });

    it("returns empty for non-whatsapp payload", () => {
      expect(extractWhatsAppMessages({ object: "other" })).toEqual([]);
      expect(extractWhatsAppMessages({})).toEqual([]);
    });

    it("ignores non-text messages", () => {
      const payload = {
        object: "whatsapp_business_account",
        entry: [
          {
            changes: [
              {
                value: {
                  messages: [
                    { from: "123", type: "image" },
                    { from: "456", type: "text", text: { body: "ok" } },
                  ],
                },
              },
            ],
          },
        ],
      };
      expect(extractWhatsAppMessages(payload)).toEqual([{ from: "456", text: "ok" }]);
    });
  });

  describe("createWhatsAppAdapter", () => {
    it("returns adapter with whatsapp channel", () => {
      const adapter = createWhatsAppAdapter();
      expect(adapter.channel).toBe("whatsapp");
    });
  });
});
