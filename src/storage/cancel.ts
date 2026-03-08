import { writeFile, unlink } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

function getDataDir(): string {
  return process.env.GTD_DATA_DIR ?? join(homedir(), ".skate");
}

function getCancelPath(taskId: string): string {
  return join(getDataDir(), `cancel-${taskId}`);
}

export function cancelPath(taskId: string): string {
  return getCancelPath(taskId);
}

export function isCancelled(taskId: string): boolean {
  return existsSync(getCancelPath(taskId));
}

export async function requestCancel(taskId: string): Promise<void> {
  await writeFile(getCancelPath(taskId), "1", "utf-8");
}

export async function clearCancel(taskId: string): Promise<void> {
  try {
    await unlink(getCancelPath(taskId));
  } catch {
    // Ignore if file doesn't exist
  }
}
