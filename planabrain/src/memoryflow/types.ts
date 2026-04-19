export type MemoryRole = "user" | "assistant";

export type MemoryLayer = "semantic" | "episodic" | "summary" | "working";
export type MemoryStoreKind = "sqlite" | "json";
export type ScopeKind = "user" | "group" | "conversation";
export type MemoryVisibility = "private" | "conversation" | "shared";

export interface EngineConfig {
  rootDir: string;
  sqlitePath: string;
  storeKind: MemoryStoreKind;
  maxWorkingTurns: number;
  maxEpisodicItems: number;
  maxSummaryItems: number;
  summaryEveryTurns: number;
  compactionEnabled: boolean;
  compactionKeepRecentTurns: number;
  compactionMinSourceTurns: number;
  conversationTtlMs: number;
  defaultTokenBudget: number;
  groupMemoryEnabled: boolean;
  retrievalLoggingEnabled: boolean;
}

export interface ScopeParams {
  userId: string;
  chatId?: string;
  conversationId?: string;
  scopeKind?: ScopeKind;
}

export interface ScopeDescriptor {
  scopeId: string;
  userId: string;
  chatId: string;
  conversationId?: string;
  scopeKind: ScopeKind;
}

export interface Turn {
  id: string;
  role: MemoryRole;
  text: string;
  at: number;
  tokens: number;
  salience: number;
  ownerUserId?: string;
}

export interface SemanticFact {
  id: string;
  key: string;
  value: string;
  text: string;
  at: number;
  lastConfirmedAt: number;
  confidence: number;
  salience: number;
  embedding: number[];
  sourceTurnId: string;
  createdByUserId?: string;
  visibility: MemoryVisibility;
  scopeKind: ScopeKind;
}

export interface EpisodicItem {
  id: string;
  text: string;
  at: number;
  salience: number;
  embedding: number[];
}

export interface SummaryItem {
  id: string;
  text: string;
  fromTurnId: string;
  toTurnId: string;
  at: number;
  salience: number;
  embedding: number[];
}

export interface WorkingStore {
  version: 1;
  turns: Turn[];
}

export interface SemanticStore {
  version: 1;
  facts: SemanticFact[];
}

export interface EpisodicStore {
  version: 1;
  items: EpisodicItem[];
}

export interface SummaryStore {
  version: 1;
  items: SummaryItem[];
}

export interface MemoryState {
  working: WorkingStore;
  semantic: SemanticStore;
  episodic: EpisodicStore;
  summary: SummaryStore;
}

export interface IngestTurnInput extends ScopeParams {
  role: MemoryRole | "ai";
  text: string;
  at?: number;
}

export interface RetrieveContextInput extends ScopeParams {
  query: string;
  tokenBudget?: number;
}

export interface PreparePromptInput extends ScopeParams {
  userText: string;
  tokenBudget?: number;
  at?: number;
}

export interface RememberAssistantInput extends ScopeParams {
  assistantText: string;
  at?: number;
}

export interface RankedItem {
  id: string;
  text: string;
  at: number;
  salience: number;
  layer: MemoryLayer;
  score: number;
  tokens: number;
}

export interface RankedSection {
  name: MemoryLayer;
  items: RankedItem[];
}

export interface ContextBundle {
  tokenBudget: number;
  estimatedTokens: number;
  sections: RankedSection[];
  contextText: string;
}

export interface MemoryStore {
  loadState(scope: ScopeDescriptor): Promise<MemoryState>;
  saveState(scope: ScopeDescriptor, state: MemoryState): Promise<void>;
  removeScope(scope: ScopeDescriptor): Promise<void>;
  resetUser(userId: string): Promise<boolean>;
  resetAll(): Promise<boolean>;
  close(): void;
}
