import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";

import type { Settings } from "../../config/settings.js";
import { createVertexExpressEmbeddingsClient } from "../google/vertexExpress.js";
import { invokeOllamaApi } from "../ollama/api.js";

export type EmbeddingsClient = {
  embedDocuments(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
};

export function createEmbeddings(settings: Settings): EmbeddingsClient {
  if (settings.aiProvider === "vertexexpress") {
    return createVertexExpressEmbeddingsClient(settings);
  }
  if (settings.aiProvider === "ollama") {
    return createOllamaEmbeddings(settings);
  }
  if (!settings.googleApiKey) {
    throw new Error(
      "GOOGLE_API_KEY is required for the current embeddings configuration",
    );
  }
  return new GoogleGenerativeAIEmbeddings({
    apiKey: settings.googleApiKey,
    modelName: settings.embeddingModel,
  });
}

function createOllamaEmbeddings(settings: Settings): EmbeddingsClient {
  if (!settings.ollamaHost) {
    throw new Error("PLANABRAIN_OLLAMA_HOST is required for ollama embeddings");
  }
  if (settings.ollamaApiKeys.length === 0) {
    throw new Error("OLLAMA_API_KEY or OLLAMA_API_KEYS is required for ollama embeddings");
  }

  return {
    async embedDocuments(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) {
        return [];
      }
      const payload = await invokeOllamaEmbed(settings, texts);
      return extractEmbeddings(payload, texts.length);
    },
    async embedQuery(text: string): Promise<number[]> {
      const payload = await invokeOllamaEmbed(settings, [text]);
      const vectors = extractEmbeddings(payload, 1);
      return vectors[0] ?? [];
    },
  };
}

async function invokeOllamaEmbed(settings: Settings, inputs: string[]): Promise<unknown> {
  return invokeOllamaApi({
    providerName: "Ollama embeddings",
    host: settings.ollamaHost,
    apiKeys: settings.ollamaApiKeys,
    path: "/api/embed",
    payload: {
      model: settings.embeddingModel,
      input: inputs,
      truncate: true,
    },
  });
}

function extractEmbeddings(payload: unknown, expectedCount: number): number[][] {
  const record = asRecord(payload);
  const embeddings = record?.embeddings;
  if (!Array.isArray(embeddings)) {
    throw new Error("Ollama embeddings response missing embeddings");
  }
  const vectors = embeddings.map((item) => normalizeEmbedding(item));
  if (vectors.length !== expectedCount) {
    throw new Error(
      `Ollama embeddings count mismatch: expected=${expectedCount} actual=${vectors.length}`,
    );
  }
  return vectors;
}

function normalizeEmbedding(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  return value as Record<string, unknown>;
}
