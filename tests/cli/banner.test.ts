import { describe, it, expect } from "vitest";
import { renderBanner } from "../../src/cli/banner.js";

describe("Banner", () => {
  it("renders SKATE title and GTD subtitle", () => {
    const out = renderBanner();
    expect(out).toContain("SKATE");
    expect(out).toContain("GTD. Agent Orchestration");
  });

  it("renders skate ASCII art", () => {
    const out = renderBanner();
    expect(out).toContain("\\   ___   /");
    expect(out).toContain("[Skate]");
  });

  it("includes custom options when provided", () => {
    const out = renderBanner({
      mode: "Auto",
      router: "Quality",
      agentsActive: 4,
    });
    expect(out).toContain("Auto");
    expect(out).toContain("Quality");
    expect(out).toContain("4 active");
  });
});
