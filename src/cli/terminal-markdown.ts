/**
 * Terminal markdown highlighting: code blocks and diff lines.
 * Used when printing deliverable/scout/planner to the TUI (item 7).
 */
import chalk from "chalk";

const FENCE_RE = /```(\w+)?\n([\s\S]*?)```/g;

function highlightDiffBlock(content: string): string {
  return content
    .split("\n")
    .map((line) => {
      if (line.startsWith("+")) return chalk.green(line);
      if (line.startsWith("-")) return chalk.red(line);
      if (line.startsWith("@@")) return chalk.cyan(line);
      return line;
    })
    .join("\n");
}

function highlightCodeBlock(content: string, lang: string): string {
  const lower = lang.toLowerCase();
  if (lower === "diff" || lower === "patch") return highlightDiffBlock(content);
  return chalk.cyan(content);
}

/**
 * Highlight markdown for terminal: fenced code blocks get colored;
 * ```diff blocks get + green, - red, @@ cyan.
 */
export function highlightMarkdown(text: string): string {
  if (!text || typeof text !== "string") return text;
  return text.replace(FENCE_RE, (_, lang, body) => {
    const code = (body ?? "").replace(/\n$/, "");
    return "```" + (lang ?? "") + "\n" + highlightCodeBlock(code, lang ?? "") + "\n```";
  });
}
