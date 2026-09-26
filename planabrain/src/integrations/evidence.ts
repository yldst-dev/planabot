import { type WebCitation } from "./contracts.js";
import { asRecord } from "./value.js";

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
