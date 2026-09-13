import { type AnswerTurnParams, type TurnAnswer, type PreparedSearch, type TurnTranscript } from "./types.js";
import { normalizeCurrentTurnText, isCurrentInformationRequest, isExplicitSearchRequest, isSearchFollowUp, resolveSearchQuery, isSimpleSocialTurn } from "./queryPolicy.js";
import { normalizeQuestionForMemory, buildCurrentTurnReference, buildMemoryContextMessage, buildTurnMessages } from "./promptContext.js";
import { buildLongRangeWeatherReply } from "./weatherPolicy.js";
import { loadUserMemory, appendUserMemory } from "../memory/userMemoryStore.js";
import { looksUserInitiatedIntimacy, invokeChatWithIntimacyRecovery } from "./intimacyMode.js";
import { isSearchToolAvailable, usesPreSearchContext, usesNativeWebSearch, performPreSearch, ProviderRateLimitError, type ChatInvocationMetadata, type ChatMessage, mergeWebCitations } from "../integrations/chat.js";
import { DEFAULT_DELIVERY_MAX_TOKENS, finalizeAnswerForDelivery, removeModelSourceLines } from "./deliveryRewrite.js";
import { type Settings } from "../config/settings.js";
import { buildLinkContext } from "./linkContext.js";
import { buildReplay, buildChatSystemPrompt, composeContinuousUserMessage, exceedsReplayLimits } from "./replay.js";
import { contextTokens, MAX_CONTEXT_TOKENS } from "./contextBudget.js";
import { applySourceSelection } from "./sourceSelection.js";
import { requiresGlmReasoning } from "../integrations/providers/options.js";
import { checkExecution } from "../runtime/execution.js";

export const CURRENT_INFORMATION_UNAVAILABLE = [
  "확인 불가.",
  "선생님.",
  "최신 정보를 검색 결과와 출처로 확인하지 못했습니다.",
  "추측해서 답하지 않겠습니다.",
].join("\n");

export async function answerWithWebSearch(params: AnswerTurnParams): Promise<string> {
  const result = await answerTurn(params);
  return result.answer;
}

export async function answerTurn(params: AnswerTurnParams): Promise<TurnAnswer> {
  const currentTurnText =
    normalizeCurrentTurnText(
      params.currentTurnText ?? params.linkSourceText ?? params.question,
    ) ||
    normalizeQuestionForMemory(params.question);
  const longRangeWeatherReply = buildLongRangeWeatherReply(
    currentTurnText,
    params.question,
  );
  if (longRangeWeatherReply) {
    return { answer: longRangeWeatherReply };
  }
  const continuous = params.continuousChat ?? params.settings.continuousChat;
  const userId = params.userId ?? "default";
  const history =
    !continuous && params.settings.memoryEnabled && params.settings.memoryMaxMessages > 0
      ? await loadUserMemory({
        memoryDir: params.settings.memoryDir,
        userId,
        chatScope: params.chatScope,
        conversationId: params.conversationId,
        maxMessages: params.settings.memoryMaxMessages
      })
      : [];
  const recentTurns = params.recentTurns ?? [];
  const priorUserTexts = continuous
    ? recentTurns.filter((turn) => turn.role === "user").map((turn) => turn.text)
    : history.filter((message) => message.role === "human").map((message) => message.content);
  const priorTexts = continuous
    ? recentTurns.map((turn) => turn.text)
    : history.map((message) => message.content);

  const currentInfoRequired = isCurrentInformationRequest(currentTurnText);
  const intimacyActive =
    params.settings.intimacyEnabled &&
    looksUserInitiatedIntimacy(currentTurnText, priorTexts);
  const explicitSearch = isExplicitSearchRequest(currentTurnText);
  const searchFollowUp =
    !currentInfoRequired &&
    !explicitSearch &&
    isSearchFollowUp(priorUserTexts.at(-1), currentTurnText);
  const nativeSearch = usesNativeWebSearch(params.settings);
  const searchToolEnabled =
    !nativeSearch &&
    isSearchToolAvailable(params.settings) &&
    !(intimacyActive && !explicitSearch && !currentInfoRequired && !searchFollowUp);
  const preSearchMode = searchToolEnabled && usesPreSearchContext(params.settings);
  const wantsPreSearch =
    preSearchMode && (currentInfoRequired || explicitSearch || searchFollowUp);
  const startedAt = Date.now();
  const searchTask: Promise<PreparedSearch> = wantsPreSearch
    ? resolveSearchQuery(params.settings, priorUserTexts, currentTurnText, {
      forceQuery: currentInfoRequired || explicitSearch,
    }).then(async (query) => ({
      query,
      context: query ? await performPreSearch(params.settings, query) : null,
    }))
    : Promise.resolve({ query: undefined, context: null });
  const deliveryEnabled =
    params.settings.deliveryRewriteEnabled && !intimacyActive;
  const deliveryLimit =
    params.settings.deliveryMaxOutputTokens ?? DEFAULT_DELIVERY_MAX_TOKENS;
  let generationSettings: Settings =
    params.settings.deliveryRewriteEnabled && (continuous || deliveryEnabled) && !(params.settings.aiProvider === "openrouter" && requiresGlmReasoning(params.settings.chatModel))
      ? {
        ...params.settings,
        chatMaxOutputTokens: Math.min(
          params.settings.chatMaxOutputTokens ?? deliveryLimit,
          Math.round(deliveryLimit * 1.1),
        ),
      }
      : params.settings;

  const simpleSocialTurn = isSimpleSocialTurn(currentTurnText) && !params.images?.length;
  if (simpleSocialTurn && params.settings.aiProvider === "openrouter" && requiresGlmReasoning(params.settings.chatModel) && params.settings.chatThinkingMode === "default") {
    generationSettings = { ...generationSettings, chatThinkingMode: "low" };
  }

  let search: PreparedSearch;
  let linkContext: Awaited<ReturnType<typeof buildLinkContext>>;
  try {
    [search, linkContext] = await Promise.all([
      searchTask,
      buildLinkContext(params.settings, currentTurnText),
    ]);
  } catch (error) {
    if (error instanceof ProviderRateLimitError) {
      return { answer: error.message };
    }
    throw error;
  }
  const preparedAt = Date.now();
  const referenceContext = buildCurrentTurnReference(
    params.question,
    currentTurnText,
  );
  const memoryContext = simpleSocialTurn ? null : buildMemoryContextMessage(params.memoryContext);

  let invocation: ChatInvocationMetadata;
  const preSearch = search.context;
  let epoch = 0;
  try {
    const systemContent = buildChatSystemPrompt(params.settings, {
      searchEnabled: nativeSearch || searchToolEnabled,
      intimacyActive,
    });
    if (continuous && nativeSearch) {
      const replay = buildReplay(recentTurns, true);
      epoch = replay.epoch;
      const userContent = composeContinuousUserMessage({
        referenceContext,
        memoryContext,
        linkContext: linkContext?.content ?? null,
        searchContext: preSearch?.context ?? null,
        currentTurnText,
      });
      const messages: ChatMessage[] = exceedsReplayLimits(
        replay,
        userContent.length,
        params.workingTurnLimit,
      ) || contextTokens([{ role: "system", content: systemContent }, ...replay.messages, { role: "user", content: userContent, images: params.images }]) > MAX_CONTEXT_TOKENS
        ? []
        : replay.messages;
      if (messages.length !== replay.messages.length) {
        epoch = replay.epoch + 1;
      }
      invocation = await invokeChatWithIntimacyRecovery({
        settings: generationSettings,
        preserveReplay: true,
        maxContinuations: 1,
        enableSearchTool: searchToolEnabled && !preSearchMode,
        webFetchUrlSource: currentTurnText,
        intimacyActive,
        messages: [
          { role: "system", content: systemContent },
          ...messages,
          { role: "user", content: userContent, images: params.images },
        ],
      });
    } else {
      const replay = continuous
        ? buildReplay(recentTurns, false, Math.min(38, Math.max(0, (params.workingTurnLimit ?? 40) - 2)))
        : { messages: history.map((message): ChatMessage => ({ role: message.role === "ai" ? "assistant" : "user", content: message.content })), epoch: 0 };
      epoch = replay.epoch;
      invocation = await invokeChatWithIntimacyRecovery({
        settings: generationSettings,
        enableSearchTool: searchToolEnabled && !preSearchMode,
        maxContinuations: deliveryEnabled && !searchToolEnabled ? 0 : 1,
        webFetchUrlSource: currentTurnText,
        intimacyActive,
        messages: buildTurnMessages({
          systemContent,
          history: replay.messages,
          memoryContext,
          referenceContext,
          linkContext: linkContext?.content ?? null,
          searchContext: preSearch?.context ?? null,
          currentTurnText,
          images: params.images,
        }),
      });
    }
  } catch (error) {
    if (error instanceof ProviderRateLimitError) {
      return { answer: error.message };
    }
    throw error;
  }

  if (preSearch) {
    invocation = { ...invocation, citations: mergeWebCitations(preSearch.citations, invocation.citations), searchUsed: true };
  }
  const answeredAt = Date.now();
  const selected = applySourceSelection(invocation.content, invocation.citations);
  const transcript: TurnTranscript | undefined =
    continuous && invocation.wireMessages.length > 0
      ? { wireMessages: invocation.wireMessages, epoch }
      : undefined;
  if (
    !nativeSearch &&
    (currentInfoRequired || explicitSearch || searchFollowUp) &&
    (!invocation.searchUsed || selected.citations.length === 0)
  ) {
    return { answer: CURRENT_INFORMATION_UNAVAILABLE, transcript: continuous ? { wireMessages: [], epoch: epoch + 1 } : undefined };
  }
  checkExecution();
  const citations = mergeWebCitations(
    selected.citations,
    linkContext?.citations ?? [],
  );
  const answer = await finalizeAnswerForDelivery({
    question: currentTurnText,
    answer: selected.content,
    finishReason: invocation.finishReason,
    settings: params.settings,
    verifiedCitations: citations.map((citation) => ({
      url: citation.url,
      ...(citation.title ? { title: citation.title } : {}),
    })),
  });
  logTurnTiming(startedAt, preparedAt, answeredAt, Date.now());
  const memoryQuestion = currentTurnText;

  if (!continuous && params.settings.memoryEnabled && params.settings.memoryMaxMessages > 0) {
    await appendUserMemory({
      memoryDir: params.settings.memoryDir,
      userId,
      chatScope: params.chatScope,
      conversationId: params.conversationId,
      maxMessages: params.settings.memoryMaxMessages,
      messages: [
        { role: "human", content: memoryQuestion, at: Date.now() },
        { role: "ai", content: answer, at: Date.now() }
      ]
    });
  }

  return {
    answer,
    transcript: continuous && !nativeSearch
      ? { wireMessages: [{ role: "user", content: currentTurnText }, { role: "assistant", content: answer }], epoch }
      : transcript && (removeModelSourceLines(answer).replace(/\s/gu, "") !== invocation.wireMessages.at(-1)?.content.replace(/\s/gu, "") || Boolean(params.images?.length))
        ? { wireMessages: [], epoch: epoch + 1 }
        : transcript
  };
}

export function logTurnTiming(
  startedAt: number,
  preparedAt: number,
  answeredAt: number,
  deliveredAt: number,
): void {
  console.error(
    `[planabrain] 턴 처리 시간(ms) 준비=${preparedAt - startedAt} 답변=${answeredAt - preparedAt} 전달=${deliveredAt - answeredAt} 합계=${deliveredAt - startedAt}`,
  );
}

export { type RecentTurnInput, type TurnTranscript, type TurnAnswer, type AnswerTurnParams, type Replay } from "./types.js";
export { buildChatSystemPrompt, composeContinuousUserMessage, exceedsReplayLimits, buildReplay } from "./replay.js";
export { isSearchFollowUp, resolveSearchQuery, parseRewrittenQuery, isExplicitSearchRequest, isInformationRequestForm, isCurrentInformationRequest, normalizeCurrentTurnText } from "./queryPolicy.js";
export { applySourceSelection } from "./sourceSelection.js";
