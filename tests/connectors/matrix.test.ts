import { describe, it, expect } from "vitest";
import { createMatrixAdapter } from "../../src/connectors/matrix.js";

describe("Matrix connector", () => {
  it("returns adapter with matrix channel", () => {
    const adapter = createMatrixAdapter();
    expect(adapter.channel).toBe("matrix");
  });

  it("receiveTask yields nothing", async () => {
    const adapter = createMatrixAdapter();
    const messages: unknown[] = [];
    for await (const m of adapter.receiveTask()) {
      messages.push(m);
    }
    expect(messages).toEqual([]);
  });
});
