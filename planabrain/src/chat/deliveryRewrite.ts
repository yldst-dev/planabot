import { checkExecution } from "../runtime/execution.js";
import { buildSystemPrompt } from "../config/systemPrompt.js";
import type { Settings } from "../config/settings.js";
import { invokeChat, normalizeCitationUrl } from "../integrations/chat.js";
import { estimateTokenCount } from "tokenx";
import { looksAbruptlyTruncated, isLengthLimitedFinishReason } from "../integrations/continuation.js";
import { resolveAuxSettings } from "./auxSettings.js";

export type VerifiedCitation = {
  url: string;
  title?: string;
};

type Params = {
  question: string;
  answer: string;
  settings: Settings;
  verifiedCitations?: VerifiedCitation[];
  finishReason?: string;
};

export const DEFAULT_DELIVERY_MAX_TOKENS = 1024;
const MAX_VERIFIED_CITATIONS = 5;
const MAX_VERIFIED_SOURCE_CHARS = 1500;
const MAX_VERIFIED_LABEL_CHARS = 40;

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
    `답변은 ${limit}토큰 이내로 완결하십시오. 짧은 인사나 잡담에는 이 길이를 채우지 마십시오.`,
    ...deliveryRuleLines(),
  ].join("\n");
}

export async function finalizeAnswerForDelivery(params: Params): Promise<string> {
  const normalized = normalizeDeliveryText(removeModelSourceLines(params.answer));
  const verifiedCitations = normalizeVerifiedCitations(params.verifiedCitations);
  if (verifiedCitations.length > 0) {
    return appendVerifiedSources(normalized, verifiedCitations);
  }
  if (!params.settings.deliveryRewriteEnabled) {
    return normalized;
  }
  if (!isLengthLimitedFinishReason(params.finishReason) && !shouldRewriteForDelivery(normalized, params.settings.deliveryMaxOutputTokens)) {
    return normalized;
  }

  const deliveryTokenLimit =
    params.settings.deliveryMaxOutputTokens ?? DEFAULT_DELIVERY_MAX_TOKENS;
  const rewriteSettings = resolveAuxSettings(params.settings);
  const rewritePrompt = [
    buildSystemPrompt(params.settings),
    `다음 초안을 텔레그램 전송용 최종 답변으로 다시 작성하십시오.`,
    `반드시 ${deliveryTokenLimit}토큰 이내로 줄이십시오.`,
    ...deliveryRuleLines(),
  ].join("\n");

  try {
    const rewritten = await invokeChat({
      settings: rewriteSettings,
      maxContinuations: 0,
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
    if (!finalText || !preservesLiteralFacts(normalized, finalText)) {
      return normalized;
    }
    return finalText;
  } catch {
    checkExecution();
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

export function normalizeDeliveryText(raw: string): string {
  let text = raw.replace(/\r\n/g, "\n").trim();
  if (!text) {
    return text;
  }
  text = text.replace(/\n{3,}/g, "\n\n").trim();
  const lines = text.split("\n");
  const fenced = closedFenceLines(lines);
  return lines.map((line, index) => (fenced[index] ? line : breakIntoSentenceLines(line))).join("\n").trim();
}

function closedFenceLines(lines: string[]): boolean[] {
  const inside = lines.map(() => false);
  let open = -1;
  lines.forEach((line, index) => {
    if (!/^\s*```/u.test(line) || /^\s*```.*```\s*$/u.test(line)) return;
    if (open < 0) {
      open = index;
      return;
    }
    inside.fill(true, open, index + 1);
    open = -1;
  });
  return inside;
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

const INLINE_SOURCE_LABEL = String.raw`(?<![\p{L}\p{N}_])(?:출처|Sources?):`;
const INLINE_SOURCE_LINK = String.raw`(?:https?:\/\/[^\s,]+|\[[^\]]*\]\(https?:\/\/[^)\s]+\))`;
const INLINE_SOURCE_PATTERNS = [
  /(?<!\s)\s*\((?:출처|Sources?):(?:[^()]|\([^()]*\))*\)/gu,
  new RegExp(String.raw`(?<!\s)\s*${INLINE_SOURCE_LABEL}\s*${INLINE_SOURCE_LINK}(?:\s*,\s*${INLINE_SOURCE_LINK})*`, "gu"),
  new RegExp(String.raw`(?<=[.!?。…)\]])\s*${INLINE_SOURCE_LABEL}.*?(?:[.!?。](?=\s)|$)`, "gu"),
];

export function removeModelSourceLines(input: string): string {
  const lines = input.split(/\r?\n/u);
  const fenced = closedFenceLines(lines);
  return lines
    .map((line, index) => {
      if (fenced[index]) return line;
      const source = line.match(/(?<![\p{L}\p{N}_])(?:출처|sources?):/iu);
      if (source?.index !== undefined && /^[\s>*\-•]*$/u.test(line.slice(0, source.index))) return "";
      const trimmed = line.trim();
      if (
        /^https?:\/\/\S+(?:(?:\s+,\s*|,\s+)https?:\/\/\S+)*$/iu.test(trimmed) ||
        /^(?:\[[^\]]+\]\(https?:\/\/[^)]+\))(?:\s*,\s*\[[^\]]+\]\(https?:\/\/[^)]+\))*$/iu.test(
          trimmed,
        )
      ) {
        return "";
      }
      return INLINE_SOURCE_PATTERNS.reduce((text, pattern) => text.replace(pattern, ""), line);
    })
    .join("\n")
    .trim();
}

function appendVerifiedSources(answer: string, entries: string[]): string {
  const sourceLine = `출처: ${entries.join(", ")}`;
  return answer ? `${answer}\n\n${sourceLine}` : sourceLine;
}

export function sanitizeCitationLabel(raw: string | undefined): string {
  const cleaned = String(raw ?? "")
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/[[\]()]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (cleaned.length <= MAX_VERIFIED_LABEL_CHARS) {
    return cleaned;
  }
  let end = MAX_VERIFIED_LABEL_CHARS;
  const code = cleaned.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) {
    end -= 1;
  }
  return cleaned.slice(0, end).trim();
}

function buildCitationLabel(
  title: string | undefined,
  url: URL,
  position: number,
): string {
  const fromTitle = sanitizeCitationLabel(title);
  if (fromTitle) {
    return fromTitle;
  }
  const fromHost = sanitizeCitationLabel(url.hostname.replace(/^www\./iu, ""));
  if (fromHost) {
    return fromHost;
  }
  return `링크${position}`;
}

function normalizeVerifiedCitations(
  citations: VerifiedCitation[] | undefined,
): string[] {
  const seen = new Set<string>();
  const entries: string[] = [];
  let totalChars = 0;
  for (const citation of citations ?? []) {
    if (entries.length >= MAX_VERIFIED_CITATIONS) {
      break;
    }
    const normalized = normalizeCitationUrl(citation.url);
    if (!normalized || normalized.includes(")") || seen.has(normalized)) {
      continue;
    }
    const label = buildCitationLabel(citation.title, new URL(normalized), entries.length + 1);
    const entry = `[${label}](${normalized})`;
    if (totalChars + entry.length > MAX_VERIFIED_SOURCE_CHARS) {
      continue;
    }
    seen.add(normalized);
    entries.push(entry);
    totalChars += entry.length;
  }
  return entries;
}

export function preservesLiteralFacts(original: string, rewritten: string): boolean {
  const numbers = (text: string): string[] => [...new Set(text.match(/\d+(?:[.,:/×x-]\d+)*/gu) ?? [])].sort();
  const negative = (text: string): boolean => /않|아니|없|불가|미완료|취소/gu.test(text);
  return JSON.stringify(numbers(original)) === JSON.stringify(numbers(rewritten)) && negative(original) === negative(rewritten);
}
