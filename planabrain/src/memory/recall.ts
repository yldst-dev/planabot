import { estimateTokens } from "../runtime/tokens.js";
import { PINNED_KINDS, type MemoryRecord } from "./types.js";

export type MemoryRecall = {
  pinned: MemoryRecord[];
  candidates: MemoryRecord[];
};

const MAX_PINNED = 6;
const MAX_CANDIDATES = 16;
const FALLBACK_LIMIT = 5;
const FALLBACK_MIN_OVERLAP = 0.12;
const RECENCY_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;

export function selectRecall(memories: MemoryRecord[], query: string, now = Date.now()): MemoryRecall {
  const pinned = memories
    .filter((memory) => PINNED_KINDS.includes(memory.kind))
    .sort((a, b) => b.importance - a.importance || b.updatedAt - a.updatedAt)
    .slice(0, MAX_PINNED);
  const pinnedIds = new Set(pinned.map((memory) => memory.id));
  const queryGrams = bigrams(query);
  const candidates = memories
    .filter((memory) => !pinnedIds.has(memory.id))
    .map((memory) => ({ memory, score: priorScore(memory, queryGrams, now) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CANDIDATES)
    .map((entry) => entry.memory);
  return { pinned, candidates };
}

export function fallbackRelevant(candidates: MemoryRecord[], query: string): MemoryRecord[] {
  const queryGrams = bigrams(query);
  return candidates
    .map((memory) => ({ memory, overlap: overlap(queryGrams, bigrams(memory.content)) }))
    .filter((entry) => entry.overlap >= FALLBACK_MIN_OVERLAP)
    .sort((a, b) => b.overlap - a.overlap)
    .slice(0, FALLBACK_LIMIT)
    .map((entry) => entry.memory);
}

export function renderMemoryContext(memories: MemoryRecord[], tokenBudget: number): string | null {
  const personal: string[] = [];
  const room: string[] = [];
  let used = 0;
  for (const memory of memories) {
    const line = `- ${memory.content}`;
    const cost = estimateTokens(line) + 2;
    if (used + cost > tokenBudget) continue;
    used += cost;
    (memory.kind === "room" ? room : personal).push(line);
  }
  if (personal.length === 0 && room.length === 0) return null;
  return [
    ...(personal.length ? ["사용자에 대해 기억하는 내용:", ...personal] : []),
    ...(room.length ? ["이 대화방에 대해 기억하는 내용:", ...room] : []),
  ].join("\n");
}

function priorScore(memory: MemoryRecord, queryGrams: Set<string>, now: number): number {
  const age = Math.max(0, now - Math.max(memory.updatedAt, memory.lastRecalledAt ?? 0));
  const recency = Math.pow(0.5, age / RECENCY_HALF_LIFE_MS);
  return 0.5 * overlap(queryGrams, bigrams(memory.content)) + 0.3 * memory.importance + 0.2 * recency;
}

export function bigrams(text: string): Set<string> {
  const grams = new Set<string>();
  for (const word of text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    const chars = Array.from(word);
    if (chars.length === 1) grams.add(word);
    for (let index = 0; index < chars.length - 1; index += 1) grams.add(chars[index] + chars[index + 1]);
  }
  return grams;
}

function overlap(query: Set<string>, target: Set<string>): number {
  if (query.size === 0 || target.size === 0) return 0;
  let shared = 0;
  for (const gram of query) if (target.has(gram)) shared += 1;
  return (2 * shared) / (query.size + target.size);
}
