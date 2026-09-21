import { randomUUID } from "node:crypto";
import path from "node:path";

import { resolveDataPath } from "../config/paths.js";
import { readTodos, saveTodos } from "./persistence.js";
import { serial } from "../runtime/serial.js";
import { checkExecution } from "../runtime/execution.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_TODO_ITEMS = 100;

export type TodoItem = {
  id: string;
  content: string;
  completed: boolean;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  completedAt?: number;
};

export type TodoListOutput = {
  items: TodoItem[];
  markdown: string;
  context: string;
};

export type TodoMutationOutput = {
  ok: boolean;
  item?: TodoItem;
  items: TodoItem[];
  markdown: string;
  error?: string;
};

export async function listTodos(userId: string): Promise<TodoListOutput> {
  const items = await loadVisibleTodos(userId);
  return {
    items,
    markdown: formatTodoMarkdown(items),
    context: formatTodoContext(items)
  };
}

export async function addTodo(userId: string, content: string): Promise<TodoMutationOutput> {
  const normalized = normalizeContent(content);
  if (!normalized) {
    return mutationError(userId, "내용을 확인하지 못했습니다.");
  }

  return mutateTodos(userId, (items) => {
    if (items.length >= MAX_TODO_ITEMS) {
      return { ok: false, items, markdown: formatTodoMarkdown(items), error: "등록 가능한 항목 수를 초과했습니다." };
    }
    const now = Date.now();
    const item: TodoItem = {
      id: createTodoId(), content: normalized, completed: false,
      createdAt: now, updatedAt: now, expiresAt: now + DAY_MS,
    };
    const next = visibleTodos([...items, item], now);
    return { ok: true, item, items: next, markdown: formatTodoMarkdown(next) };
  });
}

export async function completeTodo(userId: string, query: string): Promise<TodoMutationOutput> {
  return mutateMatchedTodo(userId, query, (item, now) => ({
    ...item,
    completed: true,
    completedAt: now,
    updatedAt: now
  }));
}

export async function updateTodo(
  userId: string,
  query: string,
  content: string
): Promise<TodoMutationOutput> {
  const normalized = normalizeContent(content);
  if (!normalized) {
    return mutationError(userId, "수정할 내용을 확인하지 못했습니다.");
  }
  return mutateMatchedTodo(userId, query, (item, now) => ({
    ...item,
    content: normalized,
    updatedAt: now
  }));
}

export async function deleteTodo(userId: string, query: string): Promise<TodoMutationOutput> {
  return mutateTodos(userId, (items) => {
    const match = findTodoMatch(items.filter((item) => !item.completed), query);
    if (!match) return missingTodo(items);
    const next = items.filter((item) => item.id !== match.id);
    return { ok: true, item: match, items: next, markdown: formatTodoMarkdown(next) };
  });
}

export function formatTodoMarkdown(items: TodoItem[]): string {
  const header = "오늘 할 일 입니다. 선생님.\n보조가 필요하면 말씀해 주십시오.";
  if (items.length === 0) {
    return `${header}\n\n- [ ] 등록된 항목이 없습니다.`;
  }
  return `${header}\n\n${items.map(formatTodoLine).join("\n")}`;
}

export function formatTodoContext(items: TodoItem[]): string {
  if (items.length === 0) {
    return "[]";
  }
  return items.map((item) => JSON.stringify({
    id: item.id,
    completed: item.completed,
    content: item.content
  })).join("\n");
}

function formatTodoLine(item: TodoItem): string {
  const mark = item.completed ? "x" : " ";
  return `- [${mark}] ${item.content}`;
}

async function mutateMatchedTodo(
  userId: string,
  query: string,
  mutate: (item: TodoItem, now: number) => TodoItem
): Promise<TodoMutationOutput> {
  return mutateTodos(userId, (items) => {
    const match = findTodoMatch(items.filter((item) => !item.completed), query);
    if (!match) return missingTodo(items);
    const changed = mutate(match, Date.now());
    const next = visibleTodos(items.map((item) => item.id === match.id ? changed : item), Date.now());
    return { ok: true, item: changed, items: next, markdown: formatTodoMarkdown(next) };
  });
}

function missingTodo(items: TodoItem[]): TodoMutationOutput {
  return { ok: false, items, markdown: formatTodoMarkdown(items), error: "대상 항목을 찾지 못했습니다." };
}

async function mutateTodos(userId: string, change: (items: TodoItem[]) => TodoMutationOutput): Promise<TodoMutationOutput> {
  const filePath = todoFilePath(userId);
  return serial(filePath, async () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      checkExecution();
      const snapshot = await readTodos(filePath);
      const result = change(visibleTodos(snapshot.items, Date.now()));
      if (!result.ok || await saveTodos(filePath, snapshot.revision, result.items)) return result;
    }
    throw new Error("할 일 저장이 겹쳐 완료하지 못했습니다. 잠시 후 다시 요청해 주십시오.");
  });
}

async function mutationError(userId: string, error: string): Promise<TodoMutationOutput> {
  const items = await loadVisibleTodos(userId);
  return {
    ok: false,
    items,
    markdown: formatTodoMarkdown(items),
    error
  };
}

async function loadVisibleTodos(userId: string): Promise<TodoItem[]> {
  return visibleTodos((await readTodos(todoFilePath(userId))).items, Date.now());
}

function visibleTodos(items: TodoItem[], now: number): TodoItem[] {
  return normalizeTodos(items)
    .filter((item) => !item.completed || item.expiresAt > now)
    .sort((a, b) => Number(a.completed) - Number(b.completed) || a.createdAt - b.createdAt)
    .slice(0, MAX_TODO_ITEMS);
}

function normalizeTodos(items: unknown[]): TodoItem[] {
  return items
    .map((item) => normalizeTodo(item))
    .filter((item): item is TodoItem => Boolean(item));
}

function normalizeTodo(raw: unknown): TodoItem | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const item = raw as Partial<TodoItem>;
  const content = normalizeContent(item.content ?? "");
  if (!content) {
    return undefined;
  }
  const createdAt = positiveNumber(item.createdAt) ?? Date.now();
  const updatedAt = positiveNumber(item.updatedAt) ?? createdAt;
  const expiresAt = positiveNumber(item.expiresAt) ?? createdAt + DAY_MS;
  const completedAt = positiveNumber(item.completedAt);
  return {
    id: normalizeId(item.id ?? "") || createTodoId(),
    content,
    completed: Boolean(item.completed),
    createdAt,
    updatedAt,
    expiresAt,
    ...(completedAt ? { completedAt } : {})
  };
}

function findTodoMatch(items: TodoItem[], query: string): TodoItem | undefined {
  const normalized = normalizeMatchText(query);
  if (!normalized) {
    return undefined;
  }
  return (
    items.find((item) => normalizeMatchText(item.id) === normalized) ??
    items.find((item) => normalizeMatchText(item.id).startsWith(normalized)) ??
    items.find((item) => normalizeMatchText(item.content) === normalized) ??
    items.find((item) => normalizeMatchText(item.content).includes(normalized)) ??
    items.find((item) => normalized.includes(normalizeMatchText(item.content)))
  );
}

function todoFilePath(userId: string): string {
  return path.join(resolveTodoDir(), `${safeUserId(userId)}.json`);
}

function resolveTodoDir(): string {
  const explicit = process.env.PLANABRAIN_TODO_DIR?.trim();
  if (explicit) {
    return resolveDataPath(explicit);
  }
  const indexPath = resolveDataPath(
    process.env.PLANABRAIN_INDEX_PATH ?? ".planabrain/index.json",
  );
  return path.join(path.dirname(indexPath), "todos");
}

function safeUserId(userId: string): string {
  const value = String(userId).trim().replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 200);
  return value || "default";
}

function createTodoId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 12);
}

function normalizeId(value: unknown): string {
  return String(value ?? "").trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
}

function normalizeContent(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
}

function normalizeMatchText(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[()[\]{}"'`.,!?。！？]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function positiveNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}
