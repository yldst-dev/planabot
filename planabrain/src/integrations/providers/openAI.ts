import { type Settings } from "../../config/settings.js";
import { type ChatMessage, type ChatInvocationResult, type OpenAICompatibleToolChatConfig, type GeminiSafetySetting } from "../contracts.js";
import { DEFAULT_CHAT_TEMPERATURE, DEFAULT_CHAT_TOP_P, requiresGlmReasoning } from "./options.js";
import { invokeOpenAICompatibleChat, postOpenAIChatChoice, extractOpenAIResult } from "../transport/openAI.js";
import { withRateLimitRetry } from "../retry.js";
import { buildWebTools, extractOllamaToolCalls, executeOllamaToolCall } from "../tools/webTools.js";
import { WebToolPolicy } from "../webToolPolicy.js";
import { ProviderApiError } from "../providerError.js";
import { withWebToolCitations } from "../evidence.js";

export async function invokeGeminiMockChat(
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

export async function invokeOpenRouterChat(
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

  const hasImages = messages.some((message) => (message.images?.length ?? 0) > 0);
  const ignoredProviders: string[] = [
    ...(settings.openRouterIgnoreProviders ?? []),
  ];

  const headers: Record<string, string> = {
    authorization: `Bearer ${settings.openRouterApiKey}`,
  };
  if (settings.openRouterSiteUrl) {
    headers["http-referer"] = settings.openRouterSiteUrl;
  }
  if (settings.openRouterAppName) {
    headers["x-title"] = settings.openRouterAppName;
  }

  return withRateLimitRetry(async () => {
    const payload: Record<string, unknown> = {
      model: settings.chatModel,
      temperature: settings.openRouterTemperature ?? DEFAULT_CHAT_TEMPERATURE,
      top_p: settings.openRouterTopP ?? DEFAULT_CHAT_TOP_P,
      messages: messages.map((message) => ({
        role: normalizeOpenAIRole(message.role),
        content: toOpenAIMessageContent(message),
      })),
    };
    const reasoning = buildOpenRouterReasoning(settings);
    if (reasoning) payload.reasoning = reasoning;
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
    if (hasImages || ignoredProviders.length > 0 || settings.openRouterProviderOrder?.length) {
      payload.provider = {
        allow_fallbacks:
          ignoredProviders.length > 0 ||
          !settings.openRouterProviderOrder?.length,
        ...(settings.openRouterProviderOrder?.length ? { order: settings.openRouterProviderOrder } : {}),
        ...(hasImages ? { require_parameters: true } : {}),
        ...(ignoredProviders.length > 0 ? { ignore: [...ignoredProviders] } : {}),
      };
    }
    try {
      return await invokeOpenAICompatibleChat({
        providerName: "OpenRouter",
        url: `${settings.openRouterBaseUrl}/chat/completions`,
        headers,
        payload,
      });
    } catch (error) {
      if (error instanceof ProviderApiError && error.upstreamProvider) {
        if (!ignoredProviders.includes(error.upstreamProvider)) {
          ignoredProviders.push(error.upstreamProvider);
        }
      }
      throw error;
    }
  });
}

export async function invokeGeminiWebChat(
  settings: Settings,
  messages: ChatMessage[],
): Promise<ChatInvocationResult> {
  if (!settings.geminiWebApiKey) {
    throw new Error(
      "PLANABRAIN_GEMINIWEB_API_KEY is required when PLANABRAIN_AI_PROVIDER=geminiweb",
    );
  }
  if (!settings.geminiWebBaseUrl) {
    throw new Error(
      "PLANABRAIN_GEMINIWEB_BASE_URL is required when PLANABRAIN_AI_PROVIDER=geminiweb",
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
  if (settings.chatMaxOutputTokens) {
    payload.max_tokens = settings.chatMaxOutputTokens;
  }

  return withRateLimitRetry(() =>
    invokeOpenAICompatibleChat({
      providerName: "geminiweb",
      url: `${settings.geminiWebBaseUrl}/chat/completions`,
      headers: {
        authorization: `Bearer ${settings.geminiWebApiKey}`,
      },
      payload,
    }),
  );
}

export async function invokeOpenAICompatibleToolChat(
  config: OpenAICompatibleToolChatConfig,
  settings: Settings,
  messages: ChatMessage[],
  webFetchUrlSource: string | undefined,
): Promise<ChatInvocationResult> {
  const tools = buildWebTools(config.webSearchAvailable, config.webFetchAvailable);
  const maxIterations = tools
    ? Math.max(1, settings.ollamaToolMaxIterations)
    : 1;
  const url = `${config.baseUrl}/chat/completions`;
  const headers = { authorization: `Bearer ${config.apiKey}` };
  const workingMessages: Array<Record<string, unknown>> = messages.map(
    (message) => ({
      role: normalizeOpenAIRole(message.role),
      content: toOpenAIMessageContent(message),
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
      postOpenAIChatChoice({
        providerName: config.providerName,
        url,
        headers,
        payload,
      }),
    );
    const toolCalls = tools ? extractOllamaToolCalls(choice.message) : [];
    if (toolCalls.length === 0) {
      const result = extractOpenAIResult({
        choices: [{ message: choice.message, finish_reason: choice.finishReason }],
      });
      if (!result.content) {
        throw new ProviderApiError({
          kind: "empty_or_filtered",
          provider: config.providerName,
          status: 200,
          message: `${config.providerName} API response missing choices[0].message.content`,
        });
      }
      return withWebToolCitations(result, webToolPolicy);
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

  throw new Error(`${config.providerName} tool-calling exceeded iteration limit`);
}

export async function invokeCerebrasChat(
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
  return invokeOpenAICompatibleToolChat(
    {
      providerName: "Cerebras",
      apiKey: settings.cerebrasApiKey,
      baseUrl: settings.cerebrasBaseUrl,
      webSearchAvailable: Boolean(
        enableSearchTool &&
        settings.cerebrasWebSearchEnabled &&
        settings.ollamaApiKeys.length > 0,
      ),
      webFetchAvailable: Boolean(enableSearchTool && settings.webFetchEnabled),
    },
    settings,
    messages,
    webFetchUrlSource,
  );
}

export async function invokeModelStudioChat(
  settings: Settings,
  messages: ChatMessage[],
  enableSearchTool: boolean | undefined,
  webFetchUrlSource: string | undefined,
): Promise<ChatInvocationResult> {
  if (!settings.modelStudioApiKey) {
    throw new Error(
      "MODEL_STUDIO_API_KEY is required when PLANABRAIN_AI_PROVIDER=modelstudio",
    );
  }
  if (!settings.modelStudioBaseUrl) {
    throw new Error(
      "PLANABRAIN_MODELSTUDIO_BASE_URL is required when PLANABRAIN_AI_PROVIDER=modelstudio",
    );
  }
  return invokeOpenAICompatibleToolChat(
    {
      providerName: "ModelStudio",
      apiKey: settings.modelStudioApiKey,
      baseUrl: settings.modelStudioBaseUrl,
      webSearchAvailable: Boolean(
        enableSearchTool &&
        settings.modelStudioWebSearchEnabled &&
        settings.ollamaApiKeys.length > 0,
      ),
      webFetchAvailable: Boolean(
        enableSearchTool && settings.modelStudioWebSearchEnabled && settings.webFetchEnabled,
      ),
    },
    settings,
    messages,
    webFetchUrlSource,
  );
}

export function buildOpenRouterWebSearchTool(
  settings: Settings,
  enableSearchTool: boolean | undefined,
): Record<string, unknown> | null {
  if (
    !(enableSearchTool && settings.openRouterWebSearchEnabled) ||
    settings.openRouterWebSearchBackend === "ollama"
  ) {
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

export function buildGeminiMockThinkingLevel(
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

export function toOpenAIMessageContent(
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

export function normalizeOpenAIRole(role: ChatMessage["role"]): "system" | "user" | "assistant" | "tool" {
  if (role === "developer") {
    return "system";
  }
  if (role === "tool") {
    return "tool";
  }
  return role;
}

export function buildSafetySettingsOff(): GeminiSafetySetting[] {
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

export function buildOpenRouterReasoning(settings: Settings): Record<string, unknown> | undefined {
  if (!requiresGlmReasoning(settings.chatModel)) return undefined;
  const mode = settings.chatThinkingMode;
  if (mode === "default") return undefined;
  return { effort: mode === "high" || mode === "medium" ? "high" : "low", exclude: true };
}
