import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";

import type { Settings } from "../../config/settings.js";
import { createVertexExpressEmbeddingsClient } from "../google/vertexExpress.js";
import { invokeOllamaApi } from "../ollama/api.js";

export type EmbeddingsClient = {
  embedDocuments(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
};

export function createEmbeddings(settings: Settings): EmbeddingsClient {
  if (settings.embeddingProvider === "vertexexpress") {
    return createVertexExpressEmbeddingsClient(settings);
  }
  if (settings.embeddingProvider === "ollama") {
    return createOllamaEmbeddings(settings);
  }
  if (settings.embeddingProvider === "openrouter") {
    return createOpenRouterEmbeddings(settings);
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

function createOpenRouterEmbeddings(settings: Settings): EmbeddingsClient {
  if (!settings.openRouterApiKey) {
    throw new Error("OPENROUTER_API_KEY is required for openrouter embeddings");
  }
  const baseUrl = settings.openRouterBaseUrl ?? "https://openrouter.ai/api/v1";
  const model = settings.openRouterEmbeddingModel ?? "google/gemini-embedding-001";
  const apiKey = settings.openRouterApiKey;
  return {
    async embedDocuments(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) {
        return [];
      }
      return requestOpenRouterEmbeddings(baseUrl, apiKey, model, texts);
    },
    async embedQuery(text: string): Promise<number[]> {
      const vectors = await requestOpenRouterEmbeddings(baseUrl, apiKey, model, [
        text,
      ]);
      return vectors[0] ?? [];
    },
  };
}

async function requestOpenRouterEmbeddings(
  baseUrl: string,
  apiKey: string,
  model: string,
  inputs: string[],
): Promise<number[][]> {
  const response = await fetch(`${baseUrl}/embeddings`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, input: inputs }),
  });

  const raw = await response.text();
  let body: unknown = null;
  if (raw.trim()) {
    try {
      body = JSON.parse(raw);
    } catch {
      body = raw;
    }
  }
  if (!response.ok) {
    const record = asRecord(body);
    const error = asRecord(record?.error);
    const message =
      (typeof error?.message === "string" && error.message) ||
      (typeof body === "string" && body) ||
      `status ${response.status}`;
    throw new Error(`OpenRouter embeddings error (${response.status}): ${message}`);
  }

  const record = asRecord(body);
  const data = record?.data;
  if (!Array.isArray(data)) {
    throw new Error("OpenRouter embeddings response missing data");
  }
  const sorted = [...data].sort((a, b) => {
    const ai = Number(asRecord(a)?.index ?? 0);
    const bi = Number(asRecord(b)?.index ?? 0);
    return ai - bi;
  });
  const vectors = sorted.map((item) => normalizeEmbedding(asRecord(item)?.embedding));
  if (vectors.length !== inputs.length) {
    throw new Error(
      `OpenRouter embeddings count mismatch: expected=${inputs.length} actual=${vectors.length}`,
    );
  }
  return vectors;
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
