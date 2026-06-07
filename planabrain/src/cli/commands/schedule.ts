import { readFile } from "node:fs/promises";

import { interpretScheduleRequest } from "../../schedule/intent.js";

export async function runScheduleInterpretCommand(args: string[]): Promise<void> {
  const text = await resolveText(args, "Usage: planabrain schedule-interpret <text>");
  const result = interpretScheduleRequest(text);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function resolveText(parts: string[], usage: string): Promise<string> {
  const text = parts.join(" ").trim();
  if (text) {
    return text;
  }
  const textFile = process.env.PLANABRAIN_SCHEDULE_TEXT_FILE?.trim();
  if (textFile) {
    try {
      return (await readFile(textFile, "utf8")).trim();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`schedule 텍스트 파일 읽기 실패: ${message}`);
    }
  }
  ensure(false, usage);
  return "";
}

function ensure(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}
