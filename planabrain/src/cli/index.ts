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
  runMemoryMigrateJsonCommand,
  runMemoryPrepareCommand,
  runMemoryResetUserCommand
} from "./commands/memory.js";
import { runTokensCommand } from "./commands/tokens.js";
import { parseCli } from "./parse.js";

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
  if (parsed.command === "memory-migrate-json") {
    await runMemoryMigrateJsonCommand(parsed.args);
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
  process.exitCode = 1;
}
