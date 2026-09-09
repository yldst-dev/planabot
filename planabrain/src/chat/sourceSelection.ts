import { type WebCitation } from "../integrations/chat.js";

export const MAX_FALLBACK_CITATIONS = 3;

export const SOURCE_SELECTION_LINE = /^\s*출처\s*번호\s*[:：]\s*(.+?)\s*$/u;

export function applySourceSelection(
  content: string,
  citations: WebCitation[],
): { content: string; citations: WebCitation[]; } {
  const lines = content.split("\n");
  let selectedIndexes: number[] | null = null;
  let none = false;
  const kept: string[] = [];
  for (const line of lines) {
    const match = SOURCE_SELECTION_LINE.exec(line);
    if (!match) {
      kept.push(line);
      continue;
    }
    const body = match[1].trim();
    if (/없음|none/iu.test(body)) {
      none = true;
      continue;
    }
    const numbers = Array.from(body.matchAll(/\d+/gu), (m) => Number(m[0]))
      .filter((n) => Number.isFinite(n) && n >= 1 && n <= citations.length);
    selectedIndexes = Array.from(new Set(numbers));
  }
  const cleaned = kept.join("\n").replace(/\n{3,}/gu, "\n\n").trim();
  if (none) {
    return { content: cleaned, citations: [] };
  }
  if (selectedIndexes && selectedIndexes.length > 0) {
    return {
      content: cleaned,
      citations: selectedIndexes.map((n) => citations[n - 1]),
    };
  }
  return { content: cleaned, citations: citations.slice(0, MAX_FALLBACK_CITATIONS) };
}
