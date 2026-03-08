/**
 * MCP client utilities: test connectivity, discover tools.
 * Minimal implementation without full MCP SDK dependency.
 */

import { spawn } from "child_process";
import { createInterface } from "readline";
import type { McpServerConfig } from "./store.js";

export interface McpTestResult {
  success: boolean;
  error?: string;
  /** Tools discovered (if any) */
  tools?: string[];
}

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpListToolsResult {
  success: boolean;
  error?: string;
  tools?: McpToolInfo[];
}

/**
 * Test MCP server connectivity.
 * - stdio: spawn process, wait for stdin ready.
 * - url: HTTP GET to health/root.
 */
export async function testMcpServer(config: McpServerConfig): Promise<McpTestResult> {
  if (config.transport === "stdio") {
    const cmd = config.config.command;
    const args = config.config.args ?? [];
    if (!cmd) {
      return { success: false, error: "stdio: command required" };
    }
    return new Promise((resolve) => {
      const proc = spawn(cmd, args, {
        env: { ...process.env, ...config.env },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const timeout = setTimeout(() => {
        proc.kill("SIGTERM");
        resolve({ success: false, error: "Timeout (5s) waiting for server" });
      }, 5000);
      proc.on("error", (err) => {
        clearTimeout(timeout);
        resolve({ success: false, error: err.message });
      });
      proc.on("spawn", () => {
        clearTimeout(timeout);
        proc.kill("SIGTERM");
        resolve({ success: true });
      });
    });
  }

  if (config.transport === "url") {
    const url = config.config.url;
    if (!url) {
      return { success: false, error: "url: url required" };
    }
    try {
      const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(5000) });
      return { success: res.ok, error: res.ok ? undefined : `HTTP ${res.status}` };
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }
  }

  return { success: false, error: `Unknown transport: ${config.transport}` };
}

const MCP_TIMEOUT_MS = 15_000;

/**
 * List tools from an MCP server (stdio only). Performs initialize → initialized → tools/list.
 */
export async function listMcpTools(config: McpServerConfig): Promise<McpListToolsResult> {
  if (config.transport !== "stdio") {
    return { success: false, error: "tools/list is only supported for stdio transport" };
  }
  const cmd = config.config.command;
  const args = config.config.args ?? [];
  if (!cmd) {
    return { success: false, error: "stdio: command required" };
  }

  return new Promise((resolve) => {
    const proc = spawn(cmd, args, {
      env: { ...process.env, ...config.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const timeout = setTimeout(() => {
      proc.kill("SIGTERM");
      resolve({ success: false, error: "Timeout waiting for tools/list" });
    }, MCP_TIMEOUT_MS);

    const rl = createInterface({ input: proc.stdout!, crlfDelay: Infinity });
    const lines: string[] = [];
    function onLine(line: string): void {
      lines.push(line);
      processLines();
    }
    rl.on("line", onLine);

    proc.stderr?.on("data", () => {});

    function send(obj: Record<string, unknown>): void {
      const msg = JSON.stringify(obj) + "\n";
      proc.stdin?.write(msg);
    }

    proc.on("error", (err) => {
      clearTimeout(timeout);
      rl.close();
      resolve({ success: false, error: err.message });
    });

    let state: "init" | "initialized" | "tools" = "init";
    let initDone = false;

    rl.on("close", () => {
      clearTimeout(timeout);
      if (!initDone) resolve({ success: false, error: "Server closed before initialize response" });
    });

    function processLines(): void {
      while (lines.length > 0) {
        const raw = lines.shift()!.trim();
        if (!raw) continue;
        let msg: { id?: number; result?: unknown; error?: { message?: string }; method?: string };
        try {
          msg = JSON.parse(raw) as typeof msg;
        } catch {
          continue;
        }
        if (msg.method === "notifications/initialized" || msg.method === "notifications/cancelled") continue;
        if (state === "init" && msg.result !== undefined) {
          initDone = true;
          state = "initialized";
          send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
          send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
          state = "tools";
          continue;
        }
        if (state === "tools" && (msg.id === 2 || msg.result !== undefined)) {
          proc.kill("SIGTERM");
          clearTimeout(timeout);
          rl.close();
          const err = msg.error;
          if (err) {
            resolve({ success: false, error: err.message ?? "tools/list failed" });
            return;
          }
          const result = msg.result as { tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> };
          const tools = (result?.tools ?? []).map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          }));
          resolve({ success: true, tools });
          return;
        }
      }
    }

    proc.stdin?.on("error", () => {});

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "gtd-mcp-tools", version: "0.1.0" },
      },
    });
  });
}

/**
 * List resources from an MCP server (stdio only). Performs initialize → initialized → resources/list.
 */
export async function listMcpResources(config: McpServerConfig): Promise<McpListResourcesResult> {
  if (config.transport !== "stdio") {
    return { success: false, error: "resources/list is only supported for stdio transport" };
  }
  const cmd = config.config.command;
  const args = config.config.args ?? [];
  if (!cmd) {
    return { success: false, error: "stdio: command required" };
  }

  return new Promise((resolve) => {
    const proc = spawn(cmd, args, {
      env: { ...process.env, ...config.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const timeout = setTimeout(() => {
      proc.kill("SIGTERM");
      resolve({ success: false, error: "Timeout waiting for resources/list" });
    }, MCP_TIMEOUT_MS);

    const rl = createInterface({ input: proc.stdout!, crlfDelay: Infinity });
    const lines: string[] = [];
    function onLine(line: string): void {
      lines.push(line);
      processLines();
    }
    rl.on("line", onLine);

    proc.stderr?.on("data", () => {});

    function send(obj: Record<string, unknown>): void {
      const msg = JSON.stringify(obj) + "\n";
      proc.stdin?.write(msg);
    }

    proc.on("error", (err) => {
      clearTimeout(timeout);
      rl.close();
      resolve({ success: false, error: err.message });
    });

    let state: "init" | "initialized" | "resources" = "init";
    let initDone = false;

    rl.on("close", () => {
      clearTimeout(timeout);
      if (!initDone) resolve({ success: false, error: "Server closed before initialize response" });
    });

    function processLines(): void {
      while (lines.length > 0) {
        const raw = lines.shift()!.trim();
        if (!raw) continue;
        let msg: { id?: number; result?: { resources?: Array<{ uri: string; name?: string; description?: string; mimeType?: string }> }; error?: { message?: string }; method?: string };
        try {
          msg = JSON.parse(raw) as typeof msg;
        } catch {
          continue;
        }
        if (msg.method === "notifications/initialized" || msg.method === "notifications/cancelled") continue;
        if (state === "init" && msg.result !== undefined) {
          initDone = true;
          state = "initialized";
          send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
          send({ jsonrpc: "2.0", id: 2, method: "resources/list", params: {} });
          state = "resources";
          continue;
        }
        if (state === "resources" && (msg.id === 2 || msg.result !== undefined || msg.error !== undefined)) {
          proc.kill("SIGTERM");
          clearTimeout(timeout);
          rl.close();
          if (msg.error) {
            resolve({ success: false, error: msg.error.message ?? "resources/list failed" });
            return;
          }
          const result = msg.result;
          const resources = (result?.resources ?? []).map((r) => ({
            uri: r.uri,
            name: r.name,
            description: r.description,
            mimeType: r.mimeType,
          }));
          resolve({ success: true, resources });
          return;
        }
      }
    }

    proc.stdin?.on("error", () => {});

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "gtd-mcp-resources", version: "0.1.0" },
      },
    });
  });
}

export interface McpResourceInfo {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

export interface McpListResourcesResult {
  success: boolean;
  error?: string;
  resources?: McpResourceInfo[];
}

export interface McpReadResourceResult {
  success: boolean;
  error?: string;
  /** Inline base64 or text contents (MCP resources/read response) */
  contents?: Array<{ mimeType?: string; blob?: string; text?: string }>;
}

/**
 * Read one resource by URI from an MCP server (stdio only). Performs initialize → initialized → resources/read.
 */
export async function readMcpResource(config: McpServerConfig, uri: string): Promise<McpReadResourceResult> {
  if (config.transport !== "stdio") {
    return { success: false, error: "resources/read is only supported for stdio transport" };
  }
  const cmd = config.config.command;
  const args = config.config.args ?? [];
  if (!cmd) {
    return { success: false, error: "stdio: command required" };
  }

  return new Promise((resolve) => {
    const proc = spawn(cmd, args, {
      env: { ...process.env, ...config.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const timeout = setTimeout(() => {
      proc.kill("SIGTERM");
      resolve({ success: false, error: "Timeout waiting for resources/read" });
    }, MCP_TIMEOUT_MS);

    const rl = createInterface({ input: proc.stdout!, crlfDelay: Infinity });
    const lines: string[] = [];
    function onLine(line: string): void {
      lines.push(line);
      processLines();
    }
    rl.on("line", onLine);
    function send(obj: unknown): void {
      const s = JSON.stringify(obj) + "\n";
      proc.stdin?.write(s);
    }
    let state: "init" | "ready" = "init";
    function processLines(): void {
      while (lines.length > 0) {
        const line = lines.shift()!.trim();
        if (!line) continue;
        let msg: { id?: number; method?: string; result?: unknown; error?: { message?: string } };
        try {
          msg = JSON.parse(line) as typeof msg;
        } catch {
          continue;
        }
        if (msg.method === "notifications/initialized" || msg.method === "notifications/cancelled") continue;
        if (state === "init" && msg.result !== undefined) {
          state = "ready";
          send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
          send({ jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri } });
          continue;
        }
        if (state === "ready" && msg.id === 1) {
          proc.kill("SIGTERM");
          clearTimeout(timeout);
          if (msg.error) {
            resolve({ success: false, error: msg.error.message ?? "resources/read failed" });
            return;
          }
          const result = msg.result as { contents?: Array<{ mimeType?: string; blob?: string; text?: string }> } | undefined;
          resolve({ success: true, contents: result?.contents });
          return;
        }
      }
    }
    proc.stdin?.on("error", () => {});
    send({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "gtd-mcp-resources-read", version: "0.1.0" },
      },
    });
  });
}

export interface McpCallResult {
  success: boolean;
  output?: string;
  error?: string;
  isError?: boolean;
}

/**
 * Invoke a tool on an MCP server (stdio only). Performs initialize → initialized → tools/call.
 */
export async function callMcpTool(
  config: McpServerConfig,
  toolName: string,
  args: Record<string, unknown>
): Promise<McpCallResult> {
  if (config.transport !== "stdio") {
    return { success: false, error: "tools/call is only supported for stdio transport" };
  }
  const cmd = config.config.command;
  const commandArgs = config.config.args ?? [];
  if (!cmd) {
    return { success: false, error: "stdio: command required" };
  }

  return new Promise((resolve) => {
    const proc = spawn(cmd, commandArgs, {
      env: { ...process.env, ...config.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const timeout = setTimeout(() => {
      proc.kill("SIGTERM");
      resolve({ success: false, error: "Timeout waiting for tools/call" });
    }, MCP_TIMEOUT_MS);

    const rl = createInterface({ input: proc.stdout!, crlfDelay: Infinity });
    const lines: string[] = [];
    function onLine(line: string): void {
      lines.push(line);
      processLines();
    }
    rl.on("line", onLine);

    proc.stderr?.on("data", () => {});

    function send(obj: Record<string, unknown>): void {
      const msg = JSON.stringify(obj) + "\n";
      proc.stdin?.write(msg);
    }

    proc.on("error", (err) => {
      clearTimeout(timeout);
      rl.close();
      resolve({ success: false, error: err.message });
    });

    let state: "init" | "initialized" | "call" = "init";
    let initDone = false;

    rl.on("close", () => {
      clearTimeout(timeout);
      if (!initDone) resolve({ success: false, error: "Server closed before initialize response" });
    });

    function processLines(): void {
      while (lines.length > 0) {
        const raw = lines.shift()!.trim();
        if (!raw) continue;
        let msg: { id?: number; result?: { content?: Array<{ type?: string; text?: string }>; isError?: boolean }; error?: { message?: string }; method?: string };
        try {
          msg = JSON.parse(raw) as typeof msg;
        } catch {
          continue;
        }
        if (msg.method === "notifications/initialized" || msg.method === "notifications/cancelled") continue;
        if (state === "init" && msg.result !== undefined) {
          initDone = true;
          state = "initialized";
          send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
          send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: toolName, arguments: args ?? {} } });
          state = "call";
          continue;
        }
        if (state === "call" && (msg.id === 2 || msg.result !== undefined || msg.error !== undefined)) {
          proc.kill("SIGTERM");
          clearTimeout(timeout);
          rl.close();
          if (msg.error) {
            resolve({ success: false, error: msg.error.message ?? "tools/call failed" });
            return;
          }
          const result = msg.result;
          const isError = result?.isError === true;
          const content = result?.content ?? [];
          const textParts = content.filter((c) => c.type === "text" && c.text).map((c) => c.text);
          resolve({
            success: !isError,
            output: textParts.length ? textParts.join("\n") : undefined,
            error: isError && textParts.length ? textParts.join("\n") : undefined,
            isError,
          });
          return;
        }
      }
    }

    proc.stdin?.on("error", () => {});

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "gtd-mcp-call", version: "0.1.0" },
      },
    });
  });
}
