/**
 * Sandbox execution layer for shell and tool calls.
 * Policy-enforced; optional OS sandbox:
 * - Linux: bubblewrap (bwrap) when GTD_USE_BWRAP=1
 * - macOS: sandbox-exec when GTD_USE_SANDBOX=1 (minimal profile: cwd + env)
 * - Per-project profile: .gtd/sandbox.json overrides GTD_SANDBOX_PROFILE for that cwd.
 */

import { exec, spawnSync } from "child_process";
import { promisify } from "util";
import { platform } from "os";
import { readFile } from "fs/promises";
import { join } from "path";
import { checkCommandPermission, type ToolPolicy } from "./policy.js";

const execAsync = promisify(exec);

export interface SandboxOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  /** Extra read-only directories (Linux bwrap: --ro-bind; Windows: no-op; macOS: use .gtd/sandbox.json) */
  extraReadDirs?: string[];
}

/** Parse positive integer from env; return default if unset or invalid. */
function parseSandboxLimit(envKey: string, defaultVal: number): number {
  const v = process.env[envKey];
  if (v === undefined || v === "") return defaultVal;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 0x7fff) : defaultVal;
}

const DEFAULT_MAX_OPEN_FILES = 256;
const DEFAULT_MAX_PROCESSES = 64;

/** A.1: Sandbox on by default when available; set GTD_SANDBOX_DISABLE=1 to opt out. */
function useBwrap(plat: NodeJS.Platform): boolean {
  if (plat !== "linux") return false;
  if (process.env.GTD_SANDBOX_DISABLE === "1" || process.env.GTD_SANDBOX_DISABLE === "true") return false;
  if (process.env.GTD_USE_BWRAP === "0" || process.env.GTD_USE_BWRAP === "false") return false;
  return true;
}

function useMacOSSandbox(plat: NodeJS.Platform): boolean {
  if (plat !== "darwin") return false;
  if (process.env.GTD_SANDBOX_DISABLE === "1" || process.env.GTD_SANDBOX_DISABLE === "true") return false;
  if (process.env.GTD_USE_SANDBOX === "0" || process.env.GTD_USE_SANDBOX === "false") return false;
  return true;
}

/** Return current sandbox mechanism for doctor/visibility. */
export function getSandboxMechanism(): "bwrap" | "sandbox-exec" | "none" {
  const plat = platform();
  if (useBwrap(plat)) return "bwrap";
  if (useMacOSSandbox(plat)) return "sandbox-exec";
  return "none";
}

/** Session-level extra read-only dirs (REPL: sandbox-add-read-dir). Used by bwrap on Linux. */
const sandboxExtraReadDirs: string[] = [];
export function getSandboxExtraReadDirs(): string[] {
  return [...sandboxExtraReadDirs];
}
export function addSandboxExtraReadDir(dir: string): void {
  const n = dir.trim();
  if (n && !sandboxExtraReadDirs.includes(n)) sandboxExtraReadDirs.push(n);
}
export function clearSandboxExtraReadDirs(): void {
  sandboxExtraReadDirs.length = 0;
}

const SANDBOX_CONFIG_DIR = ".gtd";
const SANDBOX_CONFIG_FILE = "sandbox.json";

/**
 * Load sandbox profile path from .gtd/sandbox.json in the given directory.
 * Overrides GTD_SANDBOX_PROFILE for that project. Returns undefined if missing or invalid.
 * Relative paths in "profile" are resolved against cwd.
 */
export async function loadSandboxProfileFromProject(cwd: string): Promise<string | undefined> {
  const path = join(cwd, SANDBOX_CONFIG_DIR, SANDBOX_CONFIG_FILE);
  try {
    const raw = await readFile(path, "utf-8");
    const data = JSON.parse(raw) as Record<string, unknown>;
    const profile = typeof data?.profile === "string" ? data.profile.trim() : undefined;
    if (!profile) return undefined;
    if (profile.startsWith("/")) return profile;
    return join(cwd, profile);
  } catch {
    return undefined;
  }
}

/**
 * Wrap command with ulimit -n (max open files) and -u (max processes) so the sandboxed shell and children are limited.
 * No-op if limits are not supported (e.g. Alpine); 2>/dev/null avoids noise.
 */
function wrapCommandWithLimits(command: string): string {
  const maxOpen = parseSandboxLimit("GTD_SANDBOX_MAX_OPEN_FILES", DEFAULT_MAX_OPEN_FILES);
  const maxProc = parseSandboxLimit("GTD_SANDBOX_MAX_PROCESSES", DEFAULT_MAX_PROCESSES);
  return `ulimit -n ${maxOpen} -u ${maxProc} 2>/dev/null; ${command}`;
}

/** Whether to allow network in bwrap. When GTD_SANDBOX_NETWORK=allow, network is allowed; otherwise denied (--unshare-net). */
function bwrapNetworkAllowed(): boolean {
  const v = process.env.GTD_SANDBOX_NETWORK?.toLowerCase().trim();
  return v === "allow" || v === "1" || v === "true";
}

/** Build bwrap args to run command in a minimal namespace with cwd bound. */
function bwrapArgs(cwd: string, command: string, extraReadDirs: string[] = []): string[] {
  const cwdNorm = cwd.replace(/\\/g, "/");
  const wrapped = wrapCommandWithLimits(command);
  const args = [
    "--ro-bind", "/", "/",
    "--dev", "/dev",
    "--proc", "/proc",
    "--tmpfs", "/tmp",
    "--bind", cwdNorm, cwdNorm,
    "--chdir", cwdNorm,
  ];
  if (!bwrapNetworkAllowed()) args.push("--unshare-net");
  for (const d of extraReadDirs) {
    const norm = d.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
    if (norm && norm !== cwdNorm) args.push("--ro-bind", norm, norm);
  }
  args.push("--", "sh", "-c", wrapped);
  return args;
}

/**
 * Execute a shell command with policy enforcement.
 * When GTD_USE_BWRAP=1 and platform is Linux, runs the command inside bubblewrap if available.
 */
export async function runSandboxedCommand(
  command: string,
  policy: ToolPolicy,
  options: SandboxOptions = {}
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const perm = checkCommandPermission(command, policy);
  if (perm === "deny") {
    throw new Error(`Command denied by policy: ${command}`);
  }
  if (perm === "ask") {
    throw new Error(`Command requires approval: ${command}`);
  }

  const timeout = options.timeoutMs ?? 30_000;
  const env = { ...process.env, ...options.env };
  const cwd = options.cwd ?? process.cwd();

  const plat = platform();
  const useBwrapNow = useBwrap(plat);
  const extraReadDirs = options.extraReadDirs ?? getSandboxExtraReadDirs();
  if (useBwrapNow) {
    const args = bwrapArgs(cwd, command, extraReadDirs);
    const result = spawnSync("bwrap", args, {
      cwd,
      env: { ...env },
      encoding: "utf-8",
      timeout,
      maxBuffer: 1024 * 1024,
    });
    const spawnFailed = result.error || result.status === 127;
    if (!spawnFailed) {
      const stdout = (result.stdout ?? "") as string;
      const stderr = (result.stderr ?? "") as string;
      const exitCode = result.status ?? 1;
      return { stdout, stderr, exitCode };
    }
  }

  if (useMacOSSandbox(plat)) {
    const projectProfile = await loadSandboxProfileFromProject(cwd);
    const profilePath = projectProfile ?? process.env.GTD_SANDBOX_PROFILE?.trim();
    const wrappedCommand = wrapCommandWithLimits(command);
    const sandboxArgs = profilePath
      ? ["-f", profilePath, "-D", `CWD=${cwd}`, "-D", `HOME=${env.HOME ?? process.env.HOME ?? ""}`, "sh", "-c", wrappedCommand]
      : ["-D", `CWD=${cwd}`, "-D", `HOME=${env.HOME ?? process.env.HOME ?? ""}`, "sh", "-c", wrappedCommand];
    const result = spawnSync(
      "sandbox-exec",
      sandboxArgs,
      { cwd, env: { ...env }, encoding: "utf-8", timeout, maxBuffer: 1024 * 1024 }
    );
    const stdout = (result.stdout ?? "") as string;
    const stderr = (result.stderr ?? "") as string;
    const exitCode = result.status ?? 1;
    return { stdout, stderr, exitCode };
  }

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      env,
      timeout,
      maxBuffer: 1024 * 1024,
    });
    return { stdout: stdout ?? "", stderr: stderr ?? "", exitCode: 0 };
  } catch (e) {
    const err = e as { code?: number; killed?: boolean; signal?: string };
    const exitCode = typeof err.code === "number" ? err.code : 1;
    const stdout = (e as { stdout?: string }).stdout ?? "";
    const stderr = (e as { stderr?: string }).stderr ?? (e instanceof Error ? e.message : String(e));
    return { stdout, stderr, exitCode };
  }
}
