import { WEB_FETCH_TOOL, type ChatInvocationResult, type ChatMessage, type ToolCall, type ToolMode } from "../contracts.js";
import { fetchWithTimeout, ProviderApiError } from "../providerError.js";
import { readUsage, recordProviderResponse } from "../responseMetadata.js";
import { withRateLimitRetry } from "../retry.js";
import { buildProviderApiError, readJsonOrText } from "../transport/httpError.js";
import { asRecord, stringifyWellFormed } from "../value.js";
import { resolveReasoningEffort } from "./codex.js";
import { type Settings } from "../../config/settings.js";

export const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const MAX_TOKENS = 32000;
const DEFAULT_SYSTEM = "You are a helpful assistant. Follow the conversation's language.";

export async function invokeAnthropicChat(
  settings: Settings,
  messages: ChatMessage[],
  toolMode?: ToolMode,
): Promise<ChatInvocationResult> {
  if (!settings.anthropicApiKey) {
    throw new Error("ANTHROPIC_API_KEY is required when using anthropic");
  }
  const payload = buildAnthropicPayload(settings, messages, toolMode);
  return withRateLimitRetry(async () => {
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
    return readAnthropicMessage(body, toolMode === "auto");
  });
}

export function buildAnthropicPayload(settings: Settings, messages: ChatMessage[], toolMode?: ToolMode): Record<string, unknown> {
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
  return {
    model: settings.chatModel,
    max_tokens: MAX_TOKENS,
    system: [{ type: "text", text: system || DEFAULT_SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: turns.map(({ role, content }) => ({ role, content })),
    ...(toolMode ? {
      tools: [{ name: WEB_FETCH_TOOL.name, description: WEB_FETCH_TOOL.description, input_schema: WEB_FETCH_TOOL.parameters }],
      tool_choice: { type: toolMode },
    } : {}),
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
  const blocks = Array.isArray(message?.content) ? message.content : [];
  const content = blocks
    .map(asRecord)
    .map((block) => (block?.type === "text" && typeof block.text === "string" ? block.text : ""))
    .join("")
    .trim();
  const stopReason = typeof message?.stop_reason === "string" ? message.stop_reason : undefined;
  const toolCalls: ToolCall[] = acceptToolCalls ? blocks.map(asRecord).flatMap(readToolUse) : [];
  if (toolCalls.length > 0) {
    return { content, finishReason: stopReason, toolCalls, providerContent: blocks };
  }
  if (!content) {
    throw stopReason === "refusal"
      ? emptyResponse("anthropic refusal: content blocked", false)
      : emptyResponse("anthropic 응답에 본문이 없습니다.", true);
  }
  return { content, finishReason: stopReason };
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
