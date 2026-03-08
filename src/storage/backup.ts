import { execSync } from "child_process";
import { readdir, mkdir } from "fs/promises";
import { join, dirname, basename } from "path";
import { homedir } from "os";
import { createInterface } from "readline";

function getDataDir(): string {
  return process.env.GTD_DATA_DIR ?? join(homedir(), ".skate");
}

/**
 * Create a timestamped backup archive of the data directory.
 * @param outPath - Optional output path. Default: ./skate-backup-YYYY-MM-DD-HHmmss.tar.gz
 * @returns Path to the created archive
 */
export async function backup(outPath?: string): Promise<string> {
  const dataDir = getDataDir();
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const archivePath = outPath ?? join(process.cwd(), `skate-backup-${timestamp}.tar.gz`);

  try {
    execSync(`tar -czf "${archivePath}" -C "${dirname(dataDir)}" "${basename(dataDir)}"`, {
      stdio: "pipe",
    });
  } catch (e) {
    throw new Error(`Backup failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  return archivePath;
}

/**
 * Restore from a backup archive into the data directory.
 * @param archivePath - Path to the .tar.gz archive
 * @param force - Skip confirmation if directory already has content
 */
export async function restore(archivePath: string, force?: boolean): Promise<void> {
  const dataDir = getDataDir();
  const parentDir = dirname(dataDir);

  if (!force) {
    try {
      const entries = await readdir(dataDir);
      if (entries.length > 0) {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise<string>((resolve) => {
          rl.question(
            `Directory ${dataDir} already has ${entries.length} file(s). Overwrite? [y/N] `,
            resolve
          );
        });
        rl.close();
        if (answer.toLowerCase() !== "y" && answer.toLowerCase() !== "yes") {
          throw new Error("Restore cancelled");
        }
      }
    } catch (err) {
      if (err instanceof Error && err.message === "Restore cancelled") throw err;
      // ENOENT: dir doesn't exist, proceed
    }
  }

  try {
    await mkdir(parentDir, { recursive: true });
    execSync(`tar -xzf "${archivePath}" -C "${parentDir}"`, { stdio: "pipe" });
  } catch (e) {
    throw new Error(`Restore failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
