import { listTodos } from "../../todo/store.js";

export async function runTodoListCommand(args: string[]): Promise<void> {
  const [userId] = args;
  if (!userId) {
    throw new Error("Usage: planabrain todo-list <userId>");
  }
  process.stdout.write(`${JSON.stringify(await listTodos(String(userId)))}\n`);
}
