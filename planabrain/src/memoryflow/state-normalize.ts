import { randomUUID } from "node:crypto";

import { embedText } from "./embedding.js";
import { scoreSalience } from "./extractors.js";
import { estimateTokens } from "./token-estimator.js";
import type {
  EpisodicStore,
  IngestTurnInput,
  MemoryState,
  MemoryVisibility,
  SemanticStore,
  ScopeKind,
  SummaryStore,
  Turn,
  WorkingStore
} from "./types.js";

export function createEmptyState(): MemoryState {
  return {
    working: {
      version: 1,
      turns: []
    },
    episodic: {
      version: 1,
      items: []
    },
    semantic: {
      version: 1,
      facts: []
    },
    summary: {
      version: 1,
      items: []
    }
  };
}

export function normalizeState(input: unknown): MemoryState {
  const root = asObject(input);
  return {
    working: normalizeWorking(root.working),
    episodic: normalizeEpisodic(root.episodic),
    semantic: normalizeSemantic(root.semantic),
    summary: normalizeSummary(root.summary)
  };
}

function normalizeRole(raw: IngestTurnInput["role"]): "user" | "assistant" {
  const role = String(raw ?? "user").toLowerCase();
  return role === "assistant" || role === "ai" ? "assistant" : "user";
}

function normalizeWorking(input: unknown): WorkingStore {
  const turnsRaw = getArray((input as Record<string, unknown> | null)?.turns);
  const turns = turnsRaw
    .map((turnRaw) => {
      const turn = asObject(turnRaw);
      const text = String(turn.text ?? "").trim();
      if (!text) {
        return null;
      }
      const at = toNumber(turn.at, Date.now());
      const normalizedTurn: Turn = {
        id: String(turn.id ?? `turn_${Date.now()}_${randomUUID().slice(0, 8)}`),
        role: normalizeRole(String(turn.role ?? "user") as IngestTurnInput["role"]),
        text,
        at,
        tokens: toNumber(turn.tokens, estimateTokens(text)),
        salience: toNumber(turn.salience, scoreSalience(text)),
        ownerUserId: normalizeOwnerUserId(turn.ownerUserId)
      };
      return normalizedTurn;
    })
    .filter(isTurn);

  return {
    version: 1,
    turns
  };
}

function normalizeEpisodic(input: unknown): EpisodicStore {
  const itemsRaw = getArray((input as Record<string, unknown> | null)?.items);
  const items = itemsRaw
    .map((itemRaw) => {
      const item = asObject(itemRaw);
      const text = String(item.text ?? "").trim();
      if (!text) {
        return null;
      }
      return {
        id: String(item.id ?? `epi_${Date.now()}_${randomUUID().slice(0, 8)}`),
        text,
        at: toNumber(item.at, Date.now()),
        salience: toNumber(item.salience, scoreSalience(text)),
        embedding: asNumberArray(item.embedding, embedText(text))
      };
    })
    .filter(isRecord);

  return {
    version: 1,
    items
  };
}

function normalizeSemantic(input: unknown): SemanticStore {
  const factsRaw = getArray((input as Record<string, unknown> | null)?.facts);
  const facts = factsRaw
    .map((factRaw) => {
      const fact = asObject(factRaw);
      const key = String(fact.key ?? "").trim();
      const value = String(fact.value ?? "").trim();
      if (!key || !value) {
        return null;
      }
      const text = String(fact.text ?? `${key}=${value}`).trim();
      const at = toNumber(fact.at, Date.now());
      return {
        id: String(fact.id ?? `fact_${Date.now()}_${randomUUID().slice(0, 8)}`),
        key,
        value,
        text,
        at,
        lastConfirmedAt: toNumber(fact.lastConfirmedAt, at),
        confidence: toNumber(fact.confidence, 0.6),
        salience: toNumber(fact.salience, scoreSalience(text)),
        embedding: asNumberArray(fact.embedding, embedText(value || text)),
        sourceTurnId: String(fact.sourceTurnId ?? "").trim(),
        createdByUserId: normalizeOwnerUserId(fact.createdByUserId),
        visibility: normalizeVisibility(fact.visibility),
        scopeKind: normalizeScopeKind(fact.scopeKind)
      };
    })
    .filter(isRecord);

  return {
    version: 1,
    facts
  };
}

function normalizeSummary(input: unknown): SummaryStore {
  const itemsRaw = getArray((input as Record<string, unknown> | null)?.items);
  const items = itemsRaw
    .map((itemRaw) => {
      const item = asObject(itemRaw);
      const text = String(item.text ?? "").trim();
      if (!text) {
        return null;
      }
      return {
        id: String(item.id ?? `sum_${Date.now()}_${randomUUID().slice(0, 8)}`),
        text,
        fromTurnId: String(item.fromTurnId ?? ""),
        toTurnId: String(item.toTurnId ?? ""),
        at: toNumber(item.at, Date.now()),
        salience: toNumber(item.salience, scoreSalience(text)),
        embedding: asNumberArray(item.embedding, embedText(text))
      };
    })
    .filter(isRecord);

  return {
    version: 1,
    items
  };
}

function getArray(input: unknown): unknown[] {
  return Array.isArray(input) ? input : [];
}

function asObject(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object") {
    return {};
  }
  return input as Record<string, unknown>;
}

function toNumber(input: unknown, fallback: number): number {
  const parsed = Number(input);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return parsed;
}

function asNumberArray(input: unknown, fallback: number[]): number[] {
  if (!Array.isArray(input)) {
    return fallback;
  }
  const out = input
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));
  if (!out.length) {
    return fallback;
  }
  return out;
}

function normalizeOwnerUserId(input: unknown): string | undefined {
  const value = String(input ?? "").trim();
  return value ? value : undefined;
}

function normalizeVisibility(input: unknown): MemoryVisibility {
  const value = String(input ?? "").trim().toLowerCase();
  if (value === "conversation") {
    return "conversation";
  }
  if (value === "shared") {
    return "shared";
  }
  return "private";
}

function normalizeScopeKind(input: unknown): ScopeKind {
  const value = String(input ?? "").trim().toLowerCase();
  if (value === "conversation") {
    return "conversation";
  }
  if (value === "group") {
    return "group";
  }
  return "user";
}

function isRecord<T extends object>(value: T | null): value is T {
  return value !== null;
}

function isTurn(value: Turn | null): value is Turn {
  return value !== null;
}
