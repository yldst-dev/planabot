import { type ChatInvocationResult, type ChatMessage } from "../contracts.js";
import { fetchWithTimeout, ProviderApiError } from "../providerError.js";
import { readUsage, recordProviderResponse } from "../responseMetadata.js";
import { withRateLimitRetry } from "../retry.js";
import { buildProviderApiError, readJsonOrText } from "../transport/httpError.js";
import { asRecord } from "../value.js";
import { resolveReasoningEffort } from "./codex.js";
import { type Settings } from "../../config/settings.js";

export const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const MAX_TOKENS = 32000;
const DEFAULT_SYSTEM = "You are a helpful assistant. Follow the conversation's language.";

type ContentBlock = Record<string, unknown>;

export async function invokeAnthropicChat(
  settings: Settings,
  messages: ChatMessage[],
): Promise<ChatInvocationResult> {
  if (!settings.anthropicApiKey) {
    throw new Error("ANTHROPIC_API_KEY is required when using anthropic");
  }
  const payload = buildAnthropicPayload(settings, messages);
  return withRateLimitRetry(async () => {
    const response = await fetchWithTimeout(ANTHROPIC_MESSAGES_URL, {
      method: "POST",
      headers: {
        "x-api-key": settings.anthropicApiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const body = await readJsonOrText(response);
    if (!response.ok) {
      throw buildProviderApiError("anthropic", body, response);
    }
    return readAnthropicMessage(body);
  });
}

export function buildAnthropicPayload(settings: Settings, messages: ChatMessage[]): Record<string, unknown> {
  const system = messages
    .filter((message) => message.role === "system" || message.role === "developer")
    .map((message) => message.content.trim())
    .filter(Boolean)
    .join("\n\n");
  const turns = messages
    .filter((message) => message.role !== "system" && message.role !== "developer")
    .map((message) => ({
      role: message.role === "assistant" ? "assistant" : "user",
      content: toContentBlocks(message),
    }))
    .filter((turn) => turn.content.length > 0);
  const effort = resolveReasoningEffort(settings.chatThinkingMode);
  return {
    model: settings.chatModel,
    max_tokens: MAX_TOKENS,
    system: [{ type: "text", text: system || DEFAULT_SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: turns,
    ...(effort ? { output_config: { effort } } : {}),
  };
}

function toContentBlocks(message: ChatMessage): ContentBlock[] {
  const images = message.role === "assistant" ? [] : message.images ?? [];
  return [
    ...images.map((image) => ({
      type: "image",
      source: { type: "base64", media_type: image.mimeType, data: image.data },
    })),
    ...(message.content.trim() ? [{ type: "text", text: message.content }] : []),
  ];
}

export function readAnthropicMessage(body: unknown): ChatInvocationResult {
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
  if (!content) {
    throw stopReason === "refusal"
      ? emptyResponse("anthropic refusal: content blocked", false)
      : emptyResponse("anthropic 응답에 본문이 없습니다.", true);
  }
  return { content, finishReason: stopReason };
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
