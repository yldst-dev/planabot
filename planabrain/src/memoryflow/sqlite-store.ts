import { MemoryConflictError } from "./concurrency.js";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { createEmptyState, normalizeState, normalizeWireMessages } from "./state-normalize.js";
import { safeId } from "./storage.js";
import type { MemoryState, MemoryStore, ScopeDescriptor, WireMessage } from "./types.js";

type SqliteModule = {
  DatabaseSync: new (path: string) => DatabaseSync;
};

const require = createRequire(import.meta.url);

export class SqliteMemoryStore implements MemoryStore {
  private readonly db: DatabaseSync;

  constructor(sqlitePath: string) {
    const sqlite = loadSqliteModule();
    mkdirSync(path.dirname(sqlitePath), { recursive: true });
    this.db = new sqlite.DatabaseSync(sqlitePath);
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.transaction(() => {
      this.db.exec(`
      CREATE TABLE IF NOT EXISTS scopes (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        scope_kind TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY,
        scope_id TEXT NOT NULL,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        at INTEGER NOT NULL,
        tokens INTEGER NOT NULL,
        salience REAL NOT NULL,
        owner_user_id TEXT,
        FOREIGN KEY (scope_id) REFERENCES scopes(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS semantic_facts (
        id TEXT PRIMARY KEY,
        scope_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        text TEXT NOT NULL,
        at INTEGER NOT NULL,
        last_confirmed_at INTEGER NOT NULL,
        confidence REAL NOT NULL,
        salience REAL NOT NULL,
        embedding TEXT NOT NULL,
        source_turn_id TEXT NOT NULL DEFAULT '',
        created_by_user_id TEXT,
        visibility TEXT NOT NULL DEFAULT 'private',
        fact_scope_kind TEXT NOT NULL DEFAULT 'user',
        FOREIGN KEY (scope_id) REFERENCES scopes(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS episodic_items (
        id TEXT PRIMARY KEY,
        scope_id TEXT NOT NULL,
        text TEXT NOT NULL,
        at INTEGER NOT NULL,
        salience REAL NOT NULL,
        embedding TEXT NOT NULL,
        FOREIGN KEY (scope_id) REFERENCES scopes(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS summary_items (
        id TEXT PRIMARY KEY,
        scope_id TEXT NOT NULL,
        text TEXT NOT NULL,
        from_turn_id TEXT NOT NULL,
        to_turn_id TEXT NOT NULL,
        at INTEGER NOT NULL,
        salience REAL NOT NULL,
        embedding TEXT NOT NULL,
        FOREIGN KEY (scope_id) REFERENCES scopes(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_scopes_user_kind ON scopes(user_id, scope_kind);
      CREATE INDEX IF NOT EXISTS idx_scopes_chat_kind ON scopes(chat_id, scope_kind);
      CREATE INDEX IF NOT EXISTS idx_turns_scope_at ON turns(scope_id, at DESC);
      CREATE INDEX IF NOT EXISTS idx_semantic_scope_at ON semantic_facts(scope_id, last_confirmed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_episodic_scope_at ON episodic_items(scope_id, at DESC);
      CREATE INDEX IF NOT EXISTS idx_summary_scope_at ON summary_items(scope_id, at DESC);
    `);
      for (const [table, column, definition] of [
        ["scopes", "revision", "INTEGER NOT NULL DEFAULT 0"],
        ["scopes", "exchange_ids", "TEXT NOT NULL DEFAULT '[]'"],
        ["scopes", "participant_ids", "TEXT NOT NULL DEFAULT '[]'"],
        ["turns", "owner_user_id", "TEXT"],
        ["turns", "wire_messages", "TEXT"],
        ["turns", "epoch", "INTEGER"],
        ["semantic_facts", "source_turn_id", "TEXT NOT NULL DEFAULT ''"],
        ["semantic_facts", "created_by_user_id", "TEXT"],
        ["semantic_facts", "visibility", "TEXT NOT NULL DEFAULT 'private'"],
        ["semantic_facts", "fact_scope_kind", "TEXT NOT NULL DEFAULT 'user'"],
      ]) {
        const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
        if (!columns.some((entry) => entry.name === column)) {
          this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
        }
      }
    });
  }

  async loadState(scope: ScopeDescriptor): Promise<MemoryState> {
    this.upsertScope(scope);
    return this.transaction(() => this.readState(scope));
  }

  private readState(scope: ScopeDescriptor): MemoryState {
    const version = this.db.prepare("SELECT revision, exchange_ids, participant_ids FROM scopes WHERE id = ?").get(scope.scopeId);
    const empty = createEmptyState();

    const turns = this.db
      .prepare(
        "SELECT id, role, text, at, tokens, salience, owner_user_id, wire_messages, epoch FROM turns WHERE scope_id = ? ORDER BY at ASC"
      )
      .all(scope.scopeId) as Array<Record<string, unknown>>;

    const semanticFacts = this.db
      .prepare(
        "SELECT id, key, value, text, at, last_confirmed_at, confidence, salience, embedding, source_turn_id, created_by_user_id, visibility, fact_scope_kind FROM semantic_facts WHERE scope_id = ? ORDER BY last_confirmed_at DESC"
      )
      .all(scope.scopeId) as Array<Record<string, unknown>>;

    const episodicItems = this.db
      .prepare("SELECT id, text, at, salience, embedding FROM episodic_items WHERE scope_id = ? ORDER BY at DESC")
      .all(scope.scopeId) as Array<Record<string, unknown>>;

    const summaryItems = this.db
      .prepare(
        "SELECT id, text, from_turn_id, to_turn_id, at, salience, embedding FROM summary_items WHERE scope_id = ? ORDER BY at DESC"
      )
      .all(scope.scopeId) as Array<Record<string, unknown>>;

    return normalizeState({
      revision: Number(version?.revision ?? 0),
      exchangeIds: JSON.parse(String(version?.exchange_ids ?? "[]")),
      participantIds: JSON.parse(String(version?.participant_ids ?? "[]")),
      working: {
        version: 1,
        turns: turns.map((row) => ({
          id: String(row.id ?? ""),
          role: String(row.role ?? "user"),
          text: String(row.text ?? ""),
          at: Number(row.at ?? 0),
          tokens: Number(row.tokens ?? 0),
          salience: Number(row.salience ?? 0),
          ownerUserId: String(row.owner_user_id ?? "").trim() || undefined,
          wireMessages: parseWireMessages(row.wire_messages),
          epoch: row.epoch == null ? undefined : Number(row.epoch)
        }))
      },
      semantic: {
        version: 1,
        facts: semanticFacts.map((row) => ({
          id: String(row.id ?? ""),
          key: String(row.key ?? ""),
          value: String(row.value ?? ""),
          text: String(row.text ?? ""),
          at: Number(row.at ?? 0),
          lastConfirmedAt: Number(row.last_confirmed_at ?? row.at ?? 0),
          confidence: Number(row.confidence ?? 0),
          salience: Number(row.salience ?? 0),
          embedding: parseEmbedding(row.embedding),
          sourceTurnId: String(row.source_turn_id ?? "").trim(),
          createdByUserId: String(row.created_by_user_id ?? "").trim() || undefined,
          visibility: String(row.visibility ?? "private").trim(),
          scopeKind: String(row.fact_scope_kind ?? "user").trim()
        }))
      },
      episodic: {
        version: 1,
        items: episodicItems.map((row) => ({
          id: String(row.id ?? ""),
          text: String(row.text ?? ""),
          at: Number(row.at ?? 0),
          salience: Number(row.salience ?? 0),
          embedding: parseEmbedding(row.embedding)
        }))
      },
      summary: {
        version: 1,
        items: summaryItems.map((row) => ({
          id: String(row.id ?? ""),
          text: String(row.text ?? ""),
          fromTurnId: String(row.from_turn_id ?? ""),
          toTurnId: String(row.to_turn_id ?? ""),
          at: Number(row.at ?? 0),
          salience: Number(row.salience ?? 0),
          embedding: parseEmbedding(row.embedding)
        }))
      }
    }) ?? empty;
  }

  async saveState(scope: ScopeDescriptor, state: MemoryState): Promise<void> {
    const normalized = normalizeState(state);
    this.transaction(() => {
      this.upsertScope(scope);
      const updated = this.db.prepare("UPDATE scopes SET revision = revision + 1, exchange_ids = ?, participant_ids = ? WHERE id = ? AND revision = ?")
        .run(JSON.stringify(normalized.exchangeIds ?? []), JSON.stringify(normalized.participantIds ?? []), scope.scopeId, normalized.revision ?? 0);
      if (Number(updated.changes) !== 1) throw new MemoryConflictError();
      this.db.prepare("DELETE FROM turns WHERE scope_id = ?").run(scope.scopeId);
      this.db.prepare("DELETE FROM semantic_facts WHERE scope_id = ?").run(scope.scopeId);
      this.db.prepare("DELETE FROM episodic_items WHERE scope_id = ?").run(scope.scopeId);
      this.db.prepare("DELETE FROM summary_items WHERE scope_id = ?").run(scope.scopeId);

      const insertTurn = this.db.prepare(`
        INSERT INTO turns (id, scope_id, role, text, at, tokens, salience, owner_user_id, wire_messages, epoch)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const turn of normalized.working.turns) {
        insertTurn.run(
          turn.id,
          scope.scopeId,
          turn.role,
          turn.text,
          turn.at,
          turn.tokens,
          turn.salience,
          turn.ownerUserId ?? null,
          turn.wireMessages ? JSON.stringify(turn.wireMessages) : null,
          turn.epoch ?? null
        );
      }

      const insertSemantic = this.db.prepare(`
        INSERT INTO semantic_facts (id, scope_id, key, value, text, at, last_confirmed_at, confidence, salience, embedding, source_turn_id, created_by_user_id, visibility, fact_scope_kind)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const fact of normalized.semantic.facts) {
        insertSemantic.run(
          fact.id,
          scope.scopeId,
          fact.key,
          fact.value,
          fact.text,
          fact.at,
          fact.lastConfirmedAt,
          fact.confidence,
          fact.salience,
          JSON.stringify(fact.embedding),
          fact.sourceTurnId,
          fact.createdByUserId ?? null,
          fact.visibility,
          fact.scopeKind
        );
      }

      const insertEpisodic = this.db.prepare(`
        INSERT INTO episodic_items (id, scope_id, text, at, salience, embedding)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const item of normalized.episodic.items) {
        insertEpisodic.run(
          item.id,
          scope.scopeId,
          item.text,
          item.at,
          item.salience,
          JSON.stringify(item.embedding)
        );
      }

      const insertSummary = this.db.prepare(`
        INSERT INTO summary_items (id, scope_id, text, from_turn_id, to_turn_id, at, salience, embedding)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const item of normalized.summary.items) {
        insertSummary.run(
          item.id,
          scope.scopeId,
          item.text,
          item.fromTurnId,
          item.toTurnId,
          item.at,
          item.salience,
          JSON.stringify(item.embedding)
        );
      }

      this.db
        .prepare("UPDATE scopes SET updated_at = ? WHERE id = ?")
        .run(Date.now(), scope.scopeId);
    });
  }

  async removeScope(scope: ScopeDescriptor): Promise<void> {
    this.transaction(() => {
      this.upsertScope(scope);
      this.clearScope(scope.scopeId);
    });
  }

  private clearScope(scopeId: string): void {
    for (const table of ["turns", "semantic_facts", "episodic_items", "summary_items"]) {
      this.db.prepare(`DELETE FROM ${table} WHERE scope_id = ?`).run(scopeId);
    }
    this.db.prepare("UPDATE scopes SET revision = revision + 1, exchange_ids = '[]', participant_ids = '[]' WHERE id = ?").run(scopeId);
  }

  async resetUser(userId: string): Promise<boolean> {
    return this.transaction(() => {
      const scopes = this.db.prepare("SELECT id FROM scopes WHERE user_id = ? OR EXISTS (SELECT 1 FROM json_each(scopes.participant_ids) WHERE value = ?) UNION SELECT scope_id AS id FROM turns WHERE owner_user_id = ? UNION SELECT scope_id AS id FROM semantic_facts WHERE created_by_user_id = ?")
        .all(safeId(userId), safeId(userId), safeId(userId), safeId(userId));
      for (const scope of scopes) this.clearScope(String(scope.id));
      return scopes.length > 0;
    });
  }

  async resetAll(): Promise<boolean> {
    return this.transaction(() => {
      const scopes = this.db.prepare("SELECT id FROM scopes").all();
      for (const scope of scopes) this.clearScope(String(scope.id));
      return scopes.length > 0;
    });
  }

  close(): void {
    this.db.close();
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private upsertScope(scope: ScopeDescriptor): void {
    const now = Date.now();
    this.db
      .prepare(`
        INSERT INTO scopes (id, user_id, chat_id, scope_kind, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          user_id = excluded.user_id,
          chat_id = excluded.chat_id,
          scope_kind = excluded.scope_kind,
          updated_at = excluded.updated_at
      `)
      .run(scope.scopeId, safeId(scope.userId), safeId(scope.chatId), scope.scopeKind, now, now);
  }
}

function parseEmbedding(raw: unknown): number[] {
  if (Array.isArray(raw)) {
    return raw
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value));
  }
  if (typeof raw !== "string") {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value));
  } catch {
    return [];
  }
}

function loadSqliteModule(): SqliteModule {
  try {
    return require("node:sqlite") as SqliteModule;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`SQLite runtime unavailable: ${message}`);
  }
}

function parseWireMessages(raw: unknown): WireMessage[] | undefined {
  if (typeof raw !== "string" || !raw.trim()) {
    return undefined;
  }
  try {
    return normalizeWireMessages(JSON.parse(raw));
  } catch {
    return undefined;
  }
}
