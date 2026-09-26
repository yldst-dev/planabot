import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import type { ChatContext, ConversationTurn, MemoryKind, MemoryOperation, MemoryRecord, WireMessage } from "./types.js";

type SqliteModule = { DatabaseSync: new (path: string) => DatabaseSync; };
type Row = Record<string, SQLInputValue>;

const require = createRequire(import.meta.url);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversation_turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  at INTEGER NOT NULL,
  owner_user_id TEXT,
  wire_messages TEXT,
  epoch INTEGER
);
CREATE INDEX IF NOT EXISTS conversation_turns_scope ON conversation_turns (chat_id, conversation_id, at);
CREATE INDEX IF NOT EXISTS conversation_turns_owner ON conversation_turns (owner_user_id);

CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_user_id TEXT,
  chat_id TEXT NOT NULL,
  direct INTEGER NOT NULL,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  importance REAL NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_recalled_at INTEGER
);
CREATE INDEX IF NOT EXISTS memories_subject ON memories (subject_user_id, chat_id);
CREATE INDEX IF NOT EXISTS memories_chat ON memories (chat_id);

CREATE TABLE IF NOT EXISTS exchanges (
  request_id TEXT PRIMARY KEY,
  at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS resets (
  user_id TEXT PRIMARY KEY,
  at INTEGER NOT NULL
);
`;

const VISIBLE = `(
  (subject_user_id = :userId AND (chat_id = :chatId OR (:direct = 1 AND direct = 0)))
  OR (subject_user_id IS NULL AND chat_id = :chatId)
)`;

export class MemoryDatabase {
  private readonly db: DatabaseSync;

  constructor(databasePath: string) {
    const sqlite = loadSqlite();
    if (databasePath !== ":memory:") mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new sqlite.DatabaseSync(databasePath);
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  recordExchange(params: {
    requestId?: string;
    chatId: string;
    conversationId?: string;
    turns: ConversationTurn[];
    maxTurns: number;
    cutoffAt: number;
  }): boolean {
    return this.transaction(() => {
      if (params.requestId) {
        const inserted = this.db
          .prepare("INSERT OR IGNORE INTO exchanges (request_id, at) VALUES (?, ?)")
          .run(params.requestId, Date.now());
        if (inserted.changes === 0) return false;
        this.db.prepare("DELETE FROM exchanges WHERE at < ?").run(params.cutoffAt);
      }
      if (!params.conversationId) return true;
      const insert = this.db.prepare(
        "INSERT INTO conversation_turns (chat_id, conversation_id, role, text, at, owner_user_id, wire_messages, epoch) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (const turn of params.turns) {
        insert.run(
          params.chatId,
          params.conversationId,
          turn.role,
          turn.text,
          turn.at,
          turn.ownerUserId ?? null,
          turn.wireMessages?.length ? JSON.stringify(turn.wireMessages) : null,
          turn.epoch ?? null,
        );
      }
      this.db.prepare(`
        DELETE FROM conversation_turns
        WHERE chat_id = :chatId AND conversation_id = :conversationId AND (
          at < :cutoffAt OR id NOT IN (
            SELECT id FROM conversation_turns
            WHERE chat_id = :chatId AND conversation_id = :conversationId
            ORDER BY at DESC, id DESC LIMIT :maxTurns
          )
        )
      `).run({ chatId: params.chatId, conversationId: params.conversationId, cutoffAt: params.cutoffAt, maxTurns: params.maxTurns });
      return true;
    });
  }

  listConversationTurns(chatId: string, conversationId: string, cutoffAt: number): ConversationTurn[] {
    const rows = this.db.prepare(`
      SELECT role, text, at, owner_user_id, wire_messages, epoch FROM conversation_turns
      WHERE chat_id = ? AND conversation_id = ? AND at >= ?
      ORDER BY at ASC, id ASC
    `).all(chatId, conversationId, cutoffAt) as Row[];
    return rows.map((row) => ({
      role: row.role === "assistant" ? "assistant" : "user",
      text: String(row.text),
      at: Number(row.at),
      ...(typeof row.owner_user_id === "string" ? { ownerUserId: row.owner_user_id } : {}),
      ...(typeof row.wire_messages === "string" ? { wireMessages: parseWireMessages(row.wire_messages) } : {}),
      ...(typeof row.epoch === "number" || typeof row.epoch === "bigint" ? { epoch: Number(row.epoch) } : {}),
    }));
  }

  listVisibleMemories(context: ChatContext): MemoryRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM memories WHERE ${VISIBLE}
      ORDER BY updated_at DESC, id DESC
    `).all(visibilityParams(context)) as Row[];
    return rows.map(toRecord);
  }

  applyOperations(params: {
    context: ChatContext;
    operations: MemoryOperation[];
    startedAt: number;
    maxMemoriesPerUser: number;
  }): number {
    return this.transaction(() => {
      const reset = this.db.prepare("SELECT MAX(at) AS at FROM resets WHERE user_id IN (?, '*')").get(params.context.userId) as Row | undefined;
      if (reset?.at != null && Number(reset.at) >= params.startedAt) return 0;
      const now = Date.now();
      let applied = 0;
      for (const operation of params.operations) {
        if (operation.op === "add") {
          const subject = operation.kind === "room" ? null : params.context.userId;
          this.db.prepare(`
            INSERT INTO memories (subject_user_id, chat_id, direct, kind, content, importance, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(subject, params.context.chatId, params.context.direct ? 1 : 0, operation.kind, operation.content, operation.importance, now, now);
          applied += 1;
          continue;
        }
        const target = { ...visibilityParams(params.context), id: operation.id };
        const result = operation.op === "update"
          ? this.db.prepare(`
              UPDATE memories SET content = :content, importance = COALESCE(:importance, importance), updated_at = :now
              WHERE id = :id AND ${VISIBLE}
            `).run({ ...target, content: operation.content, importance: operation.importance ?? null, now })
          : this.db.prepare(`DELETE FROM memories WHERE id = :id AND ${VISIBLE}`).run(target);
        applied += Number(result.changes);
      }
      this.db.prepare(`
        DELETE FROM memories WHERE subject_user_id = :userId AND id NOT IN (
          SELECT id FROM memories WHERE subject_user_id = :userId
          ORDER BY importance DESC, updated_at DESC LIMIT :limit
        )
      `).run({ userId: params.context.userId, limit: params.maxMemoriesPerUser });
      return applied;
    });
  }

  markRecalled(ids: number[], at: number): void {
    if (ids.length === 0) return;
    const statement = this.db.prepare("UPDATE memories SET last_recalled_at = ? WHERE id = ?");
    this.transaction(() => {
      for (const id of ids) statement.run(at, id);
    });
  }

  forget(context: ChatContext, id: number): boolean {
    const result = this.db.prepare(`DELETE FROM memories WHERE id = :id AND ${VISIBLE}`).run({ ...visibilityParams(context), id });
    return Number(result.changes) > 0;
  }

  resetUser(userId: string): boolean {
    return this.transaction(() => {
      this.db.prepare("INSERT INTO resets (user_id, at) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET at = excluded.at").run(userId, Date.now());
      const memories = this.db.prepare("DELETE FROM memories WHERE subject_user_id = ?").run(userId);
      const turns = this.db.prepare(`
        DELETE FROM conversation_turns WHERE (chat_id, conversation_id) IN (
          SELECT DISTINCT chat_id, conversation_id FROM conversation_turns WHERE owner_user_id = ?
        )
      `).run(userId);
      return Number(memories.changes) + Number(turns.changes) > 0;
    });
  }

  resetAll(): boolean {
    return this.transaction(() => {
      let removed = 0;
      for (const table of ["memories", "conversation_turns", "exchanges"]) {
        removed += Number(this.db.prepare(`DELETE FROM ${table}`).run().changes);
      }
      this.db.prepare("DELETE FROM resets").run();
      this.db.prepare("INSERT INTO resets (user_id, at) VALUES ('*', ?)").run(Date.now());
      return removed > 0;
    });
  }

  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

function visibilityParams(context: ChatContext): Record<string, SQLInputValue> {
  return { userId: context.userId, chatId: context.chatId, direct: context.direct ? 1 : 0 };
}

function toRecord(row: Row): MemoryRecord {
  return {
    id: Number(row.id),
    subjectUserId: typeof row.subject_user_id === "string" ? row.subject_user_id : null,
    chatId: String(row.chat_id),
    direct: Number(row.direct) === 1,
    kind: String(row.kind) as MemoryKind,
    content: String(row.content),
    importance: Number(row.importance),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    lastRecalledAt: row.last_recalled_at == null ? null : Number(row.last_recalled_at),
  };
}

export function normalizeWireMessages(input: unknown): WireMessage[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const messages: WireMessage[] = [];
  for (const raw of input) {
    if (typeof raw !== "object" || raw === null) continue;
    const item = raw as Record<string, unknown>;
    const role = item.role === "assistant" ? "assistant" : item.role === "user" ? "user" : null;
    if (role && typeof item.content === "string") messages.push({ role, content: item.content });
  }
  return messages.length > 0 ? messages : undefined;
}

function parseWireMessages(raw: string): WireMessage[] | undefined {
  try {
    return normalizeWireMessages(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

function loadSqlite(): SqliteModule {
  try {
    return require("node:sqlite") as SqliteModule;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`SQLite runtime unavailable: ${message}`);
  }
}
