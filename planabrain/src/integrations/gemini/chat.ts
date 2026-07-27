import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";

import type { Settings } from "../../config/settings.js";
import { sanitizeAssistantOutput } from "../../chat/sanitizeOutput.js";
import { createGoogleSearchTool } from "../googleSearch/retrievalTool.js";
import { invokeVertexExpressChat } from "../google/vertexExpress.js";
import { invokeOllamaApi } from "../ollama/api.js";
import { fetchWebPage } from "../webFetch.js";
import { WebToolPolicy } from "../webToolPolicy.js";
import {
  ProviderApiError,
  classifyHttpStatus,
  fetchWithTimeout,
  isRetryable,
} from "../providerError.js";

const DEFAULT_CHAT_TEMPERATURE = 1.0;
const DEFAULT_CHAT_TOP_P = 0.7;

const RATE_LIMIT_MAX_RETRIES = 2;
const RATE_LIMIT_RETRY_CAP_MS = 8000;
const RATE_LIMIT_MESSAGE = [
  "선생님.",
  "지금 요청이 한꺼번에 몰려서 처리 용량이 잠시 가득 찼습니다.",
  "조금만 기다렸다가 다시 말씀해 주시겠어요.",
  "금방 정리하고 다시 도와드리겠습니다.",
].join("\n");

export class ProviderRateLimitError extends ProviderApiError {
  constructor(message: string) {
    super({
      kind: "rate_limited",
      status: 429,
      retryable: true,
      message,
    });
    this.name = "ProviderRateLimitError";
  }
}

async function withRateLimitRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status !== 429) {
        throw error;
      }
      if (attempt >= RATE_LIMIT_MAX_RETRIES) {
        throw new ProviderRateLimitError(RATE_LIMIT_MESSAGE);
      }
      const retryAfterMs = (error as { retryAfterMs?: number }).retryAfterMs;
      const backoffMs = Math.min(
        retryAfterMs ?? 1000 * 2 ** attempt,
        RATE_LIMIT_RETRY_CAP_MS,
      );
      await sleep(backoffMs);
    }
  }
}

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

export type WebCitation = {
  url: string;
  title?: string;
  evidence?: string;
};

export type ChatInvocationMetadata = {
  content: string;
  citations: WebCitation[];
  searchUsed: boolean;
};

type ChatInvocationResult = {
  content: string;
  finishReason?: string;
  citations?: WebCitation[];
  searchUsed?: boolean;
};

export type ChatInvocationParams = {
  settings: Settings;
  messages: ChatMessage[];
  enableSearchTool?: boolean;
  webFetchUrlSource?: string;
};

export async function invokeChat(params: ChatInvocationParams): Promise<string> {
  const output = await invokeChatWithMetadata(params);
  return output.content;
}

export async function invokeChatWithMetadata(
  params: ChatInvocationParams,
): Promise<ChatInvocationMetadata> {
  let workingMessages = [...params.messages];
  let combined = "";
  let citations: WebCitation[] = [];
  let searchUsed = false;
  const maxContinuations = 2;

  for (let attempt = 0; attempt <= maxContinuations; attempt += 1) {
    const result = await invokeChatOnce({
      settings: params.settings,
      messages: workingMessages,
      enableSearchTool: params.enableSearchTool,
      webFetchUrlSource: params.webFetchUrlSource,
    });
    combined = combined
      ? mergeContinuationContent(combined, result.content)
      : result.content.trim();
    citations = mergeWebCitations(citations, result.citations ?? []);
    searchUsed = searchUsed || result.searchUsed === true;
    if (!shouldContinueChat(result.finishReason, combined)) {
      return {
        content: sanitizeAssistantOutput(normalizeContinuationArtifacts(combined)),
        citations,
        searchUsed,
      };
    }
    if (attempt === maxContinuations) {
      return {
        content: sanitizeAssistantOutput(normalizeContinuationArtifacts(combined)),
        citations,
        searchUsed,
      };
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
          "방금 답변한 마지막 문장 다음부터만 이어서 남은 정보를 적어 주십시오. 이미 쓴 서두는 반복하지 말고, 출처 줄, 메타 설명, 내부 판단은 쓰지 마십시오.",
      },
    ];
  }

  return {
    content: sanitizeAssistantOutput(normalizeContinuationArtifacts(combined)),
    citations,
    searchUsed,
  };
}

async function invokeChatOnce(params: {
  settings: Settings;
  messages: ChatMessage[];
  enableSearchTool?: boolean;
  webFetchUrlSource?: string;
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
  if (params.settings.aiProvider === "cerebras") {
    return invokeCerebrasChat(
      params.settings,
      params.messages,
      params.enableSearchTool,
      params.webFetchUrlSource,
    );
  }
  if (params.settings.aiProvider === "geminimock" && hasImages) {
    throw new Error("이미지 입력은 현재 openrouter 또는 ollama provider에서만 지원합니다.");
  }
  if (params.settings.aiProvider === "ollama") {
    return invokeOllamaChat(
      params.settings,
      params.messages,
      params.enableSearchTool,
      params.webFetchUrlSource,
    );
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

  return withRateLimitRetry(() =>
    invokeOpenAICompatibleChat({
      providerName: "OpenRouter",
      url: `${settings.openRouterBaseUrl}/chat/completions`,
      headers,
      payload,
    }),
  );
}

async function invokeCerebrasChat(
  settings: Settings,
  messages: ChatMessage[],
  enableSearchTool: boolean | undefined,
  webFetchUrlSource: string | undefined,
): Promise<ChatInvocationResult> {
  if (!settings.cerebrasApiKey) {
    throw new Error(
      "CEREBRAS_API_KEY is required when PLANABRAIN_AI_PROVIDER=cerebras",
    );
  }
  if (!settings.cerebrasBaseUrl) {
    throw new Error(
      "PLANABRAIN_CEREBRAS_BASE_URL is required when PLANABRAIN_AI_PROVIDER=cerebras",
    );
  }

  const webSearchAvailable = Boolean(
    enableSearchTool &&
      settings.cerebrasWebSearchEnabled &&
      settings.ollamaApiKeys.length > 0,
  );
  const webFetchAvailable = Boolean(enableSearchTool && settings.webFetchEnabled);
  const tools = buildWebTools(webSearchAvailable, webFetchAvailable);
  const maxIterations = tools
    ? Math.max(1, settings.ollamaToolMaxIterations)
    : 1;
  const url = `${settings.cerebrasBaseUrl}/chat/completions`;
  const headers = { authorization: `Bearer ${settings.cerebrasApiKey}` };
  const workingMessages: Array<Record<string, unknown>> = messages.map(
    (message) => ({
      role: normalizeOpenAIRole(message.role),
      content: message.content,
    }),
  );
  const webToolPolicy = new WebToolPolicy(webFetchUrlSource ?? "");

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const payload: Record<string, unknown> = {
      model: settings.chatModel,
      temperature: DEFAULT_CHAT_TEMPERATURE,
      top_p: DEFAULT_CHAT_TOP_P,
      messages: workingMessages,
    };
    if (tools) {
      payload.tools = tools;
    }
    if (settings.chatMaxOutputTokens) {
      payload.max_tokens = settings.chatMaxOutputTokens;
    }

    const choice = await withRateLimitRetry(() =>
      postOpenAIChatChoice({ providerName: "Cerebras", url, headers, payload }),
    );
    const toolCalls = tools ? extractOllamaToolCalls(choice.message) : [];
    if (toolCalls.length === 0) {
      const result = extractOpenAIResult({
        choices: [{ message: choice.message, finish_reason: choice.finishReason }],
      });
      if (!result.content) {
        throw new ProviderApiError({
          kind: "empty_or_filtered",
          provider: "Cerebras",
          status: 200,
          message: "Cerebras API response missing choices[0].message.content",
        });
      }
      return result;
    }

    workingMessages.push(choice.message);
    for (const toolCall of toolCalls) {
      const result = await executeOllamaToolCall(
        settings,
        toolCall,
        webToolPolicy,
      );
      workingMessages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify(result),
      });
    }
  }

  throw new Error("Cerebras tool-calling exceeded iteration limit");
}

export function isSearchToolAvailable(settings: Settings): boolean {
  if (settings.aiProvider === "openrouter") {
    return settings.openRouterWebSearchEnabled;
  }
  if (settings.aiProvider === "cerebras") {
    return settings.cerebrasWebSearchEnabled && settings.ollamaApiKeys.length > 0;
  }
  if (settings.aiProvider === "ollama") {
    return settings.ollamaWebSearchEnabled;
  }
  if (settings.aiProvider === "google" || settings.aiProvider === "vertexexpress") {
    return true;
  }
  return false;
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
  webFetchUrlSource: string | undefined,
): Promise<ChatInvocationResult> {
  const normalizedMessages = messages.map((message) => toOllamaMessage(message));
  const webSearchAvailable = Boolean(enableSearchTool && settings.ollamaWebSearchEnabled);
  const webFetchAvailable = Boolean(
    enableSearchTool && settings.ollamaWebFetchEnabled && settings.webFetchEnabled,
  );
  const tools = buildWebTools(webSearchAvailable, webFetchAvailable);
  const maxIterations = Math.max(1, settings.ollamaToolMaxIterations);
  let workingMessages = normalizedMessages;
  const webToolPolicy = new WebToolPolicy(webFetchUrlSource ?? "");

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

    const response = await withRateLimitRetry(() =>
      invokeOllamaApi({
        providerName: "Ollama",
        host: settings.ollamaHost,
        apiKeys: settings.ollamaApiKeys,
        path: "/api/chat",
        payload,
      }),
    );
    const message = extractOllamaMessage(response);
    const toolCalls = extractOllamaToolCalls(message);
    if (toolCalls.length === 0) {
      const content = normalizeOllamaContent(message.content);
      if (!content) {
        throw new ProviderApiError({
          kind: "empty_or_filtered",
          provider: "Ollama",
          status: 200,
          message: "Ollama API response missing message.content",
        });
      }
      return {
        content,
        finishReason: extractOllamaFinishReason(response),
      };
    }

    workingMessages = [...workingMessages, message];
    for (const toolCall of toolCalls) {
      const result = await executeOllamaToolCall(
        settings,
        toolCall,
        webToolPolicy,
      );
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
  if (mode === "minimal") {
    return { thinkingLevel: "LOW" };
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
  if (mode === "minimal") {
    return "LOW";
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
  if (mode === "minimal") {
    return "low";
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

function buildWebTools(
  enableWebSearch: boolean,
  enableWebFetch: boolean,
): Array<Record<string, unknown>> | undefined {
  const tools: Array<Record<string, unknown>> = [];
  if (enableWebSearch) {
    tools.push({
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
    });
  }
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
  return tools.length > 0 ? tools : undefined;
}

async function executeOllamaToolCall(
  settings: Settings,
  toolCall: OllamaToolCall,
  policy: WebToolPolicy,
): Promise<unknown> {
  if (!policy.tryStartToolCall()) {
    return { error: "웹 도구 호출 한도를 초과했습니다." };
  }
  if (toolCall.name === "web_search") {
    if (settings.ollamaApiKeys.length === 0) {
      throw new Error("OLLAMA_API_KEY or OLLAMA_API_KEYS is required for Ollama web search");
    }
    const query = readRequiredString(toolCall.arguments.query, "web_search.query");
    const requestedMaxResults = readOptionalPositiveInt(toolCall.arguments.max_results);
    const maxResults = Math.min(
      settings.ollamaWebSearchMaxResults,
      requestedMaxResults ?? settings.ollamaWebSearchMaxResults,
    );
    const result = await invokeOllamaApi({
      providerName: "Ollama Web Search",
      host: settings.ollamaSearchHost,
      apiKeys: settings.ollamaApiKeys,
      path: "/api/web_search",
      payload: {
        query,
        max_results: maxResults,
      },
    });
    policy.addSearchResult(result);
    return result;
  }
  const url = readRequiredString(toolCall.arguments.url, "web_fetch.url");
  if (!policy.allowsFetch(url)) {
    return { error: "현재 요청이나 검색 결과에 없는 URL은 가져올 수 없습니다." };
  }
  try {
    return await fetchWebPage(settings, url);
  } catch {
    return { error: "웹페이지를 안전하게 가져오지 못했습니다." };
  }
}

function extractOllamaMessage(payload: unknown): Record<string, unknown> {
  const record = asRecord(payload);
  const message = asRecord(record?.message);
  if (!message) {
    throw new ProviderApiError({
      kind: "empty_or_filtered",
      provider: "Ollama",
      status: 200,
      message: "Ollama API response missing message",
    });
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
  const response = await fetchWithTimeout(params.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...params.headers,
    },
    body: JSON.stringify(params.payload),
  });

  const body = await readJsonOrText(response);
  if (!response.ok) {
    throw buildProviderApiError(params.providerName, body, response);
  }

  const result = extractOpenAIResult(body);
  if (!result.content) {
    throw new ProviderApiError({
      kind: "empty_or_filtered",
      provider: params.providerName,
      status: 200,
      message: `${params.providerName} API response missing choices[0].message.content`,
    });
  }
  return result;
}

async function postOpenAIChatChoice(params: {
  providerName: string;
  url: string;
  payload: Record<string, unknown>;
  headers?: Record<string, string>;
}): Promise<{ message: Record<string, unknown>; finishReason?: string }> {
  const response = await fetchWithTimeout(params.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...params.headers,
    },
    body: JSON.stringify(params.payload),
  });

  const body = await readJsonOrText(response);
  if (!response.ok) {
    throw buildProviderApiError(params.providerName, body, response);
  }

  const record = asRecord(body);
  const choices = record?.choices;
  const firstChoice = Array.isArray(choices) ? asRecord(choices[0]) : null;
  const message = asRecord(firstChoice?.message) ?? {};
  const finishReason =
    typeof firstChoice?.finish_reason === "string"
      ? firstChoice.finish_reason
      : typeof firstChoice?.finishReason === "string"
        ? firstChoice.finishReason
        : undefined;
  return { message, finishReason };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(headerValue: string | null): number | undefined {
  if (!headerValue) {
    return undefined;
  }
  const seconds = Number.parseFloat(headerValue.trim());
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  return undefined;
}

function buildProviderApiError(
  providerName: string,
  body: unknown,
  response: Response,
): ProviderApiError {
  const apiMessage = extractProviderErrorText(body);
  const kind = classifyHttpStatus(response.status, apiMessage);
  const error = new ProviderApiError({
    kind,
    provider: providerName,
    status: response.status,
    apiMessage,
    retryable: isRetryable(kind),
    message: buildApiErrorMessage(providerName, body, response.status),
  });
  error.retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
  return error;
}

function extractProviderErrorText(body: unknown): string {
  const record = asRecord(body);
  const nestedError = asRecord(record?.error);
  const nestedMessage = nestedError?.message;
  if (typeof nestedMessage === "string" && nestedMessage.trim()) {
    return nestedMessage.trim();
  }
  const errorValue = record?.error;
  if (typeof errorValue === "string" && errorValue.trim()) {
    return errorValue.trim();
  }
  const message = record?.message;
  if (typeof message === "string" && message.trim()) {
    return message.trim();
  }
  if (typeof body === "string" && body.trim()) {
    return body.trim();
  }
  return "";
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
    return {
      content: "",
      citations: [],
      searchUsed: hasOpenRouterSearchUsage(record),
    };
  }
  const firstChoice = asRecord(choices[0]);
  const message = asRecord(firstChoice?.message);
  const content = message?.content;
  const citations = parseOpenRouterCitations(message?.annotations);
  const searchUsed = citations.length > 0 || hasOpenRouterSearchUsage(record);
  const finishReason =
    typeof firstChoice?.finish_reason === "string"
      ? firstChoice.finish_reason
      : typeof firstChoice?.finishReason === "string"
        ? firstChoice.finishReason
        : undefined;
  if (typeof content === "string") {
    return {
      content,
      finishReason,
      citations,
      searchUsed,
    };
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
      citations,
      searchUsed,
    };
  }
  return {
    content: "",
    finishReason,
    citations,
    searchUsed,
  };
}

export function parseOpenRouterCitations(value: unknown): WebCitation[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const citations: WebCitation[] = [];
  for (const item of value) {
    const annotation = asRecord(item);
    if (annotation?.type !== "url_citation") {
      continue;
    }
    const nested = asRecord(annotation.url_citation) ?? annotation;
    const url = normalizeCitationUrl(nested.url);
    if (!url) {
      continue;
    }
    const title = normalizeCitationText(nested.title, 300);
    const evidence = normalizeCitationText(
      nested.content ?? nested.text ?? nested.quote,
      4000,
    );
    citations.push({
      url,
      ...(title ? { title } : {}),
      ...(evidence ? { evidence } : {}),
    });
  }
  return mergeWebCitations(citations);
}

export function mergeWebCitations(
  ...groups: ReadonlyArray<ReadonlyArray<WebCitation>>
): WebCitation[] {
  const merged = new Map<string, WebCitation>();
  for (const group of groups) {
    for (const citation of group) {
      const url = normalizeCitationUrl(citation.url);
      if (!url) {
        continue;
      }
      const current = merged.get(url);
      const title = normalizeCitationText(citation.title, 300);
      const evidence = normalizeCitationText(citation.evidence, 4000);
      merged.set(url, {
        url,
        ...((title ?? current?.title) ? { title: title ?? current?.title } : {}),
        ...((evidence ?? current?.evidence)
          ? { evidence: evidence ?? current?.evidence }
          : {}),
      });
    }
  }
  return Array.from(merged.values());
}

function hasOpenRouterSearchUsage(record: Record<string, unknown> | null): boolean {
  const usage = asRecord(record?.usage);
  const serverToolUse = asRecord(usage?.server_tool_use ?? usage?.serverToolUse);
  const count =
    typeof serverToolUse?.web_search_requests === "number"
      ? serverToolUse.web_search_requests
      : typeof serverToolUse?.webSearchRequests === "number"
        ? serverToolUse.webSearchRequests
        : 0;
  return Number.isFinite(count) && count > 0;
}

function normalizeCitationUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 4096) {
    return null;
  }
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.username || url.password) {
      return null;
    }
    url.hash = "";
    for (const key of Array.from(url.searchParams.keys())) {
      if (
        /(auth|code|credential|jwt|key|password|secret|session|sig|token)/i.test(
          key,
        )
      ) {
        url.searchParams.delete(key);
      }
    }
    return url.toString();
  } catch {
    return null;
  }
}

function normalizeCitationText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, maxLength) : undefined;
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
