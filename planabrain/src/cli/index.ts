import fs from "fs";
import path from "path";
import dotenv from "dotenv";

function loadEnv(): void {
  const explicitPath = process.env.DOTENV_CONFIG_PATH;
  if (explicitPath) {
    dotenv.config({ path: explicitPath });
    return;
  }

  const cwd = process.cwd();
  const candidates = [path.join(cwd, ".env"), path.join(cwd, "..", ".env")];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      dotenv.config({ path: candidate });
      return;
    }
  }

  dotenv.config();
}

loadEnv();

import { loadSettings } from "../config/settings.js";
import { runAskCommand } from "./commands/ask.js";
import { runIngestCommand } from "./commands/ingest.js";
import {
  runMemoryAssistantCommand,
  runMemoryDeleteFactCommand,
  runMemoryListFactsCommand,
  runMemoryMigrateJsonCommand,
  runMemoryPrepareCommand,
  runMemoryResetAllCommand,
  runMemoryResetUserCommand,
  runMemoryUpdateFactCommand
} from "./commands/memory.js";
import { runScheduleInterpretCommand } from "./commands/schedule.js";
import { runTokensCommand } from "./commands/tokens.js";
import {
  runTodoAddCommand,
  runTodoCompleteCommand,
  runTodoDeleteCommand,
  runTodoInterpretCommand,
  runTodoListCommand,
  runTodoUpdateCommand
} from "./commands/todo.js";
import { parseCli } from "./parse.js";
import {
  formatStructuredErrorLine,
  toStructuredError,
} from "../integrations/providerError.js";

export async function main(argv: string[]): Promise<void> {
  const parsed = parseCli(argv);

  if (parsed.command === "tokens") {
    await runTokensCommand(parsed.args);
    return;
  }
  if (parsed.command === "memory-prepare") {
    await runMemoryPrepareCommand(parsed.args);
    return;
  }
  if (parsed.command === "memory-assistant") {
    await runMemoryAssistantCommand(parsed.args);
    return;
  }
  if (parsed.command === "memory-reset-user") {
    await runMemoryResetUserCommand(parsed.args);
    return;
  }
  if (parsed.command === "memory-reset-all") {
    await runMemoryResetAllCommand();
    return;
  }
  if (parsed.command === "memory-list-facts") {
    await runMemoryListFactsCommand(parsed.args);
    return;
  }
  if (parsed.command === "memory-delete-fact") {
    await runMemoryDeleteFactCommand(parsed.args);
    return;
  }
  if (parsed.command === "memory-update-fact") {
    await runMemoryUpdateFactCommand(parsed.args);
    return;
  }
  if (parsed.command === "memory-migrate-json") {
    await runMemoryMigrateJsonCommand(parsed.args);
    return;
  }
  if (parsed.command === "todo-list") {
    await runTodoListCommand(parsed.args);
    return;
  }
  if (parsed.command === "todo-add") {
    await runTodoAddCommand(parsed.args);
    return;
  }
  if (parsed.command === "todo-complete") {
    await runTodoCompleteCommand(parsed.args);
    return;
  }
  if (parsed.command === "todo-update") {
    await runTodoUpdateCommand(parsed.args);
    return;
  }
  if (parsed.command === "todo-delete") {
    await runTodoDeleteCommand(parsed.args);
    return;
  }
  if (parsed.command === "todo-interpret") {
    await runTodoInterpretCommand(parsed.args);
    return;
  }
  if (parsed.command === "schedule-interpret") {
    await runScheduleInterpretCommand(parsed.args);
    return;
  }

  const settings = loadSettings();

  if (parsed.command === "ingest") {
    await runIngestCommand(parsed.args, settings);
    return;
  }

  if (parsed.command === "ask") {
    await runAskCommand(parsed.args, settings);
    return;
  }
}

try {
  await main(process.argv);
} catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${message}\n`);
  const structured = toStructuredError(err);
  process.stderr.write(`${formatStructuredErrorLine(structured)}\n`);
  process.exitCode = 1;
}
