import { usesPreSearchContext } from "../search.js";
import { type ChatProviderName, type ChatProvider, type ChatInvocationOnceParams, type ChatInvocationResult } from "../contracts.js";
import { invokeGoogleNativeChat as invokeGoogleChat } from "../google/native.js";
import { invokeVertexExpressChat } from "../google/vertexExpress.js";
import { invokeGeminiMockChat, invokeOpenRouterChat, invokeCerebrasChat, invokeModelStudioChat, invokeGeminiWebChat } from "./openAI.js";
import { invokeOllamaChat } from "./ollama.js";
import { type Settings } from "../../config/settings.js";
import { checkExecution, measureStage } from "../../runtime/execution.js";

export const UNSUPPORTED_IMAGE_MESSAGE =
  "현재 선택한 모델 연결은 이미지 입력을 지원하지 않습니다.";

export const CHAT_PROVIDERS: Record<ChatProviderName, ChatProvider> = {
  google: {
    supportsImages: true,
    hasCredentials: (settings) => Boolean(settings.googleApiKey),
    searchAvailable: () => true,
    invoke: (params) => invokeGoogleChat(params),
  },
  vertexexpress: {
    supportsImages: true,
    hasCredentials: (settings) => Boolean(settings.vertexExpressApiKey),
    searchAvailable: () => true,
    invoke: (params) => invokeVertexExpressChat(params),
  },
  geminimock: {
    supportsImages: false,
    hasCredentials: (settings) => Boolean(settings.geminiMockBaseUrl),
    searchAvailable: () => false,
    invoke: (params) => invokeGeminiMockChat(params.settings, params.messages),
  },
  openrouter: {
    supportsImages: true,
    hasCredentials: (settings) => Boolean(settings.openRouterApiKey),
    searchAvailable: (settings) => {
      if (!settings.openRouterWebSearchEnabled) {
        return false;
      }
      return settings.openRouterWebSearchBackend === "ollama"
        ? settings.ollamaApiKeys.length > 0
        : true;
    },
    invoke: (params) =>
      invokeOpenRouterChat(params.settings, params.messages, params.enableSearchTool),
  },
  cerebras: {
    supportsImages: true,
    hasCredentials: (settings) => Boolean(settings.cerebrasApiKey),
    searchAvailable: (settings) =>
      settings.cerebrasWebSearchEnabled && settings.ollamaApiKeys.length > 0,
    invoke: (params) =>
      invokeCerebrasChat(
        params.settings,
        params.messages,
        params.enableSearchTool,
        params.webFetchUrlSource,
      ),
  },
  modelstudio: {
    supportsImages: false,
    hasCredentials: (settings) => Boolean(settings.modelStudioApiKey),
    searchAvailable: (settings) =>
      settings.modelStudioWebSearchEnabled && settings.ollamaApiKeys.length > 0,
    invoke: (params) =>
      invokeModelStudioChat(
        params.settings,
        params.messages,
        params.enableSearchTool,
        params.webFetchUrlSource,
      ),
  },
  ollama: {
    supportsImages: true,
    hasCredentials: (settings) => settings.ollamaApiKeys.length > 0,
    searchAvailable: (settings) => settings.ollamaWebSearchEnabled,
    invoke: (params) =>
      invokeOllamaChat(
        params.settings,
        params.messages,
        params.enableSearchTool,
        params.webFetchUrlSource,
      ),
  },
  geminiweb: {
    supportsImages: true,
    hasCredentials: (settings) =>
      Boolean(settings.geminiWebApiKey && settings.geminiWebBaseUrl),
    searchAvailable: () => false,
    invoke: (params) => invokeGeminiWebChat(params.settings, params.messages),
  },
};

export function providerHasCredentials(
  settings: Settings,
  provider: ChatProviderName,
): boolean {
  return CHAT_PROVIDERS[provider]?.hasCredentials(settings) ?? false;
}

export async function invokeChatOnce(params: ChatInvocationOnceParams): Promise<ChatInvocationResult> {
  checkExecution();
  const provider = CHAT_PROVIDERS[params.settings.aiProvider];
  if (!provider) {
    throw new Error(`지원하지 않는 provider입니다: ${params.settings.aiProvider}`);
  }
  const hasImages = params.messages.some((message) => (message.images?.length ?? 0) > 0);
  if (hasImages && !provider.supportsImages) {
    throw new Error(UNSUPPORTED_IMAGE_MESSAGE);
  }
  return measureStage(`provider:${params.settings.aiProvider}`, () => provider.invoke(params));
}

export function isSearchToolAvailable(settings: Settings): boolean {
  if (settings.aiProvider === "geminiweb") {
    return false;
  }
  return (
    (CHAT_PROVIDERS[settings.aiProvider]?.searchAvailable(settings) ?? false) ||
    (settings.aiProvider === "geminimock" && usesPreSearchContext(settings))
  );
}
