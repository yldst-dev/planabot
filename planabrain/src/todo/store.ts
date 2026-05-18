import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

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

type TodoFile = {
  version: 1;
  items: TodoItem[];
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

  const now = Date.now();
  const items = visibleTodos(await loadRawTodos(userId), now);
  if (items.length >= MAX_TODO_ITEMS) {
    return mutationError(userId, "등록 가능한 항목 수를 초과했습니다.");
  }
  const item: TodoItem = {
    id: createTodoId(),
    content: normalized,
    completed: false,
    createdAt: now,
    updatedAt: now,
    expiresAt: now + DAY_MS
  };
  const next = [...items, item];
  await saveRawTodos(userId, next);
  const visible = visibleTodos(next, now);
  return {
    ok: true,
    item,
    items: visible,
    markdown: formatTodoMarkdown(visible)
  };
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
  const items = await loadRawTodos(userId);
  const match = findTodoMatch(items.filter((item) => !item.completed), query);
  if (!match) {
    return mutationError(userId, "대상 항목을 찾지 못했습니다.");
  }

  const next = items.filter((item) => item.id !== match.id);
  await saveRawTodos(userId, next);
  const visible = visibleTodos(next, Date.now());
  return {
    ok: true,
    item: match,
    items: visible,
    markdown: formatTodoMarkdown(visible)
  };
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
  const items = await loadRawTodos(userId);
  const match = findTodoMatch(items.filter((item) => !item.completed), query);
  if (!match) {
    return mutationError(userId, "대상 항목을 찾지 못했습니다.");
  }

  const now = Date.now();
  const next = items.map((item) => (item.id === match.id ? mutate(item, now) : item));
  await saveRawTodos(userId, next);
  const visible = visibleTodos(next, now);
  const changed = next.find((item) => item.id === match.id);
  return {
    ok: true,
    item: changed,
    items: visible,
    markdown: formatTodoMarkdown(visible)
  };
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
  const items = await loadRawTodos(userId);
  const now = Date.now();
  const visible = visibleTodos(items, now);
  if (visible.length !== items.length) {
    await saveRawTodos(userId, visible);
  }
  return visible;
}

function visibleTodos(items: TodoItem[], now: number): TodoItem[] {
  return normalizeTodos(items)
    .filter((item) => !item.completed || item.expiresAt > now)
    .sort((a, b) => Number(a.completed) - Number(b.completed) || a.createdAt - b.createdAt)
    .slice(0, MAX_TODO_ITEMS);
}

async function loadRawTodos(userId: string): Promise<TodoItem[]> {
  const filePath = todoFilePath(userId);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) {
      return [];
    }
    throw error;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<TodoFile>;
    return normalizeTodos(Array.isArray(parsed.items) ? parsed.items : []);
  } catch {
    return [];
  }
}

async function saveRawTodos(userId: string, items: TodoItem[]): Promise<void> {
  const filePath = todoFilePath(userId);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const file: TodoFile = {
    version: 1,
    items: normalizeTodos(items)
  };
  await fs.writeFile(filePath, JSON.stringify(file), "utf8");
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
    return path.isAbsolute(explicit) ? explicit : path.resolve(process.cwd(), explicit);
  }
  const indexPath = process.env.PLANABRAIN_INDEX_PATH ?? ".planabrain/index.json";
  const base = path.isAbsolute(indexPath)
    ? path.dirname(indexPath)
    : path.resolve(process.cwd(), path.dirname(indexPath));
  return path.join(base, "todos");
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

function isNodeErrorCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === code);
}
