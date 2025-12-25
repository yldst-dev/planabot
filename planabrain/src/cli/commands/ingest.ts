import type { Settings } from "../../config/settings.js";
import { ingestDirectory } from "../../rag/ingest.js";

export async function runIngestCommand(args: string[], settings: Settings): Promise<void> {
  const sourceDir = args[0];
  if (!sourceDir) {
    throw new Error("Usage: planabrain ingest <sourceDir>");
  }

  const count = await ingestDirectory({ sourceDir, settings });
  process.stdout.write(`${count}\n`);
}
