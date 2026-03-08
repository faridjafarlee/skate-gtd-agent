/**
 * Git auto-commit, undo, dirty handling, and attribution (Aider-style items 13–24).
 */

import { execSync, spawnSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";

const AGENT_SIGNATURE = "(gtd)";
const AGENT_TRAILER = "Co-authored-by: gtd <gtd@skate>";

export function isGitRepo(cwd: string): boolean {
  return existsSync(join(cwd, ".git"));
}

/**
 * Returns true if there are uncommitted changes (staged or unstaged).
 */
export function hasDirtyFiles(cwd: string): boolean {
  try {
    const out = execSync("git status --porcelain", { cwd, encoding: "utf-8" });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Commit all staged and unstaged changes with the given message.
 */
export function commitAll(
  cwd: string,
  message: string,
  opts: { noVerify?: boolean; attribution?: boolean } = {}
): { success: boolean; output?: string; error?: string } {
  try {
    execSync("git add -A", { cwd, encoding: "utf-8", stdio: "pipe" });
    const env = { ...process.env };
    if (opts.attribution) {
      try {
        const author = execSync("git config user.name", { cwd, encoding: "utf-8" }).trim();
        const email = execSync("git config user.email", { cwd, encoding: "utf-8" }).trim();
        const suffixed = author.includes(AGENT_SIGNATURE) ? author : `${author} ${AGENT_SIGNATURE}`;
        env.GIT_AUTHOR_NAME = suffixed;
        env.GIT_AUTHOR_EMAIL = email;
        env.GIT_COMMITTER_NAME = suffixed;
        env.GIT_COMMITTER_EMAIL = email;
      } catch {
        env.GIT_AUTHOR_NAME = "gtd";
        env.GIT_COMMITTER_NAME = "gtd";
      }
    }
    const args = ["commit", "-m", message, ...(opts.noVerify ? ["--no-verify"] : [])];
    const result = spawnSync("git", args, { cwd, encoding: "utf-8", env, stdio: "pipe" });
    if (result.status !== 0) {
      const msg = (result.stderr || result.stdout || "").trim();
      throw new Error(msg || `git commit exited ${result.status}`);
    }
    return { success: true };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    const msg = (err.stderr || err.stdout || err.message || String(e)).trim();
    return { success: false, error: msg };
  }
}

export interface LastCommitInfo {
  sha: string;
  message: string;
  author: string;
  committer: string;
  body?: string;
}

/**
 * Get the last commit's metadata.
 */
export function getLastCommit(cwd: string): LastCommitInfo | null {
  try {
    const format = "%H%n%s%n%an%n%cn%n%b";
    const out = execSync(`git log -1 --format=${format}`, { cwd, encoding: "utf-8" });
    const lines = out.trim().split("\n");
    if (lines.length < 4) return null;
    const [sha, message, author, committer, ...bodyLines] = lines;
    return {
      sha: sha ?? "",
      message: message ?? "",
      author: author ?? "",
      committer: committer ?? "",
      body: bodyLines.length ? bodyLines.join("\n").trim() : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Whether the commit was made by the agent (author or committer contains "(gtd)" or has Co-authored-by: gtd).
 */
export function isAgentCommit(commit: LastCommitInfo): boolean {
  if (!commit) return false;
  if (commit.author.includes(AGENT_SIGNATURE) || commit.committer.includes(AGENT_SIGNATURE)) return true;
  if (commit.body?.includes(AGENT_TRAILER)) return true;
  return false;
}

/**
 * Undo the last commit. If hard is true, discard changes; otherwise reset --soft (keep changes staged).
 */
export function undoLastCommit(cwd: string, hard = true): { success: boolean; output?: string; error?: string } {
  try {
    const mode = hard ? "--hard" : "--soft";
    execSync(`git reset ${mode} HEAD~1`, { cwd, encoding: "utf-8", stdio: "pipe" });
    return { success: true };
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    return { success: false, error: (err.stderr || err.message || String(e)).trim() };
  }
}

/**
 * Generate a short Conventional Commits-style message from task description (heuristic or template).
 * Template: use opts.template (or GTD_COMMIT_MESSAGE_PROMPT); {description} is replaced with first line.
 */
export function generateCommitMessage(
  taskDescription: string,
  opts?: { template?: string; _diffSummary?: string }
): string {
  const firstLine = taskDescription.split(/\n/)[0]?.trim().slice(0, 72) ?? "task";
  const description = firstLine.replace(/["\\]/g, "'").trim() || "update";
  const template = opts?.template ?? process.env.GTD_COMMIT_MESSAGE_PROMPT?.trim();
  if (template) {
    return template.replace(/\{description\}/g, description).trim().slice(0, 72) || "chore: update";
  }
  const lower = description.toLowerCase();
  if (lower.startsWith("fix") || lower.startsWith("add") || lower.startsWith("implement")) return description;
  if (lower.startsWith("feat:") || lower.startsWith("fix:") || lower.startsWith("chore:")) return description;
  return "feat: " + description;
}

/**
 * Run a raw git command; returns combined stdout + stderr. For REPL /git <args>.
 */
export function runGitCommand(cwd: string, args: string): { success: boolean; output: string; error?: string } {
  const result = spawnSync("git", args.trim().split(/\s+/).filter(Boolean), {
    cwd,
    encoding: "utf-8",
    shell: false,
  });
  const out = (result.stdout || "").trim();
  const err = (result.stderr || "").trim();
  const combined = out + (out && err ? "\n" : "") + err;
  return {
    success: result.status === 0,
    output: combined || "(no output)",
    error: result.status !== 0 ? (err || `exit ${result.status}`) : undefined,
  };
}
