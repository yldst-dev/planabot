import type { Settings } from "../config/settings.js";
import { runAskCommand } from "./commands/ask.js";
import {
  runMemoryAssistantCommand,
  runMemoryDeleteFactCommand,
  runMemoryExchangeCommand,
  runMemoryListFactsCommand,
  runMemoryMigrateJsonCommand,
  runMemoryPrepareCommand,
  runMemoryResetAllCommand,
  runMemoryResetUserCommand,
  runMemoryUpdateFactCommand,
} from "./commands/memory.js";
import { runScheduleInterpretCommand } from "./commands/schedule.js";
import {
  runTodoAddCommand,
  runTodoCompleteCommand,
  runTodoDeleteCommand,
  runTodoInterpretCommand,
  runTodoListCommand,
  runTodoUpdateCommand,
} from "./commands/todo.js";
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
  "memory-prepare": (args) => runMemoryPrepareCommand(args),
  "memory-assistant": (args) => runMemoryAssistantCommand(args),
  "memory-exchange": (args) => runMemoryExchangeCommand(args),
  "memory-reset-user": (args) => runMemoryResetUserCommand(args),
  "memory-reset-all": () => runMemoryResetAllCommand(),
  "memory-list-facts": (args) => runMemoryListFactsCommand(args),
  "memory-delete-fact": (args) => runMemoryDeleteFactCommand(args),
  "memory-update-fact": (args) => runMemoryUpdateFactCommand(args),
  "memory-migrate-json": (args) => runMemoryMigrateJsonCommand(args),
  "todo-list": (args) => runTodoListCommand(args),
  "todo-add": (args) => runTodoAddCommand(args),
  "todo-complete": (args) => runTodoCompleteCommand(args),
  "todo-update": (args) => runTodoUpdateCommand(args),
  "todo-delete": (args) => runTodoDeleteCommand(args),
  "todo-interpret": (args) => runTodoInterpretCommand(args),
  "schedule-interpret": (args) => runScheduleInterpretCommand(args),
} satisfies Record<string, CommandHandler>;

export type Command = keyof typeof COMMANDS;

export const COMMAND_NAMES = Object.keys(COMMANDS) as Command[];

export function isCommand(value: string): value is Command {
  return Object.prototype.hasOwnProperty.call(COMMANDS, value);
}
