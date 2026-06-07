const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const MAX_TIMER_MS = 30 * DAY_MS;
const MAX_SCHEDULE_MS = 366 * DAY_MS;

export type ScheduleInterpretOutput = {
  handled: boolean;
  action: "none" | "list" | "add" | "cancel";
  kind?: "schedule" | "timer";
  title?: string;
  dueAtMs?: number;
  durationMs?: number;
  target?: string;
  message?: string;
  error?: string;
};

type ParsedTime = {
  dueAtMs: number;
  durationMs?: number;
  matchedText: string;
  kind: "schedule" | "timer";
};

export function interpretScheduleRequest(text: string): ScheduleInterpretOutput {
  const userText = extractUserText(text);
  const normalized = normalizeIntentText(userText);
  const parsedTime = parseScheduleTime(userText);
  const related =
    isScheduleRelated(normalized) ||
    isScheduleContextText(text) ||
    Boolean(parsedTime && isAddRequest(normalized));
  if (!related) {
    return emptyOutput();
  }

  if (isCancelRequest(normalized)) {
    return {
      handled: true,
      action: "cancel",
      target: extractCancelTarget(userText)
    };
  }

  if (!parsedTime) {
    if (isAddRequest(normalized)) {
      return {
        handled: true,
        action: "add",
        error: "시각을 확인하지 못했습니다."
      };
    }
    if (isListRequest(normalized)) {
      return {
        handled: true,
        action: "list"
      };
    }
    return emptyOutput();
  }

  const now = nowMs();
  const maxDelay = parsedTime.kind === "timer" ? MAX_TIMER_MS : MAX_SCHEDULE_MS;
  if (parsedTime.dueAtMs <= now) {
    return {
      handled: true,
      action: "add",
      error: "현재 이후 시각만 등록할 수 있습니다."
    };
  }
  if (parsedTime.dueAtMs - now > maxDelay) {
    return {
      handled: true,
      action: "add",
      error: parsedTime.kind === "timer" ? "타이머는 최대 30일까지 지원합니다." : "일정은 최대 366일까지만 지원합니다."
    };
  }

  const title = extractScheduleTitle(userText, parsedTime);
  return {
    handled: true,
    action: "add",
    kind: parsedTime.kind,
    title: title || (parsedTime.kind === "timer" ? "타이머" : "일정"),
    dueAtMs: parsedTime.dueAtMs,
    ...(parsedTime.durationMs ? { durationMs: parsedTime.durationMs } : {})
  };
}

function parseScheduleTime(text: string): ParsedTime | undefined {
  return parseRelativeTime(text) ?? parseAbsoluteDateTime(text) ?? parseKoreanDateTime(text);
}

function parseRelativeTime(text: string): ParsedTime | undefined {
  const normalized = text.replace(/\s+/g, " ").trim();
  const pattern = /(?:(\d+)\s*일\s*)?(?:(\d+)\s*시간\s*)?(?:(\d+)\s*분\s*)?(?:(\d+)\s*초\s*)?(?:뒤|후|있다가)/;
  const match = normalized.match(pattern);
  if (!match) {
    const timer = normalized.match(/(\d+)\s*(초|분|시간|일)(?=.*(?:타이머|알림))/);
    if (!timer) {
      return undefined;
    }
    const amount = Number(timer[1]);
    const unit = timer[2];
    const durationMs = unitToMs(amount, unit);
    if (!durationMs) {
      return undefined;
    }
    return {
      dueAtMs: nowMs() + durationMs,
      durationMs,
      matchedText: timer[0],
      kind: "timer"
    };
  }
  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3] ?? 0);
  const seconds = Number(match[4] ?? 0);
  const durationMs = days * DAY_MS + hours * HOUR_MS + minutes * MINUTE_MS + seconds * SECOND_MS;
  if (durationMs <= 0) {
    return undefined;
  }
  return {
    dueAtMs: nowMs() + durationMs,
    durationMs,
    matchedText: match[0],
    kind: "timer"
  };
}

function parseAbsoluteDateTime(text: string): ParsedTime | undefined {
  const normalized = text.replace(/\s+/g, " ").trim();
  const match = normalized.match(/(\d{4})[-.\/년]\s*(\d{1,2})[-.\/월]\s*(\d{1,2})일?\s*(?:(오전|오후|새벽|밤|저녁|낮)\s*)?(\d{1,2})시(?:\s*(\d{1,2})분?)?/);
  if (!match) {
    return undefined;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = normalizeHour(Number(match[5]), match[4]);
  const minute = Number(match[6] ?? 0);
  const dueAtMs = kstDateMs(year, month, day, hour, minute);
  if (!Number.isFinite(dueAtMs)) {
    return undefined;
  }
  return {
    dueAtMs,
    matchedText: match[0],
    kind: "schedule"
  };
}

function parseKoreanDateTime(text: string): ParsedTime | undefined {
  const normalized = text.replace(/\s+/g, " ").trim();
  const time = normalized.match(/(?:(오전|오후|새벽|밤|저녁|낮)\s*)?(\d{1,2})시(?:\s*(\d{1,2})분?)?/);
  if (!time) {
    return undefined;
  }
  const now = nowKstParts();
  let year = now.year;
  let month = now.month;
  let day = now.day;
  let dateText = "";

  const monthDay = normalized.match(/(\d{1,2})월\s*(\d{1,2})일/);
  const relativeDay = normalized.match(/오늘|내일|모레|글피/);
  const weekday = normalized.match(/(?:(이번주|다음주|다담주)\s*)?(월요일|화요일|수요일|목요일|금요일|토요일|일요일|월|화|수|목|금|토|일)/);

  if (monthDay) {
    month = Number(monthDay[1]);
    day = Number(monthDay[2]);
    dateText = monthDay[0];
    if (kstDateMs(year, month, day, 23, 59) <= nowMs()) {
      year += 1;
    }
  } else if (relativeDay) {
    const offset = relativeDay[0] === "오늘" ? 0 : relativeDay[0] === "내일" ? 1 : relativeDay[0] === "모레" ? 2 : 3;
    const parts = addKstDays(now.year, now.month, now.day, offset);
    year = parts.year;
    month = parts.month;
    day = parts.day;
    dateText = relativeDay[0];
  } else if (weekday) {
    const weekOffset = weekday[1] === "다담주" ? 14 : weekday[1] === "다음주" ? 7 : 0;
    const targetDay = weekdayIndex(weekday[2]);
    const currentDay = kstWeekday(now.year, now.month, now.day);
    let offset = targetDay - currentDay + weekOffset;
    if (offset <= 0 && weekOffset === 0) {
      offset += 7;
    }
    const parts = addKstDays(now.year, now.month, now.day, offset);
    year = parts.year;
    month = parts.month;
    day = parts.day;
    dateText = weekday[0];
  }

  const hour = normalizeHour(Number(time[2]), time[1]);
  const minute = Number(time[3] ?? 0);
  let dueAtMs = kstDateMs(year, month, day, hour, minute);
  if (!dateText && dueAtMs <= nowMs()) {
    const parts = addKstDays(year, month, day, 1);
    year = parts.year;
    month = parts.month;
    day = parts.day;
    dueAtMs = kstDateMs(year, month, day, hour, minute);
  }
  if (!Number.isFinite(dueAtMs)) {
    return undefined;
  }

  return {
    dueAtMs,
    matchedText: [dateText, time[0]].filter(Boolean).join(" ").trim(),
    kind: "schedule"
  };
}

function extractScheduleTitle(text: string, parsedTime: ParsedTime): string {
  let value = extractUserText(text);
  if (parsedTime.matchedText) {
    value = value.replace(parsedTime.matchedText, " ");
  }
  value = value
    .replace(/프라나야/g, " ")
    .replace(/(?:일정|스케줄|타이머|알림|리마인더|리마인드|예약)(?:을|를|에|로)?/gi, " ")
    .replace(/(?:등록|추가|생성|설정|맞춰|알려|예약)(?:해줘|해주세요|해|합니다|해라|줘)?$/gi, " ")
    .replace(/(?:해줘|해주세요|해|줘|부탁)$/gi, " ")
    .replace(/(?:에|때|쯤)$/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleanupText(value);
}

function extractCancelTarget(text: string): string {
  return cleanupText(
    extractUserText(text)
      .replace(/(?:일정|스케줄|타이머|알림|리마인더|리마인드|예약|항목)/gi, " ")
      .replace(/(?:취소|삭제|지워|제거|없애|해줘|해주세요|해|줘)/g, " ")
  );
}

function unitToMs(amount: number, unit: string): number {
  if (!Number.isFinite(amount) || amount <= 0) {
    return 0;
  }
  if (unit === "초") {
    return amount * SECOND_MS;
  }
  if (unit === "분") {
    return amount * MINUTE_MS;
  }
  if (unit === "시간") {
    return amount * HOUR_MS;
  }
  if (unit === "일") {
    return amount * DAY_MS;
  }
  return 0;
}

function normalizeHour(hour: number, marker?: string): number {
  let value = hour;
  if ((marker === "오후" || marker === "밤" || marker === "저녁") && value < 12) {
    value += 12;
  }
  if ((marker === "오전" || marker === "새벽") && value === 12) {
    value = 0;
  }
  return value;
}

function kstDateMs(year: number, month: number, day: number, hour: number, minute: number): number {
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    return Number.NaN;
  }
  const ms = Date.UTC(year, month - 1, day, hour, minute) - KST_OFFSET_MS;
  const check = new Date(ms + KST_OFFSET_MS);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() + 1 !== month ||
    check.getUTCDate() !== day ||
    check.getUTCHours() !== hour ||
    check.getUTCMinutes() !== minute
  ) {
    return Number.NaN;
  }
  return ms;
}

function nowMs(): number {
  const raw = process.env.PLANABRAIN_NOW_MS?.trim();
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return Date.now();
}

function nowKstParts(): { year: number; month: number; day: number } {
  const date = new Date(nowMs() + KST_OFFSET_MS);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate()
  };
}

function addKstDays(year: number, month: number, day: number, offset: number): { year: number; month: number; day: number } {
  const date = new Date(Date.UTC(year, month - 1, day + offset));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate()
  };
}

function kstWeekday(year: number, month: number, day: number): number {
  const date = new Date(Date.UTC(year, month - 1, day));
  const dayIndex = date.getUTCDay();
  return dayIndex === 0 ? 6 : dayIndex - 1;
}

function weekdayIndex(value: string): number {
  const first = value[0];
  return ["월", "화", "수", "목", "금", "토", "일"].indexOf(first);
}

function isScheduleRelated(text: string): boolean {
  return hasAny(text, ["일정", "스케줄", "타이머", "알림", "리마인더", "리마인드", "예약"]);
}

function isScheduleContextText(text: string): boolean {
  return hasAny(normalizeIntentText(text), [
    "일정 확인",
    "예정된 항목입니다",
    "등록된 항목이 없습니다",
    "[일정]",
    "[타이머]"
  ]);
}

function isAddRequest(text: string): boolean {
  return hasAny(text, ["등록", "추가", "생성", "설정", "맞춰", "알려", "예약"]);
}

function isCancelRequest(text: string): boolean {
  return hasAny(text, ["취소", "삭제", "지워", "제거", "없애"]);
}

function isListRequest(text: string): boolean {
  return hasAny(text, ["뭐", "무엇", "목록", "보여", "알려", "확인", "남았", "있어", "있나요"]);
}

function hasAny(text: string, words: string[]): boolean {
  return words.some((word) => text.includes(word));
}

function extractUserText(text: string): string {
  const marker = "사용자 질문:";
  const idx = text.lastIndexOf(marker);
  const value = idx >= 0 ? text.slice(idx + marker.length) : text;
  const questionMarker = "질문:";
  const questionIdx = value.lastIndexOf(questionMarker);
  return (questionIdx >= 0 ? value.slice(questionIdx + questionMarker.length) : value).trim();
}

function cleanupText(text: string): string {
  return text
    .replace(/^[\s:：,.\-에때쯤]+/, "")
    .replace(/(?:을|를|은|는|이|가|도|좀|제발|부탁)$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function normalizeIntentText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function emptyOutput(): ScheduleInterpretOutput {
  return {
    handled: false,
    action: "none"
  };
}
