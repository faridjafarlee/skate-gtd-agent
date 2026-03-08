/**
 * Plugin loader: load and validate plugin manifests.
 */

import { readFile } from "fs/promises";
import { join } from "path";
import type { PluginManifest } from "./types.js";

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/;

export interface LoadPluginResult {
  success: boolean;
  manifest?: PluginManifest;
  error?: string;
}

/**
 * Validate manifest against schema rules (no JSON Schema runtime dependency).
 */
function validateManifest(data: unknown): data is PluginManifest {
  if (!data || typeof data !== "object") return false;
  const m = data as Record<string, unknown>;
  if (typeof m.id !== "string" || !ID_PATTERN.test(m.id)) return false;
  if (typeof m.name !== "string" || m.name.length === 0) return false;
  if (typeof m.version !== "string" || !VERSION_PATTERN.test(m.version)) return false;
  return true;
}

/**
 * Load plugin manifest from a directory (expects manifest.json or plugin.json).
 */
export async function loadPluginManifest(pluginDir: string): Promise<LoadPluginResult> {
  const candidates = ["manifest.json", "plugin.json", "package.json"];
  for (const name of candidates) {
    const path = join(pluginDir, name);
    try {
      const raw = await readFile(path, "utf-8");
      const data = JSON.parse(raw) as unknown;
      // package.json may have manifest under "skate", "gtd", or "gtdMantis" (legacy)
      const manifest = (data as Record<string, unknown>).skate ?? (data as Record<string, unknown>).gtd ?? (data as Record<string, unknown>).gtdMantis ?? data;
      if (validateManifest(manifest)) {
        return { success: true, manifest: manifest as PluginManifest };
      }
      if (name === "package.json" && typeof (data as Record<string, unknown>).name === "string") {
        const pkg = data as { name: string; version: string; description?: string };
        const synthetic: PluginManifest = {
          id: pkg.name.replace(/^@[^/]+\//, "").replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "plugin",
          name: pkg.name,
          version: pkg.version,
          description: pkg.description,
        };
        if (validateManifest(synthetic)) {
          return { success: true, manifest: synthetic };
        }
      }
    } catch {
      continue;
    }
  }
  return { success: false, error: `No valid manifest in ${pluginDir}` };
}

/**
 * List plugin manifests from a directory (e.g. node_modules/gtd-*).
 */
export async function discoverPlugins(searchDir: string): Promise<PluginManifest[]> {
  const withPaths = await discoverPluginsWithPaths(searchDir);
  return withPaths.map((p) => p.manifest);
}

export interface PluginWithPath {
  path: string;
  manifest: PluginManifest;
}

/**
 * List plugins with their directory paths (for running commands).
 */
export async function discoverPluginsWithPaths(searchDir: string): Promise<PluginWithPath[]> {
  const { readdir } = await import("fs/promises");
  const out: PluginWithPath[] = [];
  try {
    const entries = await readdir(searchDir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory() && (e.name.startsWith("gtd-") || e.name.startsWith("skate-") || e.name.includes("gtd-mantis-plugin") || e.name.includes("skate-plugin"))) {
        const pluginPath = join(searchDir, e.name);
        const result = await loadPluginManifest(pluginPath);
        if (result.success && result.manifest) {
          out.push({ path: pluginPath, manifest: result.manifest });
        }
      }
    }
  } catch {
    // ignore
  }
  return out;
}
