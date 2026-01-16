import type { Settings } from "./settings.js";

const KST_TIMEZONE = "Asia/Seoul";

function currentKstTimestamp(): string {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("sv-SE", {
    timeZone: KST_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });

  const parts = formatter.formatToParts(now);
  const values: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== "literal") {
      values[part.type] = part.value;
    }
  }

  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`;
}

export function buildSystemPrompt(settings: Settings): string {
  const kst = currentKstTimestamp();
  return `${settings.systemPrompt}\n\n시간 기준: KST(Asia/Seoul)\n현재 시간: ${kst} KST`;
}
