import { buildSystemPrompt } from "../config/systemPrompt.js";
import type { Settings } from "../config/settings.js";
import { invokeChat } from "../integrations/gemini/chat.js";

type Params = {
  question: string;
  answer: string;
  settings: Settings;
};

export const DEFAULT_DELIVERY_MAX_TOKENS = 1024;

// 생성/재작성 양쪽에서 공유하는 전송 포맷 규칙(문구 중복 방지)
export function deliveryRuleLines(): string[] {
  return [
    `사실관계, 날짜, 수치, 고유명사, 출처는 유지하십시오.`,
    `문장 중간에 출처를 끼워 넣지 말고, 출처는 마지막에 한 번만 "출처:" 줄로 정리하십시오.`,
    `메타 설명, 내부 판단, 마크다운, 목록 기호는 금지합니다.`,
  ];
}

// 1패스 생성 시 시스템 프롬프트에 주입할 전송 규칙(길이 제약을 생성 단계에서 강제)
export function buildDeliveryGenerationRules(
  deliveryMaxOutputTokens: number | undefined,
): string {
  const limit = deliveryMaxOutputTokens ?? DEFAULT_DELIVERY_MAX_TOKENS;
  return [
    `[전송 형식] 답변은 텔레그램 전송용 최종본입니다.`,
    `반드시 ${limit}토큰(약 ${Math.floor(limit * 0.7)}자) 이내로 작성하십시오.`,
    ...deliveryRuleLines(),
  ].join("\n");
}

export async function finalizeAnswerForDelivery(params: Params): Promise<string> {
  const normalized = normalizeDeliveryText(params.answer);
  if (!params.settings.deliveryRewriteEnabled) {
    return normalized;
  }
  if (!shouldRewriteForDelivery(normalized, params.settings.deliveryMaxOutputTokens)) {
    return normalized;
  }

  const deliveryTokenLimit =
    params.settings.deliveryMaxOutputTokens ?? DEFAULT_DELIVERY_MAX_TOKENS;
  const rewriteSettings: Settings = {
    ...params.settings,
    chatMaxOutputTokens: deliveryTokenLimit,
    chatThinkingMode: "off",
  };
  const rewritePrompt = [
    buildSystemPrompt(params.settings),
    `다음 초안을 텔레그램 전송용 최종 답변으로 다시 작성하십시오.`,
    `반드시 ${deliveryTokenLimit}토큰 이내로 줄이십시오.`,
    ...deliveryRuleLines(),
  ].join("\n");

  try {
    const rewritten = await invokeChat({
      settings: rewriteSettings,
      messages: [
        {
          role: "system",
          content: rewritePrompt,
        },
        {
          role: "user",
          content: [
            `질문:`,
            params.question.trim(),
            ``,
            `초안:`,
            normalized,
          ].join("\n"),
        },
      ],
    });
    const finalText = normalizeDeliveryText(rewritten);
    if (!finalText) {
      return normalized;
    }
    return finalText;
  } catch {
    return normalized;
  }
}

function shouldRewriteForDelivery(
  answer: string,
  deliveryMaxOutputTokens: number | undefined,
): boolean {
  if (!answer.trim()) {
    return false;
  }
  if (hasInlineSourceMarker(answer)) {
    return true;
  }
  if (countSourceMarkers(answer) > 1) {
    return true;
  }
  if (looksAbruptlyTruncated(answer)) {
    return true;
  }
  const maxTokens = deliveryMaxOutputTokens ?? DEFAULT_DELIVERY_MAX_TOKENS;
  return estimateTokenCount(answer) > maxTokens;
}

function normalizeDeliveryText(raw: string): string {
  let text = raw.replace(/\r\n/g, "\n").trim();
  if (!text) {
    return text;
  }
  text = text.replace(/([^\n])[^\S\n]*출처:[^\S\n]*/g, "$1\n\n출처: ");
  text = text.replace(/\n{3,}/g, "\n\n").trim();
  const sourceLines = text
    .split("\n")
    .map((line) => line.trimEnd());
  const sourceIndexes = sourceLines
    .map((line, index) => (line.trimStart().startsWith("출처:") ? index : -1))
    .filter((index) => index >= 0);
  let lines = sourceLines;
  if (sourceIndexes.length > 1) {
    const keepIndex = sourceIndexes[sourceIndexes.length - 1] ?? -1;
    lines = sourceLines.filter(
      (_, index) => !sourceIndexes.includes(index) || index === keepIndex,
    );
  }
  return lines.map(breakIntoSentenceLines).join("\n").trim();
}

function breakIntoSentenceLines(line: string): string {
  const content = line.trimStart();
  if (!content || content.startsWith("출처:") || /https?:\/\//i.test(line)) {
    return line;
  }
  return line
    .replace(/([^\s.!?][.!?]+["'”’)\]]*)[ \t]+(?=\S)/g, "$1\n")
    .replace(/([。！？]+["'”’)\]）」』》]*)[ \t]*(?=\S)/g, "$1\n");
}

function hasInlineSourceMarker(answer: string): boolean {
  // 같은 줄에 본문과 "출처:"가 섞인 경우만 인라인으로 본다(줄바꿈 분리는 정상).
  return /[^\n][^\S\n]*출처:/.test(answer);
}

function countSourceMarkers(answer: string): number {
  return answer.match(/출처:/g)?.length ?? 0;
}

function estimateTokenCount(answer: string): number {
  return Math.ceil(answer.length / 2);
}

function looksAbruptlyTruncated(content: string): boolean {
  const trimmed = content.trim();
  if (trimmed.length < 220) {
    return false;
  }
  if (hasUnbalancedPairs(trimmed)) {
    return true;
  }
  if (/[.!?…][\])}"'”’]*$/.test(trimmed)) {
    return false;
  }
  if (/https?:\/\/\S+$/.test(trimmed)) {
    return false;
  }
  const tail = trimmed.slice(-120);
  if (/[:;,]\s*$/.test(tail)) {
    return true;
  }
  if (/[가-힣A-Za-z0-9]$/.test(trimmed)) {
    return /(?:의|은|는|이|가|을|를|와|과|로|에|에서|에게|부터|까지|이며|또는|그리고|및|후|중|예정|가능|경우|관련)$/.test(
      tail,
    );
  }
  return false;
}

function hasUnbalancedPairs(content: string): boolean {
  const boldMatches = content.match(/\*\*/g)?.length ?? 0;
  if (boldMatches % 2 !== 0) {
    return true;
  }
  const openParens =
    (content.match(/\(/g)?.length ?? 0) - (content.match(/\)/g)?.length ?? 0);
  const openBrackets =
    (content.match(/\[/g)?.length ?? 0) - (content.match(/\]/g)?.length ?? 0);
  return openParens > 0 || openBrackets > 0;
}
