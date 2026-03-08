/**
 * Run plugin lifecycle hooks (beforeTask, afterTask) from manifests.
 * Discover plugins from GTD_PLUGINS_DIR or node_modules and invoke hook scripts.
 */

import { spawn } from "child_process";
import { join } from "path";
import { discoverPluginsWithPaths } from "./loader.js";
import type { PluginHooks } from "./types.js";

const HOOK_TIMEOUT_MS = Math.max(5000, Math.min(60_000, parseInt(process.env.GTD_PLUGIN_HOOK_TIMEOUT_MS ?? "15000", 10) || 15_000));

function getPluginsDir(): string {
  return process.env.GTD_PLUGINS_DIR || join(process.cwd(), "node_modules");
}

/**
 * Run a single hook script (path relative to plugin dir). Env is merged with process.env.
 */
function runHookScript(pluginPath: string, scriptPath: string, env: Record<string, string>): Promise<void> {
  const absoluteScript = join(pluginPath, scriptPath);
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [absoluteScript], {
      env: { ...process.env, ...env },
      stdio: "ignore",
      cwd: pluginPath,
    });
    const t = setTimeout(() => {
      proc.kill("SIGTERM");
      resolve();
    }, HOOK_TIMEOUT_MS);
    proc.on("exit", () => {
      clearTimeout(t);
      resolve();
    });
    proc.on("error", () => resolve());
  });
}

/**
 * Run all plugins' beforeTask hooks. Call once before starting the pipeline.
 */
export async function runBeforeTaskHooks(env: { TASK_ID: string; TASK_DESCRIPTION: string }): Promise<void> {
  const searchDir = getPluginsDir();
  const plugins = await discoverPluginsWithPaths(searchDir);
  const baseEnv = { ...env, TASK_PHASE: "pre_task" };
  for (const { path: pluginPath, manifest } of plugins) {
    const hooks = (manifest as { hooks?: PluginHooks }).hooks;
    const script = hooks?.beforeTask;
    if (script?.trim()) {
      await runHookScript(pluginPath, script, { ...baseEnv, GTD_PLUGIN_ID: manifest.id, GTD_PLUGIN_PATH: pluginPath });
    }
  }
}

/**
 * Run all plugins' afterTask hooks. Call once after the pipeline ends.
 */
export async function runAfterTaskHooks(env: {
  TASK_ID: string;
  TASK_DESCRIPTION: string;
  TASK_STATUS: string;
  TASK_ERROR?: string;
}): Promise<void> {
  const searchDir = getPluginsDir();
  const plugins = await discoverPluginsWithPaths(searchDir);
  const baseEnv = { ...env, TASK_PHASE: "post_task" };
  for (const { path: pluginPath, manifest } of plugins) {
    const hooks = (manifest as { hooks?: PluginHooks }).hooks;
    const script = hooks?.afterTask;
    if (script?.trim()) {
      await runHookScript(pluginPath, script, { ...baseEnv, GTD_PLUGIN_ID: manifest.id, GTD_PLUGIN_PATH: pluginPath });
    }
  }
}

/**
 * Run all plugins' beforeAgent hooks. Call before each role (Scout, Planner, Builder, etc.).
 */
export async function runBeforeAgentHooks(env: { TASK_ID: string; TASK_DESCRIPTION: string; ROLE: string }): Promise<void> {
  const searchDir = getPluginsDir();
  const plugins = await discoverPluginsWithPaths(searchDir);
  const baseEnv = { ...env, TASK_PHASE: "pre_agent" };
  for (const { path: pluginPath, manifest } of plugins) {
    const hooks = (manifest as { hooks?: PluginHooks }).hooks;
    const script = hooks?.beforeAgent;
    if (script?.trim()) {
      await runHookScript(pluginPath, script, { ...baseEnv, GTD_PLUGIN_ID: manifest.id, GTD_PLUGIN_PATH: pluginPath });
    }
  }
}

/**
 * Run all plugins' afterAgent hooks. Call after each role.
 */
export async function runAfterAgentHooks(env: { TASK_ID: string; TASK_DESCRIPTION: string; ROLE: string }): Promise<void> {
  const searchDir = getPluginsDir();
  const plugins = await discoverPluginsWithPaths(searchDir);
  const baseEnv = { ...env, TASK_PHASE: "post_agent" };
  for (const { path: pluginPath, manifest } of plugins) {
    const hooks = (manifest as { hooks?: PluginHooks }).hooks;
    const script = hooks?.afterAgent;
    if (script?.trim()) {
      await runHookScript(pluginPath, script, { ...baseEnv, GTD_PLUGIN_ID: manifest.id, GTD_PLUGIN_PATH: pluginPath });
    }
  }
}
