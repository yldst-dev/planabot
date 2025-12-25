import crypto from "node:crypto";

import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";

import type { Settings } from "../config/settings.js";
import { createEmbeddings } from "../integrations/gemini/embeddings.js";
import { loadSourceDirectory } from "../loaders/sourceDirectory.js";
import { saveIndex } from "../retrieval/indexStore.js";
import type { StoredChunk, StoredIndex } from "../retrieval/types.js";

export async function ingestDirectory(params: {
  sourceDir: string;
  settings: Settings;
}): Promise<number> {
  const docs = await loadSourceDirectory(params.sourceDir);

  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 1000,
    chunkOverlap: 150
  });
  const splits = await splitter.splitDocuments(docs);

  const texts = splits.map((d) => d.pageContent);
  const sources = splits.map((d) => String(d.metadata.source ?? ""));

  const embeddings = createEmbeddings(params.settings);
  const vectors = await embeddings.embedDocuments(texts);

  if (vectors.length !== texts.length) {
    throw new Error(
      `Embedding count mismatch: texts=${texts.length} embeddings=${vectors.length}`
    );
  }

  const embeddingDimension = vectors[0]?.length ?? 0;
  if (embeddingDimension <= 0) {
    throw new Error(
      `Embedding dimension invalid (${embeddingDimension}). Check embedding model: ${params.settings.embeddingModel}`
    );
  }

  for (let i = 0; i < vectors.length; i += 1) {
    const dim = vectors[i]?.length ?? 0;
    if (dim !== embeddingDimension) {
      throw new Error(
        `Embedding dimension mismatch at chunk ${i}: expected=${embeddingDimension} actual=${dim}`
      );
    }
  }

  const chunks: StoredChunk[] = texts.map((text, i) => {
    const source = sources[i] ?? "";
    const id = crypto
      .createHash("sha256")
      .update(`${source}\n${text}`)
      .digest("hex");

    return {
      id,
      source,
      text,
      embedding: vectors[i] ?? []
    };
  });

  const index: StoredIndex = {
    version: 1,
    embeddingModel: params.settings.embeddingModel,
    embeddingDimension,
    chunks
  };

  await saveIndex(params.settings.indexPath, index);
  return chunks.length;
}
