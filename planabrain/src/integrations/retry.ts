import { ProviderApiError, toStructuredError } from "./providerError.js";
import { checkExecution, waitForRetry, currentExecution } from "../runtime/execution.js";

export const RATE_LIMIT_MAX_RETRIES = 2;

export const RATE_LIMIT_RETRY_CAP_MS = 8000;

export const RATE_LIMIT_MESSAGE = [
  "선생님.",
  "지금 요청이 한꺼번에 몰려서 처리 용량이 잠시 가득 찼습니다.",
  "조금만 기다렸다가 다시 말씀해 주시겠어요.",
  "금방 정리하고 다시 도와드리겠습니다.",
].join("\n");

export class ProviderRateLimitError extends ProviderApiError {
  constructor(message: string) {
    super({
      kind: "rate_limited",
      status: 429,
      retryable: true,
      message,
    });
    this.name = "ProviderRateLimitError";
  }
}

export async function withRateLimitRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      checkExecution();
      const structured = toStructuredError(error);
      const status = structured.status;
      const execution = currentExecution();
      if (!structured.retryable || (execution && execution.calls >= execution.maxCalls)) {
        throw error;
      }
      if (attempt >= RATE_LIMIT_MAX_RETRIES) {
        if (status === 429) throw new ProviderRateLimitError(RATE_LIMIT_MESSAGE);
        throw error;
      }
      const retryAfterMs = (error as { retryAfterMs?: number; }).retryAfterMs;
      const backoffMs = Math.min(
        retryAfterMs ?? 1000 * 2 ** attempt,
        RATE_LIMIT_RETRY_CAP_MS,
      );
      await waitForRetry(backoffMs);
    }
  }
}
