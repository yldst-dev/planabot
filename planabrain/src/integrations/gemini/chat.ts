import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";

import type { Settings } from "../../config/settings.js";
import { createGoogleSearchTool } from "../googleSearch/retrievalTool.js";

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "developer" | "tool";
  content: string;
};

export async function invokeChat(params: {
  settings: Settings;
  messages: ChatMessage[];
  enableGoogleSearchTool?: boolean;
}): Promise<string> {
  if (params.settings.aiProvider === "google") {
    return invokeGoogleChat(params);
  }
  return invokeGeminiMockChat(params.settings, params.messages);
}

function createChatModel(settings: Settings): ChatGoogleGenerativeAI {
  if (!settings.googleApiKey) {
    throw new Error(
      "GOOGLE_API_KEY is required when PLANABRAIN_AI_PROVIDER=google",
    );
  }
  return new ChatGoogleGenerativeAI({
    apiKey: settings.googleApiKey,
    model: settings.chatModel,
    maxOutputTokens: settings.chatMaxOutputTokens,
    topP: 0.7,
    thinkingConfig: {
      thinkingLevel: "LOW",
    },
  });
}

async function invokeGoogleChat(params: {
  settings: Settings;
  messages: ChatMessage[];
  enableGoogleSearchTool?: boolean;
}): Promise<string> {
  const model = params.enableGoogleSearchTool
    ? createChatModel(params.settings).bindTools([createGoogleSearchTool()])
    : createChatModel(params.settings);

  const result = await model.invoke(toLangChainMessages(params.messages));
  return normalizeLangChainContent(result.content);
}

async function invokeGeminiMockChat(
  settings: Settings,
  messages: ChatMessage[],
): Promise<string> {
  if (!settings.geminiMockBaseUrl) {
    throw new Error(
      "PLANABRAIN_GEMINIMOCK_BASE_URL or GEMINI_CLI_API_HOST/GEMINI_CLI_API_PORT is required when PLANABRAIN_AI_PROVIDER=geminimock",
    );
  }
  const payload: Record<string, unknown> = {
    model: settings.chatModel,
    messages: messages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
  };

  const response = await fetch(
    `${settings.geminiMockBaseUrl}/v1/chat/completions`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    },
  );

  const body = await readJsonOrText(response);
  if (!response.ok) {
    throw new Error(buildApiErrorMessage(body, response.status));
  }

  const content = extractOpenAIContent(body);
  if (!content) {
    throw new Error(
      "GeminiMock API response missing choices[0].message.content",
    );
  }
  return content;
}

function toLangChainMessages(
  messages: ChatMessage[],
): Array<SystemMessage | HumanMessage | AIMessage> {
  return messages.map((message) => {
    if (message.role === "system") {
      return new SystemMessage(message.content);
    }
    if (message.role === "assistant") {
      return new AIMessage(message.content);
    }
    return new HumanMessage(message.content);
  });
}

function normalizeLangChainContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const parts = content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        const record = asRecord(item);
        const text = record?.text;
        return typeof text === "string" ? text : "";
      })
      .filter((item) => item.length > 0);
    if (parts.length > 0) {
      return parts.join("\n");
    }
  }
  return String(content ?? "");
}

async function readJsonOrText(response: Response): Promise<unknown> {
  const raw = await response.text();
  if (!raw.trim()) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function buildApiErrorMessage(body: unknown, status: number): string {
  const record = asRecord(body);
  const nestedError = asRecord(record?.error);
  const nestedMessage = nestedError?.message;
  if (typeof nestedMessage === "string" && nestedMessage.trim()) {
    return `GeminiMock API error (${status}): ${nestedMessage.trim()}`;
  }
  const message = record?.message;
  if (typeof message === "string" && message.trim()) {
    return `GeminiMock API error (${status}): ${message.trim()}`;
  }
  if (typeof body === "string" && body.trim()) {
    return `GeminiMock API error (${status}): ${body.trim()}`;
  }
  return `GeminiMock API error (${status})`;
}

function extractOpenAIContent(body: unknown): string {
  const record = asRecord(body);
  const choices = record?.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return "";
  }
  const firstChoice = asRecord(choices[0]);
  const message = asRecord(firstChoice?.message);
  const content = message?.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const parts = content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        const recordItem = asRecord(item);
        const text = recordItem?.text;
        return typeof text === "string" ? text : "";
      })
      .filter((item) => item.length > 0);
    return parts.join("\n");
  }
  return "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  return value as Record<string, unknown>;
}
