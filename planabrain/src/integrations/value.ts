

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  return value as Record<string, unknown>;
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function stringifyWellFormed(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => (typeof item === "string" ? item.replace(LONE_SURROGATE, "\uFFFD") : item));
}
