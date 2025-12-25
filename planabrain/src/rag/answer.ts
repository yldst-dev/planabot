import { HumanMessage, SystemMessage } from "@langchain/core/messages";

import type { Settings } from "../config/settings.js";
import { createChatModel } from "../integrations/gemini/chat.js";
import { createEmbeddings } from "../integrations/gemini/embeddings.js";
import { loadIndex } from "../retrieval/indexStore.js";
import { topKSimilarChunks } from "../retrieval/search.js";
import { buildContext } from "./context.js";

export async function answerQuestion(params: {
  question: string;
  settings: Settings;
}): Promise<string> {
  const index = await loadIndex(params.settings.indexPath);
  if (index.embeddingModel !== params.settings.embeddingModel) {
    throw new Error(
      `Embedding model mismatch.\nIndex: ${index.embeddingModel}\nCurrent: ${params.settings.embeddingModel}\nRe-run: npm run dev -- ingest <sourceDir>`
    );
  }

  const embeddings = createEmbeddings(params.settings);
  const queryEmbedding = await embeddings.embedQuery(params.question);
  const expectedDim = index.embeddingDimension ?? index.chunks.find((c) => c.embedding.length > 0)?.embedding.length ?? 0;
  if (expectedDim <= 0) {
    throw new Error(
      `Index embeddings are invalid. Re-run: npm run dev -- ingest <sourceDir>`
    );
  }
  if (queryEmbedding.length !== expectedDim) {
    throw new Error(
      `Embedding dimension mismatch.\nIndex: ${expectedDim}\nQuery: ${queryEmbedding.length}\nRe-run: npm run dev -- ingest <sourceDir>`
    );
  }

  const top = topKSimilarChunks({
    queryEmbedding,
    chunks: index.chunks,
    k: 4
  });

  const context = buildContext(top.map((t) => t.chunk));
  const llm = createChatModel(params.settings);

  const result = await llm.invoke([
    new SystemMessage(params.settings.systemPrompt),
    new HumanMessage(`Question:\n${params.question}\n\nContext:\n${context}`)
  ]);

  return String(result.content);
}
