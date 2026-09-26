import { ProviderApiError, classifyHttpStatus, isRetryable } from "../providerError.js";
import { asRecord } from "../value.js";

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
    upstreamProvider: readUpstreamProvider(body),
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

export function readUpstreamProvider(body: unknown): string | undefined {
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
  const message = record?.message ?? record?.detail;
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

