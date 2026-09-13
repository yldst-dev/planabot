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

export function readGoogleGrounding(value: unknown): {
  citations: Array<{ url: string; title?: string; }>;
  searchUsed: boolean;
} {
  const root = record(value);
  const candidate = record(Array.isArray(root.candidates) ? root.candidates[0] : undefined);
  const metadata = record(root.response_metadata);
  const grounding = record(candidate.groundingMetadata ?? metadata.groundingMetadata ?? root.groundingMetadata);
  const chunks = Array.isArray(grounding.groundingChunks) ? grounding.groundingChunks : [];
  const citations: Array<{ url: string; title?: string; }> = [];
  for (const chunk of chunks) {
    const web = record(record(chunk).web);
    if (typeof web.uri !== "string") continue;
    try {
      const url = new URL(web.uri);
      if (url.protocol !== "https:" || url.username || url.password) continue;
      if (citations.some((citation) => citation.url === url.toString())) continue;
      citations.push({ url: url.toString(), ...(typeof web.title === "string" ? { title: web.title } : {}) });
    } catch {
      continue;
    }
  }
  return {
    citations,
    searchUsed: citations.length > 0 || (Array.isArray(grounding.webSearchQueries) && grounding.webSearchQueries.length > 0),
  };
}
