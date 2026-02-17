import { type Dirent, promises as fs } from "node:fs";
import path from "node:path";

import { loadConfig } from "./config.js";
import { JsonMemoryStore } from "./json-store.js";
import { normalizeState } from "./state-normalize.js";
import { parseScopeId } from "./storage.js";
import { SqliteMemoryStore } from "./sqlite-store.js";

export interface JsonMigrationResult {
  sourceDir: string;
  sqlitePath: string;
  migratedScopes: number;
  skippedScopes: number;
  turns: number;
  semanticFacts: number;
  episodicItems: number;
  summaryItems: number;
}

export async function migrateJsonMemoryToSqlite(args?: {
  sourceDir?: string;
  sqlitePath?: string;
}): Promise<JsonMigrationResult> {
  const config = loadConfig();
  const sourceDir = path.resolve(args?.sourceDir ?? config.rootDir);
  const sqlitePath = path.resolve(args?.sqlitePath ?? config.sqlitePath);

  const jsonStore = new JsonMemoryStore(sourceDir);
  const sqliteStore = new SqliteMemoryStore(sqlitePath);

  let entries: Dirent[];
  try {
    entries = await fs.readdir(sourceDir, { withFileTypes: true });
  } catch (error: unknown) {
    if (isEnoent(error)) {
      sqliteStore.close();
      return {
        sourceDir,
        sqlitePath,
        migratedScopes: 0,
        skippedScopes: 0,
        turns: 0,
        semanticFacts: 0,
        episodicItems: 0,
        summaryItems: 0
      };
    }
    sqliteStore.close();
    throw error;
  }

  let migratedScopes = 0;
  let skippedScopes = 0;
  let turns = 0;
  let semanticFacts = 0;
  let episodicItems = 0;
  let summaryItems = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const scope = parseScopeId(entry.name);
    if (!scope) {
      skippedScopes += 1;
      continue;
    }

    const state = normalizeState(await jsonStore.loadState(scope));
    await sqliteStore.saveState(scope, state);
    migratedScopes += 1;
    turns += state.working.turns.length;
    semanticFacts += state.semantic.facts.length;
    episodicItems += state.episodic.items.length;
    summaryItems += state.summary.items.length;
  }

  sqliteStore.close();

  return {
    sourceDir,
    sqlitePath,
    migratedScopes,
    skippedScopes,
    turns,
    semanticFacts,
    episodicItems,
    summaryItems
  };
}

function isEnoent(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const candidate = error as NodeJS.ErrnoException;
  return candidate.code === "ENOENT";
}
