import { promises as fs } from "node:fs";
import path from "node:path";

import type { StoredIndex } from "./types.js";

export async function saveIndex(filePath: string, index: StoredIndex): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(index), "utf-8");
}

export async function loadIndex(filePath: string): Promise<StoredIndex> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch (err: unknown) {
    if (err && typeof err === "object" && "code" in err && (err as { code?: unknown }).code === "ENOENT") {
      throw new Error(
        `Index not found: ${filePath}\nRun: npm run dev -- ingest <sourceDir>`
      );
    }
    throw err;
  }
  const parsed = JSON.parse(raw) as StoredIndex;
  if (parsed.version !== 1) {
    throw new Error("Unsupported index version");
  }
  return parsed;
}
