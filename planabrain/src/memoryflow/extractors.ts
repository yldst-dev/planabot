import { randomUUID } from "node:crypto";

import { embedText } from "./embedding.js";
import type { MemoryRole, SemanticFact, Turn } from "./types.js";

interface ScoredTurn {
  role: MemoryRole;
  text: string;
  score: number;
  at: number;
}

export function scoreSalience(text: string): number {
  const input = String(text ?? "").trim();
  if (!input) {
    return 0;
  }

  let score = 0.2;
  if (/(내 이름|my name|나는|i am|i'm|저는)/iu.test(input)) {
    score += 0.25;
  }
  if (/(좋아|싫어|선호|prefer|hate|love|like)/iu.test(input)) {
    score += 0.2;
  }
  if (/(항상|절대|반드시|always|never|must|important)/iu.test(input)) {
    score += 0.15;
  }
  if (/(약속|기억|remember|remind|다음부터|from now on)/iu.test(input)) {
    score += 0.15;
  }
  const len = Array.from(input).length;
  if (len >= 12 && len <= 240) {
    score += 0.1;
  }
  if (/[?？]/u.test(input)) {
    score -= 0.08;
  }

  if (score < 0) {
    return 0;
  }
  if (score > 1) {
    return 1;
  }
  return Number(score.toFixed(4));
}

export function extractSemanticFacts(text: string, at: number): SemanticFact[] {
  const input = String(text ?? "").trim();
  if (!input) {
    return [];
  }

  const facts: SemanticFact[] = [];

  const koName = input.match(/내\s*이름은\s*([^\s.,!?]{1,32})/u);
  if (koName?.[1]) {
    facts.push(buildFact("profile.name", koName[1], input, at, 0.95));
  }

  const enName = input.match(/\bmy\s+name\s+is\s+([a-z0-9_-]{1,32})\b/iu);
  if (enName?.[1]) {
    facts.push(buildFact("profile.name", enName[1], input, at, 0.95));
  }

  collectMulti(
    input,
    /(?:나는|저는)\s*([^\n.!?]{1,80}?)\s*(?:을|를)?\s*(좋아해|좋아합니다|선호해|선호합니다)/gu
  ).forEach((item) => {
    const value = item[1];
    if (value) {
      facts.push(buildFact("preference.like", sanitizeValue(value), input, at, 0.85));
    }
  });

  collectMulti(input, /\bi\s+(?:like|love|prefer)\s+([^.!\n]{1,80})/giu).forEach((item) => {
    const value = item[1];
    if (value) {
      facts.push(buildFact("preference.like", sanitizeValue(value), input, at, 0.85));
    }
  });

  collectMulti(
    input,
    /(?:나는|저는)\s*([^\n.!?]{1,80}?)\s*(?:을|를)?\s*(싫어해|싫어합니다|비선호|안\s*좋아해)/gu
  ).forEach((item) => {
    const value = item[1];
    if (value) {
      facts.push(buildFact("preference.dislike", sanitizeValue(value), input, at, 0.85));
    }
  });

  collectMulti(input, /\bi\s+(?:hate|dislike)\s+([^.!\n]{1,80})/giu).forEach((item) => {
    const value = item[1];
    if (value) {
      facts.push(buildFact("preference.dislike", sanitizeValue(value), input, at, 0.85));
    }
  });

  const koHobby = input.match(/내\s*(?:취미|관심사)는\s*([^\n.!?]{1,80})/u);
  if (koHobby?.[1]) {
    facts.push(buildFact("profile.hobby", sanitizeValue(koHobby[1]), input, at, 0.8));
  }

  const enHobby = input.match(/\bmy\s+hobby\s+is\s+([^.!\n]{1,80})/iu);
  if (enHobby?.[1]) {
    facts.push(buildFact("profile.hobby", sanitizeValue(enHobby[1]), input, at, 0.8));
  }

  return dedupeFacts(facts);
}

export function shouldCreateEpisode(text: string, salience: number): boolean {
  const input = String(text ?? "").trim();
  if (!input) {
    return false;
  }
  if (salience >= 0.45) {
    return true;
  }
  return /(결정|약속|remember|plan|meeting|deadline|중요)/iu.test(input);
}

export function shouldStoreInGroupMemory(text: string, role: MemoryRole): boolean {
  const input = String(text ?? "").trim();
  if (!input) {
    return false;
  }
  if (Array.from(input).length < 8) {
    return false;
  }
  const hasSharedKeyword =
    /(우리|이\s*방|그룹|채널|규칙|정책|합의|공지|일정|회의|project|team|rule|policy|decision|agenda|deadline|todo|task)/iu.test(
      input
    );
  const hasGlobalDirective =
    /(다음부터|반드시|금지|허용|기준|준수|please\s+follow|must|should|do\s+not)/iu.test(input);
  const hasPersonalSignal =
    /(내\s*이름|나는|저는|내가|my\s+name|i\s+am|i'm|i\s+like|i\s+love|i\s+hate|취미|선호|좋아해|싫어해)/iu.test(
      input
    );
  const looksLikeQuestion = /[?？]\s*$/.test(input);

  if (hasPersonalSignal && !hasSharedKeyword) {
    return false;
  }
  if (hasSharedKeyword || hasGlobalDirective) {
    return true;
  }
  if (role === "assistant" && !looksLikeQuestion) {
    return /(요약|정리|기록|summary|noted|notion|memory)/iu.test(input);
  }
  return false;
}

export function summarizeTurns(turns: Turn[]): string {
  const cleaned = turns
    .map((turn) => {
      const text = String(turn.text ?? "").trim().replace(/\s+/g, " ");
      if (!text) {
        return null;
      }
      const scored: ScoredTurn = {
        role: turn.role,
        text,
        score: scoreSalience(text),
        at: turn.at
      };
      return scored;
    })
    .filter(isScoredTurn);

  if (!cleaned.length) {
    return "";
  }

  const picked = cleaned
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return b.at - a.at;
    })
    .slice(0, 4)
    .map((item) => `${item.role === "user" ? "user" : "assistant"}: ${item.text}`);

  return picked.join("\n");
}

function buildFact(
  key: string,
  value: string,
  sourceText: string,
  at: number,
  confidence: number
): SemanticFact {
  const clean = sanitizeValue(value);
  return {
    id: `fact_${at}_${randomUUID().slice(0, 8)}`,
    key,
    value: clean,
    text: `${key}=${clean}`,
    at,
    lastConfirmedAt: at,
    confidence,
    salience: scoreSalience(sourceText),
    embedding: embedText(clean)
  };
}

function sanitizeValue(value: string): string {
  return String(value ?? "")
    .replace(/[\n\r\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function collectMulti(text: string, regex: RegExp): RegExpExecArray[] {
  const out: RegExpExecArray[] = [];
  let match = regex.exec(text);
  while (match) {
    out.push(match);
    match = regex.exec(text);
  }
  return out;
}

function dedupeFacts(facts: SemanticFact[]): SemanticFact[] {
  const seen = new Set<string>();
  const out: SemanticFact[] = [];
  for (const fact of facts) {
    const key = `${fact.key}::${fact.value.toLowerCase()}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(fact);
  }
  return out;
}

function isScoredTurn(value: ScoredTurn | null): value is ScoredTurn {
  return value !== null;
}
