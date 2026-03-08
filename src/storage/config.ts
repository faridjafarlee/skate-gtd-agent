import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { homedir } from "os";

/** Path to per-project config (.gtd/config.json). Overrides user config when loading in that directory. */
export function getProjectConfigPath(cwd: string): string {
  return join(cwd, ".gtd", "config.json");
}
import { clearTasks } from "./store.js";
import { resetModelsConfig } from "./models-config.js";

/** Config directory (GTD_DATA_DIR or ~/.skate). Used by setup and config path. */
export function getConfigDir(): string {
  return process.env.GTD_DATA_DIR ?? join(homedir(), ".skate");
}

function getTemplatesPath(): string {
  return join(getConfigDir(), "templates.json");
}

function getConfigPath(): string {
  return join(getConfigDir(), "config.json");
}

function getConfigLockPath(): string {
  return join(getConfigDir(), "config.lock");
}

function getOrgConfigPath(): string {
  return process.env.GTD_ORG_CONFIG ?? join(getConfigDir(), "org.json");
}

function getEnvConfigPath(env: string): string {
  return join(getConfigDir(), `config.${env}.json`);
}

/** Path to the active config file (respects GTD_ENV). */
export function getActiveConfigPath(): string {
  const env = process.env.GTD_ENV;
  return env ? getEnvConfigPath(env) : getConfigPath();
}

export interface CustomAgentDef {
  id: string;
  name: string;
  prompt: string;
  description?: string;
}

export interface ChannelConfig {
  qualityProfile?: "fast" | "balanced" | "max";
  approvalPolicy?: "auto" | "hybrid" | "always";
  defaultModel?: string;
  modelOverrides?: Partial<Record<string, string>>;
}

export type PermissionMode = "default" | "plan" | "accept-edits" | "dont-ask" | "bypass";

/** Aliases for permission modes (acceptEdits → accept-edits, etc.). */
export const PERMISSION_MODE_ALIASES: Record<string, PermissionMode> = {
  acceptEdits: "accept-edits",
  dontAsk: "dont-ask",
  bypassPermissions: "bypass",
};

/** Normalize user-facing permission mode (including aliases) to canonical PermissionMode. */
export function normalizePermissionMode(value: string): PermissionMode | undefined {
  const canonical: PermissionMode[] = ["default", "plan", "accept-edits", "dont-ask", "bypass"];
  if (canonical.includes(value as PermissionMode)) return value as PermissionMode;
  return PERMISSION_MODE_ALIASES[value] ?? undefined;
}

export interface GTDConfig {
  qualityProfile?: "fast" | "balanced" | "max";
  approvalPolicy?: "auto" | "hybrid" | "always";
  defaultModel?: string;
  templates?: Record<string, string>;
  modelOverrides?: Partial<Record<string, string>>;
  /** Per-channel overrides (e.g. telegram: { qualityProfile: "fast" }) */
  channels?: Partial<Record<string, ChannelConfig>>;
  /** Custom agent roles (e.g. Security Auditor, API Designer) */
  agents?: CustomAgentDef[];
  /** Override which roles run per profile. Keys: fast, balanced, max. Values: role IDs (built-in or custom). */
  profileRoles?: Partial<Record<"fast" | "balanced" | "max", string[]>>;
  /** Tool permission mode: default, plan, accept-edits, dont-ask, bypass */
  permissionMode?: PermissionMode;
  /** Default named mode when --mode is not passed: architect | debug | ask | orchestrator */
  defaultMode?: string;
  /** Current org id when org.json has multiple orgs (gtd org use). */
  currentOrg?: string;
  /** Rule files to load and merge (paths relative to cwd or absolute). When set, overrides default lookup. */
  rules?: string[];
  /** Default context file names when rules is not set (e.g. ["CONTEXT.md", "AGENTS.md"]). Resolved relative to cwd. */
  rulesDefaultNames?: string[];
  /** Per-role rule files (CC-10), e.g. { builder: [".gtd/rules.builder.md"], planner: [".gtd/rules.planner.md"] }. */
  rulesByRole?: Partial<Record<string, string[]>>;
  /** MCP resource URIs to load into Planner/Builder context (CC-18), e.g. [{ serverId: "schema", uri: "project://schema.json" }]. */
  mcpContextResources?: Array<{ serverId: string; uri: string }>;
  /** Per-category tool timeouts in ms (e.g. network: 30000, command: 60000). */
  toolTimeouts?: Partial<Record<string, number>>;
  /** Restrict Builder to a subset of tools, e.g. "read_only". */
  toolChoice?: string;
  /** URL template for /bug (REPL). Append headline as query param; e.g. "https://github.com/org/repo/issues/new?title=". Or set GTD_BUG_REPORT_URL. */
  bugReportUrl?: string;
  /** Default exclude patterns for glob/search (e.g. ["node_modules", ".git"]). Used when a glob or file-search tool is available. */
  defaultExcludes?: string[];
  /** Default lint command (e.g. "npm run lint"). Overridden by GTD_LINT_CMD or --lint-cmd. */
  lintCmd?: string;
  /** Per-language lint commands (e.g. { "python": "ruff check .", "typescript": "npm run lint" }). Used when no lintCmd/CLI override. */
  lintByLanguage?: Partial<Record<string, string>>;
  /** Default test command (e.g. "npm test"). Overridden by GTD_TEST_CMD or --test-cmd. */
  testCmd?: string;
  /** Repo map token budget (default 1024). Overridden by GTD_MAP_TOKENS or --map-tokens. */
  mapTokens?: number;
  /** Commit message template; {description} is replaced with task first line. E.g. "feat: {description}". Overridden by GTD_COMMIT_MESSAGE_PROMPT. */
  commitMessagePrompt?: string;
  /** Edit format for Builder: "diff" = prefer apply_patch (unified diff), "whole" = prefer write_file/edit_file. Overridden by GTD_EDIT_FORMAT. */
  editFormat?: "diff" | "whole";
  /** Named profiles (e.g. work, quick) with overrides. Calliope-style. */
  profiles?: Record<string, Partial<Omit<GTDConfig, "profiles" | "channels">>>;
  /** Active profile name; when set, profile overrides are applied on load. */
  defaultProfile?: string;
  /** Preset persona: minimal | professional | poetic. Injected into agent context. */
  persona?: "minimal" | "professional" | "poetic";
  /** Max autonomous agent steps per task (default 20 when unset; cap via --max-turns or GTD_MAX_TURNS). Stops after this many role runs. */
  maxTurns?: number;
  /** When true, prefer local models (e.g. Ollama) when routing; cloud as opt-in (Agent CLI local-first). Overridden by GTD_LOCAL_FIRST. */
  localFirst?: boolean;
}

/** Org-level restrictions (optional org.json or GTD_ORG_CONFIG). */
export interface OrgRestrictions {
  allowedQualityProfiles?: ("fast" | "balanced" | "max")[];
  allowedApprovalPolicies?: ("auto" | "hybrid" | "always")[];
  allowedModels?: string[];
}

/** Org config file: legacy single OrgRestrictions or { orgs: Record<string, OrgRestrictions> }. */
type OrgConfigFile = OrgRestrictions | { orgs: Record<string, OrgRestrictions> };

function normalizeOrgRestrictions(data: OrgRestrictions): OrgRestrictions {
  return {
    allowedQualityProfiles: Array.isArray(data.allowedQualityProfiles) ? data.allowedQualityProfiles : undefined,
    allowedApprovalPolicies: Array.isArray(data.allowedApprovalPolicies) ? data.allowedApprovalPolicies : undefined,
    allowedModels: Array.isArray(data.allowedModels) ? data.allowedModels : undefined,
  };
}

/** List org ids from org config. Returns ["default"] for legacy single-org file. */
export async function listOrgIds(): Promise<string[]> {
  try {
    const raw = await readFile(getOrgConfigPath(), "utf-8");
    const data = JSON.parse(raw) as OrgConfigFile;
    if (!data || typeof data !== "object") return [];
    if ("orgs" in data && data.orgs && typeof data.orgs === "object" && !Array.isArray(data.orgs)) {
      return Object.keys(data.orgs);
    }
    return ["default"];
  } catch {
    return [];
  }
}

/** Load org restrictions for the given current org id (from config.currentOrg). Returns null if file missing or invalid. */
export async function loadOrgRestrictions(currentOrgId?: string): Promise<OrgRestrictions | null> {
  try {
    const raw = await readFile(getOrgConfigPath(), "utf-8");
    const data = JSON.parse(raw) as OrgConfigFile;
    if (!data || typeof data !== "object") return null;
    if ("orgs" in data && data.orgs && typeof data.orgs === "object" && !Array.isArray(data.orgs)) {
      const id = currentOrgId && data.orgs[currentOrgId] ? currentOrgId : Object.keys(data.orgs)[0];
      return id ? normalizeOrgRestrictions(data.orgs[id]) : null;
    }
    return normalizeOrgRestrictions(data as OrgRestrictions);
  } catch {
    return null;
  }
}

/** Reset org cache (for testing). No-op; listOrgIds/loadOrgRestrictions read file each time. */
export function _resetOrgRestrictionsCache(): void {}

/** Apply org restrictions to config: ensure effective values are within allowed lists. */
export function applyOrgRestrictions(cfg: GTDConfig, org: OrgRestrictions | null): GTDConfig {
  if (!org) return cfg;
  let qualityProfile = cfg.qualityProfile ?? "balanced";
  let approvalPolicy = cfg.approvalPolicy ?? "hybrid";
  let defaultModel = cfg.defaultModel;
  if (org.allowedQualityProfiles?.length && !org.allowedQualityProfiles.includes(qualityProfile)) {
    qualityProfile = org.allowedQualityProfiles[0];
  }
  if (org.allowedApprovalPolicies?.length && !org.allowedApprovalPolicies.includes(approvalPolicy)) {
    approvalPolicy = org.allowedApprovalPolicies[0];
  }
  if (org.allowedModels?.length && defaultModel && !org.allowedModels.includes(defaultModel)) {
    defaultModel = org.allowedModels[0];
  }
  return { ...cfg, qualityProfile, approvalPolicy, defaultModel };
}

/** Validate a partial config against org restrictions. Throws if a value is disallowed. */
export function validateConfigAgainstOrg(config: Partial<GTDConfig>, org: OrgRestrictions | null): void {
  if (!org) return;
  if (config.qualityProfile && org.allowedQualityProfiles?.length && !org.allowedQualityProfiles.includes(config.qualityProfile)) {
    throw new Error(`Org restrictions: qualityProfile must be one of ${org.allowedQualityProfiles.join(", ")}`);
  }
  if (config.approvalPolicy && org.allowedApprovalPolicies?.length && !org.allowedApprovalPolicies.includes(config.approvalPolicy)) {
    throw new Error(`Org restrictions: approvalPolicy must be one of ${org.allowedApprovalPolicies.join(", ")}`);
  }
  if (config.defaultModel && org.allowedModels?.length && !org.allowedModels.includes(config.defaultModel)) {
    throw new Error(`Org restrictions: defaultModel must be one of ${org.allowedModels.join(", ")}`);
  }
}

/** Load templates from templates.json (if exists) and merge with config.templates. Config overrides file. */
export async function getMergedTemplates(cfg: GTDConfig): Promise<Record<string, string>> {
  let fromFile: Record<string, string> = {};
  try {
    const raw = await readFile(getTemplatesPath(), "utf-8");
    const data = JSON.parse(raw) as Record<string, string>;
    if (data && typeof data === "object") {
      fromFile = Object.fromEntries(Object.entries(data).filter(([k, v]) => typeof k === "string" && typeof v === "string"));
    }
  } catch {
    // templates.json not found or invalid
  }
  return { ...fromFile, ...(cfg.templates ?? {}) };
}

/** Load per-project config from .gtd/config.json in cwd. Returns null if missing or invalid. Calliope-style. */
export async function loadProjectConfig(cwd: string): Promise<Partial<GTDConfig> | null> {
  const path = getProjectConfigPath(cwd);
  try {
    const raw = await readFile(path, "utf-8");
    const data = JSON.parse(raw) as Record<string, unknown>;
    if (!data || typeof data !== "object") return null;
    const allowed = ["qualityProfile", "approvalPolicy", "defaultModel", "defaultMode", "permissionMode", "mapTokens", "lintCmd", "testCmd", "persona", "defaultProfile", "maxTurns", "localFirst"];
    const out: Partial<GTDConfig> = {};
    for (const k of allowed) {
      if (k in data && data[k] !== undefined) (out as Record<string, unknown>)[k] = data[k];
    }
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}

/** Load user config and merge project overrides for the given cwd. Use for task/interactive when project config should apply. */
export async function loadConfigForCwd(cwd: string): Promise<GTDConfig> {
  const user = await loadConfig();
  const project = await loadProjectConfig(cwd);
  if (!project) return user;
  return { ...user, ...project };
}

/** Merge channel-specific config with global. Use for connectors. */
export function getConfigForChannel(cfg: GTDConfig, channel: string): GTDConfig {
  const ch = cfg.channels?.[channel];
  if (!ch) return cfg;
  return {
    ...cfg,
    qualityProfile: ch.qualityProfile ?? cfg.qualityProfile,
    approvalPolicy: ch.approvalPolicy ?? cfg.approvalPolicy,
    defaultModel: ch.defaultModel ?? cfg.defaultModel,
    modelOverrides: ch.modelOverrides ? { ...cfg.modelOverrides, ...ch.modelOverrides } : cfg.modelOverrides,
  };
}

const DEFAULTS: GTDConfig = {
  qualityProfile: "balanced",
  approvalPolicy: "hybrid",
};

let cached: GTDConfig | null = null;

/** Reset cache (for testing). */
export function _resetConfigCache(): void {
  cached = null;
}

/** Check if config is locked (managed mode: no writes without force). */
export async function isConfigLocked(): Promise<boolean> {
  if (process.env.GTD_CONFIG_LOCK === "1" || process.env.GTD_CONFIG_LOCK === "true") return true;
  try {
    await readFile(getConfigLockPath(), "utf-8");
    return true;
  } catch {
    return false;
  }
}

/** Create config lock file (governance: prevent config changes). */
export async function setConfigLock(locked: boolean): Promise<void> {
  const path = getConfigLockPath();
  if (locked) {
    await mkdir(getConfigDir(), { recursive: true });
    await writeFile(path, JSON.stringify({ locked: true, at: new Date().toISOString() }, null, 2), "utf-8");
  } else {
    const { unlink } = await import("fs/promises");
    try {
      await unlink(path);
    } catch {
      // ignore
    }
  }
}

export async function loadConfig(): Promise<GTDConfig> {
  if (cached) {
    const org = await loadOrgRestrictions(cached.currentOrg);
    return applyOrgRestrictions(cached, org);
  }
  const env = process.env.GTD_ENV;
  const paths = env ? [getEnvConfigPath(env), getConfigPath()] : [getConfigPath()];
  for (const path of paths) {
    try {
      const raw = await readFile(path, "utf-8");
      const data = JSON.parse(raw) as GTDConfig;
      if (data.permissionMode) {
        data.permissionMode = normalizePermissionMode(data.permissionMode) ?? data.permissionMode;
      }
      cached = { ...DEFAULTS, ...data };
      if (cached.defaultProfile && cached.profiles?.[cached.defaultProfile]) {
        const overrides = cached.profiles[cached.defaultProfile];
        if (overrides && typeof overrides === "object") cached = { ...cached, ...overrides };
      }
      if (process.env.GTD_DEFAULT_MODEL) cached.defaultModel = process.env.GTD_DEFAULT_MODEL;
      if (process.env.GTD_QUALITY_PROFILE) cached.qualityProfile = process.env.GTD_QUALITY_PROFILE as GTDConfig["qualityProfile"];
      if (process.env.GTD_LOCAL_FIRST === "1" || process.env.GTD_LOCAL_FIRST === "true") cached.localFirst = true;
      if (process.env.GTD_APPROVAL_POLICY) cached.approvalPolicy = process.env.GTD_APPROVAL_POLICY as GTDConfig["approvalPolicy"];
      if (process.env.GTD_DEFAULT_MODE) cached.defaultMode = process.env.GTD_DEFAULT_MODE;
      if (process.env.GTD_PERMISSION_MODE) cached.permissionMode = normalizePermissionMode(process.env.GTD_PERMISSION_MODE) ?? cached.permissionMode;
      const org = await loadOrgRestrictions(cached.currentOrg);
      return applyOrgRestrictions(cached, org);
    } catch (err) {
      const isNotFound = err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT";
      if (!isNotFound) throw err;
    }
  }
  cached = { ...DEFAULTS };
  if (process.env.GTD_DEFAULT_MODEL) cached.defaultModel = process.env.GTD_DEFAULT_MODEL;
  if (process.env.GTD_QUALITY_PROFILE) cached.qualityProfile = process.env.GTD_QUALITY_PROFILE as GTDConfig["qualityProfile"];
  if (process.env.GTD_APPROVAL_POLICY) cached.approvalPolicy = process.env.GTD_APPROVAL_POLICY as GTDConfig["approvalPolicy"];
  if (process.env.GTD_LOCAL_FIRST === "1" || process.env.GTD_LOCAL_FIRST === "true") cached.localFirst = true;
  const dir = getConfigDir();
  await mkdir(dir, { recursive: true });
  await writeFile(paths[0], JSON.stringify(cached, null, 2), "utf-8");
  const org = await loadOrgRestrictions(cached.currentOrg);
  return applyOrgRestrictions(cached, org);
}

export interface SaveConfigOptions {
  /** When true, write even if config is locked (governance override). */
  force?: boolean;
}

export async function saveConfig(config: Partial<GTDConfig>, opts?: SaveConfigOptions): Promise<void> {
  const locked = await isConfigLocked();
  if (locked && !opts?.force) {
    throw new Error("Config is locked. Use 'gtd config unlock' or saveConfig(..., { force: true }) to override.");
  }
  const current = await loadConfig();
  const org = await loadOrgRestrictions(current.currentOrg);
  validateConfigAgainstOrg(config, org);
  const merged = { ...current, ...config };
  cached = merged;
  await mkdir(getConfigDir(), { recursive: true });
  const path = process.env.GTD_ENV ? getEnvConfigPath(process.env.GTD_ENV) : getConfigPath();
  await writeFile(path, JSON.stringify(merged, null, 2), "utf-8");
}

export interface ResetConfigOptions {
  /** When true, also clears tasks (tasks.json) and models config (models.json). */
  all?: boolean;
}

export async function resetConfig(opts?: ResetConfigOptions): Promise<void> {
  cached = { ...DEFAULTS };
  await mkdir(getConfigDir(), { recursive: true });
  const path = process.env.GTD_ENV ? getEnvConfigPath(process.env.GTD_ENV) : getConfigPath();
  await writeFile(path, JSON.stringify(cached, null, 2), "utf-8");

  if (opts?.all) {
    await clearTasks();
    await resetModelsConfig();
  }
}
