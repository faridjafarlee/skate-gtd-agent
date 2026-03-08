/**
 * MCP server configuration store.
 * Register, list, remove MCP servers.
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { homedir } from "os";

function getDataDir(): string {
  return process.env.GTD_DATA_DIR ?? join(homedir(), ".skate");
}

function getMcpPath(): string {
  return join(getDataDir(), "mcp.json");
}

export type McpTransportType = "stdio" | "url";

export interface McpServerConfig {
  id: string;
  name: string;
  /** stdio: spawn command. url: HTTP/SSE endpoint */
  transport: McpTransportType;
  /** For stdio: { command, args? }. For url: { url } */
  config: { command?: string; args?: string[]; url?: string };
  /** Optional env overrides */
  env?: Record<string, string>;
}

export interface McpStore {
  servers: McpServerConfig[];
}

async function readMcp(): Promise<McpStore> {
  try {
    const raw = await readFile(getMcpPath(), "utf-8");
    const data = JSON.parse(raw) as McpStore;
    return data && Array.isArray(data.servers) ? data : { servers: [] };
  } catch {
    return { servers: [] };
  }
}

async function writeMcp(store: McpStore): Promise<void> {
  await mkdir(getDataDir(), { recursive: true });
  await writeFile(getMcpPath(), JSON.stringify(store, null, 2), "utf-8");
}

export async function listMcpServers(): Promise<McpServerConfig[]> {
  const store = await readMcp();
  return store.servers;
}

export async function getMcpServer(id: string): Promise<McpServerConfig | undefined> {
  const store = await readMcp();
  return store.servers.find((s) => s.id === id);
}

export async function registerMcpServer(config: McpServerConfig): Promise<void> {
  const store = await readMcp();
  const idx = store.servers.findIndex((s) => s.id === config.id);
  if (idx >= 0) {
    store.servers[idx] = config;
  } else {
    store.servers.push(config);
  }
  await writeMcp(store);
}

export async function removeMcpServer(id: string): Promise<boolean> {
  const store = await readMcp();
  const idx = store.servers.findIndex((s) => s.id === id);
  if (idx < 0) return false;
  store.servers.splice(idx, 1);
  await writeMcp(store);
  return true;
}
