import { type ChatInvocationResult } from "../contracts.js";
import { fetchWithTimeout, ProviderApiError, classifyHttpStatus, isRetryable } from "../providerError.js";
import { readUsage, recordProviderResponse } from "../responseMetadata.js";
import { asRecord } from "../value.js";
import { hasOpenRouterSearchUsage, parseOpenRouterCitations } from "../evidence.js";

export async function readJsonOrText(response: Response): Promise<unknown> {
  const raw = await response.text();
  if (!raw.trim()) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export async function invokeOpenAICompatibleChat(params: {
  providerName: string;
  url: string;
  payload: Record<string, unknown>;
  headers?: Record<string, string>;
}): Promise<ChatInvocationResult> {
  const response = await fetchWithTimeout(params.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...params.headers,
    },
    body: JSON.stringify(params.payload),
  });

  const body = await readJsonOrText(response);
  readUsage(body);
  recordProviderResponse(body, readUpstreamProvider(body, response));
  if (!response.ok || hasErrorPayload(body)) {
    throw buildProviderApiError(params.providerName, body, response);
  }

  const result = extractOpenAIResult(body);
  if (!result.content) {
    const message = `${params.providerName} API response missing choices[0].message.content`;
    throw new ProviderApiError({
      kind: "empty_or_filtered",
      provider: params.providerName,
      status: 200,
      apiMessage: message,
      retryable: true,
      message,
      upstreamProvider: readUpstreamProvider(body, response),
    });
  }
  return result;
}

export async function postOpenAIChatChoice(params: {
  providerName: string;
  url: string;
  payload: Record<string, unknown>;
  headers?: Record<string, string>;
}): Promise<{ message: Record<string, unknown>; finishReason?: string; }> {
  const response = await fetchWithTimeout(params.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...params.headers,
    },
    body: JSON.stringify(params.payload),
  });

  const body = await readJsonOrText(response);
  readUsage(body);
  recordProviderResponse(body, readUpstreamProvider(body, response));
  if (!response.ok || hasErrorPayload(body)) {
    throw buildProviderApiError(params.providerName, body, response);
  }

  const record = asRecord(body);
  const choices = record?.choices;
  const firstChoice = Array.isArray(choices) ? asRecord(choices[0]) : null;
  const message = asRecord(firstChoice?.message) ?? {};
  const finishReason =
    typeof firstChoice?.finish_reason === "string"
      ? firstChoice.finish_reason
      : typeof firstChoice?.finishReason === "string"
        ? firstChoice.finishReason
        : undefined;
  return { message, finishReason };
}

export function parseRetryAfterMs(headerValue: string | null): number | undefined {
  if (!headerValue) {
    return undefined;
  }
  const seconds = Number.parseFloat(headerValue.trim());
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  return undefined;
}

export function buildProviderApiError(
  providerName: string,
  body: unknown,
  response: Response,
): ProviderApiError {
  const apiMessage = extractProviderErrorText(body);
  const status = resolveErrorStatus(body, response.status);
  const kind = classifyHttpStatus(status, apiMessage);
  const error = new ProviderApiError({
    kind,
    provider: providerName,
    status,
    apiMessage,
    retryable: isRetryable(kind),
    message: buildApiErrorMessage(providerName, body, status),
    upstreamProvider: readUpstreamProvider(body, response),
  });
  error.retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
  return error;
}

export function hasErrorPayload(body: unknown): boolean {
  const record = asRecord(body);
  if (!record || record.error == null) {
    return false;
  }
  if (typeof record.error === "string") {
    return Boolean(record.error.trim());
  }
  return asRecord(record.error) !== null;
}

export function resolveErrorStatus(body: unknown, httpStatus: number): number {
  const nested = asRecord(asRecord(body)?.error);
  const code = nested?.code;
  const numeric =
    typeof code === "number"
      ? code
      : typeof code === "string"
        ? Number.parseInt(code, 10)
        : Number.NaN;
  if (Number.isFinite(numeric) && numeric >= 400) {
    return numeric;
  }
  if (httpStatus >= 400) {
    return httpStatus;
  }
  if (hasErrorPayload(body)) {
    return 502;
  }
  return httpStatus;
}

export function readUpstreamProvider(
  body: unknown,
  response: Response,
): string | undefined {
  const header = response.headers.get("x-openrouter-provider")?.trim();
  if (header) {
    return header;
  }
  const record = asRecord(body);
  if (typeof record?.provider === "string" && record.provider.trim()) {
    return record.provider.trim();
  }
  const metadata = asRecord(asRecord(record?.error)?.metadata);
  if (typeof metadata?.provider_name === "string" && metadata.provider_name.trim()) {
    return metadata.provider_name.trim();
  }
  return undefined;
}

export function extractProviderErrorText(body: unknown): string {
  const record = asRecord(body);
  const nestedError = asRecord(record?.error);
  const nestedMessage = nestedError?.message;
  if (typeof nestedMessage === "string" && nestedMessage.trim()) {
    return nestedMessage.trim();
  }
  const errorValue = record?.error;
  if (typeof errorValue === "string" && errorValue.trim()) {
    return errorValue.trim();
  }
  const message = record?.message;
  if (typeof message === "string" && message.trim()) {
    return message.trim();
  }
  if (typeof body === "string" && body.trim()) {
    return body.trim();
  }
  return "";
}

export function buildApiErrorMessage(
  providerName: string,
  body: unknown,
  status: number,
): string {
  const record = asRecord(body);
  const nestedError = asRecord(record?.error);
  const nestedMessage = nestedError?.message;
  if (typeof nestedMessage === "string" && nestedMessage.trim()) {
    return `${providerName} API error (${status}): ${nestedMessage.trim()}`;
  }
  const message = record?.message;
  if (typeof message === "string" && message.trim()) {
    return `${providerName} API error (${status}): ${message.trim()}`;
  }
  if (typeof body === "string" && body.trim()) {
    return `${providerName} API error (${status}): ${body.trim()}`;
  }
  return `${providerName} API error (${status})`;
}

export function extractOpenAIResult(body: unknown): ChatInvocationResult {
  const record = asRecord(body);
  const choices = record?.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return {
      content: "",
      citations: [],
      searchUsed: hasOpenRouterSearchUsage(record),
    };
  }
  const firstChoice = asRecord(choices[0]);
  const message = asRecord(firstChoice?.message);
  const content = message?.content;
  const citations = parseOpenRouterCitations(message?.annotations);
  const searchUsed = citations.length > 0 || hasOpenRouterSearchUsage(record);
  const finishReason =
    typeof firstChoice?.finish_reason === "string"
      ? firstChoice.finish_reason
      : typeof firstChoice?.finishReason === "string"
        ? firstChoice.finishReason
        : undefined;
  if (typeof content === "string") {
    return {
      content,
      finishReason,
      citations,
      searchUsed,
    };
  }
  if (Array.isArray(content)) {
    const parts = content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        const recordItem = asRecord(item);
        const text = recordItem?.text;
        return typeof text === "string" ? text : "";
      })
      .filter((item) => item.length > 0);
    return {
      content: parts.join("\n"),
      finishReason,
      citations,
      searchUsed,
    };
  }
  return {
    content: "",
    finishReason,
    citations,
    searchUsed,
  };
}
