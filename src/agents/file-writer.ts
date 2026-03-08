import { writeFile, mkdir } from "fs/promises";
import { dirname, join } from "path";

type CodeBlock = { lang: string; path?: string; code: string };

const CODE_BLOCK_RE = /```(\w+)?\n([\s\S]*?)```/g;

const PATH_LIKE = /^[\w./-]+\.\w+$/;

/**
 * Parse markdown code blocks. Supports:
 * - ```ts\nfile.ts\ncode``` (path on first line after lang)
 * - ```ts\ncode``` (no path)
 */
export function parseCodeBlocks(text: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  let m: RegExpExecArray | null;
  CODE_BLOCK_RE.lastIndex = 0;
  while ((m = CODE_BLOCK_RE.exec(text)) !== null) {
    const lang = m[1] ?? "";
    const body = (m[2] ?? "").trim();
    const firstLine = body.split("\n")[0] ?? "";
    const rest = body.includes("\n") ? body.slice(body.indexOf("\n") + 1).trim() : "";
    const looksLikePath = PATH_LIKE.test(firstLine) && !firstLine.includes(" ");
    const path = looksLikePath ? firstLine : undefined;
    const code = looksLikePath ? rest : body;
    blocks.push({ lang, path, code });
  }
  return blocks;
}

export async function writeCodeBlocks(
  blocks: CodeBlock[],
  baseDir: string,
  options?: { dryRun?: boolean }
): Promise<{ written: string[]; skipped: string[] }> {
  const written: string[] = [];
  const skipped: string[] = [];

  for (const block of blocks) {
    if (!block.code) continue;
    const filePath = block.path
      ? join(baseDir, block.path)
      : join(baseDir, `output_${blocks.indexOf(block)}.${block.lang || "txt"}`);

    if (options?.dryRun) {
      written.push(filePath);
      continue;
    }

    try {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, block.code, "utf-8");
      written.push(filePath);
    } catch {
      skipped.push(filePath);
    }
  }

  return { written, skipped };
}
