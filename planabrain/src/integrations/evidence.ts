import { type WebCitation, type ChatInvocationResult } from "./contracts.js";
import { asRecord } from "./value.js";
import { WebToolPolicy } from "./webToolPolicy.js";

export function parseOpenRouterCitations(value: unknown): WebCitation[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const citations: WebCitation[] = [];
  for (const item of value) {
    const annotation = asRecord(item);
    if (annotation?.type !== "url_citation") {
      continue;
    }
    const nested = asRecord(annotation.url_citation) ?? annotation;
    const url = normalizeCitationUrl(nested.url);
    if (!url) {
      continue;
    }
    const title = normalizeCitationText(nested.title, 300);
    const evidence = normalizeCitationText(
      nested.content ?? nested.text ?? nested.quote,
      4000,
    );
    citations.push({
      url,
      ...(title ? { title } : {}),
      ...(evidence ? { evidence } : {}),
    });
  }
  return mergeWebCitations(citations);
}

export function parseWebSearchCitations(
  results: ReadonlyArray<unknown>,
): WebCitation[] {
  const citations: WebCitation[] = [];
  for (const result of results) {
    const record = asRecord(result);
    const rawItems = record?.results ?? record?.data ?? result;
    const items: unknown[] = Array.isArray(rawItems) ? rawItems : [];
    for (const item of items) {
      const entry = asRecord(item);
      if (!entry) {
        continue;
      }
      const url = normalizeCitationUrl(entry.url);
      if (!url) {
        continue;
      }
      const title = normalizeCitationText(entry.title, 300);
      const evidence = normalizeCitationText(
        entry.content ?? entry.snippet ?? entry.text,
        4000,
      );
      citations.push({
        url,
        ...(title ? { title } : {}),
        ...(evidence ? { evidence } : {}),
      });
    }
  }
  return mergeWebCitations(citations);
}

export function withWebToolCitations(
  result: ChatInvocationResult,
  policy: WebToolPolicy,
): ChatInvocationResult {
  if (!policy.searchExecuted) {
    return result;
  }
  return {
    ...result,
    citations: mergeWebCitations(
      result.citations ?? [],
      parseWebSearchCitations(policy.searchResults),
    ),
    searchUsed: true,
  };
}

export function mergeWebCitations(
  ...groups: ReadonlyArray<ReadonlyArray<WebCitation>>
): WebCitation[] {
  const merged = new Map<string, WebCitation>();
  for (const group of groups) {
    for (const citation of group) {
      const url = normalizeCitationUrl(citation.url);
      if (!url) {
        continue;
      }
      const current = merged.get(url);
      const title = normalizeCitationText(citation.title, 300);
      const evidence = normalizeCitationText(citation.evidence, 4000);
      merged.set(url, {
        url,
        ...((title ?? current?.title) ? { title: title ?? current?.title } : {}),
        ...((evidence ?? current?.evidence)
          ? { evidence: evidence ?? current?.evidence }
          : {}),
      });
    }
  }
  return Array.from(merged.values());
}

export function hasOpenRouterSearchUsage(record: Record<string, unknown> | null): boolean {
  const usage = asRecord(record?.usage);
  const serverToolUse = asRecord(usage?.server_tool_use ?? usage?.serverToolUse);
  const count =
    typeof serverToolUse?.web_search_requests === "number"
      ? serverToolUse.web_search_requests
      : typeof serverToolUse?.webSearchRequests === "number"
        ? serverToolUse.webSearchRequests
        : 0;
  return Number.isFinite(count) && count > 0;
}

export function normalizeCitationUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 4096) {
    return null;
  }
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.username || url.password) {
      return null;
    }
    url.hash = "";
    for (const key of Array.from(url.searchParams.keys())) {
      if (
        /(auth|code|credential|jwt|key|password|secret|session|sig|token)/i.test(
          key,
        )
      ) {
        url.searchParams.delete(key);
      }
    }
    return url.toString();
  } catch {
    return null;
  }
}

export function normalizeCitationText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, maxLength) : undefined;
}
