import { type AnswerTurnParams, type TurnAnswer, type PreparedSearch } from "./types.js";
import { normalizeCurrentTurnText, isCurrentInformationRequest, isExplicitSearchRequest, isSearchFollowUp, resolveSearchQuery, isSimpleSocialTurn } from "./queryPolicy.js";
import { normalizeQuestionForMemory, buildCurrentTurnReference, buildMemoryContextMessage, buildTurnMessages } from "./promptContext.js";
import { buildLongRangeWeatherReply } from "./weatherPolicy.js";
import { looksUserInitiatedIntimacy, invokeChatWithIntimacyRecovery } from "./intimacyMode.js";
import { usesPreSearchContext, performPreSearch, ProviderRateLimitError, type ChatInvocationMetadata, type ChatMessage, mergeWebCitations } from "../integrations/chat.js";
import { finalizeAnswerForDelivery } from "./deliveryRewrite.js";
import { buildLinkContext } from "./linkContext.js";
import { buildReplay, buildChatSystemPrompt } from "./replay.js";
import { applySourceSelection } from "./sourceSelection.js";
import { checkExecution } from "../runtime/execution.js";

export const CURRENT_INFORMATION_UNAVAILABLE = [
  "확인 불가.",
  "선생님.",
  "최신 정보를 검색 결과와 출처로 확인하지 못했습니다.",
  "추측해서 답하지 않겠습니다.",
].join("\n");

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
  const recentTurns = params.recentTurns ?? [];
  const priorUserTexts = recentTurns.filter((turn) => turn.role === "user").map((turn) => turn.text);
  const priorTexts = recentTurns.map((turn) => turn.text);

  const signals = params.signals;
  const currentInfoRequired = signals ? signals.currentInfo : isCurrentInformationRequest(currentTurnText);
  const intimacyActive =
    params.settings.intimacyEnabled &&
    looksUserInitiatedIntimacy(currentTurnText, priorTexts);
  const explicitSearch = isExplicitSearchRequest(currentTurnText);
  const followUpSignal = signals
    ? signals.searchFollowUp
    : isSearchFollowUp(priorUserTexts.at(-1), currentTurnText);
  const searchFollowUp = !currentInfoRequired && !explicitSearch && followUpSignal;
  const searchEnabled =
    usesPreSearchContext(params.settings) &&
    !(intimacyActive && !explicitSearch && !currentInfoRequired && !searchFollowUp);
  const wantsPreSearch =
    searchEnabled && (currentInfoRequired || explicitSearch || searchFollowUp);
  const startedAt = Date.now();
  const searchTask: Promise<PreparedSearch> = wantsPreSearch
    ? resolveSearchQuery(params.settings, priorUserTexts, currentTurnText, {
      forceQuery: currentInfoRequired || explicitSearch,
      followUp: followUpSignal,
    }).then(async (query) => ({
      query,
      context: query ? await performPreSearch(params.settings, query) : null,
    }))
    : Promise.resolve({ query: undefined, context: null });
  const deliveryEnabled =
    params.settings.deliveryRewriteEnabled && !intimacyActive;
  const simpleSocialTurn =
    (signals ? signals.socialOnly : isSimpleSocialTurn(currentTurnText)) && !params.images?.length;

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
      searchEnabled,
      intimacyActive,
    });
    const replay = continuous
      ? buildReplay(recentTurns, Math.min(38, Math.max(0, (params.workingTurnLimit ?? 40) - 2)))
      : { messages: recentTurns.map((turn): ChatMessage => ({ role: turn.role, content: turn.text })), epoch: 0 };
    epoch = replay.epoch;
    invocation = await invokeChatWithIntimacyRecovery({
      settings: params.settings,
      maxContinuations: deliveryEnabled && !searchEnabled ? 0 : 1,
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
  if (
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

  return {
    answer,
    transcript: continuous
      ? { wireMessages: [{ role: "user", content: currentTurnText }, { role: "assistant", content: answer }], epoch }
      : undefined,
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
export { buildChatSystemPrompt, buildReplay } from "./replay.js";
export { isSearchFollowUp, resolveSearchQuery, parseRewrittenQuery, isExplicitSearchRequest, isInformationRequestForm, isCurrentInformationRequest, normalizeCurrentTurnText } from "./queryPolicy.js";
export { applySourceSelection } from "./sourceSelection.js";
