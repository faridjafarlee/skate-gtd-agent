/**
 * Optional RAG: embed memory entries and MEMORY.md chunks, store vectors,
 * retrieve by similarity when building context. Enabled when GTD_RAG_ENABLED=1 and OPENAI_API_KEY is set.
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { homedir } from "os";

function getDataDir(): string {
  return process.env.GTD_DATA_DIR ?? join(homedir(), ".skate");
}

function getVectorsPath(): string {
  return join(getDataDir(), "vectors.json");
}

export interface VectorChunk {
  id: string;
  text: string;
  embedding: number[];
}

function isRagEnabled(): boolean {
  return process.env.GTD_RAG_ENABLED === "1" && Boolean(process.env.OPENAI_API_KEY);
}

async function embed(text: string): Promise<number[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return [];
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "text-embedding-3-small",
      input: text.slice(0, 8000),
    }),
  });
  if (!res.ok) return [];
  const data = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
  const emb = data.data?.[0]?.embedding;
  return Array.isArray(emb) ? emb : [];
}

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

interface VectorsFile {
  chunks?: VectorChunk[];
  memoryHash?: string;
}

async function readVectorsFile(): Promise<VectorsFile> {
  try {
    const raw = await readFile(getVectorsPath(), "utf-8");
    const data = JSON.parse(raw) as VectorsFile;
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

function readVectors(): Promise<VectorChunk[]> {
  return readVectorsFile().then((f) => (Array.isArray(f.chunks) ? f.chunks : []));
}

function simpleHash(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) - h + text.charCodeAt(i)) | 0;
  }
  return String(h);
}

async function writeVectors(chunks: VectorChunk[], memoryHash?: string): Promise<void> {
  await mkdir(getDataDir(), { recursive: true });
  const payload: VectorsFile = { chunks };
  if (memoryHash) payload.memoryHash = memoryHash;
  await writeFile(getVectorsPath(), JSON.stringify(payload, null, 0), "utf-8");
}

/**
 * Index text chunks (e.g. memory entries or MEMORY.md segments). No-op if RAG disabled.
 * @param memoryHash - Optional; if set, stored so indexChunksIfNeeded can skip when unchanged.
 */
export async function indexChunks(
  chunks: { id: string; text: string }[],
  options?: { memoryHash?: string }
): Promise<void> {
  if (!isRagEnabled() || chunks.length === 0) return;
  const existing = await readVectors();
  const byId = new Map(existing.map((c) => [c.id, c]));
  for (const { id, text } of chunks) {
    const embedding = await embed(text);
    if (embedding.length) byId.set(id, { id, text, embedding });
  }
  await writeVectors([...byId.values()], options?.memoryHash);
}

/**
 * Content signature for memory (e.g. hash of MEMORY.md + entries). Used to skip re-indexing when unchanged.
 */
export function memoryContentSignature(projectMemory: string, entries: Array<{ id: string; key: string; value: string }>): string {
  const parts = [projectMemory, ...entries.map((e) => `${e.id}:${e.key}:${e.value}`)];
  return simpleHash(parts.join("\n"));
}

/**
 * Index chunks only when contentSignature differs from the last stored hash. No-op if RAG disabled or signature unchanged.
 */
export async function indexChunksIfNeeded(
  chunks: { id: string; text: string }[],
  contentSignature: string
): Promise<void> {
  if (!isRagEnabled() || chunks.length === 0) return;
  const file = await readVectorsFile();
  if (file.memoryHash === contentSignature) return;
  await indexChunks(chunks, { memoryHash: contentSignature });
}

/**
 * Retrieve top-k most similar chunks to the query. Returns their text. Empty if RAG disabled.
 */
export async function retrieve(query: string, k: number): Promise<string[]> {
  const withSources = await retrieveWithSources(query, k);
  return withSources.map((x) => x.text);
}

export interface RagChunkWithSource {
  text: string;
  sourceId: string;
}

/**
 * Retrieve top-k most similar chunks with source attribution (chunk id, e.g. mem_0 or entry id).
 */
export async function retrieveWithSources(query: string, k: number): Promise<RagChunkWithSource[]> {
  if (!isRagEnabled() || k <= 0) return [];
  const chunks = await readVectors();
  if (chunks.length === 0) return [];
  const queryEmb = await embed(query);
  if (queryEmb.length === 0) return [];
  const scored = chunks
    .map((c) => ({ id: c.id, text: c.text, score: cosine(c.embedding, queryEmb) }))
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, k).map((s) => ({ text: s.text, sourceId: s.id }));
}
