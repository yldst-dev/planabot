import { COMMAND_NAMES, isCommand, type Command } from "./registry.js";

export type { Command };

export function parseCli(argv: string[]): { command: Command; args: string[] } {
  const [, , command, ...rest] = argv;
  if (!command || !isCommand(command)) {
    throw new Error(`Usage: planabrain <${COMMAND_NAMES.join("|")}> [...]`);
  }
  return { command, args: rest };
}
