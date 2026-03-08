/**
 * Plugin SDK types and manifest definition.
 */

export interface PluginToolProvider {
  name: string;
  description: string;
  parameters?: Record<string, { type: string; description?: string; required?: boolean }>;
}

export interface PluginCommand {
  id: string;
  name: string;
  description?: string;
  handler?: string;
}

export interface PluginPrompt {
  id: string;
  template: string;
  description?: string;
}

export interface PluginHooks {
  beforeTask?: string;
  afterTask?: string;
  /** Per-role: run before each agent (Scout, Planner, Builder, etc.). Env: ROLE, TASK_PHASE=pre_agent. */
  beforeAgent?: string;
  /** Per-role: run after each agent. Env: ROLE, TASK_PHASE=post_agent. */
  afterAgent?: string;
}

export interface PluginMemoryAdapter {
  id: string;
  type: "project" | "user" | "org";
  config?: Record<string, unknown>;
}

export interface PluginChannelAdapter {
  id: string;
  name: string;
  config?: Record<string, unknown>;
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  toolProviders?: PluginToolProvider[];
  commands?: PluginCommand[];
  prompts?: PluginPrompt[];
  hooks?: PluginHooks;
  memoryAdapters?: PluginMemoryAdapter[];
  channelAdapters?: PluginChannelAdapter[];
}
