import { type ChatMessage, type ChatInvocationParams, type ChatInvocationMetadata, type ChatInvocationResult, type ToolMode, type WebCitation, type WireMessage } from "./contracts.js";
import { MAX_CONTEXT_TOKENS, contextTokens, fitContextMessages, imageTokenEstimate } from "../chat/contextBudget.js";
import { runPreSearch } from "./search.js";
import { sanitizeAssistantOutput } from "../chat/sanitizeOutput.js";
import { normalizeContinuationArtifacts, mergeContinuationContent, shouldContinueChat } from "./continuation.js";
import { invokeAnthropicChat } from "./providers/anthropic.js";
import { invokeCodexChat } from "./providers/codex.js";
import { ExecutionLimitError, measureStage } from "../runtime/execution.js";
import { mergeWebCitations } from "./evidence.js";

const MAX_WEB_FETCH_ROUNDS = 3;
const MAX_WEB_FETCH_CALLS = 8;
const WEB_FETCH_IMAGE_NOTE = "방금 읽은 링크의 미리보기 이미지입니다. 질문과 관련 있거나 본문이 부족할 때만 참고하고, 그렇지 않으면 언급하지 않습니다.";
const WEB_FETCH_TOO_LONG = "대화와 참고 자료가 이미 길어 이 페이지를 읽지 못했습니다. 읽지 못했다고 밝히고 내용을 추측하지 마십시오.";

export function insertBeforeLastUserMessage(
  messages: ChatMessage[],
  message: ChatMessage,
): ChatMessage[] {
  const lastUserIndex = messages.map((item) => item.role).lastIndexOf("user");
  if (lastUserIndex < 0) {
    return [...messages, message];
  }
  return [
    ...messages.slice(0, lastUserIndex),
    message,
    ...messages.slice(lastUserIndex),
  ];
}

export async function invokeChat(params: ChatInvocationParams): Promise<string> {
  const output = await invokeChatWithMetadata(params);
  return output.content;
}

export async function invokeChatWithMetadata(
  params: ChatInvocationParams,
): Promise<ChatInvocationMetadata> {
  const imageTokens = imageTokenEstimate(params.settings.codexImageDetail);
  let workingMessages = params.preSearchQuery ? fitContextMessages(params.messages, false, imageTokens) : params.messages;
  let combined = "";
  let citations: WebCitation[] = [];
  let searchUsed = false;
  const maxContinuations = Math.min(2, Math.max(0, params.maxContinuations ?? 2));
  const preSearch = params.preSearchQuery
    ? await runPreSearch(params.settings, params.preSearchQuery)
    : null;
  if (preSearch) {
    workingMessages = insertBeforeLastUserMessage(workingMessages, {
      role: "user",
      content: preSearch.context,
      contextKind: "evidence",
    });
    citations = preSearch.citations;
    searchUsed = true;
  }
  workingMessages = fitContextMessages(workingMessages, false, imageTokens);
  let continuationMessages = [...workingMessages];
  const wireInput = workingMessages.slice(Math.max(0, workingMessages.map((message) => message.role).lastIndexOf("user")));
  const finish = (finishReason: string | undefined): ChatInvocationMetadata => {
    const content = sanitizeAssistantOutput(normalizeContinuationArtifacts(combined));
    return {
      content,
      citations,
      searchUsed,
      finishReason,
      wireMessages: [...wireInput.map(toWireMessage), { role: "assistant", content }],
    };
  };

  const provider = params.settings.aiProvider;
  const providerInvoke = provider === "anthropic" ? invokeAnthropicChat : invokeCodexChat;
  const invoke = (messages: ChatMessage[], toolMode?: ToolMode): Promise<ChatInvocationResult> =>
    measureStage(`provider:${provider}`, () => providerInvoke(params.settings, messages, toolMode));
  let toolMode: ToolMode | undefined = params.webFetch ? "auto" : undefined;
  for (let attempt = 0; attempt <= maxContinuations; attempt += 1) {
    let result = await invoke(workingMessages, toolMode);
    for (let round = 1; params.webFetch && result.toolCalls?.length; round += 1) {
      const fitted = result.toolCalls.length > MAX_WEB_FETCH_CALLS
        ? undefined
        : await runWebFetchRound(params.webFetch, result, workingMessages, imageTokens);
      if (!fitted) {
        toolMode = "none";
        result = await invoke(workingMessages, toolMode);
        break;
      }
      workingMessages = fitted;
      continuationMessages = workingMessages;
      toolMode = round < MAX_WEB_FETCH_ROUNDS ? "auto" : "none";
      result = await invoke(workingMessages, toolMode);
    }
    toolMode = continuationMessages.some((message) => message.toolCalls) ? "none" : undefined;
    combined = combined
      ? mergeContinuationContent(combined, result.content)
      : result.content.trim();
    citations = mergeWebCitations(citations, result.citations ?? []);
    searchUsed = searchUsed || result.searchUsed === true;
    if (!shouldContinueChat(result.finishReason, combined)) {
      return finish(result.finishReason);
    }
    if (attempt === maxContinuations) {
      return finish(result.finishReason);
    }
    try {
      workingMessages = fitContextMessages([
        ...continuationMessages,
        {
          role: "assistant",
          content: combined,
        },
        {
          role: "user",
          content:
            "방금 답변한 마지막 문장 다음부터만 이어서 남은 정보를 적어 주십시오. 이미 쓴 서두는 반복하지 말고, 출처 줄, 메타 설명, 내부 판단은 쓰지 마십시오.",
        },
      ], true, imageTokens);
    } catch (error) {
      if (error instanceof ExecutionLimitError) return finish(result.finishReason);
      throw error;
    }
  }

  return finish(undefined);
}

async function runWebFetchRound(
  webFetch: NonNullable<ChatInvocationParams["webFetch"]>,
  result: ChatInvocationResult,
  messages: ChatMessage[],
  imageTokens: number,
): Promise<ChatMessage[] | undefined> {
  const { outputs, images, discard } = await webFetch(result.toolCalls ?? []);
  const textOnly: ChatMessage[] = [
    { role: "assistant", content: result.content, toolCalls: result.toolCalls, providerContent: result.providerContent, contextKind: "evidence" },
    ...outputs.map(({ callId, output }): ChatMessage => ({ role: "user", content: output, toolCallId: callId, contextKind: "evidence" })),
  ];
  const withImages: ChatMessage[] = images.length > 0
    ? [...textOnly, { role: "user", content: WEB_FETCH_IMAGE_NOTE, images, contextKind: "evidence" }]
    : textOnly;
  const unread = textOnly.map((message) => message.toolCallId ? { ...message, content: WEB_FETCH_TOO_LONG } : message);
  const fits = contextTokens([...messages, ...withImages], imageTokens) <= MAX_CONTEXT_TOKENS;
  for (const candidate of fits ? [withImages] : [textOnly, unread]) {
    try {
      const fitted = fitContextMessages([...messages, ...candidate], false, imageTokens);
      if (candidate === unread) discard?.();
      return fitted;
    } catch (error) {
      if (!(error instanceof ExecutionLimitError)) throw error;
    }
  }
  discard?.();
  return undefined;
}

export function toWireMessage(message: ChatMessage): WireMessage {
  return {
    role: message.role === "assistant" ? "assistant" : "user",
    content: message.content,
  };
}

export { ProviderRateLimitError } from "./retry.js";
export { type InputImage, type ChatMessage, type ToolCall, type WebCitation, type WireMessage, type ChatInvocationMetadata, type ChatInvocationParams, type PreSearchContext, type WebFetchRound, type WebFetchRunner } from "./contracts.js";
export { usesPreSearchContext, buildSearchQuery, SOURCE_SELECTION_INSTRUCTION, performPreSearch } from "./search.js";
export { parseWebSearchCitations, mergeWebCitations, normalizeCitationUrl, isSecretParam } from "./evidence.js";
