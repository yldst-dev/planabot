import { readFile } from "node:fs/promises";

import { interpretTodoRequest } from "../../todo/intent.js";
import { addTodo, completeTodo, deleteTodo, listTodos, updateTodo } from "../../todo/store.js";

export async function runTodoListCommand(args: string[]): Promise<void> {
  const [userId] = args;
  ensure(Boolean(userId), "Usage: planabrain todo-list <userId>");
  const result = await listTodos(String(userId));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

export async function runTodoAddCommand(args: string[]): Promise<void> {
  const [userId, ...parts] = args;
  ensure(Boolean(userId), "Usage: planabrain todo-add <userId> <content>");
  const content = await resolveText(parts, "Usage: planabrain todo-add <userId> <content>");
  const result = await addTodo(String(userId), content);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

export async function runTodoCompleteCommand(args: string[]): Promise<void> {
  const [userId, ...parts] = args;
  ensure(Boolean(userId), "Usage: planabrain todo-complete <userId> <query>");
  const query = await resolveText(parts, "Usage: planabrain todo-complete <userId> <query>");
  const result = await completeTodo(String(userId), query);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

export async function runTodoUpdateCommand(args: string[]): Promise<void> {
  const [userId, query, ...parts] = args;
  ensure(Boolean(userId && query), "Usage: planabrain todo-update <userId> <query> <content>");
  const content = await resolveText(parts, "Usage: planabrain todo-update <userId> <query> <content>");
  const result = await updateTodo(String(userId), String(query), content);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

export async function runTodoDeleteCommand(args: string[]): Promise<void> {
  const [userId, ...parts] = args;
  ensure(Boolean(userId), "Usage: planabrain todo-delete <userId> <query>");
  const query = await resolveText(parts, "Usage: planabrain todo-delete <userId> <query>");
  const result = await deleteTodo(String(userId), query);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

export async function runTodoInterpretCommand(args: string[]): Promise<void> {
  const [userId, ...parts] = args;
  ensure(Boolean(userId), "Usage: planabrain todo-interpret <userId> <text>");
  const text = await resolveText(parts, "Usage: planabrain todo-interpret <userId> <text>");
  const result = await interpretTodoRequest(String(userId), text);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function resolveText(parts: string[], usage: string): Promise<string> {
  const text = parts.join(" ").trim();
  if (text) {
    return text;
  }
  const textFile = process.env.PLANABRAIN_TODO_TEXT_FILE?.trim();
  if (textFile) {
    try {
      return (await readFile(textFile, "utf8")).trim();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`todo 텍스트 파일 읽기 실패: ${message}`);
    }
  }
  ensure(false, usage);
  return "";
}

function ensure(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}
