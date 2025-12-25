import type { StoredChunk } from "../retrieval/types.js";

export function buildContext(chunks: StoredChunk[]): string {
  return chunks.map((c) => `SOURCE: ${c.source}\n${c.text}`).join("\n\n---\n\n");
}
