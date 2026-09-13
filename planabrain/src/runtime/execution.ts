import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

export type ExecutionOptions = {
  requestId?: string;
  signal?: AbortSignal;
  deadlineMs?: number;
  maxCalls?: number;
  maxTools?: number;
};

export type Execution = {
  requestId: string;
  signal: AbortSignal;
  deadlineMs: number;
  calls: number;
  tools: number;
  inputTokens: number;
  outputTokens: number;
  usageReports: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  providerResponses: Array<{ model?: string; provider?: string; cost?: number; }>;
  maxCalls: number;
  maxTools: number;
};

const executions = new AsyncLocalStorage<Execution>();

export class ExecutionLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionLimitError";
  }
}

export function currentExecution(): Execution | undefined {
  return executions.getStore();
}

export function checkExecution(): void {
  const execution = currentExecution();
  execution?.signal.throwIfAborted();
  if (execution && Date.now() >= execution.deadlineMs) {
    throw new DOMException("요청 처리 시간이 초과되었습니다.", "TimeoutError");
  }
}

export async function runExecution<T>(
  operation: string,
  work: () => Promise<T>,
  options: ExecutionOptions = {},
): Promise<T> {
  if (currentExecution()) {
    checkExecution();
    return work();
  }
  const startedAt = Date.now();
  const deadlineMs = Math.min(options.deadlineMs ?? startedAt + 175_000, startedAt + 175_000);
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException("요청 처리 시간이 초과되었습니다.", "TimeoutError")),
    Math.max(1, deadlineMs - startedAt),
  );
  timer.unref();
  const signal = options.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal;
  const execution: Execution = {
    requestId: options.requestId ?? randomUUID(),
    signal,
    deadlineMs,
    calls: 0,
    tools: 0,
    inputTokens: 0,
    outputTokens: 0,
    usageReports: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    providerResponses: [],
    maxCalls: options.maxCalls ?? 12,
    maxTools: options.maxTools ?? 8,
  };
  let outcome = "error";
  try {
    return await executions.run(execution, async () => {
      checkExecution();
      const result = await abortable(work(), signal);
      checkExecution();
      outcome = "ok";
      return result;
    });
  } finally {
    clearTimeout(timer);
    console.error(JSON.stringify({
      event: "execution",
      operation,
      requestId: execution.requestId,
      durationMs: Date.now() - startedAt,
      outcome: signal.aborted ? "cancelled" : outcome,
      calls: execution.calls,
      tools: execution.tools,
      inputTokens: execution.inputTokens,
      outputTokens: execution.outputTokens,
      usageReports: execution.usageReports,
      cachedInputTokens: execution.cachedInputTokens,
      reasoningTokens: execution.reasoningTokens,
      providerResponses: execution.providerResponses,
    }));
  }
}

export function consumeCall(): void {
  checkExecution();
  const execution = currentExecution();
  if (!execution) return;
  if (execution.calls >= execution.maxCalls) {
    throw new ExecutionLimitError("모델 호출 한도에 도달했습니다.");
  }
  execution.calls += 1;
}

export function consumeTool(): boolean {
  checkExecution();
  const execution = currentExecution();
  if (!execution) return true;
  if (execution.tools >= execution.maxTools) return false;
  execution.tools += 1;
  return true;
}

export function recordUsage(inputTokens: unknown, outputTokens: unknown, cachedInputTokens?: unknown, reasoningTokens?: unknown): void {
  const execution = currentExecution();
  if (!execution) return;
  let reported = false;
  if (typeof inputTokens === "number" && Number.isFinite(inputTokens) && inputTokens >= 0) {
    execution.inputTokens += inputTokens;
    reported = true;
  }
  if (typeof outputTokens === "number" && Number.isFinite(outputTokens) && outputTokens >= 0) {
    execution.outputTokens += outputTokens;
    reported = true;
  }
  if (typeof cachedInputTokens === "number" && Number.isFinite(cachedInputTokens) && cachedInputTokens >= 0) execution.cachedInputTokens += cachedInputTokens;
  if (typeof reasoningTokens === "number" && Number.isFinite(reasoningTokens) && reasoningTokens >= 0) execution.reasoningTokens += reasoningTokens;
  if (reported) execution.usageReports += 1;
}

export async function waitForRetry(ms: number): Promise<void> {
  checkExecution();
  await delay(ms, undefined, { signal: currentExecution()?.signal });
}

export async function abortable<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  let cancel: () => void = () => { };
  const aborted = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(signal.reason ?? new DOMException("요청이 취소되었습니다.", "AbortError"));
    if (signal.aborted) cancel(); else signal.addEventListener("abort", cancel, { once: true });
  });
  try { return await Promise.race([work, aborted]); } finally { signal.removeEventListener("abort", cancel); }
}

export async function measureStage<T>(stage: string, work: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  let outcome = "error";
  try {
    checkExecution();
    const result = await work();
    checkExecution();
    outcome = "ok";
    return result;
  } finally {
    const execution = currentExecution();
    if (execution) console.error(JSON.stringify({ event: "stage", requestId: execution.requestId, stage, outcome, durationMs: Date.now() - startedAt }));
  }
}
