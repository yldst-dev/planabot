export type Command =
  | "ingest"
  | "ask"
  | "tokens"
  | "memory-prepare"
  | "memory-assistant"
  | "memory-reset-user"
  | "memory-reset-all"
  | "memory-list-facts"
  | "memory-delete-fact"
  | "memory-update-fact"
  | "memory-migrate-json"
  | "todo-list"
  | "todo-add"
  | "todo-complete"
  | "todo-update"
  | "todo-delete"
  | "todo-interpret";

export function parseCli(argv: string[]): { command: Command; args: string[] } {
  const [, , command, ...rest] = argv;
  if (
    command !== "ingest" &&
    command !== "ask" &&
    command !== "tokens" &&
    command !== "memory-prepare" &&
    command !== "memory-assistant" &&
    command !== "memory-reset-user" &&
    command !== "memory-reset-all" &&
    command !== "memory-list-facts" &&
    command !== "memory-delete-fact" &&
    command !== "memory-update-fact" &&
    command !== "memory-migrate-json" &&
    command !== "todo-list" &&
    command !== "todo-add" &&
    command !== "todo-complete" &&
    command !== "todo-update" &&
    command !== "todo-delete" &&
    command !== "todo-interpret"
  ) {
    throw new Error(
      "Usage: planabrain <ingest|ask|tokens|memory-prepare|memory-assistant|memory-reset-user|memory-reset-all|memory-list-facts|memory-delete-fact|memory-update-fact|memory-migrate-json|todo-list|todo-add|todo-complete|todo-update|todo-delete|todo-interpret> [...]"
    );
  }
  return { command, args: rest };
}
