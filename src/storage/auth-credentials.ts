/**
 * Login/logout: store API keys in a file under data dir and load them at CLI startup.
 * File format: KEY=value per line (shell-sourceable). Used by gtd auth login/logout.
 */
import { readFileSync, existsSync } from "fs";
import { writeFile, readFile, mkdir, unlink } from "fs/promises";
import { join } from "path";
import { getDataDir } from "./store.js";

const AUTH_ENV_FILE = "env";

export function getAuthEnvPath(): string {
  return join(getDataDir(), AUTH_ENV_FILE);
}

/** Known provider env var names (for login prompts and status). */
export const PROVIDER_ENV_KEYS: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_AI_API_KEY",
  gemini: "GOOGLE_AI_API_KEY",
};
export const GTD_API_KEY_NAME = "GTD_API_KEY";

/**
 * Load KEY=value lines from auth env file into process.env.
 * Call at CLI startup so gtd commands see stored keys. Skips empty lines and comments.
 */
export function loadAuthEnvSync(): void {
  const path = getAuthEnvPath();
  try {
    if (!existsSync(path)) return;
    const raw = readFileSync(path, "utf-8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx <= 0) continue;
      const key = trimmed.slice(0, idx).trim();
      const value = trimmed.slice(idx + 1).trim();
      if (key) process.env[key] = value;
    }
  } catch {
    // ignore missing or unreadable file
  }
}

/**
 * Save a single provider key to the auth file. Merges with existing lines (by key).
 */
export async function saveAuthCredential(envKey: string, value: string): Promise<void> {
  const dir = getDataDir();
  await mkdir(dir, { recursive: true });
  const path = getAuthEnvPath();
  let lines: string[] = [];
  try {
    const raw = await readFile(path, "utf-8");
    const existing = new Map<string, string>();
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx > 0) {
        const k = trimmed.slice(0, idx).trim();
        const v = trimmed.slice(idx + 1).trim();
        if (k) existing.set(k, v);
      }
    }
    existing.set(envKey, value);
    lines = Array.from(existing.entries()).map(([k, v]) => `${k}=${v}`);
  } catch {
    lines = [`${envKey}=${value}`];
  }
  await writeFile(path, lines.join("\n") + "\n", "utf-8");
}

/**
 * Remove all stored credentials (delete the env file).
 */
export async function clearAuthCredentials(): Promise<boolean> {
  const path = getAuthEnvPath();
  try {
    if (existsSync(path)) {
      await unlink(path);
      return true;
    }
  } catch {
    // ignore
  }
  return false;
}

/**
 * Return which of the known provider keys are set (from env, including after loadAuthEnvSync).
 */
export function getSetProviderKeys(): string[] {
  const set: string[] = [];
  for (const envKey of Object.values(PROVIDER_ENV_KEYS)) {
    if (process.env[envKey]?.trim()) set.push(envKey);
  }
  if (process.env[GTD_API_KEY_NAME]?.trim()) set.push(GTD_API_KEY_NAME);
  return set;
}

export function hasStoredAuthFile(): boolean {
  return existsSync(getAuthEnvPath());
}
