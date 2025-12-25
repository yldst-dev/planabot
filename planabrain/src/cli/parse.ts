export type Command = "ingest" | "ask";

export function parseCli(argv: string[]): { command: Command; args: string[] } {
  const [, , command, ...rest] = argv;
  if (command !== "ingest" && command !== "ask") {
    throw new Error("Usage: planabrain <ingest|ask> [...]");
  }
  return { command, args: rest };
}
