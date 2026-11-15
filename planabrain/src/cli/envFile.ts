import { readFile } from "node:fs/promises";

export async function readEnvOrFile(key: string): Promise<string | undefined> {
  const file = process.env[`${key}_FILE`]?.trim();
  if (!file) {
    return process.env[key];
  }
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${key}_FILE 읽기 실패: ${message}`);
  }
}
