import { WEB_FETCH_TOOL, type ChatInvocationResult, type ChatMessage, type ToolCall, type ToolMode, type WebCitation } from "../contracts.js";
import { mergeWebCitations } from "../evidence.js";
import { fetchWithTimeout, ProviderApiError } from "../providerError.js";
import { readUsage, recordProviderResponse } from "../responseMetadata.js";
import { consumeCall } from "../../runtime/execution.js";
import { withRateLimitRetry } from "../retry.js";
import { buildProviderApiError, readJsonOrText } from "../transport/httpError.js";
import { asRecord, stringifyWellFormed } from "../value.js";
import { resolveReasoningEffort } from "./codex.js";
import { type Settings } from "../../config/settings.js";

export const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const MAX_TOKENS = 32000;
const DEFAULT_SYSTEM = "You are a helpful assistant. Follow the conversation's language.";
const WEB_SEARCH_TOOL = { type: "web_search_20250305", name: "web_search", max_uses: 3 } as const;
const MAX_PAUSE_RESUMES = 2;
const SERVER_TOOL_BLOCKS = new Set(["server_tool_use", "web_search_tool_result"]);

export async function invokeAnthropicChat(
  settings: Settings,
  messages: ChatMessage[],
  toolMode?: ToolMode,
  webSearch = false,
): Promise<ChatInvocationResult> {
  if (!settings.anthropicApiKey) {
    throw new Error("ANTHROPIC_API_KEY is required when using anthropic");
  }
  return withRateLimitRetry(async () => {
    let payload = buildAnthropicPayload(settings, messages, toolMode, webSearch);
    let body: unknown;
    try {
      body = await postMessages(settings, payload);
    } catch (error) {
      if (!rejectsWebSearch(error, payload)) throw error;
      console.error(`[planabrain] Anthropic이 웹 검색 도구를 거절해 검색 없이 다시 보냅니다: ${error.apiMessage}`);
      payload = buildAnthropicPayload(settings, messages, toolMode, false);
      body = await postMessages(settings, payload);
    }
    const earlier: unknown[] = [];
    for (let resume = 0; resume < MAX_PAUSE_RESUMES && asRecord(body)?.stop_reason === "pause_turn"; resume += 1) {
      readUsage(body);
      const paused = contentBlocks(asRecord(body));
      earlier.push(...paused);
      payload = { ...payload, messages: [...(payload.messages as unknown[]), { role: "assistant", content: paused }] };
      body = await postMessages(settings, payload);
    }
    const merged = earlier.length > 0 ? { ...asRecord(body), content: [...earlier, ...contentBlocks(asRecord(body))] } : body;
    return readAnthropicMessage(merged, toolMode === "auto");
  });
}

async function postMessages(settings: Settings, payload: Record<string, unknown>): Promise<unknown> {
  consumeCall();
  const response = await fetchWithTimeout(ANTHROPIC_MESSAGES_URL, {
    method: "POST",
    headers: {
      "x-api-key": settings.anthropicApiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json",
    },
    body: stringifyWellFormed(payload),
  });
  const body = await readJsonOrText(response);
  if (!response.ok) {
    throw buildProviderApiError("anthropic", body, response);
  }
  return body;
}

function rejectsWebSearch(error: unknown, payload: Record<string, unknown>): error is ProviderApiError {
  return error instanceof ProviderApiError && error.status === 400 && /web[_ ]?search/iu.test(error.apiMessage)
    && Array.isArray(payload.tools) && payload.tools.some((tool) => asRecord(tool)?.name === WEB_SEARCH_TOOL.name);
}

export function buildAnthropicPayload(settings: Settings, messages: ChatMessage[], toolMode?: ToolMode, webSearch = false): Record<string, unknown> {
  const system = messages
    .filter((message) => message.role === "system" || message.role === "developer")
    .map((message) => message.content.trim())
    .filter(Boolean)
    .join("\n\n");
  const turns: Array<{ role: "user" | "assistant"; content: unknown[]; toolResults?: boolean; }> = [];
  for (const message of messages.filter((item) => item.role !== "system" && item.role !== "developer")) {
    const previous = turns.at(-1);
    if (message.toolCallId && previous?.role === "user" && previous.toolResults) {
      previous.content.push(...toContentBlocks(message));
      continue;
    }
    const content = toContentBlocks(message);
    if (content.length > 0) {
      turns.push({ role: message.role === "assistant" ? "assistant" : "user", content, ...(message.toolCallId ? { toolResults: true } : {}) });
    }
  }
  const effort = resolveReasoningEffort(settings.chatThinkingMode);
  const searchTool = webSearch || messages.some((message) => message.providerContent?.some((block) => SERVER_TOOL_BLOCKS.has(String(asRecord(block)?.type))));
  const tools = [
    ...(toolMode ? [{ name: WEB_FETCH_TOOL.name, description: WEB_FETCH_TOOL.description, input_schema: WEB_FETCH_TOOL.parameters }] : []),
    ...(searchTool ? [WEB_SEARCH_TOOL] : []),
  ];
  return {
    model: settings.chatModel,
    max_tokens: MAX_TOKENS,
    system: [{ type: "text", text: system || DEFAULT_SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: turns.map(({ role, content }) => ({ role, content })),
    ...(tools.length > 0 ? { tools } : {}),
    ...(toolMode ? { tool_choice: { type: toolMode } } : {}),
    ...(effort ? { output_config: { effort } } : {}),
  };
}

function toContentBlocks(message: ChatMessage): unknown[] {
  if (message.toolCallId) {
    return [{ type: "tool_result", tool_use_id: message.toolCallId, content: message.content }];
  }
  if (message.providerContent) {
    return message.providerContent;
  }
  const images = message.role === "assistant" ? [] : message.images ?? [];
  return [
    ...images.map((image) => ({
      type: "image",
      source: { type: "base64", media_type: image.mimeType, data: image.data },
    })),
    ...(message.content.trim() ? [{ type: "text", text: message.content }] : []),
  ];
}

export function readAnthropicMessage(body: unknown, acceptToolCalls = false): ChatInvocationResult {
  const message = asRecord(body);
  readUsage(message);
  recordProviderResponse(message, "anthropic");
  const blocks = contentBlocks(message);
  const search = readServerSearch(blocks);
  const answerBlocks = blocks.slice(search.lastIndex + 1).map(asRecord);
  const content = answerBlocks
    .map((block) => (block?.type === "text" && typeof block.text === "string" ? block.text : ""))
    .join("")
    .trim();
  const stopReason = typeof message?.stop_reason === "string" ? message.stop_reason : undefined;
  const toolCalls: ToolCall[] = acceptToolCalls ? blocks.map(asRecord).flatMap(readToolUse) : [];
  const found = search.count > 0
    ? { citations: readSearchCitations(answerBlocks), searchUsed: true }
    : {};
  if (search.count > 0) {
    console.error(`[planabrain] 서버 검색 횟수=${search.count}${search.errors.length > 0 ? ` 오류=${search.errors.join(",")}` : ""}`);
  }
  if (toolCalls.length > 0) {
    return { content, finishReason: stopReason, toolCalls, providerContent: blocks, ...found };
  }
  if (!content) {
    throw stopReason === "refusal"
      ? emptyResponse("anthropic refusal: content blocked", false)
      : emptyResponse("anthropic 응답에 본문이 없습니다.", true);
  }
  return { content, finishReason: stopReason, ...found };
}

function contentBlocks(message: Record<string, unknown> | null): unknown[] {
  return Array.isArray(message?.content) ? message.content : [];
}

function readServerSearch(blocks: unknown[]): { lastIndex: number; count: number; errors: string[]; } {
  const search = { lastIndex: -1, count: 0, errors: [] as string[] };
  blocks.forEach((raw, index) => {
    const block = asRecord(raw);
    if (typeof block?.type !== "string" || !SERVER_TOOL_BLOCKS.has(block.type)) return;
    search.lastIndex = index;
    if (block.type === "server_tool_use") search.count += 1;
    const code = asRecord(block.content)?.error_code;
    if (typeof code === "string") search.errors.push(code);
  });
  return search;
}

function readSearchCitations(blocks: Array<Record<string, unknown> | null>): WebCitation[] {
  const found: WebCitation[] = [];
  for (const block of blocks) {
    if (block?.type !== "text" || !Array.isArray(block.citations)) continue;
    for (const raw of block.citations) {
      const citation = asRecord(raw);
      if (citation?.type !== "web_search_result_location" || typeof citation.url !== "string") continue;
      found.push({
        url: citation.url,
        ...(typeof citation.title === "string" ? { title: citation.title } : {}),
        ...(typeof citation.cited_text === "string" ? { evidence: citation.cited_text } : {}),
      });
    }
  }
  return mergeWebCitations(found);
}

function readToolUse(block: Record<string, unknown> | null): ToolCall[] {
  return block?.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string"
    ? [{ id: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}) }]
    : [];
}

function emptyResponse(message: string, retryable: boolean): ProviderApiError {
  return new ProviderApiError({
    kind: "empty_or_filtered",
    provider: "anthropic",
    status: 200,
    apiMessage: message,
    retryable,
    message,
  });
}
