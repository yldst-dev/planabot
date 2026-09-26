import { runExecution } from "../runtime/execution.js";
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
import { parseCli } from "./parse.js";
import { COMMANDS } from "./registry.js";
import {
  formatStructuredErrorLine,
  toStructuredError,
} from "../integrations/providerError.js";

export async function main(argv: string[]): Promise<void> {
  const parsed = parseCli(argv);
  const handler = COMMANDS[parsed.command];
  if (parsed.command === "serve" || parsed.command === "turn-prepare") {
    await handler(parsed.args, { loadSettings });
  } else {
    const deadline = Number(process.env.PLANABRAIN_DEADLINE_MS);
    await runExecution(parsed.command, () => handler(parsed.args, { loadSettings }), {
      requestId: process.env.PLANABRAIN_REQUEST_ID,
      deadlineMs: Number.isFinite(deadline) && deadline > 0 ? deadline : undefined,
    });
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
