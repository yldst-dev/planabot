import { recordUsage } from "../runtime/execution.js";

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

export function readUsage(value: unknown): void {
  const root = record(value);
  const usage = record(root.usage_metadata ?? root.usageMetadata ?? root.usage);
  recordUsage(
    usage.input_tokens ?? usage.prompt_tokens ?? usage.promptTokenCount ?? root.prompt_eval_count,
    usage.output_tokens ?? usage.completion_tokens ?? usage.candidatesTokenCount ?? root.eval_count,
  );
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
