import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { TodoItem } from "./store.js";
import { checkExecution } from "../runtime/execution.js";

type Snapshot = { revision: number; items: TodoItem[]; };

export async function readTodos(filePath: string): Promise<Snapshot> {
  const dir = `${filePath}.revisions`;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    let files: string[];
    try {
      files = await fs.readdir(dir);
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
      files = [];
    }
    const revision = files.filter((file) => /^[1-9][0-9]*\.json$/u.test(file))
      .reduce((latest, file) => Math.max(latest, Number(file.slice(0, -5))), 0);
    let raw: string;
    try {
      raw = await fs.readFile(revision ? path.join(dir, `${revision}.json`) : filePath, "utf8");
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
      if (revision) continue;
      return { revision: 0, items: [] };
    }
    if (!raw && revision) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("할 일 파일이 손상되어 읽지 못했습니다.");
    }
    if (typeof parsed !== "object" || parsed === null) throw new Error("할 일 파일 형식이 올바르지 않습니다.");
    const file = parsed as { version?: unknown; items?: unknown; };
    if (file.version !== 1 || !Array.isArray(file.items) || !file.items.every(isTodo)) {
      throw new Error("할 일 파일 형식이 올바르지 않습니다.");
    }
    return { revision, items: file.items };
  }
  throw new Error("최신 할 일 파일을 읽지 못했습니다.");
}

export async function saveTodos(filePath: string, revision: number, items: TodoItem[]): Promise<boolean> {
  checkExecution();
  const dir = `${filePath}.revisions`;
  await fs.mkdir(dir, { recursive: true });
  const temporary = path.join(dir, `${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, JSON.stringify({ version: 1, items }), { mode: 0o600 });
    checkExecution();
    try {
      await fs.link(temporary, path.join(dir, `${revision + 1}.json`));
    } catch (error) {
      if (hasCode(error, "EEXIST")) return false;
      throw error;
    }
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
  const obsolete = (await fs.readdir(dir).catch(() => [] as string[])).filter((file) => /^[1-9][0-9]*\.json$/u.test(file) && Number(file.slice(0, -5)) < revision);
  await Promise.all(obsolete.map((file) => fs.truncate(path.join(dir, file), 0).catch(() => {})));
  return true;
}

function isTodo(value: unknown): value is TodoItem {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Partial<TodoItem>;
  return typeof item.id === "string" && typeof item.content === "string" &&
    typeof item.completed === "boolean" &&
    [item.createdAt, item.updatedAt, item.expiresAt].every((at) => typeof at === "number" && Number.isFinite(at));
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
