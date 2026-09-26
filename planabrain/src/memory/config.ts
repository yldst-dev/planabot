import { resolveDataPath } from "../config/paths.js";

export type MemoryConfig = {
  databasePath: string;
  maxConversationTurns: number;
  conversationTtlMs: number;
  maxMemoriesPerUser: number;
  writerEnabled: boolean;
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function loadMemoryConfig(env: NodeJS.ProcessEnv = process.env): MemoryConfig {
  return {
    databasePath: resolveDataPath(env.PLANABRAIN_MEMORY_DB_PATH?.trim() || ".planabrain/memory.sqlite"),
    maxConversationTurns: readPositiveInt(env.PLANABRAIN_MEMORY_MAX_TURNS, 24),
    conversationTtlMs: readPositiveInt(env.PLANABRAIN_MEMORY_CONVERSATION_TTL_DAYS, 14) * DAY_MS,
    maxMemoriesPerUser: readPositiveInt(env.PLANABRAIN_MEMORY_MAX_ITEMS, 200),
    writerEnabled: !/^(?:0|false|off|no)$/iu.test(env.PLANABRAIN_MEMORY_WRITER_ENABLED?.trim() ?? ""),
  };
}

function readPositiveInt(raw: string | undefined, fallback: number): number {
  const value = Number.parseInt(String(raw ?? "").trim(), 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
