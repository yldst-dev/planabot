import { type EngineConfig, type MemoryStore, type ScopeParams, type MemoryRole, type RetrieveContextInput, type ContextBundle, type PreparePromptInput, type RememberExchangeInput, type Turn, type RememberAssistantInput, type ScopeDescriptor, type WireMessage, type MemoryState, type SemanticFact } from "./types.js";
import { type Settings } from "../config/settings.js";
import { loadConfig } from "./config.js";
import { createMemoryStore } from "./memory-store.js";
import { buildScopeId, buildScopeDescriptor, safeId } from "./storage.js";
import { type IngestTurnResult, type PreparePromptResult, type RememberExchangeResult, type InspectScopeResult, type ResetScopeResult, type ResetUserResult, type ResetAllResult, type ListSemanticFactsResult, type DeleteSemanticFactResult, type UpdateSemanticFactResult } from "./results.js";
import { resolveBudgetSplit, emptyContext, mergeContextBundles, sanitizeAssistantMemoryText, normalizeRole, buildTurn, selectVisibleSemanticFacts, shouldStoreSemanticFact, sameSemanticFactIdentity, formatTurnSpeaker, shouldCompactWorkingTurns, collapseSummaryItems, summarizeBundle } from "./memory-policy.js";
import { shouldStoreInGroupMemory, scoreSalience, extractSemanticFacts, shouldCreateEpisode, summarizeTurns } from "./extractors.js";
import { embedText, cosineSimilarity } from "./embedding.js";
import { randomUUID } from "node:crypto";
import { estimateTokens } from "./token-estimator.js";
import { buildContextBundle } from "./ranking.js";
import { serial } from "../runtime/serial.js";
import { MemoryConflictError } from "./concurrency.js";
import { buildCompactedSummary, buildFallbackCompactedSummary } from "./compaction.js";
import { normalizeState, createEmptyState } from "./state-normalize.js";
import { checkExecution } from "../runtime/execution.js";

export class LocalMemoryEngine {
  private readonly config: EngineConfig;
  private readonly store: MemoryStore;

  constructor(overrides: Partial<EngineConfig> = {}, private readonly modelSettings?: Settings) {
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
      groupStored: false
    };
  }

  async rememberExchange(params: RememberExchangeInput): Promise<RememberExchangeResult> {
    const userText = String(params.userText ?? "").trim();
    const assistantText = String(params.assistantText ?? "").trim();
    if (!userText || !assistantText) {
      throw new Error("사용자 질문과 assistant 응답이 모두 필요합니다.");
    }

    const at = params.at ?? Date.now();
    const assistantMemoryText = sanitizeAssistantMemoryText(userText, assistantText);
    const userScope = this.userScope(params.userId, params.chatId);
    const userResult = await this.storeExchangeInScope({
      scope: userScope,
      requestId: params.requestId,
      userText,
      assistantText: assistantMemoryText,
      at,
      ownerUserId: params.userId,
      includeWorking: false,
      includeUserFacts: true,
      includeGroupEpisodes: false
    });

    if (params.conversationId) {
      await this.storeExchangeInScope({
        scope: this.conversationScope(params.chatId, params.conversationId),
        requestId: params.requestId,
        userText,
        assistantText: assistantMemoryText,
        at,
        ownerUserId: params.userId,
        includeWorking: true,
        includeUserFacts: false,
        includeGroupEpisodes: false,
        wireMessages: params.wireMessages,
        epoch: params.epoch
      });
    }

    const groupStored =
      this.config.groupMemoryEnabled &&
      (shouldStoreInGroupMemory(userText, "user") ||
        shouldStoreInGroupMemory(assistantMemoryText, "assistant"));
    if (groupStored) {
      await this.storeExchangeInScope({
        scope: this.groupScope(params.chatId),
        requestId: params.requestId,
        userText,
        assistantText: assistantMemoryText,
        at,
        ownerUserId: params.userId,
        includeWorking: false,
        includeUserFacts: false,
        includeGroupEpisodes: true
      });
    }

    if (params.conversationId) {
      await this.compactScope(this.conversationScope(params.chatId, params.conversationId));
    }
    return {
      ...userResult,
      groupStored
    };
  }

  async listConversationTurns(params: { chatId: string; conversationId: string; }): Promise<Turn[]> {
    const state = await this.loadState(this.conversationScope(params.chatId, params.conversationId));
    return state.working.turns;
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

  async deleteSemanticFact(params: ScopeParams & { factId: string; }): Promise<DeleteSemanticFactResult> {
    const scope = this.resolveScope(params);
    return this.mutateScope(scope, async () => {
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

    });
  }

  async updateSemanticFact(
    params: ScopeParams & { factId: string; value: string; }
  ): Promise<UpdateSemanticFactResult> {
    const scope = this.resolveScope(params);
    return this.mutateScope(scope, async () => {
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

    });
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
    const result = await this.mutateScope(scope, async () => {
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
      if (turn.ownerUserId) state.participantIds = [...new Set([...(state.participantIds ?? []), turn.ownerUserId])];
      state.working.turns = state.working.turns.slice(-this.config.maxWorkingTurns);

      await this.upsertFacts(scope, state, turn);
      this.upsertEpisode(scope, state, turn);

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

    });
    await this.compactScope(scope);
    return result;
  }

  private async storeExchangeInScope(params: {
    scope: ScopeDescriptor;
    requestId?: string;
    userText: string;
    assistantText: string;
    at: number;
    ownerUserId: string;
    includeWorking: boolean;
    includeUserFacts: boolean;
    includeGroupEpisodes: boolean;
    wireMessages?: WireMessage[];
    epoch?: number;
  }): Promise<RememberExchangeResult> {
    return this.mutateScope(params.scope, async () => {
      const state = await this.loadState(params.scope);
      if (params.requestId && state.exchangeIds?.includes(params.requestId)) {
        return {
          scopeId: params.scope.scopeId, addedTurns: [], groupStored: params.includeGroupEpisodes,
          counts: {
            working: state.working.turns.length, episodic: state.episodic.items.length,
            semantic: state.semantic.facts.length, summary: state.summary.items.length
          }
        };
      }
      if (params.requestId) state.exchangeIds = [...(state.exchangeIds ?? []), params.requestId].slice(-128);
      state.participantIds = [...new Set([...(state.participantIds ?? []), safeId(params.ownerUserId)])];
      const userTurn = buildTurn("user", params.userText, params.at, params.ownerUserId);
      const assistantTurn = buildTurn("assistant", params.assistantText, params.at + 1, undefined);
      if (params.includeWorking) {
        if (params.wireMessages && params.wireMessages.length > 0) {
          assistantTurn.wireMessages = params.wireMessages;
        }
        if (typeof params.epoch === "number" && Number.isFinite(params.epoch)) {
          userTurn.epoch = params.epoch;
          assistantTurn.epoch = params.epoch;
        }
      }

      if (params.includeWorking) {
        state.working.turns.push(userTurn, assistantTurn);
        state.working.turns = state.working.turns.slice(-this.config.maxWorkingTurns);
        this.upsertEpisode(params.scope, state, userTurn);
        this.upsertEpisode(params.scope, state, assistantTurn);

      } else {
        state.working.turns = [];
      }

      if (params.includeUserFacts) {
        await this.upsertFacts(params.scope, state, userTurn);
      }

      if (params.includeGroupEpisodes) {
        if (shouldStoreInGroupMemory(params.userText, "user")) {
          this.upsertEpisode(params.scope, state, userTurn, true, true);
        }
        if (shouldStoreInGroupMemory(params.assistantText, "assistant")) {
          this.upsertEpisode(params.scope, state, assistantTurn, false, true);
        }
      }

      this.applyForgetting(params.scope, state);
      await this.saveState(params.scope, state);

      return {
        scopeId: params.scope.scopeId,
        addedTurns: [userTurn, assistantTurn],
        groupStored: params.includeGroupEpisodes,
        counts: {
          working: state.working.turns.length,
          episodic: state.episodic.items.length,
          semantic: state.semantic.facts.length,
          summary: state.summary.items.length
        }
      };

    });
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
      workingTurns: scope.scopeKind === "conversation" ? state.working.turns : []
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

  private upsertEpisode(
    scope: ScopeDescriptor,
    state: MemoryState,
    turn: Turn,
    allowGroupUser = false,
    force = false
  ): void {
    if (scope.scopeKind === "group" && turn.role === "user" && !allowGroupUser) {
      return;
    }
    if (!force && !shouldCreateEpisode(turn.text, turn.salience)) {
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

  private async compactScope(scope: ScopeDescriptor): Promise<void> {
    await serial(`compaction:${this.storageKey(scope)}`, async () => {
      const state = await this.loadState(scope);
      const latest = state.working.turns.at(-1);
      if (!latest || !shouldCompactWorkingTurns(state, this.config, latest)) return;
      await this.compactConversationState(state, latest);
      try {
        await this.saveState(scope, state);
      } catch (error) {
        if (!(error instanceof MemoryConflictError)) throw error;
      }
    });
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
        settings: this.modelSettings,
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

  private async mutateScope<T>(scope: ScopeDescriptor, work: () => Promise<T>): Promise<T> {
    return serial(this.storageKey(scope), async () => {
      for (let attempt = 0; ; attempt += 1) {
        checkExecution();
        try {
          return await work();
        } catch (error) {
          if (!(error instanceof MemoryConflictError) || attempt >= 4) throw error;
        }
      }
    });
  }

  private storageKey(scope: ScopeDescriptor): string {
    return JSON.stringify([this.config.sqlitePath, this.config.rootDir, scope.scopeId]);
  }

  private async saveState(scope: ScopeDescriptor, state: MemoryState): Promise<void> {
    checkExecution();
    await this.store.saveState(scope, normalizeState(state));
  }
}
