import { buildSystemPrompt } from "../config/systemPrompt.js";
import type { Settings } from "../config/settings.js";
import { invokeChat } from "../integrations/gemini/chat.js";

type Params = {
  question: string;
  answer: string;
  settings: Settings;
  verifiedCitationUrls?: string[];
};

export const DEFAULT_DELIVERY_MAX_TOKENS = 1024;
const MAX_VERIFIED_CITATIONS = 5;
const MAX_VERIFIED_SOURCE_CHARS = 1500;

export function deliveryRuleLines(): string[] {
  return [
    `사실관계, 날짜, 수치, 고유명사는 유지하십시오.`,
    `출처는 애플리케이션이 추가하므로 출처 줄이나 URL을 작성하지 마십시오.`,
    `메타 설명, 내부 판단, 마크다운, 목록 기호는 금지합니다.`,
  ];
}

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
  const normalized = normalizeDeliveryText(removeModelSourceLines(params.answer));
  const verifiedCitationUrls = normalizeVerifiedCitationUrls(
    params.verifiedCitationUrls,
  );
  if (verifiedCitationUrls.length > 0) {
    return appendVerifiedSources(normalized, verifiedCitationUrls);
  }
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
    const finalText = normalizeDeliveryText(removeModelSourceLines(rewritten));
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
  text = text.replace(/\n{3,}/g, "\n\n").trim();
  return text.split("\n").map(breakIntoSentenceLines).join("\n").trim();
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

export function removeModelSourceLines(input: string): string {
  return input
    .split(/\r?\n/u)
    .map((line) => {
      const source = line.match(/(?:출처|sources?):/iu);
      if (source?.index !== undefined) {
        const prefix = line.slice(0, source.index).trimEnd();
        return /^[\s>*\-•]*$/u.test(prefix) ? "" : prefix;
      }
      const trimmed = line.trim();
      if (
        /^(?:https?:\/\/\S+)(?:\s*,\s*https?:\/\/\S+)*$/iu.test(trimmed) ||
        /^(?:\[[^\]]+\]\(https?:\/\/[^)]+\))(?:\s*,\s*\[[^\]]+\]\(https?:\/\/[^)]+\))*$/iu.test(
          trimmed,
        )
      ) {
        return "";
      }
      return line;
    })
    .join("\n")
    .trim();
}

function appendVerifiedSources(answer: string, urls: string[]): string {
  const sourceLine = `출처: ${urls.join(", ")}`;
  return answer ? `${answer}\n\n${sourceLine}` : sourceLine;
}

function normalizeVerifiedCitationUrls(urls: string[] | undefined): string[] {
  const verified = new Set<string>();
  let totalChars = 0;
  for (const value of urls ?? []) {
    if (verified.size >= MAX_VERIFIED_CITATIONS) {
      break;
    }
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password) {
        continue;
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
      const normalized = url.toString();
      if (verified.has(normalized)) {
        continue;
      }
      if (totalChars + normalized.length > MAX_VERIFIED_SOURCE_CHARS) {
        continue;
      }
      verified.add(normalized);
      totalChars += normalized.length;
    } catch {
      continue;
    }
  }
  return Array.from(verified);
}
