import {
  ProviderApiError,
  classifyHttpStatus,
  fetchWithTimeout,
  isRetryable,
} from "../providerError.js";

export async function invokeOllamaApi(params: {
  providerName: string;
  host?: string;
  apiKeys: string[];
  path: string;
  payload: Record<string, unknown>;
}): Promise<unknown> {
  if (!params.host) {
    throw new Error(`${params.providerName} host is not configured`);
  }
  if (params.apiKeys.length === 0) {
    throw new Error(`${params.providerName} API key is not configured`);
  }

  let lastError: Error | null = null;
  for (let index = 0; index < params.apiKeys.length; index += 1) {
    try {
      return await invokeOllamaApiOnce({
        providerName: params.providerName,
        host: params.host,
        apiKey: params.apiKeys[index] ?? "",
        path: params.path,
        payload: params.payload,
      });
    } catch (error) {
      if (!(error instanceof OllamaApiError)) {
        throw error;
      }
      lastError = error;
      const hasNextKey = index < params.apiKeys.length - 1;
      if (!hasNextKey || !shouldFallbackToNextApiKey(error)) {
        throw error;
      }
    }
  }

  throw lastError ?? new Error(`${params.providerName} request failed`);
}

async function invokeOllamaApiOnce(params: {
  providerName: string;
  host: string;
  apiKey: string;
  path: string;
  payload: Record<string, unknown>;
}): Promise<unknown> {
  const response = await fetchWithTimeout(`${params.host}${params.path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${params.apiKey}`,
    },
    body: JSON.stringify(params.payload),
  });
  const body = await readJsonOrText(response);
  if (!response.ok) {
    throw new OllamaApiError(
      buildApiErrorMessage(params.providerName, body, response.status),
      response.status,
      extractApiErrorText(body),
      params.providerName,
    );
  }
  return body;
}

class OllamaApiError extends ProviderApiError {
  readonly apiErrorText: string;

  constructor(
    message: string,
    status: number,
    apiErrorText: string,
    provider: string,
  ) {
    const kind = classifyHttpStatus(status, apiErrorText);
    super({
      kind,
      provider,
      status,
      apiMessage: apiErrorText,
      retryable: isRetryable(kind),
      message,
    });
    this.name = "OllamaApiError";
    this.apiErrorText = apiErrorText;
  }
}

function shouldFallbackToNextApiKey(error: OllamaApiError): boolean {
  if (error.status === 429) {
    return true;
  }
  return /(quota|rate limit|too many requests|limit exceeded|quota exceeded)/i.test(
    error.apiErrorText,
  );
}

async function readJsonOrText(response: Response): Promise<unknown> {
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

function buildApiErrorMessage(
  providerName: string,
  body: unknown,
  status: number,
): string {
  const message = extractApiErrorText(body);
  if (message) {
    return `${providerName} API error (${status}): ${message}`;
  }
  return `${providerName} API error (${status})`;
}

function extractApiErrorText(body: unknown): string {
  const record = asRecord(body);
  const errorValue = record?.error;
  if (typeof errorValue === "string" && errorValue.trim()) {
    return errorValue.trim();
  }
  const nestedError = asRecord(errorValue);
  const nestedMessage = nestedError?.message;
  if (typeof nestedMessage === "string" && nestedMessage.trim()) {
    return nestedMessage.trim();
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

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  return value as Record<string, unknown>;
}
