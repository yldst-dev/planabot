import { type ChatInvocationResult, type ChatMessage } from "../contracts.js";
import { fetchWithTimeout, ProviderApiError } from "../providerError.js";
import { readUsage, recordProviderResponse } from "../responseMetadata.js";
import { withRateLimitRetry } from "../retry.js";
import { buildProviderApiError, readJsonOrText } from "../transport/httpError.js";
import { asRecord } from "../value.js";
import { type Settings } from "../../config/settings.js";

const EVENT_SEPARATOR = /\r?\n\r?\n/u;
const DEFAULT_INSTRUCTIONS = "You are a helpful assistant. Follow the conversation's language.";

type ResponsesInputItem = {
  role: "user" | "assistant";
  content: string | Array<Record<string, unknown>>;
};

export async function invokeCodexChat(
  settings: Settings,
  messages: ChatMessage[],
): Promise<ChatInvocationResult> {
  if (!settings.codexApiKey || !settings.codexBaseUrl) {
    throw new Error("CODEX_GATEWAY_API_KEY and PLANABRAIN_CODEX_BASE_URL are required when using codex");
  }
  const payload = buildCodexPayload(settings, messages);
  return withRateLimitRetry(async () => {
    const response = await fetchWithTimeout(`${settings.codexBaseUrl}/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${settings.codexApiKey}`,
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw buildProviderApiError("codex", await readJsonOrText(response), response);
    }
    return readCodexStream(response);
  });
}

export function buildCodexPayload(settings: Settings, messages: ChatMessage[]): Record<string, unknown> {
  const instructions = messages
    .filter((message) => message.role === "system" || message.role === "developer")
    .map((message) => message.content.trim())
    .filter(Boolean)
    .join("\n\n");
  const input: ResponsesInputItem[] = messages
    .filter((message) => message.role !== "system" && message.role !== "developer")
    .map((message) => ({
      role: message.role === "assistant" ? "assistant" : "user",
      content: toResponsesContent(message),
    }));
  const effort = resolveReasoningEffort(settings.chatThinkingMode);
  return {
    model: settings.chatModel,
    instructions: instructions || DEFAULT_INSTRUCTIONS,
    input,
    store: false,
    stream: true,
    ...(effort ? { reasoning: { effort } } : {}),
    ...(settings.codexFast ? { service_tier: "priority" } : {}),
  };
}

function toResponsesContent(message: ChatMessage): ResponsesInputItem["content"] {
  if (!message.images?.length || message.role === "assistant") {
    return message.content;
  }
  return [
    ...(message.content.trim() ? [{ type: "input_text", text: message.content }] : []),
    ...message.images.map((image) => ({ type: "input_image", image_url: `data:${image.mimeType};base64,${image.data}` })),
  ];
}

function resolveReasoningEffort(mode: Settings["chatThinkingMode"]): string | undefined {
  if (mode === "default") return undefined;
  return mode === "off" || mode === "minimal" ? "low" : mode;
}

export async function readCodexStream(response: Response): Promise<ChatInvocationResult> {
  if (!response.body) {
    throw emptyResponse("codex 응답 본문이 없습니다.");
  }
  const decoder = new TextDecoder();
  const deltas: string[] = [];
  let doneText: string | undefined;
  let finishReason = "stop";
  let buffer = "";
  const handle = (block: string): void => {
    const data = block
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") return;
    let event: Record<string, unknown> | null;
    try {
      event = asRecord(JSON.parse(data));
    } catch {
      return;
    }
    switch (event?.type) {
      case "response.output_text.delta":
        if (typeof event.delta === "string") deltas.push(event.delta);
        return;
      case "response.output_text.done":
        if (typeof event.text === "string") doneText = (doneText ?? "") + event.text;
        return;
      case "response.completed":
      case "response.incomplete": {
        const completed = asRecord(event.response);
        readUsage(completed);
        recordProviderResponse(completed, "codex");
        if (event.type === "response.incomplete") finishReason = "length";
        return;
      }
      case "response.failed":
      case "error":
        throw streamError(event);
      default:
    }
  };
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let separator = EVENT_SEPARATOR.exec(buffer);
    while (separator) {
      handle(buffer.slice(0, separator.index));
      buffer = buffer.slice(separator.index + separator[0].length);
      separator = EVENT_SEPARATOR.exec(buffer);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) handle(buffer);
  const content = (doneText ?? deltas.join("")).trim();
  if (!content) {
    throw emptyResponse("codex 응답에 본문이 없습니다.");
  }
  return { content, finishReason };
}

function streamError(event: Record<string, unknown>): ProviderApiError {
  const nested = asRecord(asRecord(event.response)?.error) ?? asRecord(event.error) ?? event;
  const message = typeof nested.message === "string" ? nested.message : "codex 응답 생성에 실패했습니다.";
  return new ProviderApiError({
    kind: "provider_unavailable",
    provider: "codex",
    status: 502,
    apiMessage: message,
    retryable: true,
    message: `codex API error: ${message}`,
  });
}

function emptyResponse(message: string): ProviderApiError {
  return new ProviderApiError({
    kind: "empty_or_filtered",
    provider: "codex",
    status: 200,
    apiMessage: message,
    retryable: true,
    message,
  });
}
