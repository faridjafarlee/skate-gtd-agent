import { describe, it, expect } from "vitest";
import { executeTool, listTools } from "../../src/tools/runtime.js";
import { resolvePolicy } from "../../src/security/policy.js";

describe("Tool runtime parity", () => {
  it("lists tools", () => {
    const tools = listTools();
    expect(tools.length).toBeGreaterThanOrEqual(5);
    const names = tools.map((t) => t.name);
    expect(names).toContain("read_file");
    expect(names).toContain("write_file");
    expect(names).toContain("run_command");
    expect(names).toContain("git_status");
    expect(names).toContain("web_fetch");
    expect(names).toContain("web_search");
  });

  it("executes read_file with policy", async () => {
    const policy = resolvePolicy({ mode: "dont-ask" });
    const result = await executeTool("read_file", { path: "package.json" }, policy);
    expect(result.success).toBe(true);
    expect(result.output).toContain("skate");
  });

  it("denies write in plan mode", async () => {
    const policy = resolvePolicy({ mode: "plan" });
    const result = await executeTool("write_file", { path: "test.txt", content: "x" }, policy);
    expect(result.success).toBe(false);
    expect(result.error).toContain("denied");
  });

  it("allows read in plan mode", async () => {
    const policy = resolvePolicy({ mode: "plan" });
    const result = await executeTool("read_file", { path: "package.json" }, policy);
    expect(result.success).toBe(true);
  });

  it("rejects run_command with sudo/su/pkexec (A.11)", async () => {
    const policy = resolvePolicy({ mode: "dont-ask" });
    const sudoResult = await executeTool("run_command", { command: "sudo ls" }, policy);
    expect(sudoResult.success).toBe(false);
    expect(sudoResult.error).toMatch(/[Ee]levation|sudo|su|pkexec|doas/);
    const suResult = await executeTool("run_command", { command: "su -c id" }, policy);
    expect(suResult.success).toBe(false);
    expect(suResult.error).toMatch(/[Ee]levation|sudo|su|pkexec|doas/);
  });

  it("rejects write_file outside cwd (A.3 path strictness)", async () => {
    const policy = resolvePolicy({ mode: "dont-ask" });
    const result = await executeTool("write_file", { path: "/tmp/outside-write.txt", content: "x" }, policy);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/outside workspace|outside.*cwd/);
  });

  it("rejects edit_file outside cwd (A.3 path strictness)", async () => {
    const policy = resolvePolicy({ mode: "dont-ask" });
    const result = await executeTool("edit_file", { path: "/etc/hosts", old_string: "x", new_string: "y" }, policy);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/outside workspace|outside.*cwd/);
  });

  it("rejects apply_patch with cwd outside workspace (A.3 path strictness)", async () => {
    const policy = resolvePolicy({ mode: "dont-ask" });
    const result = await executeTool(
      "apply_patch",
      { patch: "--- a/f\n+++ b/f\n@@ -1 +1 @@\n-x\n+y\n", cwd: "/tmp" },
      policy
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/outside workspace|outside.*cwd/);
  });

  it("allows write_file under cwd (A.3)", async () => {
    const policy = resolvePolicy({ mode: "dont-ask" });
    const safePath = `tool-runtime-a3-${Date.now()}.txt`;
    const result = await executeTool("write_file", { path: safePath, content: "ok" }, policy);
    expect(result.success).toBe(true);
    const { unlink } = await import("fs/promises");
    await unlink(safePath).catch(() => {});
  });
});
