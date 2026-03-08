import { describe, it, expect, beforeEach } from "vitest";
import {
  listMcpServers,
  registerMcpServer,
  removeMcpServer,
  getMcpServer,
} from "../../src/mcp/store.js";
import { testMcpServer } from "../../src/mcp/client.js";
import { loadPluginManifest, discoverPlugins, discoverPluginsWithPaths } from "../../src/plugins/loader.js";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { mkdtemp } from "fs/promises";

describe("MCP and Plugins parity", () => {
  beforeEach(async () => {
    // Clean up test MCP server if present
    await removeMcpServer("parity-test-mcp");
  });

  describe("MCP store", () => {
    it("lists MCP servers", async () => {
      const servers = await listMcpServers();
      expect(Array.isArray(servers)).toBe(true);
    });

    it("registers and retrieves MCP server", async () => {
      await registerMcpServer({
        id: "parity-test-mcp",
        name: "Test MCP",
        transport: "stdio",
        config: { command: "node", args: ["-e", "process.exit(0)"] },
      });
      const s = await getMcpServer("parity-test-mcp");
      expect(s).toBeDefined();
      expect(s?.name).toBe("Test MCP");
      expect(s?.transport).toBe("stdio");
      await removeMcpServer("parity-test-mcp");
    });

    it("tests MCP server (stdio)", async () => {
      await registerMcpServer({
        id: "parity-test-mcp",
        name: "Test",
        transport: "stdio",
        config: { command: "node", args: ["-e", ""] },
      });
      const server = await getMcpServer("parity-test-mcp");
      expect(server).toBeDefined();
      const result = await testMcpServer(server!);
      expect(result.success).toBe(true);
      await removeMcpServer("parity-test-mcp");
    });

    it("MCP test fails for invalid command", async () => {
      const result = await testMcpServer({
        id: "x",
        name: "X",
        transport: "stdio",
        config: { command: "/nonexistent-binary-xyz", args: [] },
      });
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe("Plugin loader", () => {
    it("loads valid manifest from directory", async () => {
      const dir = join(tmpdir(), `gtd-plugin-test-${Date.now()}`);
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "manifest.json"),
        JSON.stringify({
          id: "test-plugin",
          name: "Test Plugin",
          version: "1.0.0",
        }),
        "utf-8"
      );
      const result = await loadPluginManifest(dir);
      expect(result.success).toBe(true);
      expect(result.manifest?.id).toBe("test-plugin");
      expect(result.manifest?.version).toBe("1.0.0");
    });

    it("rejects invalid manifest", async () => {
      const dir = join(tmpdir(), `gtd-plugin-invalid-${Date.now()}`);
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "manifest.json"),
        JSON.stringify({ id: "bad id", name: "x", version: "1.0.0" }),
        "utf-8"
      );
      const result = await loadPluginManifest(dir);
      expect(result.success).toBe(false);
    });

    it("discovers plugins in directory", async () => {
      const base = join(tmpdir(), `gtd-plugins-${Date.now()}`);
      await mkdir(join(base, "gtd-foo"), { recursive: true });
      await writeFile(
        join(base, "gtd-foo", "manifest.json"),
        JSON.stringify({ id: "gtd-foo", name: "Foo", version: "1.0.0" }),
        "utf-8"
      );
      const plugins = await discoverPlugins(base);
      expect(plugins.length).toBeGreaterThanOrEqual(1);
      expect(plugins.some((p) => p.id === "gtd-foo")).toBe(true);
    });

    it("discoverPluginsWithPaths returns path and manifest for plugin run", async () => {
      const base = await mkdtemp(join(tmpdir(), "gtd-paths-"));
      await mkdir(join(base, "gtd-bar"), { recursive: true });
      await writeFile(
        join(base, "gtd-bar", "manifest.json"),
        JSON.stringify({
          id: "gtd-bar",
          name: "Bar",
          version: "2.0.0",
          commands: [{ id: "hello", name: "Hello", handler: "dist/hello.js" }],
        }),
        "utf-8"
      );
      const withPaths = await discoverPluginsWithPaths(base);
      expect(withPaths.length).toBe(1);
      expect(withPaths[0].manifest.id).toBe("gtd-bar");
      expect(withPaths[0].path).toBe(join(base, "gtd-bar"));
    });

    it("validate rejects non-existent path", async () => {
      const result = await loadPluginManifest(join(tmpdir(), `nonexistent-${Date.now()}`));
      expect(result.success).toBe(false);
      expect(result.error).toContain("No valid manifest");
    });
  });
});
