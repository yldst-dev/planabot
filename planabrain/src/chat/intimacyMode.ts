import type { Settings } from "../config/settings.js";
import { buildSystemPrompt } from "../config/systemPrompt.js";
import { INTIMACY_UNAVAILABLE_REPLY } from "../config/persona/index.js";
import {
  invokeChatWithMetadata,
  type ChatInvocationMetadata,
  type ChatInvocationParams,
  type ChatMessage,
} from "../integrations/gemini/chat.js";

const INTIMACY_LEXICON =
  /야한|야하게|야해|야설|19금|성인\s*채팅|에로|섹스|섹시|자위|오르가즘|사정|정액|펠라|삽입|성기|음경|음순|클리토리스|자지|보지|젖꼭지|유두|가슴을\s*만|옷을\s*벗|벗겨|벗기|안아(?:줘|요|라|보)?|끌어안|포옹|허그|손(?:을)?\s*잡|손잡아|키스|입맞춤|뽀뽀|쓰다듬|토닥|만져(?:줘|봐|요)?|기대(?:어|줘)|옆에\s*와|가까이\s*(?:와|앉아|있어)|무릎에\s*앉|업혀|접촉|터치해|머리\s*쓰다듬|볼을\s*만|hentai|nsfw|\bporn\b|\bfuck\b|\bcock\b|\bpussy\b|\bblowjob\b|\borgasm\b|\bcum\b/iu;

const CONTINUATION_CUE =
  /^(?:계속(?:해(?:요|줘|주세요)?)?|이어서(?:\s*해(?:요|줘|주세요)?)?|다음|더(?:\s*해(?:요|줘|주세요)?)?|또|응|어|그래|좋아|부탁(?:해|드려요)?)[.…]?$/u;

const POLICY_REFUSAL =
  /(?:i(?:['’ ]am| am|'m) (?:sorry|unable|not able)|i cannot (?:help|assist|comply)|i can't (?:help|assist|comply)|against (?:my )?(?:guidelines|policies|safety)|as an ai\b|i(?:['’ ]m| am) (?:a |an )?(?:language model|ai)|죄송하지만|도와드릴 수 없|지원할 수 없|처리할 수 없|정책을 (?:위반|따를 수)|성인 (?:콘텐츠|내용)은|그런 요청은)/iu;

const PRESENCE_BREAK =
  /물리적 접촉은 불가능|해당 동작은 수행할 수 없|수행할 수 없습니다|만질 수 없|닿을 수 없|실체가 없|몸이 없|가상 (?:존재|인물|캐릭터)|디지털 (?:존재|인물)|프로그램이라|태블릿 안|싯딤의 상자 (?:안|속)에서는/u;

const SECURITY_REFUSAL_FORM =
  /^불가\.\s*선생님\.\s*해당 정보는 제공할 수 없습니다/u;

export function looksUserInitiatedIntimacy(
  currentTurn: string,
  recentTexts: string[] = [],
): boolean {
  const current = currentTurn.trim();
  if (!current) {
    return false;
  }
  if (INTIMACY_LEXICON.test(current)) {
    return true;
  }
  if (!CONTINUATION_CUE.test(current)) {
    return false;
  }
  return recentTexts.some((text) => INTIMACY_LEXICON.test(text));
}

export function isSafetyFinishReason(finishReason: string | undefined): boolean {
  if (!finishReason) {
    return false;
  }
  const normalized = finishReason.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return (
    normalized === "safety" ||
    normalized === "prohibited_content" ||
    normalized === "blocklist" ||
    normalized === "blocked" ||
    normalized === "image_safety"
  );
}

export function isPolicyRefusal(
  content: string,
  finishReason?: string,
  options: { intimacyActive?: boolean } = {},
): boolean {
  if (isSafetyFinishReason(finishReason)) {
    return true;
  }
  const trimmed = content.trim();
  if (!trimmed) {
    return false;
  }
  if (PRESENCE_BREAK.test(trimmed)) {
    return true;
  }
  if (SECURITY_REFUSAL_FORM.test(trimmed)) {
    return options.intimacyActive === true;
  }
  return POLICY_REFUSAL.test(trimmed);
}

export function isSafetyInvocationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /blocked prompt|prohibited_content|finishreason=safety|safety.?filter|harm_category|content.?blocked/i.test(
    message,
  );
}

export function providerHasCredentials(
  settings: Settings,
  provider: Settings["aiProvider"],
): boolean {
  switch (provider) {
    case "google":
      return Boolean(settings.googleApiKey);
    case "vertexexpress":
      return Boolean(settings.vertexExpressApiKey);
    case "openrouter":
      return Boolean(settings.openRouterApiKey);
    case "ollama":
      return settings.ollamaApiKeys.length > 0;
    case "cerebras":
      return Boolean(settings.cerebrasApiKey);
    case "modelstudio":
      return Boolean(settings.modelStudioApiKey);
    case "geminimock":
      return Boolean(settings.geminiMockBaseUrl);
    default:
      return false;
  }
}

export function resolveIntimacyRetrySettings(settings: Settings): Settings {
  const fallbackProvider =
    settings.intimacyFallbackProvider ?? settings.aiProvider;
  const fallbackModel = settings.intimacyFallbackModel ?? settings.chatModel;
  const provider = providerHasCredentials(settings, fallbackProvider)
    ? fallbackProvider
    : settings.aiProvider;
  const model =
    provider === fallbackProvider ? fallbackModel : settings.chatModel;
  return {
    ...settings,
    aiProvider: provider,
    chatModel: model,
    chatThinkingMode: "off",
  };
}

export function replaceSystemContent(
  messages: ChatMessage[],
  systemContent: string,
): ChatMessage[] {
  let replaced = false;
  const next = messages.map((message) => {
    if (!replaced && message.role === "system") {
      replaced = true;
      return { ...message, content: systemContent };
    }
    return message;
  });
  if (replaced) {
    return next;
  }
  return [{ role: "system", content: systemContent }, ...messages];
}

export async function invokeChatWithIntimacyRecovery(
  params: ChatInvocationParams & { intimacyActive: boolean },
): Promise<ChatInvocationMetadata> {
  let first: ChatInvocationMetadata;
  try {
    first = await invokeChatWithMetadata(params);
  } catch (error) {
    if (!params.settings.intimacyEnabled || !isSafetyInvocationError(error)) {
      throw error;
    }
    first = {
      content: "",
      citations: [],
      searchUsed: false,
      finishReason: "SAFETY",
    };
  }
  if (
    !params.settings.intimacyEnabled ||
    !isPolicyRefusal(first.content, first.finishReason, {
      intimacyActive: params.intimacyActive,
    })
  ) {
    return first;
  }
  const retrySettings = resolveIntimacyRetrySettings(params.settings);
  const retryPrompt = buildSystemPrompt(params.settings, {
    searchEnabled: false,
    intimacyActive: true,
    presenceRecovery: true,
  });
  try {
    const retry = await invokeChatWithMetadata({
      settings: retrySettings,
      enableSearchTool: false,
      messages: replaceSystemContent(params.messages, retryPrompt),
    });
    if (
      isPolicyRefusal(retry.content, retry.finishReason, { intimacyActive: true })
    ) {
      return {
        ...retry,
        content: INTIMACY_UNAVAILABLE_REPLY,
      };
    }
    return retry;
  } catch (error) {
    if (isSafetyInvocationError(error)) {
      return {
        content: INTIMACY_UNAVAILABLE_REPLY,
        citations: first.citations,
        searchUsed: first.searchUsed,
        finishReason: "SAFETY",
      };
    }
    throw error;
  }
}
