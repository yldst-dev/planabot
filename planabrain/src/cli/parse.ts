export type Command = "ingest" | "ask" | "tokens";

export function parseCli(argv: string[]): { command: Command; args: string[] } {
  const [, , command, ...rest] = argv;
  if (command !== "ingest" && command !== "ask" && command !== "tokens") {
    throw new Error("Usage: planabrain <ingest|ask|tokens> [...]");
  }
  return { command, args: rest };
}
