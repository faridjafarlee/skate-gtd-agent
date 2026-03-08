import { describe, it, expect } from "vitest";
import { executeTool } from "../../src/tools/runtime.js";
import { resolvePolicy } from "../../src/security/policy.js";
import { resolve } from "path";

describe("Workspace roots parity (GTD_WORKSPACE_ROOTS)", () => {
  const policy = resolvePolicy({ mode: "dont-ask" });
  const cwd = process.cwd();
  const rootInside = cwd;
  const rootOutside = resolve(cwd, "..", "..");

  it("read_file succeeds when path is inside workspace root", async () => {
    const roots = [rootInside];
    const result = await executeTool("read_file", { path: "package.json" }, policy, { cwd, workspaceRoots: roots });
    expect(result.success).toBe(true);
    expect(result.output).toBeDefined();
  });

  it("read_file fails when path is outside workspace roots", async () => {
    const roots = [resolve(cwd, "some-nonexistent-subdir-only")];
    const result = await executeTool("read_file", { path: "package.json" }, policy, { cwd, workspaceRoots: roots });
    expect(result.success).toBe(false);
    expect(result.error).toContain("outside workspace roots");
  });

  it("read_file works without workspaceRoots (no restriction)", async () => {
    const result = await executeTool("read_file", { path: "package.json" }, policy, { cwd });
    expect(result.success).toBe(true);
  });
});
