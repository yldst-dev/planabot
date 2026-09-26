import { recordUsage, currentExecution } from "../runtime/execution.js";

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

export function readUsage(value: unknown): void {
  const root = record(value);
  const usage = record(root.usage_metadata ?? root.usageMetadata ?? root.usage);
  recordUsage(
    usage.input_tokens ?? usage.prompt_tokens ?? usage.promptTokenCount ?? root.prompt_eval_count,
    usage.output_tokens ?? usage.completion_tokens ?? usage.candidatesTokenCount ?? root.eval_count,
    record(usage.prompt_tokens_details).cached_tokens ?? usage.cachedContentTokenCount,
    record(usage.completion_tokens_details).reasoning_tokens ?? usage.thoughtsTokenCount,
  );
}

export function recordProviderResponse(value: unknown, provider: string | undefined): void {
  const execution = currentExecution();
  if (!execution) return;
  const root = record(value);
  const label = (value: unknown): string | undefined => typeof value === "string" ? value.replace(/[^a-zA-Z0-9._ /:-]/gu, "").slice(0, 120) : undefined;
  const cost = record(root.usage).cost;
  execution.providerResponses.push({ model: label(root.model), provider: label(provider), ...(typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? { cost } : {}) });
}
