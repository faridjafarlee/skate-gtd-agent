import { describe, it, expect } from "vitest";
import { renderBanner } from "../../src/cli/banner.js";

describe("Banner", () => {
  it("renders GTD MANTIS title", () => {
    const out = renderBanner();
    expect(out).toContain("GTD MANTIS");
  });

  it("renders skate ASCII art", () => {
    const out = renderBanner();
    expect(out).toContain("\\   _   /");
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
