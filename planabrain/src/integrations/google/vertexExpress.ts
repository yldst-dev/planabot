import { GoogleGenAI } from "@google/genai";

import type { Settings } from "../../config/settings.js";
import { createGoogleSearchTool } from "../googleSearch/retrievalTool.js";

const DEFAULT_CHAT_TEMPERATURE = 1.0;
const DEFAULT_CHAT_TOP_P = 0.7;

type VertexChatMessage = {
  role: "system" | "user" | "assistant" | "developer" | "tool";
  content: string;
  name?: string;
  images?: Array<{
    data: string;
    mimeType: string;
  }>;
};

export type VertexExpressChatResult = {
  content: string;
  finishReason?: string;
};

export function createVertexExpressEmbeddingsClient(settings: Settings): {
  embedDocuments(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
} {
  const ai = createVertexExpressClient(settings);
  return {
    async embedDocuments(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) {
        return [];
      }
      const response = await ai.models.embedContent({
        model: settings.embeddingModel,
        contents: texts,
      });
      return normalizeVertexEmbeddings(response.embeddings, texts.length);
    },
    async embedQuery(text: string): Promise<number[]> {
      const response = await ai.models.embedContent({
        model: settings.embeddingModel,
        contents: [text],
      });
      const vectors = normalizeVertexEmbeddings(response.embeddings, 1);
      return vectors[0] ?? [];
    },
  };
}

export async function invokeVertexExpressChat(params: {
  settings: Settings;
  messages: VertexChatMessage[];
  enableSearchTool?: boolean;
}): Promise<VertexExpressChatResult> {
  return invokeVertexExpressChatWithOptions({
    settings: params.settings,
    messages: params.messages,
    enableSearchTool: params.enableSearchTool,
    allowRetryWithoutTools: true,
  });
}

async function invokeVertexExpressChatWithOptions(params: {
  settings: Settings;
  messages: VertexChatMessage[];
  enableSearchTool?: boolean;
  allowRetryWithoutTools: boolean;
}): Promise<VertexExpressChatResult> {
  const ai = createVertexExpressClient(params.settings);
  const systemInstruction = buildSystemInstruction(params.messages);
  const contents = buildVertexContents(params.messages);
  if (contents.length === 0) {
    throw new Error("Vertex Express request missing user or assistant contents");
  }

  const config: Record<string, unknown> = {
    temperature: DEFAULT_CHAT_TEMPERATURE,
    topP: DEFAULT_CHAT_TOP_P,
  };
  if (params.settings.chatMaxOutputTokens) {
    config.maxOutputTokens = params.settings.chatMaxOutputTokens;
  }
  if (systemInstruction) {
    config.systemInstruction = {
      role: "user",
      parts: [{ text: systemInstruction }],
    };
  }
  const thinkingConfig = buildVertexThinkingConfig(
    params.settings.chatModel,
    params.settings.chatThinkingMode,
  );
  if (thinkingConfig) {
    config.thinkingConfig = thinkingConfig;
  }
  if (params.enableSearchTool) {
    config.tools = [createGoogleSearchTool()];
  }

  const response = await ai.models.generateContent({
    model: params.settings.chatModel,
    contents,
    config,
  });
  const extractedText = extractVertexResponseText(response);
  if (extractedText) {
    return {
      content: extractedText,
      finishReason: extractVertexFinishReason(response),
    };
  }
  if (params.allowRetryWithoutTools && params.enableSearchTool) {
    return invokeVertexExpressChatWithOptions({
      settings: params.settings,
      messages: params.messages,
      enableSearchTool: false,
      allowRetryWithoutTools: false,
    });
  }
  throw new Error(buildVertexResponseErrorMessage(response));
}

function createVertexExpressClient(settings: Settings): GoogleGenAI {
  if (!settings.vertexExpressApiKey) {
    throw new Error(
      "GOOGLE_VERTEX_EXPRESS_API_KEY or VERTEX_EXPRESS_API_KEY is required when PLANABRAIN_AI_PROVIDER=vertexexpress",
    );
  }
  const originalConsoleDebug = console.debug;
  console.debug = (...args: unknown[]) => {
    const first = args[0];
    if (
      typeof first === "string" &&
      first.includes(
        "The user provided Vertex AI API key will take precedence over the project/location from the environment variables.",
      )
    ) {
      return;
    }
    originalConsoleDebug(...args);
  };
  try {
    return new GoogleGenAI({
      vertexai: true,
      apiKey: settings.vertexExpressApiKey,
      apiVersion: settings.vertexExpressApiVersion,
    });
  } finally {
    console.debug = originalConsoleDebug;
  }
}

function normalizeVertexEmbeddings(
  embeddings: Array<{ values?: number[] }> | undefined,
  expectedCount: number,
): number[][] {
  if (!Array.isArray(embeddings)) {
    throw new Error("Vertex Express embeddings response missing embeddings");
  }
  const vectors = embeddings.map((embedding) =>
    Array.isArray(embedding.values)
      ? embedding.values.filter((value) => Number.isFinite(value))
      : [],
  );
  if (vectors.length !== expectedCount) {
    throw new Error(
      `Vertex Express embeddings count mismatch: expected=${expectedCount} actual=${vectors.length}`,
    );
  }
  return vectors;
}

function buildSystemInstruction(messages: VertexChatMessage[]): string {
  const parts = messages
    .filter((message) => message.role === "system" || message.role === "developer")
    .map((message) => message.content.trim())
    .filter((content) => content.length > 0);
  return parts.join("\n\n");
}

function buildVertexContents(messages: VertexChatMessage[]): Array<Record<string, unknown>> {
  const contents: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (message.role === "system" || message.role === "developer") {
      continue;
    }
    const parts: Array<Record<string, unknown>> = [];
    const text = normalizeVertexMessageText(message);
    if (text) {
      parts.push({ text });
    }
    if (message.role === "user" && Array.isArray(message.images)) {
      for (const image of message.images) {
        parts.push({
          inlineData: {
            data: image.data,
            mimeType: image.mimeType,
          },
        });
      }
    }
    if (parts.length === 0) {
      continue;
    }
    contents.push({
      role: message.role === "assistant" ? "model" : "user",
      parts,
    });
  }
  return contents;
}

function normalizeVertexMessageText(message: VertexChatMessage): string {
  const content = message.content.trim();
  if (message.role === "tool") {
    if (!content) {
      return message.name ? `도구 결과(${message.name})` : "도구 결과";
    }
    return message.name
      ? `도구 결과(${message.name}):\n${content}`
      : `도구 결과:\n${content}`;
  }
  return content;
}

function buildVertexThinkingConfig(
  model: string,
  mode: Settings["chatThinkingMode"],
): Record<string, unknown> | undefined {
  if (mode === "default") {
    return undefined;
  }
  if (mode === "off") {
    if (isGemini3Model(model)) {
      return { thinkingLevel: "MINIMAL" };
    }
    return { thinkingBudget: 0 };
  }
  if (mode === "minimal") {
    return { thinkingLevel: "MINIMAL" };
  }
  return { thinkingLevel: mode };
}

function isGemini3Model(model: string): boolean {
  return model.trim().toLowerCase().startsWith("gemini-3-");
}

function extractVertexResponseText(response: unknown): string | null {
  const record = asRecord(response);
  const directText = typeof record?.text === "string" ? record.text.trim() : "";
  if (directText) {
    return directText;
  }
  const candidates = Array.isArray(record?.candidates) ? record.candidates : [];
  for (const candidateValue of candidates) {
    const candidate = asRecord(candidateValue);
    const content = asRecord(candidate?.content);
    const parts = Array.isArray(content?.parts) ? content.parts : [];
    const text = parts
      .map((part) => asRecord(part))
      .filter((part) => part && part.thought !== true && typeof part.text === "string")
      .map((part) => (typeof part?.text === "string" ? part.text.trim() : ""))
      .filter((part) => part.length > 0)
      .join("");
    if (text) {
      return text;
    }
  }
  return null;
}

function extractVertexFinishReason(response: unknown): string | undefined {
  const record = asRecord(response);
  const firstCandidate = Array.isArray(record?.candidates)
    ? asRecord(record.candidates[0])
    : null;
  const finishReason =
    typeof firstCandidate?.finishReason === "string"
      ? firstCandidate.finishReason.trim()
      : "";
  return finishReason || undefined;
}

function buildVertexResponseErrorMessage(response: unknown): string {
  const record = asRecord(response);
  const promptFeedback = asRecord(record?.promptFeedback);
  const blockReasonMessage =
    typeof promptFeedback?.blockReasonMessage === "string"
      ? promptFeedback.blockReasonMessage.trim()
      : "";
  if (blockReasonMessage) {
    return `Vertex Express API blocked prompt: ${blockReasonMessage}`;
  }
  if (typeof promptFeedback?.blockReason === "string" && promptFeedback.blockReason) {
    return `Vertex Express API blocked prompt: ${promptFeedback.blockReason}`;
  }
  const firstCandidate = Array.isArray(record?.candidates)
    ? asRecord(record.candidates[0])
    : null;
  const finishMessage =
    typeof firstCandidate?.finishMessage === "string"
      ? firstCandidate.finishMessage.trim()
      : "";
  if (finishMessage) {
    return `Vertex Express API returned no text: ${finishMessage}`;
  }
  const finishReason =
    typeof firstCandidate?.finishReason === "string" ? firstCandidate.finishReason : "";
  if (finishReason) {
    return `Vertex Express API returned no text: finishReason=${finishReason}`;
  }
  const content = asRecord(firstCandidate?.content);
  const partKinds = (Array.isArray(content?.parts) ? content.parts : [])
    .flatMap((part) =>
      Object.entries(asRecord(part) ?? {})
        .filter(([, value]) => value !== undefined && value !== null)
        .map(([key]) => key),
    )
    .filter((key) => key !== "thought" && key !== "thoughtSignature");
  if (partKinds.length > 0) {
    return `Vertex Express API returned no text parts: ${Array.from(new Set(partKinds)).join(",")}`;
  }
  return "Vertex Express API response missing text";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  return value as Record<string, unknown>;
}
