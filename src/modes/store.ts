/**
 * Mode profiles: per-mode model/tool/permission presets.
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { homedir } from "os";

function getDataDir(): string {
  return process.env.GTD_DATA_DIR ?? join(homedir(), ".skate");
}

function getModesPath(): string {
  return join(getDataDir(), "modes.json");
}

export interface ModeDefinition {
  id: string;
  name: string;
  qualityProfile?: "fast" | "balanced" | "max";
  approvalPolicy?: "auto" | "hybrid" | "always";
  permissionMode?: "default" | "plan" | "accept-edits" | "dont-ask" | "bypass";
  defaultModel?: string;
  modelOverrides?: Record<string, string>;
}

export interface ModesStore {
  modes: ModeDefinition[];
  active?: string;
}

async function readModes(): Promise<ModesStore> {
  try {
    const raw = await readFile(getModesPath(), "utf-8");
    const data = JSON.parse(raw) as ModesStore;
    return data && Array.isArray(data.modes) ? data : { modes: [] };
  } catch {
    return { modes: [] };
  }
}

async function writeModes(store: ModesStore): Promise<void> {
  await mkdir(getDataDir(), { recursive: true });
  await writeFile(getModesPath(), JSON.stringify(store, null, 2), "utf-8");
}

export async function listModes(): Promise<ModeDefinition[]> {
  const store = await readModes();
  return store.modes;
}

export async function getMode(id: string): Promise<ModeDefinition | undefined> {
  const store = await readModes();
  return store.modes.find((m) => m.id === id);
}

export async function setMode(mode: ModeDefinition): Promise<void> {
  const store = await readModes();
  const idx = store.modes.findIndex((m) => m.id === mode.id);
  if (idx >= 0) {
    store.modes[idx] = mode;
  } else {
    store.modes.push(mode);
  }
  await writeModes(store);
}

export async function deleteMode(id: string): Promise<boolean> {
  const store = await readModes();
  const idx = store.modes.findIndex((m) => m.id === id);
  if (idx < 0) return false;
  store.modes.splice(idx, 1);
  if (store.active === id) store.active = undefined;
  await writeModes(store);
  return true;
}

export async function getActiveMode(): Promise<string | undefined> {
  const store = await readModes();
  return store.active;
}

export async function setActiveMode(id: string | undefined): Promise<void> {
  const store = await readModes();
  store.active = id;
  await writeModes(store);
}
