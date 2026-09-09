import { type ChatMessage, type ChatInvocationParams, type ChatInvocationMetadata, type WebCitation, type WireMessage } from "./contracts.js";
import { fitContextMessages } from "../chat/contextBudget.js";
import { runPreSearch } from "./search.js";
import { sanitizeAssistantOutput } from "../chat/sanitizeOutput.js";
import { normalizeContinuationArtifacts, mergeContinuationContent, shouldContinueChat } from "./continuation.js";
import { invokeChatOnce } from "./providers/registry.js";
import { mergeWebCitations } from "./evidence.js";

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
  let workingMessages = fitContextMessages(params.messages, params.preserveReplay);
  let combined = "";
  let citations: WebCitation[] = [];
  let searchUsed = false;
  let lastRawContent = "";
  const maxContinuations = Math.min(2, Math.max(0, params.maxContinuations ?? 2));
  const preSearch = params.preSearchQuery
    ? await runPreSearch(params.settings, params.preSearchQuery)
    : null;
  if (preSearch) {
    workingMessages = insertBeforeLastUserMessage(workingMessages, {
      role: "user",
      content: preSearch.context,
    });
    citations = preSearch.citations;
    searchUsed = true;
  }
  workingMessages = fitContextMessages(workingMessages, params.preserveReplay);
  const continuationMessages = [...workingMessages];
  const wireStart = Math.max(0, params.messages.length - 1);
  const finish = (finishReason: string | undefined): ChatInvocationMetadata => ({
    content: sanitizeAssistantOutput(normalizeContinuationArtifacts(combined)),
    citations,
    searchUsed,
    finishReason,
    wireMessages: [
      ...workingMessages.slice(wireStart).map(toWireMessage),
      { role: "assistant" as const, content: lastRawContent },
    ],
  });

  for (let attempt = 0; attempt <= maxContinuations; attempt += 1) {
    fitContextMessages(workingMessages, true);
    const result = await invokeChatOnce({
      settings: params.settings,
      messages: workingMessages,
      enableSearchTool: params.enableSearchTool,
      webFetchUrlSource: params.webFetchUrlSource,
    });
    lastRawContent = result.content;
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
    workingMessages = [
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
    ];
  }

  return finish(undefined);
}

export function toWireMessage(message: ChatMessage): WireMessage {
  return {
    role: message.role === "assistant" ? "assistant" : "user",
    content: message.content,
  };
}

export { ProviderRateLimitError } from "./retry.js";
export { type InputImage, type ChatMessage, type WebCitation, type WireMessage, type ChatInvocationMetadata, type ChatInvocationParams, type PreSearchContext, type ChatInvocationOnceParams } from "./contracts.js";
export { usesPreSearchContext, usesNativeWebSearch, buildSearchQuery, SOURCE_SELECTION_INSTRUCTION, performPreSearch } from "./search.js";
export { providerHasCredentials, isSearchToolAvailable } from "./providers/registry.js";
export { parseOpenRouterCitations, parseWebSearchCitations, mergeWebCitations } from "./evidence.js";
