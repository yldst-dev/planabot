import { randomUUID } from "node:crypto";
import { MemoryConflictError } from "./concurrency.js";
import { promises as fs } from "node:fs";
import path from "node:path";

import { createEmptyState, normalizeState } from "./state-normalize.js";
import {
  ensureScope,
  readJsonFile,
  parseScopeId,
  safeId,
  scopeDir,
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
    let foundVersion = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const versions = (await fs.readdir(dir)).filter((file) => /^state-[0-9]+\.json$/u.test(file))
        .sort((a, b) => Number(b.slice(6, -5)) - Number(a.slice(6, -5)));
      foundVersion = versions.length > 0;
      try {
        const raw = await fs.readFile(path.join(dir, versions[0] ?? "state.json"), "utf8");
        if (!raw && versions.length > 0) continue;
        return normalizeState(JSON.parse(raw));
      } catch (error) {
        if (!isEnoent(error)) throw error;
        if (versions.length === 0) break;
      }
    }
    if (foundVersion) throw new Error("최신 기억 파일을 읽지 못했습니다.");
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
    const current = await this.loadState(scope);
    if ((current.revision ?? 0) !== (state.revision ?? 0)) throw new MemoryConflictError();
    const revision = (current.revision ?? 0) + 1;
    const temporary = path.join(dir, `${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, JSON.stringify({ ...normalizeState(state), revision }), { mode: 0o600 });
      try {
        await fs.link(temporary, path.join(dir, `state-${revision}.json`));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new MemoryConflictError();
        throw error;
      }
    } finally {
      await fs.rm(temporary, { force: true });
    }
    const obsolete = (await fs.readdir(dir)).filter((file) => /^state-[0-9]+\.json$/u.test(file) && Number(file.slice(6, -5)) < revision - 1);
    await Promise.all(obsolete.map((file) => fs.truncate(path.join(dir, file), 0).catch(() => { })));
  }

  async removeScope(scope: ScopeDescriptor): Promise<void> {
    await this.clearScope(scope);
  }

  private async clearScope(scope: ScopeDescriptor): Promise<void> {
    let clearedRevision = 0;
    for (let attempt = 0; ; attempt += 1) {
      const current = await this.loadState(scope);
      try {
        await this.saveState(scope, { ...createEmptyState(), revision: current.revision ?? 0 });
        clearedRevision = (current.revision ?? 0) + 1;
        break;
      } catch (error) {
        if (!(error instanceof MemoryConflictError) || attempt >= 4) throw error;
      }
    }
    const dir = scopeDir(this.rootDir, scope.scopeId);
    const previous = (await fs.readdir(dir)).filter((file) => /^state-[0-9]+\.json$/u.test(file) && Number(file.slice(6, -5)) < clearedRevision);
    await Promise.all(previous.map((file) => fs.truncate(path.join(dir, file), 0)));
    for (const file of ["state.json", "working.json", "episodic.json", "semantic.json", "summary.json"]) {
      await fs.rm(path.join(dir, file), { force: true });
    }
  }

  async resetUser(userId: string): Promise<boolean> {
    return this.clearMatching(userId);
  }

  async resetAll(): Promise<boolean> {
    return this.clearMatching();
  }

  private async clearMatching(userId?: string): Promise<boolean> {
    await fs.mkdir(this.rootDir, { recursive: true });
    const entries = await fs.readdir(this.rootDir, { withFileTypes: true });
    let removed = false;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const scope = parseScopeId(entry.name);
      if (!scope) continue;
      const state = await this.loadState(scope);
      if (userId !== undefined && scope.userId !== safeId(userId) && !state.participantIds?.includes(safeId(userId))) continue;
      await this.clearScope(scope);
      removed = true;
    }
    return removed;
  }

  close(): void { }
}

function isEnoent(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const candidate = error as NodeJS.ErrnoException;
  return candidate.code === "ENOENT";
}
