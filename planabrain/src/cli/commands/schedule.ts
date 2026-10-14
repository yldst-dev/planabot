import { readFile } from "node:fs/promises";

import { classifyTurn, hasBareHour } from "../../decision/turnSignals.js";
import { interpretScheduleRequest, type ScheduleAction } from "../../schedule/intent.js";

const LIST_ONLY_PATTERN = /^(?:\s*(?:목록|리스트|전체|확인|보여\s*줘|보여|뭐\s*있어|뭐\s*있지|남은\s*거|일정|알림|타이머|좀))+\s*[?.!]*$/u;

export async function runScheduleInterpretCommand(args: string[]): Promise<void> {
  const text = await resolveText(args, "Usage: planabrain schedule-interpret <text>");
  const meridiem = hasBareHour(text)
    ? (await classifyTurn({ message: text, nowMs: Number(process.env.PLANABRAIN_NOW_MS) || undefined }))?.meridiem
    : undefined;
  const result = interpretScheduleRequest(text, { action: commandAction(text), meridiem });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

export function commandAction(text: string): ScheduleAction {
  if (/취소|삭제|지워|제거|없애/u.test(text)) return "cancel";
  if (!text.trim() || LIST_ONLY_PATTERN.test(text)) return "list";
  return "add";
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
