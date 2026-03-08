import { describe, it, expect, afterEach } from "vitest";
import { enableModel, disableModel, routeForTask } from "../../../src/core/models/index.js";

describe("Model Router", () => {
  afterEach(() => {
    enableModel("ollama/llama3");
    enableModel("ollama/llama3.2");
  });

  it("returns null when no models enabled", () => {
    disableModel("ollama/llama3");
    disableModel("ollama/llama3.2");
    const result = routeForTask("balanced", { requiresTools: true });
    expect(result).toBeNull();
  });

  it("returns a model when enabled", () => {
    enableModel("ollama/llama3");
    const result = routeForTask("balanced", { requiresTools: true });
    expect(result).not.toBeNull();
    expect(result?.modelId).toBe("ollama/llama3");
  });

  it("prefers local when preferLocal is set", () => {
    enableModel("ollama/llama3");
    enableModel("gpt-4o");
    const result = routeForTask("balanced", { requiresTools: true, preferLocal: true });
    expect(result?.modelId).toBe("ollama/llama3");
  });
});
