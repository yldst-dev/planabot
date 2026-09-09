import { type Settings } from "../config/settings.js";
import { buildSearchQuery, invokeChatWithMetadata } from "../integrations/chat.js";
import { resolveAuxSettings } from "./auxSettings.js";
import { checkExecution } from "../runtime/execution.js";

export const SEARCH_FOLLOW_UP_MAX_CHARS = 80;

export function isSearchFollowUp(
  previousUserText: string | undefined,
  currentTurnText: string,
): boolean {
  if (!previousUserText) {
    return false;
  }
  const text = normalizeCurrentTurnText(currentTurnText);
  if (!text || text.length > SEARCH_FOLLOW_UP_MAX_CHARS) {
    return false;
  }
  if (!(isCurrentInformationRequest(previousUserText) || isExplicitSearchRequest(previousUserText))) {
    return false;
  }
  if (/^(?:고마워|감사|ㅇㅋ|오케이|알겠어|응$|네$|아니$|ㅎㅎ|ㅋㅋ)/u.test(text)) {
    return false;
  }
  return /그(?:럼|건|거|곳|쪽|게)|이(?:건|거|쪽)|저(?:건|거)|아니[, ]|정정|수정|말한|뜻한|이었|였어|말고|대신|다시|왜|어째서|근거|출처|언제|어디|얼마|맞아|확실/u.test(text);
}

export const QUERY_REWRITE_SYSTEM = [
  "당신은 웹 검색어 생성기입니다.",
  "최근 대화와 마지막 사용자 메시지를 보고, 최신 정보를 찾기 위한 검색어 하나를 만드십시오.",
  "고유명사와 핵심 단어 위주로 짧게 쓰고, 조사와 요청 어미(알아봐줘, 진짜인지 등)는 뺍니다.",
  "마지막 메시지가 앞선 질문의 정정이나 보충이면 앞선 질문의 주제와 합쳐서 검색어를 만듭니다.",
  "출력은 JSON 한 줄만: {\"query\": \"검색어\"}. 검색이 필요 없으면 {\"query\": null}.",
].join("\n");

export async function resolveSearchQuery(
  settings: Settings,
  priorUserTexts: string[],
  currentTurnText: string,
  options: { forceQuery: boolean; },
): Promise<string | undefined> {
  const fallback = buildSearchQuery(currentTurnText);
  if (!settings.searchQueryRewriteEnabled) {
    return fallback;
  }
  const rewritten = await rewriteSearchQuery(settings, priorUserTexts, currentTurnText);
  if (rewritten === undefined) {
    return fallback;
  }
  if (rewritten === null) {
    return options.forceQuery ? fallback : undefined;
  }
  return rewritten;
}

export async function rewriteSearchQuery(
  settings: Settings,
  priorUserTexts: string[],
  currentTurnText: string,
): Promise<string | null | undefined> {
  const recent = priorUserTexts
    .slice(-4)
    .map((text) => `- ${text.replace(/\s+/gu, " ").slice(0, 300)}`);
  const userContent = [
    recent.length > 0 ? `최근 사용자 메시지:\n${recent.join("\n")}` : "최근 사용자 메시지: 없음",
    `마지막 사용자 메시지: ${currentTurnText}`,
  ].join("\n\n");
  try {
    const result = await invokeChatWithMetadata({
      settings: { ...resolveAuxSettings(settings), chatMaxOutputTokens: 120 },
      enableSearchTool: false,
      maxContinuations: 0,
      messages: [
        { role: "system", content: QUERY_REWRITE_SYSTEM },
        { role: "user", content: userContent },
      ],
    });
    return parseRewrittenQuery(result.content);
  } catch (error) {
    checkExecution();
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[planabrain] 검색어 재작성 실패: ${reason}`);
    return undefined;
  }
}

export function parseRewrittenQuery(raw: string): string | null | undefined {
  const match = raw.match(/\{[\s\S]*?\}/u);
  if (!match) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(match[0]) as { query?: unknown; };
    if (parsed.query === null) {
      return null;
    }
    if (typeof parsed.query === "string") {
      const query = parsed.query.replace(/\s+/gu, " ").trim();
      return query.length >= 2 && query.length <= 120 ? query : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export const EXPLICIT_SEARCH_REQUEST_PATTERN =
  /(검색|서치|구글링|찾아\s*(?:봐|줘|주세요|보세요|보자)|알아\s*(?:봐|줘|주세요|보세요|보자)|조사해\s*(?:줘|주세요))/u;

export function isExplicitSearchRequest(currentTurnText: string): boolean {
  const text = normalizeCurrentTurnText(currentTurnText);
  if (!text) {
    return false;
  }
  return EXPLICIT_SEARCH_REQUEST_PATTERN.test(text);
}

export const INFORMATION_REQUEST_FORM_PATTERN =
  /[?？]|알려\s*(?:줘|주세요|다오)|말해\s*(?:줘|주세요)|가르쳐\s*(?:줘|주세요)|찾아\s*(?:줘|봐|주세요)|검색|알아\s*(?:봐|줘)|확인해\s*(?:줘|주세요)|보여\s*(?:줘|주세요)|궁금|얼마(?:야|인가|나|지|였)|어때|어떤가|어떻게\s*(?:돼|되|될|하)|무엇|뭐야|뭔데|뭐\s*있|어디(?:야|에|서|인)|언제(?:야|인|쯤)|누구(?:야|인)|몇\s*(?:시|개|명|퍼|프로|년|월|일)|(?:나요|까요|습니까|ㅂ니까|인가요)/u;

export function isInformationRequestForm(currentTurnText: string): boolean {
  const text = normalizeCurrentTurnText(currentTurnText);
  if (!text) {
    return false;
  }
  return INFORMATION_REQUEST_FORM_PATTERN.test(text);
}

export function isCurrentInformationRequest(currentTurnText: string): boolean {
  const text = normalizeCurrentTurnText(currentTurnText);
  if (!text) {
    return false;
  }
  if (!INFORMATION_REQUEST_FORM_PATTERN.test(text)) {
    return false;
  }
  if (
    /(날씨|기온|강수|습도|미세먼지|대기질|환율|시세|주가|코인|암호화폐|금리|뉴스|속보|물가|가격|재고|운행|항공편|교통|경기\s*(?:결과|일정)|스코어|순위|통계|선거\s*결과)/u.test(
      text,
    )
  ) {
    return true;
  }
  if (
    /(?:오늘|현재|지금|실시간|최신|최근|이번\s*(?:주|달|분기|해)|올해).*(?:날짜|시간|상황|현황|정보|소식|결과|일정)|(?:날짜|시간|상황|현황|정보|소식|결과|일정).*(?:오늘|현재|지금|실시간|최신|최근)/u.test(
      text,
    )
  ) {
    return true;
  }
  return false;
}

export function normalizeCurrentTurnText(input: string): string {
  let value = String(input ?? "").trim();
  const metadataMarker = "사용자 질문:";
  const metadataIndex = value.lastIndexOf(metadataMarker);
  if (metadataIndex >= 0) {
    value = value.slice(metadataIndex + metadataMarker.length).trim();
  }
  if (value.startsWith("TODO 컨텍스트")) {
    const sections = value.split(/\n{2,}/u);
    value = sections.at(-1)?.trim() ?? value;
  }
  const questionMarker = "\n\n질문:\n";
  const questionIndex = value.lastIndexOf(questionMarker);
  if (questionIndex >= 0) {
    value = value.slice(questionIndex + questionMarker.length).trim();
  } else if (value.startsWith("질문:")) {
    value = value.slice("질문:".length).trim();
  }
  return value;
}
