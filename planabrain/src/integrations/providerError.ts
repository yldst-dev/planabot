export type ProviderErrorKind =
  | "credit_exhausted"
  | "auth_failed"
  | "rate_limited"
  | "provider_unavailable"
  | "network_timeout"
  | "invalid_request"
  | "empty_or_filtered"
  | "unknown";

export type StructuredProviderError = {
  kind: ProviderErrorKind;
  provider: string | null;
  status: number | null;
  message: string;
  retryable: boolean;
};

const CREDIT_PATTERN =
  /insufficient[\s_]+(?:credits?|quota|funds?|balance)|(?:not enough|no)\s+credits?|payment\s+required|billing|add\s+credits?|purchase\s+credits?|check\s+your\s+plan|exceeded\s+your\s+current\s+quota/i;

const DEFAULT_HTTP_TIMEOUT_MS = 60000;

export function isRetryable(kind: ProviderErrorKind): boolean {
  return (
    kind === "rate_limited" ||
    kind === "provider_unavailable" ||
    kind === "network_timeout"
  );
}

export function classifyHttpStatus(
  status: number,
  bodyText: string,
): ProviderErrorKind {
  if (status === 402) {
    return "credit_exhausted";
  }
  if (typeof bodyText === "string" && CREDIT_PATTERN.test(bodyText)) {
    return "credit_exhausted";
  }
  if (status === 401 || status === 403) {
    return "auth_failed";
  }
  if (status === 429) {
    return "rate_limited";
  }
  if (status >= 500 && status <= 599) {
    return "provider_unavailable";
  }
  if (status >= 400 && status <= 499) {
    return "invalid_request";
  }
  return "unknown";
}

export class ProviderApiError extends Error {
  readonly kind: ProviderErrorKind;
  readonly provider: string | null;
  readonly status: number | null;
  readonly apiMessage: string;
  readonly retryable: boolean;
  retryAfterMs?: number;

  constructor(params: {
    kind: ProviderErrorKind;
    provider?: string | null;
    status?: number | null;
    apiMessage?: string;
    retryable?: boolean;
    message?: string;
  }) {
    super(params.message ?? params.apiMessage ?? params.kind);
    this.name = "ProviderApiError";
    this.kind = params.kind;
    this.provider = params.provider ?? null;
    this.status = params.status ?? null;
    this.apiMessage = params.apiMessage ?? "";
    this.retryable = params.retryable ?? isRetryable(params.kind);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  return value as Record<string, unknown>;
}

function errorMessage(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }
  if (typeof error === "object" && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") {
      return message;
    }
  }
  return "";
}

function isTimeoutError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const name = (error as { name?: unknown }).name;
  if (name === "TimeoutError" || name === "AbortError") {
    return true;
  }
  const cause = (error as { cause?: unknown }).cause;
  if (cause && cause !== error && typeof cause === "object") {
    return isTimeoutError(cause);
  }
  return false;
}

function readNumericStatus(
  record: Record<string, unknown> | null,
): number | null {
  if (!record) {
    return null;
  }
  if (typeof record.status === "number" && Number.isFinite(record.status)) {
    return record.status;
  }
  const response = asRecord(record.response);
  if (
    response &&
    typeof response.status === "number" &&
    Number.isFinite(response.status)
  ) {
    return response.status;
  }
  return null;
}

function readProvider(record: Record<string, unknown> | null): string | null {
  if (!record) {
    return null;
  }
  const provider = record.provider;
  return typeof provider === "string" && provider.trim() ? provider : null;
}

function readErrorBodyText(record: Record<string, unknown> | null): string {
  if (!record) {
    return "";
  }
  const nestedError = asRecord(record.error);
  const candidates: unknown[] = [
    record.apiErrorText,
    nestedError?.message,
    record.error,
    record.message,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return "";
}

export function toStructuredError(error: unknown): StructuredProviderError {
  if (error instanceof ProviderApiError) {
    return {
      kind: error.kind,
      provider: error.provider,
      status: error.status,
      message: error.apiMessage,
      retryable: error.retryable,
    };
  }

  if (isTimeoutError(error)) {
    return {
      kind: "network_timeout",
      provider: null,
      status: null,
      message: errorMessage(error),
      retryable: true,
    };
  }

  const record = asRecord(error);
  const status = readNumericStatus(record);
  if (status !== null) {
    const bodyText = readErrorBodyText(record);
    const kind = classifyHttpStatus(status, bodyText);
    return {
      kind,
      provider: readProvider(record),
      status,
      message: bodyText || errorMessage(error),
      retryable: isRetryable(kind),
    };
  }

  if (error instanceof TypeError) {
    return {
      kind: "network_timeout",
      provider: null,
      status: null,
      message: errorMessage(error),
      retryable: true,
    };
  }

  return {
    kind: "unknown",
    provider: readProvider(record),
    status: null,
    message: errorMessage(error),
    retryable: false,
  };
}

export function formatStructuredErrorLine(
  structured: StructuredProviderError,
): string {
  return `PLANABRAIN_ERROR_JSON:${JSON.stringify(structured)}`;
}

function readHttpTimeoutMs(): number {
  const raw = process.env.PLANABRAIN_HTTP_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_HTTP_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_HTTP_TIMEOUT_MS;
  }
  return parsed;
}

export async function fetchWithTimeout(
  url: string | URL,
  init?: RequestInit,
): Promise<Response> {
  const timeoutMs = readHttpTimeoutMs();
  if (timeoutMs <= 0) {
    return fetch(url, init);
  }
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const existingSignal = init?.signal ?? undefined;
  const signal = existingSignal
    ? AbortSignal.any([existingSignal, timeoutSignal])
    : timeoutSignal;
  return fetch(url, { ...init, signal });
}
