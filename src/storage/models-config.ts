import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { applyEnabledIds, getEnabledModelIds } from "../core/models/registry.js";

function getConfigPath(): string {
  const dir = process.env.GTD_DATA_DIR ?? join(homedir(), ".skate");
  return join(dir, "models.json");
}

/** Returns enabled model IDs, or null if config file doesn't exist (use defaults). */
export async function loadEnabledModels(): Promise<string[] | null> {
  try {
    const path = getConfigPath();
    const raw = await readFile(path, "utf-8");
    const data = JSON.parse(raw) as { enabled?: string[] };
    return Array.isArray(data?.enabled) ? data.enabled : [];
  } catch {
    return null;
  }
}

export async function saveEnabledModels(enabled: string[]): Promise<void> {
  const path = getConfigPath();
  const dir = process.env.GTD_DATA_DIR ?? join(homedir(), ".skate");
  await mkdir(dir, { recursive: true });
  await writeFile(path, JSON.stringify({ enabled }, null, 2), "utf-8");
}

let modelsConfigLoaded = false;

export async function loadAndApplyModelsConfig(): Promise<void> {
  if (modelsConfigLoaded) return;
  modelsConfigLoaded = true;
  const enabled = await loadEnabledModels();
  if (enabled !== null) {
    applyEnabledIds(enabled);
  }
}

export async function persistModelsConfig(): Promise<void> {
  const enabled = getEnabledModelIds();
  await saveEnabledModels(enabled);
}

/** Reset models config to empty (clears models.json and in-memory enabled state). */
export async function resetModelsConfig(): Promise<void> {
  await saveEnabledModels([]);
  applyEnabledIds([]);
}
