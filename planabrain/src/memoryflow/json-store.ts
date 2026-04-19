import { type Dirent, promises as fs } from "node:fs";
import path from "node:path";

import { createEmptyState, normalizeState } from "./state-normalize.js";
import {
  ensureScope,
  readJsonFile,
  removeScope,
  safeId,
  scopeDir,
  writeJsonAtomic
} from "./storage.js";
import type { MemoryState, MemoryStore, ScopeDescriptor } from "./types.js";

export class JsonMemoryStore implements MemoryStore {
  private readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
  }

  async loadState(scope: ScopeDescriptor): Promise<MemoryState> {
    await ensureScope(this.rootDir, scope.scopeId);
    const dir = scopeDir(this.rootDir, scope.scopeId);
    const empty = createEmptyState();

    const working = await readJsonFile(path.join(dir, "working.json"), empty.working);
    const episodic = await readJsonFile(path.join(dir, "episodic.json"), empty.episodic);
    const semantic = await readJsonFile(path.join(dir, "semantic.json"), empty.semantic);
    const summary = await readJsonFile(path.join(dir, "summary.json"), empty.summary);

    return normalizeState({
      working,
      episodic,
      semantic,
      summary
    });
  }

  async saveState(scope: ScopeDescriptor, state: MemoryState): Promise<void> {
    const dir = scopeDir(this.rootDir, scope.scopeId);
    await ensureScope(this.rootDir, scope.scopeId);
    await writeJsonAtomic(path.join(dir, "working.json"), state.working);
    await writeJsonAtomic(path.join(dir, "episodic.json"), state.episodic);
    await writeJsonAtomic(path.join(dir, "semantic.json"), state.semantic);
    await writeJsonAtomic(path.join(dir, "summary.json"), state.summary);
  }

  async removeScope(scope: ScopeDescriptor): Promise<void> {
    await removeScope(this.rootDir, scope.scopeId);
  }

  async resetUser(userId: string): Promise<boolean> {
    const prefix = `${safeId(userId)}__`;
    let removed = false;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(this.rootDir, { withFileTypes: true });
    } catch (error: unknown) {
      if (isEnoent(error)) {
        return false;
      }
      throw error;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (!entry.name.startsWith(prefix)) {
        continue;
      }
      await fs.rm(path.join(this.rootDir, entry.name), {
        recursive: true,
        force: true
      });
      removed = true;
    }
    return removed;
  }

  async resetAll(): Promise<boolean> {
    try {
      await fs.rm(this.rootDir, {
        recursive: true,
        force: true
      });
      await fs.mkdir(this.rootDir, { recursive: true });
      return true;
    } catch (error: unknown) {
      if (isEnoent(error)) {
        return false;
      }
      throw error;
    }
  }

  close(): void {}
}

function isEnoent(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const candidate = error as NodeJS.ErrnoException;
  return candidate.code === "ENOENT";
}
