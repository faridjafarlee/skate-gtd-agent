import { describe, it, expect } from "vitest";
import { parseCodeBlocks, writeCodeBlocks } from "../../src/agents/file-writer.js";
import { mkdtemp, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

describe("File Writer", () => {
  it("parses code blocks", () => {
    const text = `
\`\`\`ts
file.ts
const x = 1;
\`\`\`

\`\`\`js
console.log("hi");
\`\`\`
`;
    const blocks = parseCodeBlocks(text);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].lang).toBe("ts");
    expect(blocks[0].path).toBe("file.ts");
    expect(blocks[0].code).toContain("const x = 1");
    expect(blocks[1].path).toBeUndefined();
    expect(blocks[1].code).toContain('console.log("hi")');
  });

  it("writes code blocks to disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gtd-"));
    const blocks = [
      { lang: "ts", path: "foo.ts", code: "export const x = 1;" },
      { lang: "txt", path: undefined, code: "hello" },
    ];
    const { written, skipped } = await writeCodeBlocks(blocks, dir);
    expect(written).toHaveLength(2);
    expect(skipped).toHaveLength(0);
    const content = await readFile(join(dir, "foo.ts"), "utf-8");
    expect(content).toBe("export const x = 1;");
  });

  it("dryRun returns paths without writing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gtd-"));
    const blocks = [{ lang: "ts", path: "dry.ts", code: "x" }];
    const { written } = await writeCodeBlocks(blocks, dir, { dryRun: true });
    expect(written).toContain(join(dir, "dry.ts"));
    await expect(readFile(join(dir, "dry.ts"), "utf-8")).rejects.toThrow();
  });
});
