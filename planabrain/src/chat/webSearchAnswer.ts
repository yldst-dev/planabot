import { type AnswerTurnParams, type TurnAnswer, type PreparedSearch } from "./types.js";
import { normalizeCurrentTurnText, isCurrentInformationRequest, isExplicitSearchRequest, isSearchFollowUp, resolveSearchQuery, isSimpleSocialTurn, describeImagesForSearch, canFollowUpSearch, isStatementTurn, extractReplyContext, extractCurrentTime, isClockQuestion, SEARCH_FOLLOW_UP_MAX_CHARS } from "./queryPolicy.js";
import { normalizeQuestionForMemory, buildCurrentTurnReference, buildMemoryContextMessage, buildTurnMessages } from "./promptContext.js";
import { buildLongRangeWeatherReply } from "./weatherPolicy.js";
import { looksUserInitiatedIntimacy, invokeChatWithIntimacyRecovery } from "./intimacyMode.js";
import { usesPreSearchContext, performPreSearch, type ChatInvocationMetadata, type ChatMessage, type InputImage, mergeWebCitations } from "../integrations/chat.js";
import { finalizeAnswerForDelivery } from "./deliveryRewrite.js";
import { buildLinkContext } from "./linkContext.js";
import { imageTokenEstimate } from "./contextBudget.js";
import { MAX_TURN_IMAGES } from "./imageLinks.js";
import { buildReplay, buildChatSystemPrompt } from "./replay.js";
import { applySourceSelection } from "./sourceSelection.js";
import { checkExecution } from "../runtime/execution.js";

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
  const explicitSearch = isExplicitSearchRequest(currentTurnText);
  const socialTurn =
    (signals ? signals.socialOnly : isSimpleSocialTurn(currentTurnText)) && !params.images?.length;
  const searchableTurn = explicitSearch || (!socialTurn && !isStatementTurn(currentTurnText) && !isClockQuestion(currentTurnText));
  const currentInfoRequired =
    searchableTurn && (signals ? signals.currentInfo : isCurrentInformationRequest(currentTurnText));
  const intimacyActive =
    params.settings.intimacyEnabled &&
    looksUserInitiatedIntimacy(currentTurnText, priorTexts);
  const followUpSignal = searchableTurn && (signals
    ? signals.searchFollowUp && canFollowUpSearch(priorUserTexts.at(-1))
    : isSearchFollowUp(priorUserTexts.at(-1), currentTurnText));
  const searchFollowUp = !currentInfoRequired && !explicitSearch && followUpSignal;
  const searchEnabled =
    usesPreSearchContext(params.settings) &&
    !(intimacyActive && !explicitSearch && !currentInfoRequired && !searchFollowUp);
  const wantsPreSearch =
    searchEnabled && (currentInfoRequired || explicitSearch || searchFollowUp);
  const startedAt = Date.now();
  const searchTask: Promise<PreparedSearch> = wantsPreSearch
    ? (params.images?.length ? describeImagesForSearch(params.settings, params.images, currentTurnText) : Promise.resolve(undefined))
      .then((imageSummary) => resolveSearchQuery(params.settings, priorUserTexts, currentTurnText, {
        forceQuery: currentInfoRequired || explicitSearch,
        followUp: followUpSignal ||
          Boolean(signals?.searchFollowUp && priorUserTexts.length > 0) ||
          (currentInfoRequired && priorUserTexts.length > 0 && currentTurnText.length <= SEARCH_FOLLOW_UP_MAX_CHARS),
        imageSummary,
        replyContext: extractReplyContext(params.question),
        currentTime: extractCurrentTime(params.question),
      }))
      .then(async (query) => {
        logSearchReason({ currentInfoRequired, explicitSearch, searchFollowUp, judged: Boolean(signals), query });
        return { query, context: query ? await performPreSearch(params.settings, query) : null };
      })
    : Promise.resolve({ query: undefined, context: null });
  const deliveryEnabled =
    params.settings.deliveryRewriteEnabled && !intimacyActive;
  const simpleSocialTurn = socialTurn;

  const [search, linkContext] = await Promise.all([
    searchTask,
    buildLinkContext(params.settings, currentTurnText, {
      maxPreviewImages: MAX_TURN_IMAGES - (params.images?.length ?? 0),
    }),
  ]);
  const preparedAt = Date.now();
  const referenceContext = buildCurrentTurnReference(
    params.question,
    currentTurnText,
  );
  const memoryContext = simpleSocialTurn ? null : buildMemoryContextMessage(params.memoryContext);

  const preSearch = search.context;
  const systemContent = buildChatSystemPrompt(params.settings, {
    searchEnabled: searchEnabled && !(wantsPreSearch && !preSearch),
    intimacyActive,
  });
  const replay = continuous
    ? buildReplay(recentTurns, Math.min(38, Math.max(0, (params.workingTurnLimit ?? 40) - 2)))
    : { messages: recentTurns.map((turn): ChatMessage => ({ role: turn.role, content: turn.text })), epoch: 0 };
  const epoch = replay.epoch;
  let invocation: ChatInvocationMetadata = await invokeChatWithIntimacyRecovery({
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
      images: turnImages(params.images, linkContext?.images),
      imageNotice: params.imageNotice,
      imageTokens: imageTokenEstimate(params.settings.codexImageDetail),
    }),
  });

  if (preSearch) {
    invocation = { ...invocation, citations: mergeWebCitations(preSearch.citations, invocation.citations), searchUsed: true };
  }
  const answeredAt = Date.now();
  const selected = applySourceSelection(invocation.content, invocation.citations);
  if (wantsPreSearch && selected.citations.length === 0) {
    console.error(
      `[planabrain] 검증된 출처 없이 답변: 검색결과=${preSearch?.citations.length ?? 0} 출처지정=${selected.selection}`,
    );
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

function turnImages(attached: InputImage[] | undefined, previews: InputImage[] | undefined): InputImage[] | undefined {
  const images = [...(attached ?? []), ...(previews ?? [])];
  return images.length ? images : undefined;
}

function logSearchReason(reason: {
  currentInfoRequired: boolean;
  explicitSearch: boolean;
  searchFollowUp: boolean;
  judged: boolean;
  query: string | undefined;
}): void {
  const kinds = [
    reason.currentInfoRequired ? "최신정보" : "",
    reason.explicitSearch ? "검색요청" : "",
    reason.searchFollowUp ? "후속" : "",
  ].filter(Boolean).join(",");
  console.error(
    `[planabrain] 사전 검색 이유=${kinds} 판단=${reason.judged ? "턴판단" : "규칙"} 검색어=${JSON.stringify(reason.query?.slice(0, 80) ?? null)}`,
  );
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
