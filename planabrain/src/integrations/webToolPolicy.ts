import { extractUrls, parseWebFetchUrl } from "./webFetch.js";

const MAX_MODEL_WEB_TOOL_CALLS = 8;
const MAX_ALLOWED_WEB_FETCH_URLS = 32;

export class WebToolPolicy {
  private readonly allowedFetchUrls = new Set<string>();
  private executedToolCalls = 0;

  constructor(currentUserContent: string) {
    this.addAllowedUrls(currentUserContent);
  }

  tryStartToolCall(): boolean {
    if (this.executedToolCalls >= MAX_MODEL_WEB_TOOL_CALLS) {
      return false;
    }
    this.executedToolCalls += 1;
    return true;
  }

  addSearchResult(value: unknown): void {
    this.addAllowedUrls(value);
  }

  allowsFetch(rawUrl: string): boolean {
    try {
      return this.allowedFetchUrls.has(parseWebFetchUrl(rawUrl).toString());
    } catch {
      return false;
    }
  }

  get allowedUrlCount(): number {
    return this.allowedFetchUrls.size;
  }

  private addAllowedUrls(value: unknown, depth = 0): void {
    if (
      depth > 5 ||
      this.allowedFetchUrls.size >= MAX_ALLOWED_WEB_FETCH_URLS
    ) {
      return;
    }
    if (typeof value === "string") {
      const remaining = MAX_ALLOWED_WEB_FETCH_URLS - this.allowedFetchUrls.size;
      for (const url of extractUrls(value, remaining)) {
        try {
          this.allowedFetchUrls.add(parseWebFetchUrl(url).toString());
        } catch {
          continue;
        }
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        this.addAllowedUrls(item, depth + 1);
      }
      return;
    }
    if (typeof value !== "object" || value === null) {
      return;
    }
    for (const nested of Object.values(value as Record<string, unknown>)) {
      this.addAllowedUrls(nested, depth + 1);
    }
  }
}
