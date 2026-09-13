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

export const GLM_53_FLASH_VISION_UNAVAILABLE =
  "선생님.. 현재 프라나의 비전 기능에 문제가 생겨 볼 수 없습니다... 죄송합니다.";

export function isGlm53FlashModel(model: string): boolean {
  return /glm-5\.3-flash/i.test(model);
}

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
  if (hasImages && isGlm53FlashModel(params.settings.chatModel)) {
    const imageModel = params.settings.openRouterImageModel?.trim();
    if (
      imageModel &&
      !isGlm53FlashModel(imageModel) &&
      params.settings.openRouterApiKey &&
      params.settings.openRouterBaseUrl
    ) {
      const imageSettings = {
        ...params.settings,
        aiProvider: "openrouter" as const,
        chatModel: imageModel,
      };
      return measureStage("provider:openrouter", () =>
        invokeOpenRouterChat(
          imageSettings,
          params.messages,
          params.enableSearchTool,
        ),
      );
    }
    return { content: GLM_53_FLASH_VISION_UNAVAILABLE };
  }
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
