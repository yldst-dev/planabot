import path from "node:path";

import type { EngineConfig } from "./types.js";

export function loadConfig(): EngineConfig {
  const rootDir = path.resolve(
    process.env.PLANABRAIN_LOCAL_MEMORY_DIR ??
      process.env.MEMORY_FLOW_ROOT ??
      ".planabrain/local-memory"
  );
  const sqlitePath = path.resolve(
    process.env.PLANABRAIN_LOCAL_MEMORY_SQLITE_PATH ?? path.join(rootDir, "memory.sqlite")
  );
  const storeKind = parseStoreKind(
    process.env.PLANABRAIN_LOCAL_MEMORY_STORE ?? process.env.MEMORY_FLOW_STORE
  );
  const maxWorkingTurns = parsePositiveInt(
    process.env.PLANABRAIN_LOCAL_MEMORY_MAX_WORKING_TURNS ??
      process.env.MEMORY_FLOW_MAX_WORKING_TURNS,
    24
  );
  const maxEpisodicItems = parsePositiveInt(
    process.env.PLANABRAIN_LOCAL_MEMORY_MAX_EPISODIC_ITEMS ??
      process.env.MEMORY_FLOW_MAX_EPISODIC_ITEMS,
    300
  );
  const maxSummaryItems = parsePositiveInt(
    process.env.PLANABRAIN_LOCAL_MEMORY_MAX_SUMMARY_ITEMS ??
      process.env.MEMORY_FLOW_MAX_SUMMARY_ITEMS,
    80
  );
  const summaryEveryTurns = parsePositiveInt(
    process.env.PLANABRAIN_LOCAL_MEMORY_SUMMARY_EVERY_TURNS ??
      process.env.MEMORY_FLOW_SUMMARY_EVERY_TURNS,
    8
  );
  const compactionEnabled = parseBoolean(
    process.env.PLANABRAIN_LOCAL_MEMORY_COMPACTION_ENABLED,
    true
  );
  const compactionKeepRecentTurns = parsePositiveInt(
    process.env.PLANABRAIN_LOCAL_MEMORY_COMPACTION_KEEP_RECENT_TURNS,
    6
  );
  const compactionMinSourceTurns = parsePositiveInt(
    process.env.PLANABRAIN_LOCAL_MEMORY_COMPACTION_MIN_SOURCE_TURNS,
    summaryEveryTurns
  );
  const defaultTokenBudget = parsePositiveInt(
    process.env.PLANABRAIN_LOCAL_MEMORY_DEFAULT_TOKEN_BUDGET ??
      process.env.MEMORY_FLOW_DEFAULT_TOKEN_BUDGET,
    900
  );
  const groupMemoryEnabled = parseBoolean(
    process.env.PLANABRAIN_LOCAL_GROUP_MEMORY_ENABLED ?? process.env.MEMORY_FLOW_GROUP_ENABLED,
    true
  );
  return {
    rootDir,
    sqlitePath,
    storeKind,
    maxWorkingTurns,
    maxEpisodicItems,
    maxSummaryItems,
    summaryEveryTurns,
    compactionEnabled,
    compactionKeepRecentTurns,
    compactionMinSourceTurns,
    defaultTokenBudget,
    groupMemoryEnabled
  };
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw == null) {
    return fallback;
  }
  const parsed = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null) {
    return fallback;
  }
  const value = raw.trim().toLowerCase();
  if (!value) {
    return fallback;
  }
  if (value === "1" || value === "true" || value === "yes" || value === "on") {
    return true;
  }
  if (value === "0" || value === "false" || value === "no" || value === "off") {
    return false;
  }
  return fallback;
}

function parseStoreKind(raw: string | undefined): EngineConfig["storeKind"] {
  const value = String(raw ?? "").trim().toLowerCase();
  if (value === "json") {
    return "json";
  }
  return "sqlite";
}
