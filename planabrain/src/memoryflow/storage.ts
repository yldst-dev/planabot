import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { ScopeDescriptor, ScopeParams } from "./types.js";

export function buildScopeId(params: ScopeParams): string {
  const chatId = safeId(params.chatId ?? "global");
  if (params.scopeKind === "group") {
    return `group__${chatId}`;
  }
  return `${safeId(params.userId)}__${chatId}`;
}

export function buildScopeDescriptor(params: ScopeParams): ScopeDescriptor {
  const scopeKind = params.scopeKind === "group" ? "group" : "user";
  const chatId = safeId(params.chatId ?? "global");
  const userId = scopeKind === "group" ? "group" : safeId(params.userId);
  return {
    scopeId: buildScopeId({ userId, chatId, scopeKind }),
    userId,
    chatId,
    scopeKind
  };
}

export function parseScopeId(scopeId: string): ScopeDescriptor | null {
  const trimmed = String(scopeId ?? "").trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith("group__")) {
    const chatPart = safeId(trimmed.slice("group__".length));
    if (!chatPart) {
      return null;
    }
    return {
      scopeId: buildScopeId({ userId: "group", chatId: chatPart, scopeKind: "group" }),
      userId: "group",
      chatId: chatPart,
      scopeKind: "group"
    };
  }
  const delimiter = "__";
  const idx = trimmed.indexOf(delimiter);
  if (idx <= 0 || idx + delimiter.length >= trimmed.length) {
    return null;
  }
  const userId = safeId(trimmed.slice(0, idx));
  const chatId = safeId(trimmed.slice(idx + delimiter.length));
  return {
    scopeId: buildScopeId({ userId, chatId, scopeKind: "user" }),
    userId,
    chatId,
    scopeKind: "user"
  };
}

export function scopeDir(rootDir: string, scopeId: string): string {
  return path.join(rootDir, scopeId);
}

export async function ensureScope(rootDir: string, scopeId: string): Promise<void> {
  await fs.mkdir(scopeDir(rootDir, scopeId), { recursive: true });
}

export async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch (error: unknown) {
    if (isEnoent(error)) {
      return fallback;
    }
    return fallback;
  }
}

export async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${randomUUID()}.tmp`;
  const payload = JSON.stringify(data);
  await fs.writeFile(temp, payload, "utf-8");
  await fs.rename(temp, filePath);
}

export function safeId(raw: string | undefined): string {
  const base = String(raw ?? "").trim();
  if (!base) {
    return "default";
  }
  const clean = base.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 200);
  return clean || "default";
}

export async function removeScope(rootDir: string, scopeId: string): Promise<void> {
  const dir = scopeDir(rootDir, scopeId);
  await fs.rm(dir, { recursive: true, force: true });
}

function isEnoent(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const candidate = error as NodeJS.ErrnoException;
  return candidate.code === "ENOENT";
}
