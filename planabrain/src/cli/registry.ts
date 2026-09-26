import type { Settings } from "../config/settings.js";
import { runAskCommand } from "./commands/ask.js";
import {
  runMemoryExchangeCommand,
  runMemoryForgetCommand,
  runMemoryListCommand,
  runMemoryResetAllCommand,
  runMemoryResetUserCommand,
} from "./commands/memory.js";
import { runScheduleInterpretCommand } from "./commands/schedule.js";
import { runServeCommand } from "./commands/serve.js";
import { runTodoListCommand } from "./commands/todo.js";
import { runTokensCommand } from "./commands/tokens.js";
import { runTurnPrepareCommand } from "./commands/turn.js";

export type CommandContext = {
  loadSettings: () => Settings;
};

export type CommandHandler = (args: string[], context: CommandContext) => Promise<void>;

export const COMMANDS = {
  ask: (args, context) => runAskCommand(args, context.loadSettings()),
  tokens: (args) => runTokensCommand(args),
  "turn-prepare": () => runTurnPrepareCommand(),
  serve: (args, context) => runServeCommand(args, context),
  "memory-exchange": (args, context) => runMemoryExchangeCommand(args, context.loadSettings()),
  "memory-list": (args) => runMemoryListCommand(args),
  "memory-forget": (args) => runMemoryForgetCommand(args),
  "memory-reset-user": (args) => runMemoryResetUserCommand(args),
  "memory-reset-all": () => runMemoryResetAllCommand(),
  "todo-list": (args) => runTodoListCommand(args),
  "schedule-interpret": (args) => runScheduleInterpretCommand(args),
} satisfies Record<string, CommandHandler>;

export type Command = keyof typeof COMMANDS;

export const COMMAND_NAMES = Object.keys(COMMANDS) as Command[];

export function isCommand(value: string): value is Command {
  return Object.prototype.hasOwnProperty.call(COMMANDS, value);
}
