import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";

import type { Settings } from "../../config/settings.js";
import { sanitizeAssistantOutput } from "../../chat/sanitizeOutput.js";
import { createGoogleSearchTool } from "../googleSearch/retrievalTool.js";
import { invokeVertexExpressChat } from "../google/vertexExpress.js";
import { invokeOllamaApi } from "../ollama/api.js";

const DEFAULT_CHAT_TEMPERATURE = 1.0;
const DEFAULT_CHAT_TOP_P = 0.7;

type GeminiSafetySetting = {
  category: string;
  threshold: string;
};

export type InputImage = {
  data: string;
  mimeType: string;
};

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "developer" | "tool";
  content: string;
  name?: string;
  images?: InputImage[];
};

type SearchToolName = "web_search" | "web_fetch";

type OllamaToolCall = {
  id: string;
  name: SearchToolName;
  arguments: Record<string, unknown>;
};

type ChatInvocationResult = {
  content: string;
  finishReason?: string;
};

export async function invokeChat(params: {
  settings: Settings;
  messages: ChatMessage[];
  enableSearchTool?: boolean;
}): Promise<string> {
  const output = await invokeChatWithContinuation(params);
  return sanitizeAssistantOutput(output);
}

async function invokeChatWithContinuation(params: {
  settings: Settings;
  messages: ChatMessage[];
  enableSearchTool?: boolean;
}): Promise<string> {
  let workingMessages = [...params.messages];
  let combined = "";
  const maxContinuations = 2;

  for (let attempt = 0; attempt <= maxContinuations; attempt += 1) {
    const result = await invokeChatOnce({
      settings: params.settings,
      messages: workingMessages,
      enableSearchTool: params.enableSearchTool,
    });
    combined = combined
      ? mergeContinuationContent(combined, result.content)
      : result.content.trim();
    if (!shouldContinueChat(result.finishReason, combined)) {
      return normalizeContinuationArtifacts(combined);
    }
    if (attempt === maxContinuations) {
      return normalizeContinuationArtifacts(combined);
    }
    workingMessages = [
      ...params.messages,
      {
        role: "assistant",
        content: combined,
      },
      {
        role: "user",
        content:
          "방금 답변한 마지막 문장 다음부터만 이어서 남은 정보와 출처를 적어 주십시오. 이미 쓴 서두는 반복하지 말고, 메타 설명이나 내부 판단은 쓰지 마십시오.",
      },
    ];
  }

  return normalizeContinuationArtifacts(combined);
}

async function invokeChatOnce(params: {
  settings: Settings;
  messages: ChatMessage[];
  enableSearchTool?: boolean;
}): Promise<ChatInvocationResult> {
  const hasImages = params.messages.some((message) => (message.images?.length ?? 0) > 0);
  if (params.settings.aiProvider === "google") {
    if (hasImages) {
      throw new Error("이미지 입력은 현재 openrouter 또는 ollama provider에서만 지원합니다.");
    }
    return invokeGoogleChat(params);
  }
  if (params.settings.aiProvider === "vertexexpress") {
    return invokeVertexExpressChat(params);
  }
  if (params.settings.aiProvider === "openrouter") {
    return invokeOpenRouterChat(params.settings, params.messages, params.enableSearchTool);
  }
  if (params.settings.aiProvider === "geminimock" && hasImages) {
    throw new Error("이미지 입력은 현재 openrouter 또는 ollama provider에서만 지원합니다.");
  }
  if (params.settings.aiProvider === "ollama") {
    return invokeOllamaChat(params.settings, params.messages, params.enableSearchTool);
  }
  return invokeGeminiMockChat(params.settings, params.messages);
}

function createChatModel(settings: Settings): ChatGoogleGenerativeAI {
  if (!settings.googleApiKey) {
    throw new Error(
      "GOOGLE_API_KEY is required when PLANABRAIN_AI_PROVIDER=google",
    );
  }
  const config: ConstructorParameters<typeof ChatGoogleGenerativeAI>[0] = {
    apiKey: settings.googleApiKey,
    model: settings.chatModel,
    temperature: DEFAULT_CHAT_TEMPERATURE,
    maxOutputTokens: settings.chatMaxOutputTokens,
    topP: DEFAULT_CHAT_TOP_P,
  };
  const thinkingConfig = buildGoogleThinkingConfig(settings.chatThinkingMode);
  if (thinkingConfig) {
    config.thinkingConfig = thinkingConfig;
  }
  return new ChatGoogleGenerativeAI(config);
}

async function invokeGoogleChat(params: {
  settings: Settings;
  messages: ChatMessage[];
  enableSearchTool?: boolean;
}): Promise<ChatInvocationResult> {
  const model = params.enableSearchTool
    ? createChatModel(params.settings).bindTools([createGoogleSearchTool()])
    : createChatModel(params.settings);

  const result = await model.invoke(toLangChainMessages(params.messages));
  return {
    content: normalizeLangChainContent(result.content),
    finishReason: extractLangChainFinishReason(result),
  };
}

async function invokeGeminiMockChat(
  settings: Settings,
  messages: ChatMessage[],
): Promise<ChatInvocationResult> {
  if (!settings.geminiMockBaseUrl) {
    throw new Error(
      "PLANABRAIN_GEMINIMOCK_BASE_URL or GEMINI_CLI_API_HOST/GEMINI_CLI_API_PORT is required when PLANABRAIN_AI_PROVIDER=geminimock",
    );
  }
  const payload: Record<string, unknown> = {
    model: settings.chatModel,
    temperature: DEFAULT_CHAT_TEMPERATURE,
    top_p: DEFAULT_CHAT_TOP_P,
    safety_settings: buildSafetySettingsOff(),
    messages: messages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
  };
  const geminiMockThinkingLevel = buildGeminiMockThinkingLevel(
    settings.chatThinkingMode,
  );
  if (geminiMockThinkingLevel) {
    payload.thinking_level = geminiMockThinkingLevel;
  }
  if (settings.chatMaxOutputTokens) {
    payload.max_tokens = settings.chatMaxOutputTokens;
  }

  return invokeOpenAICompatibleChat({
    providerName: "GeminiMock",
    url: `${settings.geminiMockBaseUrl}/v1/chat/completions`,
    payload,
  });
}

async function invokeOpenRouterChat(
  settings: Settings,
  messages: ChatMessage[],
  enableSearchTool: boolean | undefined,
): Promise<ChatInvocationResult> {
  if (!settings.openRouterApiKey) {
    throw new Error(
      "OPENROUTER_API_KEY is required when PLANABRAIN_AI_PROVIDER=openrouter",
    );
  }
  if (!settings.openRouterBaseUrl) {
    throw new Error(
      "PLANABRAIN_OPENROUTER_BASE_URL is required when PLANABRAIN_AI_PROVIDER=openrouter",
    );
  }

  const payload: Record<string, unknown> = {
    model: settings.chatModel,
    temperature: DEFAULT_CHAT_TEMPERATURE,
    top_p: DEFAULT_CHAT_TOP_P,
    messages: messages.map((message) => ({
      role: normalizeOpenAIRole(message.role),
      content: toOpenAIMessageContent(message),
    })),
  };
  const openRouterWebSearchTool = buildOpenRouterWebSearchTool(
    settings,
    enableSearchTool,
  );
  if (openRouterWebSearchTool) {
    payload.tools = [openRouterWebSearchTool];
  }
  if (settings.chatMaxOutputTokens) {
    payload.max_tokens = settings.chatMaxOutputTokens;
  }

  const headers: Record<string, string> = {
    authorization: `Bearer ${settings.openRouterApiKey}`,
  };
  if (settings.openRouterSiteUrl) {
    headers["http-referer"] = settings.openRouterSiteUrl;
  }
  if (settings.openRouterAppName) {
    headers["x-title"] = settings.openRouterAppName;
  }

  return invokeOpenAICompatibleChat({
    providerName: "OpenRouter",
    url: `${settings.openRouterBaseUrl}/chat/completions`,
    headers,
    payload,
  });
}

function buildOpenRouterWebSearchTool(
  settings: Settings,
  enableSearchTool: boolean | undefined,
): Record<string, unknown> | null {
  if (!(enableSearchTool && settings.openRouterWebSearchEnabled)) {
    return null;
  }
  const parameters: Record<string, unknown> = {
    max_results: settings.openRouterWebSearchMaxResults,
    search_context_size: settings.openRouterWebSearchContextSize,
  };
  if (settings.openRouterWebSearchMaxTotalResults) {
    parameters.max_total_results = settings.openRouterWebSearchMaxTotalResults;
  }
  return {
    type: "openrouter:web_search",
    parameters,
  };
}

async function invokeOllamaChat(
  settings: Settings,
  messages: ChatMessage[],
  enableSearchTool: boolean | undefined,
): Promise<ChatInvocationResult> {
  const normalizedMessages = messages.map((message) => toOllamaMessage(message));
  const searchEnabled = Boolean(enableSearchTool && settings.ollamaWebSearchEnabled);
  const tools = searchEnabled ? buildOllamaSearchTools(settings.ollamaWebFetchEnabled) : undefined;
  const maxIterations = Math.max(1, settings.ollamaToolMaxIterations);
  let workingMessages = normalizedMessages;

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const payload: Record<string, unknown> = {
      model: settings.chatModel,
      stream: false,
      messages: workingMessages,
    };
    const ollamaThinkingMode = buildOllamaThinkingMode(
      settings.chatThinkingMode,
    );
    if (ollamaThinkingMode !== undefined) {
      payload.think = ollamaThinkingMode;
    }
    if (tools) {
      payload.tools = tools;
    }
    if (settings.chatMaxOutputTokens) {
      payload.options = {
        num_predict: settings.chatMaxOutputTokens,
      };
    }

    const response = await invokeOllamaApi({
      providerName: "Ollama",
      host: settings.ollamaHost,
      apiKeys: settings.ollamaApiKeys,
      path: "/api/chat",
      payload,
    });
    const message = extractOllamaMessage(response);
    const toolCalls = extractOllamaToolCalls(message);
    if (toolCalls.length === 0) {
      const content = normalizeOllamaContent(message.content);
      if (!content) {
        throw new Error("Ollama API response missing message.content");
      }
      return {
        content,
        finishReason: extractOllamaFinishReason(response),
      };
    }

    workingMessages = [...workingMessages, message];
    for (const toolCall of toolCalls) {
      const result = await executeOllamaToolCall(settings, toolCall);
      workingMessages.push({
        role: "tool",
        name: toolCall.name,
        content: JSON.stringify(result),
      });
    }
  }

  throw new Error("Ollama tool-calling exceeded iteration limit");
}

function buildGoogleThinkingConfig(
  mode: Settings["chatThinkingMode"],
): { thinkingLevel: "LOW" | "MEDIUM" | "HIGH" } | undefined {
  if (mode === "off" || mode === "default") {
    return undefined;
  }
  return {
    thinkingLevel: mode.toUpperCase() as "LOW" | "MEDIUM" | "HIGH",
  };
}

function shouldContinueChat(
  finishReason: string | undefined,
  content: string,
): boolean {
  const trimmed = content.trim();
  if (!trimmed) {
    return false;
  }
  return isLengthLimitedFinishReason(finishReason) || looksAbruptlyTruncated(trimmed);
}

function isLengthLimitedFinishReason(finishReason: string | undefined): boolean {
  if (!finishReason) {
    return false;
  }
  const normalized = finishReason.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return (
    normalized === "max_tokens" ||
    normalized === "max_output_tokens" ||
    normalized === "length" ||
    normalized === "token_limit" ||
    normalized === "output_token_limit"
  );
}

function looksAbruptlyTruncated(content: string): boolean {
  if (content.length < 220) {
    return false;
  }
  if (hasUnbalancedPairs(content)) {
    return true;
  }
  if (/[.!?…][\])}"'”’]*$/.test(content)) {
    return false;
  }
  if (/https?:\/\/\S+$/.test(content)) {
    return false;
  }
  const tail = content.slice(-120);
  if (/[:;,]\s*$/.test(tail)) {
    return true;
  }
  if (/[가-힣A-Za-z0-9]$/.test(content)) {
    return /(?:의|은|는|이|가|을|를|와|과|로|에|에서|에게|부터|까지|이며|또는|그리고|및|후|중|예정|가능|경우|관련)$/.test(
      tail,
    );
  }
  return false;
}

function hasUnbalancedPairs(content: string): boolean {
  const boldMatches = content.match(/\*\*/g)?.length ?? 0;
  if (boldMatches % 2 !== 0) {
    return true;
  }
  const openParens = (content.match(/\(/g)?.length ?? 0) - (content.match(/\)/g)?.length ?? 0);
  const openBrackets = (content.match(/\[/g)?.length ?? 0) - (content.match(/\]/g)?.length ?? 0);
  return openParens > 0 || openBrackets > 0;
}

function mergeContinuationContent(existing: string, next: string): string {
  const previous = existing.trimEnd();
  const continuation = next.trim();
  if (!previous) {
    return continuation;
  }
  if (!continuation) {
    return previous;
  }
  if (previous.includes(continuation)) {
    return previous;
  }
  if (continuation.startsWith(previous)) {
    return continuation;
  }
  const overlap = findSuffixPrefixOverlap(previous, continuation);
  if (overlap > 0) {
    return `${previous}${continuation.slice(overlap)}`.trim();
  }
  if (
    /[가-힣A-Za-z0-9]$/.test(previous) &&
    /^[가-힣A-Za-z0-9]/.test(continuation)
  ) {
    return `${previous}${continuation}`;
  }
  return `${previous}\n\n${continuation}`.trim();
}

function findSuffixPrefixOverlap(existing: string, next: string): number {
  const limit = Math.min(existing.length, next.length, 400);
  for (let size = limit; size >= 20; size -= 1) {
    if (existing.slice(-size) === next.slice(0, size)) {
      return size;
    }
  }
  return 0;
}

function normalizeContinuationArtifacts(content: string): string {
  const lines = content
    .split("\n")
    .map((line) => line.trimEnd());
  const sourceIndexes = lines
    .map((line, index) => (line.trimStart().startsWith("출처:") ? index : -1))
    .filter((index) => index >= 0);
  if (sourceIndexes.length <= 1) {
    return lines.join("\n").trim();
  }
  const keepIndex = sourceIndexes[sourceIndexes.length - 1] ?? -1;
  return lines
    .filter((_, index) => !sourceIndexes.includes(index) || index === keepIndex)
    .join("\n")
    .trim();
}

function buildGeminiMockThinkingLevel(
  mode: Settings["chatThinkingMode"],
): "LOW" | "MEDIUM" | "HIGH" | undefined {
  if (mode === "off" || mode === "default") {
    return undefined;
  }
  return mode.toUpperCase() as "LOW" | "MEDIUM" | "HIGH";
}

function buildOllamaThinkingMode(
  mode: Settings["chatThinkingMode"],
): boolean | "low" | "medium" | "high" | undefined {
  if (mode === "default") {
    return undefined;
  }
  if (mode === "off") {
    return false;
  }
  return mode;
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

function toOllamaMessage(message: ChatMessage): Record<string, unknown> {
  const role = normalizeOllamaRole(message.role);
  const out: Record<string, unknown> = {
    role,
    content: message.content,
  };
  if (message.name && role === "tool") {
    out.name = message.name;
  }
  if (role === "user" && message.images && message.images.length > 0) {
    out.images = message.images.map((image) => image.data);
  }
  return out;
}

function toOpenAIMessageContent(
  message: ChatMessage,
): string | Array<Record<string, unknown>> {
  if (!message.images || message.images.length === 0) {
    return message.content;
  }
  const items: Array<Record<string, unknown>> = [];
  const text = message.content.trim();
  if (text) {
    items.push({
      type: "text",
      text,
    });
  }
  for (const image of message.images) {
    items.push({
      type: "image_url",
      image_url: {
        url: `data:${image.mimeType};base64,${image.data}`,
      },
    });
  }
  return items;
}

function normalizeOllamaRole(role: ChatMessage["role"]): "system" | "user" | "assistant" | "tool" {
  if (role === "developer") {
    return "system";
  }
  if (role === "tool") {
    return "tool";
  }
  return role;
}

function buildOllamaSearchTools(enableWebFetch: boolean): Array<Record<string, unknown>> {
  const tools: Array<Record<string, unknown>> = [
    {
      type: "function",
      function: {
        name: "web_search",
        description: "최근 웹 정보를 검색하고 관련 결과 목록을 반환합니다.",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "검색할 질의",
            },
            max_results: {
              type: "integer",
              description: "반환할 최대 검색 결과 수",
            },
          },
          required: ["query"],
        },
      },
    },
  ];
  if (enableWebFetch) {
    tools.push({
      type: "function",
      function: {
        name: "web_fetch",
        description: "특정 웹페이지 본문을 가져옵니다.",
        parameters: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description: "가져올 절대 URL",
            },
          },
          required: ["url"],
        },
      },
    });
  }
  return tools;
}

async function executeOllamaToolCall(
  settings: Settings,
  toolCall: OllamaToolCall,
): Promise<unknown> {
  if (settings.ollamaApiKeys.length === 0) {
    throw new Error("OLLAMA_API_KEY or OLLAMA_API_KEYS is required for Ollama web tools");
  }
  if (toolCall.name === "web_search") {
    const query = readRequiredString(toolCall.arguments.query, "web_search.query");
    const requestedMaxResults = readOptionalPositiveInt(toolCall.arguments.max_results);
    const maxResults = Math.min(
      settings.ollamaWebSearchMaxResults,
      requestedMaxResults ?? settings.ollamaWebSearchMaxResults,
    );
    return invokeOllamaApi({
      providerName: "Ollama Web Search",
      host: settings.ollamaSearchHost,
      apiKeys: settings.ollamaApiKeys,
      path: "/api/web_search",
      payload: {
        query,
        max_results: maxResults,
      },
    });
  }
  const url = readRequiredString(toolCall.arguments.url, "web_fetch.url");
  return invokeOllamaApi({
    providerName: "Ollama Web Fetch",
    host: settings.ollamaSearchHost,
    apiKeys: settings.ollamaApiKeys,
    path: "/api/web_fetch",
    payload: { url },
  });
}

function extractOllamaMessage(payload: unknown): Record<string, unknown> {
  const record = asRecord(payload);
  const message = asRecord(record?.message);
  if (!message) {
    throw new Error("Ollama API response missing message");
  }
  return message;
}

function normalizeOllamaContent(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
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
    return parts.join("\n").trim();
  }
  return "";
}

function extractOllamaToolCalls(message: Record<string, unknown>): OllamaToolCall[] {
  const rawToolCalls = message.tool_calls;
  if (!Array.isArray(rawToolCalls)) {
    return [];
  }
  const toolCalls: OllamaToolCall[] = [];
  for (let index = 0; index < rawToolCalls.length; index += 1) {
    const rawToolCall = asRecord(rawToolCalls[index]);
    const fn = asRecord(rawToolCall?.function);
    const name = normalizeToolName(fn?.name);
    if (!name) {
      continue;
    }
    const args = normalizeToolArguments(fn?.arguments);
    toolCalls.push({
      id: String(rawToolCall?.id ?? `${name}_${index}`),
      name,
      arguments: args,
    });
  }
  return toolCalls;
}

function normalizeToolName(raw: unknown): SearchToolName | null {
  if (raw === "web_search" || raw === "web_fetch") {
    return raw;
  }
  return null;
}

function normalizeToolArguments(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return asRecord(parsed) ?? {};
    } catch {
      return {};
    }
  }
  return asRecord(raw) ?? {};
}

function readRequiredString(value: unknown, key: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    throw new Error(`${key} is required`);
  }
  return normalized;
}

function readOptionalPositiveInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return undefined;
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

async function invokeOpenAICompatibleChat(params: {
  providerName: string;
  url: string;
  payload: Record<string, unknown>;
  headers?: Record<string, string>;
}): Promise<ChatInvocationResult> {
  const response = await fetch(params.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...params.headers,
    },
    body: JSON.stringify(params.payload),
  });

  const body = await readJsonOrText(response);
  if (!response.ok) {
    throw new Error(buildApiErrorMessage(params.providerName, body, response.status));
  }

  const result = extractOpenAIResult(body);
  if (!result.content) {
    throw new Error(
      `${params.providerName} API response missing choices[0].message.content`,
    );
  }
  return result;
}

function buildApiErrorMessage(
  providerName: string,
  body: unknown,
  status: number,
): string {
  const record = asRecord(body);
  const nestedError = asRecord(record?.error);
  const nestedMessage = nestedError?.message;
  if (typeof nestedMessage === "string" && nestedMessage.trim()) {
    return `${providerName} API error (${status}): ${nestedMessage.trim()}`;
  }
  const message = record?.message;
  if (typeof message === "string" && message.trim()) {
    return `${providerName} API error (${status}): ${message.trim()}`;
  }
  if (typeof body === "string" && body.trim()) {
    return `${providerName} API error (${status}): ${body.trim()}`;
  }
  return `${providerName} API error (${status})`;
}

function extractOpenAIResult(body: unknown): ChatInvocationResult {
  const record = asRecord(body);
  const choices = record?.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return { content: "" };
  }
  const firstChoice = asRecord(choices[0]);
  const message = asRecord(firstChoice?.message);
  const content = message?.content;
  const finishReason =
    typeof firstChoice?.finish_reason === "string"
      ? firstChoice.finish_reason
      : typeof firstChoice?.finishReason === "string"
        ? firstChoice.finishReason
        : undefined;
  if (typeof content === "string") {
    return { content, finishReason };
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
    return {
      content: parts.join("\n"),
      finishReason,
    };
  }
  return {
    content: "",
    finishReason,
  };
}

function extractLangChainFinishReason(result: unknown): string | undefined {
  const record = asRecord(result);
  const metadata = asRecord(record?.response_metadata);
  const finishReason =
    typeof metadata?.finishReason === "string"
      ? metadata.finishReason
      : typeof metadata?.finish_reason === "string"
        ? metadata.finish_reason
        : "";
  return finishReason || undefined;
}

function extractOllamaFinishReason(response: unknown): string | undefined {
  const record = asRecord(response);
  const finishReason =
    typeof record?.done_reason === "string"
      ? record.done_reason
      : typeof record?.doneReason === "string"
        ? record.doneReason
        : "";
  return finishReason || undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  return value as Record<string, unknown>;
}

function normalizeOpenAIRole(role: ChatMessage["role"]): "system" | "user" | "assistant" | "tool" {
  if (role === "developer") {
    return "system";
  }
  if (role === "tool") {
    return "tool";
  }
  return role;
}

function buildSafetySettingsOff(): GeminiSafetySetting[] {
  return [
    {
      category: "HARM_CATEGORY_HARASSMENT",
      threshold: "BLOCK_NONE",
    },
    {
      category: "HARM_CATEGORY_HATE_SPEECH",
      threshold: "BLOCK_NONE",
    },
    {
      category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
      threshold: "BLOCK_NONE",
    },
    {
      category: "HARM_CATEGORY_DANGEROUS_CONTENT",
      threshold: "BLOCK_NONE",
    },
    {
      category: "HARM_CATEGORY_CIVIC_INTEGRITY",
      threshold: "BLOCK_NONE",
    },
  ];
}
