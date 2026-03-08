/**
 * Git-native workflows: worktree, branch-per-task, diff, PR.
 */

import { execSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";

export interface WorktreeResult {
  success: boolean;
  path?: string;
  branch?: string;
  error?: string;
}

/**
 * Create a git worktree for a task.
 */
export function createWorktree(cwd: string, branch: string, path?: string): WorktreeResult {
  try {
    const outPath = path ?? join(cwd, `worktree-${branch.replace(/[/\\]/g, "-")}`);
    execSync(`git worktree add ${outPath} -b ${branch}`, { cwd, stdio: "pipe" });
    return { success: true, path: outPath, branch };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}

/**
 * Get current branch name.
 */
export function getCurrentBranch(cwd: string): string | undefined {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", { cwd, encoding: "utf-8" }).trim();
  } catch {
    return undefined;
  }
}

/**
 * Create branch for task (branch-per-task).
 */
export function createBranch(cwd: string, name: string): { success: boolean; branch?: string; error?: string } {
  try {
    execSync(`git checkout -b ${name}`, { cwd, stdio: "pipe" });
    return { success: true, branch: name };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}

/**
 * Get diff stats (short format).
 */
export function getDiffStats(cwd: string, ref = "HEAD"): { success: boolean; output?: string; error?: string } {
  try {
    const output = execSync(`git diff --stat ${ref}`, { cwd, encoding: "utf-8" });
    return { success: true, output };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}

/**
 * Check if directory is a git repo.
 */
export function isGitRepo(cwd: string): boolean {
  return existsSync(join(cwd, ".git"));
}

export interface CreatePrOptions {
  title?: string;
  body?: string;
  base?: string;
  head?: string;
  draft?: boolean;
}

/**
 * Create a PR via gh pr create. Requires gh CLI and GitHub auth.
 * Uses GITHUB_TOKEN or GH_TOKEN from env when set; otherwise gh uses its own auth (gh auth login).
 */
export function createPr(cwd: string, options: CreatePrOptions = {}): { success: boolean; output?: string; error?: string } {
  try {
    const args: string[] = ["pr", "create"];
    if (options.title) args.push("--title", options.title);
    if (options.body) args.push("--body", options.body);
    if (options.base) args.push("--base", options.base);
    if (options.head) args.push("--head", options.head);
    if (options.draft) args.push("--draft");
    const env = { ...process.env };
    const output = execSync(`gh ${args.join(" ")}`, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], env });
    return { success: true, output: output.trim() };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    const msg = err.stderr?.trim() || err.stdout?.trim() || err.message || String(e);
    return { success: false, error: msg };
  }
}

/**
 * Show PR status via gh pr status.
 */
export function prStatus(cwd: string): { success: boolean; output?: string; error?: string } {
  try {
    const output = execSync("gh pr status", { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    return { success: true, output: output.trim() };
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string; message?: string };
    const msg = err.stderr?.trim() || err.stdout?.trim() || err.message || String(e);
    return { success: false, error: msg };
  }
}

/**
 * Create a branch and open a PR in one flow (branch-per-task). Uses gh CLI.
 */
export function createBranchAndPr(
  cwd: string,
  branchName: string,
  prOptions: CreatePrOptions = {}
): { success: boolean; branch?: string; output?: string; error?: string } {
  const branchResult = createBranch(cwd, branchName);
  if (!branchResult.success) return { success: false, error: branchResult.error };
  const prResult = createPr(cwd, { ...prOptions, head: branchName });
  if (!prResult.success) return { success: false, branch: branchName, error: prResult.error };
  return { success: true, branch: branchName, output: prResult.output };
}
