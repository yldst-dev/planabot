import type { StoredChunk } from "./types.js";
import { cosineSimilarity } from "./similarity.js";

export function topKSimilarChunks(params: {
  queryEmbedding: number[];
  chunks: StoredChunk[];
  k: number;
}): Array<{ chunk: StoredChunk; score: number }> {
  const expectedDim = params.queryEmbedding.length;
  const valid = params.chunks.filter((c) => c.embedding.length === expectedDim);

  if (expectedDim === 0 || valid.length === 0) {
    throw new Error(
      "No valid embeddings found in index. Re-run: npm run dev -- ingest <sourceDir>"
    );
  }

  const scored = valid
    .map((chunk) => ({ chunk, score: cosineSimilarity(params.queryEmbedding, chunk.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, params.k);

  return scored;
}
