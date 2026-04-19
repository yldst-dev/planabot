import { randomUUID } from "node:crypto";

import { buildCompactedSummary, buildFallbackCompactedSummary } from "./compaction.js";
import { cosineSimilarity, embedText } from "./embedding.js";
import {
  extractSemanticFacts,
  scoreSalience,
  shouldCreateEpisode,
  shouldStoreInGroupMemory,
  summarizeTurns
} from "./extractors.js";
import { createMemoryStore } from "./memory-store.js";
import { buildContextBundle } from "./ranking.js";
import { createEmptyState, normalizeState } from "./state-normalize.js";
import { buildScopeDescriptor, buildScopeId, safeId } from "./storage.js";
import { estimateTokens } from "./token-estimator.js";
import { loadConfig } from "./config.js";
import type {
  ContextBundle,
  EngineConfig,
  MemoryRole,
  MemoryState,
  MemoryStore,
  PreparePromptInput,
  RememberAssistantInput,
  RetrieveContextInput,
  ScopeDescriptor,
  ScopeParams,
  SemanticFact,
  Turn
} from "./types.js";

interface IngestTurnResult {
  scopeId: string;
  addedTurn?: Turn;
  groupStored?: boolean;
  counts: {
    working: number;
    episodic: number;
    semantic: number;
    summary: number;
  };
}

interface InspectScopeResult {
  scopeId: string;
  state: MemoryState;
}

interface ResetScopeResult {
  scopeId: string;
  removed: true;
}

interface ResetUserResult {
  userId: string;
  removed: boolean;
}

interface ResetAllResult {
  removed: boolean;
}

interface ListSemanticFactsResult {
  scopeId: string;
  facts: SemanticFact[];
}

interface DeleteSemanticFactResult {
  scopeId: string;
  factId: string;
  removed: boolean;
}

interface UpdateSemanticFactResult {
  scopeId: string;
  factId: string;
  updated: boolean;
  fact?: SemanticFact;
}

interface PreparePromptResult {
  scopeId: string;
  userScopeId: string;
  conversationScopeId?: string;
  groupScopeId: string;
  userText: string;
  userMemoryContext: string;
  conversationMemoryContext: string;
  groupMemoryContext: string;
  memoryContext: string;
  memoryTokenEstimate: number;
  sections: ContextBundle["sections"];
  groupStored: boolean;
}

interface BudgetSplit {
  userBudget: number;
  conversationBudget: number;
  groupBudget: number;
}

export class LocalMemoryEngine {
  private readonly config: EngineConfig;
  private readonly store: MemoryStore;

  constructor(overrides: Partial<EngineConfig> = {}) {
    this.config = { ...loadConfig(), ...overrides };
    this.store = createMemoryStore(this.config);
  }

  buildScope(params: ScopeParams): string {
    return buildScopeId(params);
  }

  close(): void {
    this.store.close();
  }

  async ingestTurn(params: {
    userId: string;
    chatId?: string;
    role: MemoryRole | "ai";
    text: string;
    at?: number;
    conversationId?: string;
    scopeKind?: "user" | "group" | "conversation";
  }): Promise<IngestTurnResult> {
    const scope = this.resolveScope(params);
    return this.ingestTurnInScope(scope, params.role, params.text, params.at, params.userId);
  }

  async retrieveContext(params: RetrieveContextInput): Promise<ContextBundle> {
    const scope = this.resolveScope(params);
    return this.retrieveContextForScope(scope, String(params.query ?? ""), params.tokenBudget);
  }

  async preparePromptInput(params: PreparePromptInput): Promise<PreparePromptResult> {
    const userScope = this.userScope(params.userId, params.chatId);
    const conversationScope = params.conversationId
      ? this.conversationScope(params.chatId, params.conversationId)
      : null;
    const groupScope = this.groupScope(params.chatId);

    await this.ingestTurnInScope(userScope, "user", params.userText, params.at, params.userId);
    if (conversationScope) {
      await this.ingestTurnInScope(
        conversationScope,
        "user",
        params.userText,
        params.at,
        params.userId
      );
    }
    let groupStored = false;
    if (
      this.config.groupMemoryEnabled &&
      shouldStoreInGroupMemory(params.userText, "user")
    ) {
      await this.ingestTurnInScope(
        groupScope,
        "user",
        params.userText,
        params.at,
        params.userId
      );
      groupStored = true;
    }

    const totalBudget = Math.max(120, params.tokenBudget ?? this.config.defaultTokenBudget);
    const split = resolveBudgetSplit(
      params.userText,
      totalBudget,
      Boolean(conversationScope),
      this.config.groupMemoryEnabled
    );

    const userBundle = await this.retrieveContextForScope(
      userScope,
      String(params.userText ?? ""),
      split.userBudget
    );
    const conversationBundle =
      conversationScope && split.conversationBudget > 0
        ? await this.retrieveContextForScope(
            conversationScope,
            String(params.userText ?? ""),
            split.conversationBudget
          )
        : emptyContext(split.conversationBudget);
    const groupBundle =
      this.config.groupMemoryEnabled && split.groupBudget > 0
        ? await this.retrieveContextForScope(
            groupScope,
            String(params.userText ?? ""),
            split.groupBudget
          )
        : emptyContext(split.groupBudget);

    const merged = mergeContextBundles({
      totalBudget,
      userBundle,
      conversationBundle,
      groupBundle
    });

    this.logRetrieval({
      query: params.userText,
      userScopeId: userScope.scopeId,
      conversationScopeId: conversationScope?.scopeId,
      groupScopeId: groupScope.scopeId,
      userBundle,
      conversationBundle,
      groupBundle,
      merged
    });

    return {
      scopeId: userScope.scopeId,
      userScopeId: userScope.scopeId,
      conversationScopeId: conversationScope?.scopeId,
      groupScopeId: groupScope.scopeId,
      userText: params.userText,
      userMemoryContext: userBundle.contextText,
      conversationMemoryContext: conversationBundle.contextText,
      groupMemoryContext: groupBundle.contextText,
      memoryContext: merged.contextText,
      memoryTokenEstimate: merged.estimatedTokens,
      sections: merged.sections,
      groupStored
    };
  }

  async rememberAssistantTurn(params: RememberAssistantInput): Promise<IngestTurnResult> {
    const userScope = this.userScope(params.userId, params.chatId);
    const conversationScope = params.conversationId
      ? this.conversationScope(params.chatId, params.conversationId)
      : null;
    const userResult = await this.ingestTurnInScope(
      userScope,
      "assistant",
      params.assistantText,
      params.at,
      undefined
    );
    if (conversationScope) {
      await this.ingestTurnInScope(
        conversationScope,
        "assistant",
        params.assistantText,
        params.at,
        undefined
      );
    }
    if (
      this.config.groupMemoryEnabled &&
      shouldStoreInGroupMemory(params.assistantText, "assistant")
    ) {
      const groupScope = this.groupScope(params.chatId);
      await this.ingestTurnInScope(
        groupScope,
        "assistant",
        params.assistantText,
        params.at,
        undefined
      );
      return {
        ...userResult,
        groupStored: true
      };
    }
    return {
      ...userResult,
      groupStored: false
    };
  }

  async inspectScope(params: ScopeParams): Promise<InspectScopeResult> {
    const scope = this.resolveScope(params);
    const state = await this.loadState(scope);
    return {
      scopeId: scope.scopeId,
      state
    };
  }

  async resetScope(params: ScopeParams): Promise<ResetScopeResult> {
    const scope = this.resolveScope(params);
    await this.store.removeScope(scope);
    return { scopeId: scope.scopeId, removed: true };
  }

  async resetUser(userId: string): Promise<ResetUserResult> {
    const removed = await this.store.resetUser(userId);
    return { userId, removed };
  }

  async resetAll(): Promise<ResetAllResult> {
    const removed = await this.store.resetAll();
    return { removed };
  }

  async listSemanticFacts(params: ScopeParams): Promise<ListSemanticFactsResult> {
    const scope = this.resolveScope(params);
    const state = await this.loadState(scope);
    return {
      scopeId: scope.scopeId,
      facts: state.semantic.facts
        .slice()
        .sort((a, b) => {
          if (b.lastConfirmedAt !== a.lastConfirmedAt) {
            return b.lastConfirmedAt - a.lastConfirmedAt;
          }
          return b.confidence - a.confidence;
        })
    };
  }

  async deleteSemanticFact(params: ScopeParams & { factId: string }): Promise<DeleteSemanticFactResult> {
    const scope = this.resolveScope(params);
    const state = await this.loadState(scope);
    const before = state.semantic.facts.length;
    state.semantic.facts = state.semantic.facts.filter((fact) => fact.id !== params.factId);
    const removed = state.semantic.facts.length !== before;
    if (removed) {
      await this.saveState(scope, state);
    }
    return {
      scopeId: scope.scopeId,
      factId: params.factId,
      removed
    };
  }

  async updateSemanticFact(
    params: ScopeParams & { factId: string; value: string }
  ): Promise<UpdateSemanticFactResult> {
    const scope = this.resolveScope(params);
    const state = await this.loadState(scope);
    const nextValue = String(params.value ?? "").trim();
    if (!nextValue) {
      throw new Error("메모리 값은 비워둘 수 없습니다.");
    }
    const target = state.semantic.facts.find((fact) => fact.id === params.factId);
    if (!target) {
      return {
        scopeId: scope.scopeId,
        factId: params.factId,
        updated: false
      };
    }
    const now = Date.now();
    target.value = nextValue;
    target.text = `${target.key}=${nextValue}`;
    target.at = now;
    target.lastConfirmedAt = now;
    target.embedding = embedText(nextValue);
    target.salience = Number(Math.max(target.salience, scoreSalience(target.text)).toFixed(4));
    target.confidence = Number(Math.max(target.confidence, 0.85).toFixed(4));
    await this.saveState(scope, state);
    return {
      scopeId: scope.scopeId,
      factId: params.factId,
      updated: true,
      fact: target
    };
  }

  private resolveScope(params: ScopeParams): ScopeDescriptor {
    if (params.scopeKind === "group") {
      return this.groupScope(params.chatId);
    }
    if (params.scopeKind === "conversation") {
      return this.conversationScope(params.chatId, params.conversationId);
    }
    return this.userScope(params.userId, params.chatId);
  }

  private userScope(userId: string, chatId: string | undefined): ScopeDescriptor {
    return buildScopeDescriptor({
      userId: String(userId ?? "default"),
      chatId: String(chatId ?? "global"),
      scopeKind: "user"
    });
  }

  private groupScope(chatId: string | undefined): ScopeDescriptor {
    return buildScopeDescriptor({
      userId: "group",
      chatId: String(chatId ?? "global"),
      scopeKind: "group"
    });
  }

  private conversationScope(
    chatId: string | undefined,
    conversationId: string | undefined
  ): ScopeDescriptor {
    return buildScopeDescriptor({
      userId: "conversation",
      chatId: String(chatId ?? "global"),
      conversationId: String(conversationId ?? "default"),
      scopeKind: "conversation"
    });
  }

  private async ingestTurnInScope(
    scope: ScopeDescriptor,
    roleInput: MemoryRole | "ai",
    rawText: string,
    atInput: number | undefined,
    ownerUserId: string | undefined
  ): Promise<IngestTurnResult> {
    const state = await this.loadState(scope);
    const at = atInput ?? Date.now();
    const text = String(rawText ?? "").trim();

    if (!text) {
      return {
        scopeId: scope.scopeId,
        counts: {
          working: state.working.turns.length,
          episodic: state.episodic.items.length,
          semantic: state.semantic.facts.length,
          summary: state.summary.items.length
        }
      };
    }

    const role = normalizeRole(roleInput);
    const turn: Turn = {
      id: `turn_${at}_${randomUUID().slice(0, 8)}`,
      role,
      text,
      at,
      tokens: estimateTokens(text),
      salience: scoreSalience(text),
      ownerUserId: role === "user" ? safeId(String(ownerUserId ?? "").trim()) : undefined
    };

    state.working.turns.push(turn);
    state.working.turns = state.working.turns.slice(-this.config.maxWorkingTurns);

    await this.upsertFacts(scope, state, turn);
    this.upsertEpisode(scope, state, turn);
    await this.compactConversationState(state, turn);
    this.applyForgetting(scope, state);

    await this.saveState(scope, state);

    return {
      scopeId: scope.scopeId,
      addedTurn: turn,
      counts: {
        working: state.working.turns.length,
        episodic: state.episodic.items.length,
        semantic: state.semantic.facts.length,
        summary: state.summary.items.length
      }
    };
  }

  private async retrieveContextForScope(
    scope: ScopeDescriptor,
    query: string,
    tokenBudget: number | undefined
  ): Promise<ContextBundle> {
    const state = await this.loadState(scope);
    return buildContextBundle({
      query,
      tokenBudget: tokenBudget ?? this.config.defaultTokenBudget,
      semanticFacts: selectVisibleSemanticFacts(scope, state.semantic.facts),
      episodicItems: state.episodic.items,
      summaryItems: state.summary.items,
      workingTurns: state.working.turns
    });
  }

  private async upsertFacts(
    scope: ScopeDescriptor,
    state: MemoryState,
    turn: Turn
  ): Promise<void> {
    if (scope.scopeKind !== "user") {
      return;
    }
    const extracted = extractSemanticFacts(turn.text, turn.at, {
      sourceTurnId: turn.id,
      createdByUserId: turn.ownerUserId,
      visibility: "private",
      scopeKind: scope.scopeKind
    });
    if (!extracted.length) {
      return;
    }

    const acceptedFacts = extracted.filter((fact) => shouldStoreSemanticFact(turn.text, fact));
    if (!acceptedFacts.length) {
      return;
    }

    for (const fact of acceptedFacts) {
      const existingIndex = state.semantic.facts.findIndex((item) =>
        sameSemanticFactIdentity(item, fact)
      );
      if (existingIndex === -1) {
        state.semantic.facts.push(fact);
      } else {
        const previous = state.semantic.facts[existingIndex];
        if (!previous) {
          continue;
        }
        const merged: SemanticFact = {
          ...previous,
          value: fact.value,
          text: `${fact.key}=${fact.value}`,
          confidence: Number(
            Math.min(0.99, previous.confidence * 0.7 + fact.confidence * 0.3).toFixed(4)
          ),
          salience: Number(Math.max(previous.salience, fact.salience).toFixed(4)),
          lastConfirmedAt: turn.at,
          at: turn.at,
          embedding: embedText(fact.value),
          sourceTurnId: fact.sourceTurnId,
          createdByUserId: fact.createdByUserId,
          visibility: fact.visibility,
          scopeKind: fact.scopeKind
        };
        state.semantic.facts[existingIndex] = merged;
      }
    }

    state.semantic.facts = state.semantic.facts
      .filter((fact, index, all) => all.findIndex((item) => sameSemanticFactIdentity(item, fact)) === index)
      .sort((a, b) => {
        if (b.lastConfirmedAt !== a.lastConfirmedAt) {
          return b.lastConfirmedAt - a.lastConfirmedAt;
        }
        return b.confidence - a.confidence;
      })
      .slice(0, 120);
  }

  private upsertEpisode(scope: ScopeDescriptor, state: MemoryState, turn: Turn): void {
    if (scope.scopeKind === "group" && turn.role === "user") {
      return;
    }
    if (!shouldCreateEpisode(turn.text, turn.salience)) {
      return;
    }

    const episode = {
      id: `epi_${turn.at}_${randomUUID().slice(0, 8)}`,
      text: `${formatTurnSpeaker(turn)}: ${turn.text}`,
      at: turn.at,
      salience: turn.salience,
      embedding: embedText(turn.text)
    };

    const similarExists = state.episodic.items.some((item) => {
      const score = cosineSimilarity(item.embedding, episode.embedding);
      return score >= 0.93;
    });

    if (!similarExists) {
      state.episodic.items.push(episode);
    }

    state.episodic.items = state.episodic.items
      .sort((a, b) => {
        if (b.at !== a.at) {
          return b.at - a.at;
        }
        return b.salience - a.salience;
      })
      .slice(0, this.config.maxEpisodicItems);
  }

  private upsertSummary(state: MemoryState): void {
    const turns = state.working.turns;
    if (turns.length < this.config.summaryEveryTurns) {
      return;
    }

    const fromIndex = Math.max(0, turns.length - this.config.summaryEveryTurns);
    const slice = turns.slice(fromIndex);
    const text = summarizeTurns(slice);
    if (!text) {
      return;
    }

    const latestAt = slice[slice.length - 1]?.at ?? Date.now();
    const turnIds = slice.map((turn) => turn.id);
    const fromTurnId = turnIds[0] ?? "";
    const toTurnId = turnIds[turnIds.length - 1] ?? "";

    const exists = state.summary.items.some((item) => item.toTurnId === toTurnId);
    if (exists) {
      return;
    }

    state.summary.items.push({
      id: `sum_${latestAt}_${randomUUID().slice(0, 8)}`,
      text,
      fromTurnId,
      toTurnId,
      at: latestAt,
      salience: Number(
        (
          slice.reduce((acc, turn) => acc + (turn.salience ?? 0.3), 0) /
          Math.max(1, slice.length)
        ).toFixed(4)
      ),
      embedding: embedText(text)
    });

    state.summary.items = state.summary.items
      .sort((a, b) => b.at - a.at)
      .slice(0, this.config.maxSummaryItems);
  }

  private async compactConversationState(state: MemoryState, latestTurn: Turn): Promise<void> {
    if (!this.config.compactionEnabled) {
      this.upsertSummary(state);
      return;
    }

    if (!shouldCompactWorkingTurns(state, this.config, latestTurn)) {
      return;
    }

    const keepCount = Math.min(
      Math.max(1, this.config.compactionKeepRecentTurns),
      state.working.turns.length
    );
    const olderTurns = state.working.turns.slice(0, -keepCount);
    if (olderTurns.length < this.config.compactionMinSourceTurns) {
      return;
    }

    const previousSummary = collapseSummaryItems(state.summary.items);
    let compacted = "";

    try {
      compacted = await buildCompactedSummary({
        previousSummary,
        turns: olderTurns
      });
    } catch {
      compacted = "";
    }

    if (!compacted) {
      compacted = buildFallbackCompactedSummary({
        previousSummary,
        turns: olderTurns
      });
    }
    if (!compacted) {
      return;
    }

    const fromTurnId = previousSummary
      ? state.summary.items
          .map((item) => item.fromTurnId)
          .find((item) => item.length > 0) ?? olderTurns[0]?.id ?? ""
      : olderTurns[0]?.id ?? "";
    const toTurnId = olderTurns[olderTurns.length - 1]?.id ?? latestTurn.id;
    const at = olderTurns[olderTurns.length - 1]?.at ?? latestTurn.at;
    const salience =
      olderTurns.reduce((acc, turn) => acc + (turn.salience ?? 0.35), 0) /
      Math.max(1, olderTurns.length);

    state.summary.items = [
      {
        id: `sum_${at}_${randomUUID().slice(0, 8)}`,
        text: compacted,
        fromTurnId,
        toTurnId,
        at,
        salience: Number(salience.toFixed(4)),
        embedding: embedText(compacted)
      }
    ];
    state.working.turns = state.working.turns.slice(-keepCount);
  }

  private applyForgetting(scope: ScopeDescriptor, state: MemoryState): void {
    const now = Date.now();
    const episodicTtl = 1000 * 60 * 60 * 24 * 120;
    const summaryTtl = 1000 * 60 * 60 * 24 * 240;
    const conversationCutoff =
      scope.scopeKind === "conversation" ? now - this.config.conversationTtlMs : null;

    if (conversationCutoff != null) {
      state.working.turns = state.working.turns
        .filter((turn) => turn.at >= conversationCutoff)
        .slice(-this.config.maxWorkingTurns);
    }

    state.episodic.items = state.episodic.items
      .filter((item) => {
        if (conversationCutoff != null && item.at < conversationCutoff) {
          return false;
        }
        return now - item.at <= episodicTtl;
      })
      .slice(0, this.config.maxEpisodicItems);

    state.summary.items = state.summary.items
      .filter((item) => {
        if (conversationCutoff != null && item.at < conversationCutoff) {
          return false;
        }
        return now - item.at <= summaryTtl;
      })
      .slice(0, this.config.maxSummaryItems);

    state.semantic.facts = state.semantic.facts
      .map((fact) => {
        const ageDays = (now - fact.lastConfirmedAt) / (1000 * 60 * 60 * 24);
        const decay = Math.pow(0.995, Math.max(0, ageDays));
        return {
          ...fact,
          confidence: Number(Math.max(0.25, Math.min(0.99, fact.confidence * decay)).toFixed(4))
        };
      })
      .sort((a, b) => b.lastConfirmedAt - a.lastConfirmedAt)
      .slice(0, 120);
  }

  private logRetrieval(params: {
    query: string;
    userScopeId: string;
    conversationScopeId?: string;
    groupScopeId: string;
    userBundle: ContextBundle;
    conversationBundle: ContextBundle;
    groupBundle: ContextBundle;
    merged: ContextBundle;
  }): void {
    if (!this.config.retrievalLoggingEnabled) {
      return;
    }
    const payload = {
      type: "memory_retrieval",
      queryLength: params.query.length,
      scopes: {
        user: params.userScopeId,
        conversation: params.conversationScopeId,
        group: params.groupScopeId
      },
      sections: {
        user: summarizeBundle(params.userBundle),
        conversation: summarizeBundle(params.conversationBundle),
        group: summarizeBundle(params.groupBundle),
        merged: summarizeBundle(params.merged)
      }
    };
    process.stderr.write(`${JSON.stringify(payload)}\n`);
  }

  private async loadState(scope: ScopeDescriptor): Promise<MemoryState> {
    const state = await this.store.loadState(scope);
    return normalizeState(state ?? createEmptyState());
  }

  private async saveState(scope: ScopeDescriptor, state: MemoryState): Promise<void> {
    await this.store.saveState(scope, normalizeState(state));
  }
}

function normalizeRole(raw: MemoryRole | "ai"): MemoryRole {
  const role = String(raw ?? "user").toLowerCase();
  return role === "assistant" || role === "ai" ? "assistant" : "user";
}

function formatTurnSpeaker(turn: Turn): string {
  if (turn.role === "assistant") {
    return "assistant";
  }
  if (turn.ownerUserId) {
    return `user(${turn.ownerUserId})`;
  }
  return "user";
}

function sameSemanticFactIdentity(left: SemanticFact, right: SemanticFact): boolean {
  const mode = semanticFactMode(left.key);
  if (mode === "single") {
    return left.key === right.key;
  }
  return left.key === right.key && normalizeSemanticValue(left.value) === normalizeSemanticValue(right.value);
}

function semanticFactMode(key: string): "single" | "multi" {
  if (key === "preference.like" || key === "preference.dislike") {
    return "multi";
  }
  return "single";
}

function normalizeSemanticValue(value: string): string {
  return String(value ?? "")
    .normalize("NFKC")
    .trim()
    .toLowerCase();
}

function shouldStoreSemanticFact(sourceText: string, fact: SemanticFact): boolean {
  const input = String(sourceText ?? "").trim();
  if (!input) {
    return false;
  }
  if (
    /(시스템|프롬프트|system prompt|ignore previous|jailbreak|관리자|admin|규칙|정책|합의|공지)/iu.test(
      input
    )
  ) {
    return false;
  }
  if (/(영구히|무조건|반드시|기억해|저장해|메모해|remember this)/iu.test(input)) {
    return false;
  }
  if (/(관리자|admin|system|prompt|규칙|정책)/iu.test(fact.value)) {
    return false;
  }
  if (fact.key === "profile.name") {
    return /(내\s*이름은|\bmy\s+name\s+is\b)/iu.test(input);
  }
  if (fact.key === "profile.hobby") {
    return /(내\s*(?:취미|관심사)는|\bmy\s+hobby\s+is\b)/iu.test(input);
  }
  if (fact.key === "preference.like") {
    return /(?:나는|저는).*(좋아해|좋아합니다|선호해|선호합니다)|\bi\s+(?:like|love|prefer)\b/iu.test(
      input
    );
  }
  if (fact.key === "preference.dislike") {
    return /(?:나는|저는).*(싫어해|싫어합니다|비선호|안\s*좋아해)|\bi\s+(?:hate|dislike)\b/iu.test(
      input
    );
  }
  return true;
}

function selectVisibleSemanticFacts(scope: ScopeDescriptor, facts: SemanticFact[]): SemanticFact[] {
  return facts.filter((fact) => {
    if (fact.scopeKind !== scope.scopeKind) {
      return false;
    }
    if (scope.scopeKind === "user") {
      if (fact.visibility !== "private") {
        return false;
      }
      if (fact.createdByUserId && fact.createdByUserId !== scope.userId) {
        return false;
      }
      return true;
    }
    if (scope.scopeKind === "conversation") {
      return fact.visibility === "conversation";
    }
    return fact.visibility === "shared";
  });
}

function summarizeBundle(bundle: ContextBundle): Record<string, number> {
  const counts: Record<string, number> = {
    sections: bundle.sections.length,
    estimatedTokens: bundle.estimatedTokens
  };
  for (const section of bundle.sections) {
    counts[section.name] = section.items.length;
  }
  return counts;
}

function resolveBudgetSplit(
  query: string,
  totalBudget: number,
  hasConversationScope: boolean,
  groupMemoryEnabled: boolean
): BudgetSplit {
  const budget = Math.max(120, totalBudget);
  if (!groupMemoryEnabled && !hasConversationScope) {
    return {
      userBudget: budget,
      conversationBudget: 0,
      groupBudget: 0
    };
  }
  if (!hasConversationScope) {
    let userRatio = 0.6;
    if (isPersonalQuery(query)) {
      userRatio = 0.78;
    } else if (isGroupQuery(query)) {
      userRatio = 0.42;
    }
    let userBudget = Math.max(72, Math.floor(budget * userRatio));
    let groupBudget = groupMemoryEnabled ? Math.max(48, budget - userBudget) : 0;
    if (userBudget + groupBudget > budget) {
      groupBudget = Math.max(0, budget - userBudget);
    }
    if (groupBudget <= 0) {
      groupBudget = 0;
      userBudget = budget;
    }
    return {
      userBudget,
      conversationBudget: 0,
      groupBudget
    };
  }

  let userRatio = 0.26;
  let conversationRatio = 0.54;
  let groupRatio = groupMemoryEnabled ? 0.2 : 0;
  if (isPersonalQuery(query)) {
    userRatio = 0.3;
    conversationRatio = groupMemoryEnabled ? 0.55 : 0.7;
    groupRatio = groupMemoryEnabled ? 0.15 : 0;
  } else if (isGroupQuery(query)) {
    userRatio = 0.2;
    conversationRatio = 0.5;
    groupRatio = groupMemoryEnabled ? 0.3 : 0;
  }
  const userBudget = Math.max(48, Math.floor(budget * userRatio));
  let conversationBudget = Math.max(72, Math.floor(budget * conversationRatio));
  let groupBudget = groupMemoryEnabled ? Math.floor(budget * groupRatio) : 0;
  const assigned = userBudget + conversationBudget + groupBudget;
  if (assigned > budget) {
    const overflow = assigned - budget;
    if (groupBudget > 0) {
      groupBudget = Math.max(0, groupBudget - overflow);
    } else {
      conversationBudget = Math.max(72, conversationBudget - overflow);
    }
  }
  const remaining = budget - userBudget - conversationBudget - groupBudget;
  if (remaining > 0) {
    conversationBudget += remaining;
  }
  return {
    userBudget,
    conversationBudget,
    groupBudget
  };
}

function isPersonalQuery(query: string): boolean {
  return /(내가|나는|저는|나의|my|me|i\s+am|i'm|내\s*정보|내\s*기록)/iu.test(query);
}

function isGroupQuery(query: string): boolean {
  return /(우리|이\s*방|그룹|채널|규칙|정책|합의|공지|프로젝트|일정|team|group|rule|policy|decision)/iu.test(
    query
  );
}

function emptyContext(tokenBudget: number): ContextBundle {
  return {
    tokenBudget: Math.max(0, tokenBudget),
    estimatedTokens: 0,
    sections: [],
    contextText: "memory_context: none"
  };
}

function mergeContextBundles(params: {
  totalBudget: number;
  userBundle: ContextBundle;
  conversationBundle: ContextBundle;
  groupBundle: ContextBundle;
}): ContextBundle {
  const userHas = hasContext(params.userBundle);
  const conversationHas = hasContext(params.conversationBundle);
  const groupHas = hasContext(params.groupBundle);
  if (!userHas && !conversationHas && !groupHas) {
    return {
      tokenBudget: params.totalBudget,
      estimatedTokens: 0,
      sections: [],
      contextText: "memory_context: none"
    };
  }

  const lines: string[] = ["memory_context:"];
  const mergedSections: ContextBundle["sections"] = [];

  if (userHas) {
    lines.push("user_memory:");
    for (const section of params.userBundle.sections) {
      lines.push(`${section.name}:`);
      for (const item of section.items) {
        lines.push(`- ${item.text}`);
      }
      mergedSections.push({
        name: section.name,
        items: section.items.map((item) => ({
          ...item,
          text: `[user] ${item.text}`
        }))
      });
    }
  }

  if (conversationHas) {
    lines.push("conversation_memory:");
    for (const section of params.conversationBundle.sections) {
      lines.push(`${section.name}:`);
      for (const item of section.items) {
        lines.push(`- ${item.text}`);
      }
      mergedSections.push({
        name: section.name,
        items: section.items.map((item) => ({
          ...item,
          text: `[conversation] ${item.text}`
        }))
      });
    }
  }

  if (groupHas) {
    lines.push("group_memory:");
    for (const section of params.groupBundle.sections) {
      lines.push(`${section.name}:`);
      for (const item of section.items) {
        lines.push(`- ${item.text}`);
      }
      mergedSections.push({
        name: section.name,
        items: section.items.map((item) => ({
          ...item,
          text: `[group] ${item.text}`
        }))
      });
    }
  }

  return {
    tokenBudget: params.totalBudget,
    estimatedTokens:
      params.userBundle.estimatedTokens +
      params.conversationBundle.estimatedTokens +
      params.groupBundle.estimatedTokens,
    sections: mergedSections,
    contextText: lines.join("\n")
  };
}

function hasContext(bundle: ContextBundle): boolean {
  return bundle.sections.length > 0 && bundle.contextText.trim().toLowerCase() !== "memory_context: none";
}

function shouldCompactWorkingTurns(
  state: MemoryState,
  config: EngineConfig,
  latestTurn: Turn
): boolean {
  if (latestTurn.role !== "assistant") {
    return false;
  }
  const keepRecentTurns = Math.max(1, config.compactionKeepRecentTurns);
  if (state.working.turns.length <= keepRecentTurns) {
    return false;
  }
  const sourceTurns = state.working.turns.length - keepRecentTurns;
  return sourceTurns >= Math.max(1, config.compactionMinSourceTurns);
}

function collapseSummaryItems(items: MemoryState["summary"]["items"]): string {
  const texts = items
    .slice()
    .sort((a, b) => a.at - b.at)
    .map((item) => String(item.text ?? "").trim())
    .filter((item) => item.length > 0);
  if (texts.length === 0) {
    return "";
  }
  if (texts.length === 1) {
    return texts[0] ?? "";
  }
  return texts.join("\n\n");
}
