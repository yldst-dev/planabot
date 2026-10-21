import { type WebCitation } from "../integrations/chat.js";
import { bigrams } from "../memory/recall.js";

export const MAX_FALLBACK_CITATIONS = 3;

const MIN_SHARED_BIGRAMS = 3;

export const SOURCE_SELECTION_LINE = /^(.*?)(?<!\s)\s*출처\s*번호\s*[:：]\s*(.*\S|\s)\s*$/u;

export function applySourceSelection(
  content: string,
  citations: WebCitation[],
): { content: string; citations: WebCitation[]; selection: "none" | "picked" | "unmarked"; } {
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
    if (match[1].trim()) {
      kept.push(match[1].trimEnd());
    }
    const body = match[2].trim();
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
    return { content: cleaned, citations: [], selection: "none" };
  }
  if (selectedIndexes && selectedIndexes.length > 0) {
    return {
      content: cleaned,
      citations: selectedIndexes.map((n) => citations[n - 1]),
      selection: "picked",
    };
  }
  return { content: cleaned, citations: relevantCitations(cleaned, citations), selection: "unmarked" };
}

function relevantCitations(answer: string, citations: WebCitation[]): WebCitation[] {
  const answerGrams = bigrams(answer);
  return citations
    .filter((citation) => {
      const sourceGrams = bigrams(`${citation.title ?? ""} ${citation.evidence ?? ""}`);
      let shared = 0;
      for (const gram of sourceGrams) {
        if (answerGrams.has(gram)) shared += 1;
        if (shared >= MIN_SHARED_BIGRAMS) return true;
      }
      return false;
    })
    .slice(0, MAX_FALLBACK_CITATIONS);
}
