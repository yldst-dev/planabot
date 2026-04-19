import { JsonMemoryStore } from "./json-store.js";
import { SqliteMemoryStore } from "./sqlite-store.js";
import type { EngineConfig, MemoryState, MemoryStore, ScopeDescriptor } from "./types.js";

export function createMemoryStore(config: EngineConfig): MemoryStore {
  if (config.storeKind === "json") {
    return new JsonMemoryStore(config.rootDir);
  }
  try {
    const sqlite = new SqliteMemoryStore(config.sqlitePath);
    const json = new JsonMemoryStore(config.rootDir);
    return new SqliteWithJsonFallbackStore(sqlite, json);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`SQLite store init failed, fallback to json store: ${message}\n`);
    return new JsonMemoryStore(config.rootDir);
  }
}

class SqliteWithJsonFallbackStore implements MemoryStore {
  private readonly sqliteStore: SqliteMemoryStore;
  private readonly jsonStore: JsonMemoryStore;

  constructor(sqliteStore: SqliteMemoryStore, jsonStore: JsonMemoryStore) {
    this.sqliteStore = sqliteStore;
    this.jsonStore = jsonStore;
  }

  async loadState(scope: ScopeDescriptor): Promise<MemoryState> {
    const sqliteState = await this.sqliteStore.loadState(scope);
    if (hasMemory(sqliteState)) {
      return sqliteState;
    }
    return this.jsonStore.loadState(scope);
  }

  async saveState(scope: ScopeDescriptor, state: MemoryState): Promise<void> {
    await this.sqliteStore.saveState(scope, state);
  }

  async removeScope(scope: ScopeDescriptor): Promise<void> {
    await this.sqliteStore.removeScope(scope);
    await this.jsonStore.removeScope(scope);
  }

  async resetUser(userId: string): Promise<boolean> {
    const sqliteRemoved = await this.sqliteStore.resetUser(userId);
    const jsonRemoved = await this.jsonStore.resetUser(userId);
    return sqliteRemoved || jsonRemoved;
  }

  async resetAll(): Promise<boolean> {
    const sqliteRemoved = await this.sqliteStore.resetAll();
    const jsonRemoved = await this.jsonStore.resetAll();
    return sqliteRemoved || jsonRemoved;
  }

  close(): void {
    this.sqliteStore.close();
    this.jsonStore.close();
  }
}

function hasMemory(state: MemoryState): boolean {
  return (
    state.working.turns.length > 0 ||
    state.semantic.facts.length > 0 ||
    state.episodic.items.length > 0 ||
    state.summary.items.length > 0
  );
}
