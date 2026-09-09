import { type Turn, type MemoryState, type SemanticFact, type ContextBundle } from "./types.js";

export interface IngestTurnResult {
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

export interface InspectScopeResult {
  scopeId: string;
  state: MemoryState;
}

export interface ResetScopeResult {
  scopeId: string;
  removed: true;
}

export interface ResetUserResult {
  userId: string;
  removed: boolean;
}

export interface ResetAllResult {
  removed: boolean;
}

export interface ListSemanticFactsResult {
  scopeId: string;
  facts: SemanticFact[];
}

export interface DeleteSemanticFactResult {
  scopeId: string;
  factId: string;
  removed: boolean;
}

export interface UpdateSemanticFactResult {
  scopeId: string;
  factId: string;
  updated: boolean;
  fact?: SemanticFact;
}

export interface PreparePromptResult {
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

export interface RememberExchangeResult {
  scopeId: string;
  addedTurns: Turn[];
  groupStored: boolean;
  counts: IngestTurnResult["counts"];
}

export interface BudgetSplit {
  userBudget: number;
  conversationBudget: number;
  groupBudget: number;
}
