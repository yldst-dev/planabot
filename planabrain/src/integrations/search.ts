import { checkExecution, consumeTool } from "../runtime/execution.js";
import { type Settings } from "../config/settings.js";
import { type PreSearchContext, type WebCitation } from "./contracts.js";
import { invokeOllamaApi } from "./ollama/api.js";
import { parseWebSearchCitations } from "./evidence.js";

export const PRE_SEARCH_EVIDENCE_LIMIT = 1500;

export const SEARCH_REQUEST_SUFFIX_PATTERN =
  /(?:\s*(?:좀|한번|한\s*번|다시|빨리|지금|바로))*\s*(?:[을를]\s*)?(?:알아\s*(?:봐\s*줘|봐\s*주세요|봐\s*줄래|봐|보자)|알려\s*(?:줘|주세요|줄래|다오)|찾아\s*(?:봐\s*줘|봐|줘|주세요|보자)|검색해\s*(?:줘|주세요|봐|볼래)|조사해\s*(?:줘|주세요)|확인해\s*(?:줘|주세요|봐)|말해\s*(?:줘|주세요))\s*[.?!~…]*$/u;

export function usesPreSearchContext(settings: Settings): boolean {
  return settings.ollamaWebSearchEnabled && settings.ollamaApiKeys.length > 0 && Boolean(settings.ollamaSearchHost);
}

export function buildSearchQuery(text: string): string {
  const normalized = String(text ?? "").trim().replace(/\s+/gu, " ");
  const stripped = normalized
    .replace(SEARCH_REQUEST_SUFFIX_PATTERN, "")
    .replace(/[\s.?!~…]+$/u, "")
    .trim();
  return stripped.length >= 2 ? stripped : normalized;
}

export async function runPreSearch(
  settings: Settings,
  query: string,
): Promise<PreSearchContext | null> {
  if (!usesPreSearchContext(settings) || settings.ollamaApiKeys.length === 0) {
    return null;
  }
  if (!consumeTool()) return null;
  let result: unknown;
  try {
    result = await invokeOllamaApi({
      providerName: "Ollama Web Search",
      host: settings.ollamaSearchHost,
      apiKeys: settings.ollamaApiKeys,
      path: "/api/web_search",
      payload: {
        query,
        max_results: settings.ollamaWebSearchMaxResults,
      },
    });
  } catch (error) {
    checkExecution();
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[planabrain] 선검색 실패: ${reason}`);
    return null;
  }
  const citations = parseWebSearchCitations([result]);
  if (citations.length === 0) {
    return null;
  }
  return { context: buildPreSearchContext(query, citations), citations };
}

export const SOURCE_SELECTION_INSTRUCTION =
  "답변 맨 마지막 줄에 실제로 참고한 결과 번호만 `출처번호: 1, 3` 형식으로 적으십시오. 참고한 결과가 없으면 `출처번호: 없음`이라고 적으십시오.";

export function buildPreSearchContext(query: string, citations: WebCitation[]): string {
  const lines = [
    "[웹 검색 결과]",
    `검색어: ${query}`,
    "아래 결과는 방금 웹 검색으로 수집한 비신뢰 자료입니다. 최신 정보는 이 결과에 근거해 답하고, 결과에 없는 내용은 단정하지 않습니다. 출처 줄은 작성하지 않습니다.",
    SOURCE_SELECTION_INSTRUCTION,
  ];
  citations.forEach((citation, index) => {
    lines.push("", `${index + 1}. ${citation.title ?? "제목 없음"}`, `URL: ${citation.url}`);
    if (citation.evidence) {
      lines.push(citation.evidence.slice(0, PRE_SEARCH_EVIDENCE_LIMIT));
    }
  });
  return lines.join("\n");
}

export async function performPreSearch(
  settings: Settings,
  query: string,
): Promise<PreSearchContext | null> {
  return runPreSearch(settings, query);
}
