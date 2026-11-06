import { WEB_FETCH_TOOL, type ChatInvocationResult, type ChatMessage, type ToolCall, type ToolMode } from "../contracts.js";
import { fetchWithTimeout, ProviderApiError } from "../providerError.js";
import { readUsage, recordProviderResponse } from "../responseMetadata.js";
import { withRateLimitRetry } from "../retry.js";
import { buildProviderApiError, readJsonOrText } from "../transport/httpError.js";
import { asRecord, stringifyWellFormed } from "../value.js";
import { type Settings } from "../../config/settings.js";

const EVENT_SEPARATOR = /\r?\n\r?\n/u;
const DEFAULT_INSTRUCTIONS = "You are a helpful assistant. Follow the conversation's language.";

type ResponsesMessage = {
  role: "user" | "assistant";
  content: string | Array<Record<string, unknown>>;
};

type ResponsesInputItem = ResponsesMessage | Record<string, unknown>;

export async function invokeCodexChat(
  settings: Settings,
  messages: ChatMessage[],
  toolMode?: ToolMode,
): Promise<ChatInvocationResult> {
  if (!settings.codexApiKey || !settings.codexBaseUrl) {
    throw new Error("CODEX_GATEWAY_API_KEY and PLANABRAIN_CODEX_BASE_URL are required when using codex");
  }
  const payload = buildCodexPayload(settings, messages, toolMode);
  return withRateLimitRetry(async () => {
    const response = await fetchWithTimeout(`${settings.codexBaseUrl}/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${settings.codexApiKey}`,
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body: stringifyWellFormed(payload),
    });
    if (!response.ok) {
      throw buildProviderApiError("codex", await readJsonOrText(response), response);
    }
    return readCodexStream(response, toolMode === "auto");
  });
}

export function buildCodexPayload(settings: Settings, messages: ChatMessage[], toolMode?: ToolMode): Record<string, unknown> {
  const instructions = messages
    .filter((message) => message.role === "system" || message.role === "developer")
    .map((message) => message.content.trim())
    .filter(Boolean)
    .join("\n\n");
  const input: ResponsesInputItem[] = messages
    .filter((message) => message.role !== "system" && message.role !== "developer")
    .flatMap((message) => toResponsesItems(message, settings.codexImageDetail));
  const effort = resolveReasoningEffort(settings.chatThinkingMode);
  return {
    model: settings.chatModel,
    instructions: instructions || DEFAULT_INSTRUCTIONS,
    input,
    store: false,
    stream: true,
    ...(toolMode ? { tools: [{ type: "function", strict: true, ...WEB_FETCH_TOOL }], tool_choice: toolMode } : {}),
    ...(effort ? { reasoning: { effort } } : {}),
    ...(settings.codexFast ? { service_tier: "priority" } : {}),
  };
}

function toResponsesItems(message: ChatMessage, detail: Settings["codexImageDetail"]): ResponsesInputItem[] {
  if (message.toolCallId) {
    return [{ type: "function_call_output", call_id: message.toolCallId, output: message.content }];
  }
  const calls = (message.toolCalls ?? []).map((call) => ({
    type: "function_call",
    call_id: call.id,
    name: call.name,
    arguments: call.arguments,
  }));
  if (calls.length > 0 && !message.content.trim()) {
    return calls;
  }
  return [
    { role: message.role === "assistant" ? "assistant" : "user", content: toResponsesContent(message, detail) },
    ...calls,
  ];
}

function toResponsesContent(message: ChatMessage, detail: Settings["codexImageDetail"]): ResponsesMessage["content"] {
  if (!message.images?.length || message.role === "assistant") {
    return message.content;
  }
  return [
    ...(message.content.trim() ? [{ type: "input_text", text: message.content }] : []),
    ...message.images.map((image) => ({
      type: "input_image",
      image_url: `data:${image.mimeType};base64,${image.data}`,
      ...(detail ? { detail } : {}),
    })),
  ];
}

export function resolveReasoningEffort(mode: Settings["chatThinkingMode"]): string | undefined {
  if (mode === "default") return undefined;
  return mode === "off" || mode === "minimal" ? "low" : mode;
}

export async function readCodexStream(response: Response, acceptToolCalls = false): Promise<ChatInvocationResult> {
  if (!response.body) {
    throw emptyResponse("codex 응답 본문이 없습니다.");
  }
  const decoder = new TextDecoder();
  const deltas: string[] = [];
  const toolCalls: ToolCall[] = [];
  let doneText: string | undefined;
  let finishReason = "stop";
  let finished = false;
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
      case "response.output_item.done": {
        const item = asRecord(event.item);
        if (acceptToolCalls && item?.type === "function_call" && typeof item.call_id === "string" && typeof item.name === "string") {
          toolCalls.push({ id: item.call_id, name: item.name, arguments: typeof item.arguments === "string" ? item.arguments : "" });
        }
        return;
      }
      case "response.completed":
      case "response.incomplete": {
        const completed = asRecord(event.response);
        finished = true;
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
  if (!content && toolCalls.length === 0) {
    throw emptyResponse("codex 응답에 본문이 없습니다.");
  }
  return {
    content,
    finishReason: finished || doneText !== undefined ? finishReason : "length",
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  };
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
