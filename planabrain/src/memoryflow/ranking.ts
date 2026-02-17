import { cosineSimilarity, embedText } from "./embedding.js";
import { estimateTokens } from "./token-estimator.js";
import type {
  ContextBundle,
  EpisodicItem,
  MemoryLayer,
  RankedItem,
  RankedSection,
  SemanticFact,
  SummaryItem,
  Turn
} from "./types.js";

interface RankableItem {
  id: string;
  text: string;
  at: number;
  salience: number;
  embedding: number[];
}

interface BuildContextBundleInput {
  query: string;
  tokenBudget?: number;
  semanticFacts: SemanticFact[];
  episodicItems: EpisodicItem[];
  summaryItems: SummaryItem[];
  workingTurns: Turn[];
  now?: number;
}

interface RankLayerInput {
  layer: MemoryLayer;
  items: RankableItem[];
  queryEmbedding: number[];
  now: number;
  halfLifeMs: number;
  limit: number;
}

interface SectionDraft {
  name: MemoryLayer;
  items: RankedItem[];
}

interface PackByBudgetInput {
  budget: number;
  sections: SectionDraft[];
}

export function buildContextBundle(params: BuildContextBundleInput): ContextBundle {
  const now = params.now ?? Date.now();
  const budget = Math.max(120, params.tokenBudget ?? 900);
  const queryEmbedding = embedText(params.query);

  const semantic = rankLayer({
    layer: "semantic",
    items: params.semanticFacts,
    queryEmbedding,
    now,
    halfLifeMs: 1000 * 60 * 60 * 24 * 45,
    limit: 10
  });

  const episodic = rankLayer({
    layer: "episodic",
    items: params.episodicItems,
    queryEmbedding,
    now,
    halfLifeMs: 1000 * 60 * 60 * 24 * 14,
    limit: 8
  });

  const summary = rankLayer({
    layer: "summary",
    items: params.summaryItems,
    queryEmbedding,
    now,
    halfLifeMs: 1000 * 60 * 60 * 24 * 30,
    limit: 6
  });

  const workingRecent: RankedItem[] = params.workingTurns.slice(-8).map((turn) => ({
    id: turn.id,
    text: `${turn.role}: ${String(turn.text ?? "").trim()}`,
    at: turn.at,
    salience: turn.salience ?? 0.4,
    layer: "working",
    score: 0.65,
    tokens: estimateTokens(turn.text)
  }));

  const packed = packByBudget({
    budget,
    sections: [
      { name: "semantic", items: semantic },
      { name: "episodic", items: episodic },
      { name: "summary", items: summary },
      { name: "working", items: workingRecent }
    ]
  });

  const contextText = renderContextText(packed.sections);

  return {
    tokenBudget: budget,
    estimatedTokens: packed.totalTokens,
    sections: packed.sections,
    contextText
  };
}

function rankLayer(params: RankLayerInput): RankedItem[] {
  const weightByLayer: Record<MemoryLayer, number> = {
    semantic: 1,
    episodic: 0.95,
    summary: 0.88,
    working: 0.8
  };

  return params.items
    .map((item) => {
      const text = String(item.text ?? "").trim();
      if (!text) {
        return null;
      }
      const embedding = Array.isArray(item.embedding) ? item.embedding : embedText(text);
      const sim = cosineSimilarity(params.queryEmbedding, embedding);
      const recency = recencyScore(item.at ?? Date.now(), params.now, params.halfLifeMs);
      const salience = clamp01(item.salience ?? 0.4);
      const layerWeight = weightByLayer[params.layer] ?? 1;
      const score = layerWeight * (0.56 * sim + 0.24 * recency + 0.2 * salience);
      const ranked: RankedItem = {
        id: item.id,
        text,
        at: item.at ?? Date.now(),
        salience,
        layer: params.layer,
        score,
        tokens: estimateTokens(text)
      };
      return ranked;
    })
    .filter(isRankedItem)
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return b.at - a.at;
    })
    .slice(0, params.limit)
    .map((item) => ({
      ...item,
      score: Number(item.score.toFixed(4))
    }));
}

function packByBudget(params: PackByBudgetInput): { sections: RankedSection[]; totalTokens: number } {
  const out: RankedSection[] = [];
  let total = 0;
  const seen = new Set<string>();

  for (const section of params.sections) {
    const picked: RankedItem[] = [];
    for (const item of section.items) {
      const key = normalizeDedupKey(item.text);
      if (!key || seen.has(key)) {
        continue;
      }
      const withOverhead = item.tokens + 8;
      if (total + withOverhead > params.budget) {
        continue;
      }
      seen.add(key);
      total += withOverhead;
      picked.push(item);
    }
    if (picked.length) {
      out.push({ name: section.name, items: picked });
    }
  }

  return {
    sections: out,
    totalTokens: total
  };
}

function renderContextText(sections: RankedSection[]): string {
  if (!sections.length) {
    return "memory_context: none";
  }

  const lines = ["memory_context:"];

  for (const section of sections) {
    lines.push(`${section.name}:`);
    for (const item of section.items) {
      lines.push(`- ${item.text}`);
    }
  }

  return lines.join("\n");
}

function recencyScore(at: number, now: number, halfLifeMs: number): number {
  const age = Math.max(0, now - at);
  const factor = age / Math.max(1, halfLifeMs);
  return Math.pow(0.5, factor);
}

function normalizeDedupKey(text: string): string {
  return String(text ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function clamp01(value: number): number {
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

function isRankedItem(value: RankedItem | null): value is RankedItem {
  return value !== null;
}
