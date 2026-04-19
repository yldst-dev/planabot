import { buildSystemPrompt } from "../config/systemPrompt.js";
import type { Settings } from "../config/settings.js";
import { invokeChat } from "../integrations/gemini/chat.js";

type Params = {
  question: string;
  answer: string;
  settings: Settings;
};

const DEFAULT_DELIVERY_MAX_TOKENS = 1024;

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
    `사실관계, 날짜, 수치, 고유명사, 출처는 유지하십시오.`,
    `반드시 ${deliveryTokenLimit}토큰 이내로 줄이십시오.`,
    `문장 중간에 출처를 끼워 넣지 말고, 출처는 마지막에 한 번만 "출처:" 줄로 정리하십시오.`,
    `메타 설명, 내부 판단, 마크다운, 목록 기호는 금지합니다.`,
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
  text = text.replace(/([^\n])\s*출처:\s*/g, "$1\n\n출처: ");
  text = text.replace(/\n{3,}/g, "\n\n").trim();
  const sourceLines = text
    .split("\n")
    .map((line) => line.trimEnd());
  const sourceIndexes = sourceLines
    .map((line, index) => (line.trimStart().startsWith("출처:") ? index : -1))
    .filter((index) => index >= 0);
  if (sourceIndexes.length <= 1) {
    return sourceLines.join("\n").trim();
  }
  const keepIndex = sourceIndexes[sourceIndexes.length - 1] ?? -1;
  return sourceLines
    .filter((_, index) => !sourceIndexes.includes(index) || index === keepIndex)
    .join("\n")
    .trim();
}

function hasInlineSourceMarker(answer: string): boolean {
  return /[^\n]\s*출처:\s*/.test(answer);
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
