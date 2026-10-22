const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const MAX_TIMER_MS = 30 * DAY_MS;
const MAX_SCHEDULE_MS = 366 * DAY_MS;
const DEFAULT_SCHEDULE_TITLE = "요청하신 내용";
const MAX_RULE_TEXT_CHARS = 600;
const RECURRING_PATTERN = /(?:(?<![가-힣])|(?<=알림|일정|타이머|예약))매\s*(?:일(?!경제|유업|신문|우유)|주|달(?![리려린렸기아았고면게])|월|년|시간)|(?<=[\d가-힣]\s?)마다(?!가스|하지|않)/u;
export const NOON_OR_MIDNIGHT_PATTERN = /(?<=^|[^가-힣]|오늘|내일|모레|글피|요일)(?:정오|자정)(?=$|[^가-힣]|[에쯤까부전이가은는을를도만의되넘지직무경께로으엔즈와과랑나후])/gu;
const COMMON_FRACTIONS = new Set(["1/2", "1/3", "2/3", "1/4", "3/4"]);
const WEEK_QUALIFIER_PATTERN = /(?:이번|다음|다다음)\s*달|째\s*주|마지막\s*주/u;
const HELD = /(?:취소|삭제|지우|지워|없애|제거|등록|추가|설정|예약|알려|맞춰)\s*(?:하|해|주|줘)?\s*(?:지\s*(?:마|말|않)|안\s*(?:해|하|돼|되))|(?:취소|삭제|지우|지워|없애|제거|등록|추가|설정|예약)\s*(?:하면|해선|해서는|면)\s*안|할까|(?:었|았|였|줬|했|췄|됐)어[\sㅋㅎㅠㅜ.!~]*$|[?？][\sㅋㅎㅠㅜ~!.]*$/u;
const HELD_CANCEL = /나중에|이따|려고\s*(?:했|해|하)|려다|했대|했다고|하래|라고\s*했|할게|(?:하|되|오|나|마치|지|치|으|쁘)면(?:\s|$)/u;
const REQUEST_QUESTION = /(?:줄래요?|줄래예|줄랑가|주실래요|주시겠어요|주시겠습니까|줘요?|주세요|주면\s*안\s*(?:돼요?|될까요?|되나요?)|부탁(?:해|드려)?도\s*(?:될까요?|되나요?|돼요?)|수\s*있(?:어요?|나요|니|을까요?|습니까|으세요|으신가요|겠어요?|겠니))\s*[?？][?？\sㅋㅎㅠㅜ~!.]*$/u;
const VERBAL = /(?:취소|삭제|제거|등록|추가|설정|예약)\s*(?:은|는|도|좀|을|를)?\s*(?:하(?!기)|하기\s*싫|해|했|할|한|합|함|된|됐|돼|안\s|못\s|말|금지|가능|대신)|지워|지우(?!기|개)|지웠|없애|없앴|알려(?!주기|진|지)|맞춰|맞추(?!기)|맞췄|깨워|깨우(?!기)|깨울|깨웠/u;
const REQUEST_TAIL = String.raw`\s*(?:좀\s*)?(?:처리\s*)?(?:해\s*|하)?(?:줘|줭|죠|주세요|주십시오|주라|주셈|줄래|줄랑|줄\s*수|주실|주시|주면|주이소|부탁|버려|놔|둬|놓아|두자|놓자|도\s*(?:돼|됩니다|괜찮)|자(?=[\s.!~]*$)|요(?=[\s.!~?ㅋㅎㅠㅜ]*$)|라(?=[\s.!~]*$)|ㄱ|고\s*싶|할래|할게|합니다(?=[\s.!~]*$)|(?=[\s.!~?ㅋㅎㅠㅜ\p{Extended_Pictographic}\u{FE0F}]*$))`;
const REQUESTED = new RegExp(String.raw`(?<!안\s*)(?:취소|삭제|지워|지우|없애|제거|등록|추가|설정|예약|알려|맞춰|맞추|깨워)${REQUEST_TAIL}`, "u");
const CANCEL_COMMAND = new RegExp(String.raw`(?:취소|삭제|지워|지우|없애|제거)${REQUEST_TAIL}`, "u");
const POLITE_TAIL = /\s*(?:좀\s*)?(?:(?:해\s*)?(?:줘요?|주세요|주십시오|줄래요?|줄래예|줄랑가|주실래요|주시겠어요|주시겠습니까|주면\s*안\s*(?:돼요?|될까요?|되나요?)|(?:줄|주실|주시)\s*수\s*있(?:어요?|나요|니|을까요?|습니까|으세요|으신가요|겠어요?|겠니))|부탁(?:해요?|드려요|드립니다|합니다)?(?:도\s*(?:될까요?|되나요?|돼요?))?)[\s?？!~.ㅋㅎㅠㅜ\p{Extended_Pictographic}\u{FE0F}]*$/u;
export const EARLIER_COMMAND = /(?:줘|주세요|주십시오|해라|주라|주셈)[\s.!~,]/u;

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
  matched: Array<[number, number]>;
  kind: "schedule" | "timer";
};

export type ScheduleAction = Exclude<ScheduleInterpretOutput["action"], "none">;

export function interpretScheduleRequest(
  text: string,
  options: { nowMs?: number; action?: ScheduleAction; meridiem?: "am" | "pm"; command?: boolean } = {},
): ScheduleInterpretOutput {
  const now = resolveNow(options.nowMs);
  const decided = options.action;
  const userText = extractUserText(text);
  if (userText.length > MAX_RULE_TEXT_CHARS) {
    return decided === "list" ? { handled: true, action: "list" } : emptyOutput();
  }
  const timeText = /\d{1,2}\s*시(?!간)/u.test(userText)
    ? userText.replace(/자정\s*(?:넘어서|지나서|넘어|이후|후)\s*(?=\d{1,2}\s*시)/gu, "새벽 ").replace(/정오\s*(?:넘어서|지나서|넘어|이후|후)\s*(?=\d{1,2}\s*시)/gu, "오후 ").replace(/자정(?=\s*\d{1,2}\s*시)/gu, "밤").replace(/정오(?=\s*\d{1,2}\s*시)/gu, "낮")
    : userText.replace(NOON_OR_MIDNIGHT_PATTERN, (word) => (word === "정오" ? "낮 12시" : "밤 12시"));
  const normalized = normalizeIntentText(userText);
  const parsedTime = parseScheduleTime(timeText, now, options.meridiem);
  const related =
    decided !== undefined ||
    (!isHowToQuestion(normalized) &&
      (isScheduleRelated(normalized) ||
        isScheduleContextText(text) ||
        Boolean(parsedTime !== undefined && isAddRequest(normalized))));
  if (!related) {
    return emptyOutput();
  }

  const held = (HELD.test(normalized) && !REQUEST_QUESTION.test(normalized)) || (VERBAL.test(normalized) && !REQUESTED.test(normalized));
  if (decided ? decided === "cancel" : isCancelRequest(normalized)) {
    if (held || HELD_CANCEL.test(normalized) || (/려고/u.test(normalized) && !EARLIER_COMMAND.test(normalized))) {
      return emptyOutput();
    }
    return {
      handled: true,
      action: "cancel",
      target: extractCancelTarget(userText)
    };
  }

  if (decided === "list" || (!decided && !isAddRequest(normalized) && parsedTime?.kind !== "timer" && isListRequest(normalized))) {
    return {
      handled: true,
      action: "list"
    };
  }

  if (held && !options.command) {
    return emptyOutput();
  }

  if (RECURRING_PATTERN.test(normalized) && (parsedTime || decided === "add" || isAddRequest(normalized))) {
    return {
      handled: true,
      action: "add",
      error: "반복 일정은 아직 지원하지 않습니다."
    };
  }

  if (!parsedTime) {
    if (decided === "add" || isAddRequest(normalized)) {
      return {
        handled: true,
        action: "add",
        error: "시각을 확인하지 못했습니다."
      };
    }
    return emptyOutput();
  }

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

  const title = extractScheduleTitle(timeText, parsedTime);
  return {
    handled: true,
    action: "add",
    kind: parsedTime.kind,
    title: title || DEFAULT_SCHEDULE_TITLE,
    dueAtMs: parsedTime.dueAtMs,
    ...(parsedTime.durationMs ? { durationMs: parsedTime.durationMs } : {})
  };
}

function parseScheduleTime(text: string, now: number, meridiem?: "am" | "pm"): ParsedTime | null | undefined {
  const absolute = parseAbsoluteDateTime(text, meridiem);
  if (absolute === null) {
    return null;
  }
  return parseRelativeTime(text, now) ?? absolute ?? parseKoreanDateTime(text, now, meridiem);
}

function parseRelativeTime(text: string, now: number): ParsedTime | undefined {
  const normalized = text.replace(/\s+/g, " ").trim();
  const pattern = /(?<!\d)(?:(\d+)\s*일\s*)?(?:(\d+)\s*시간\s*(반(?=$|[^가-힣]|[에쯤경께이은만뒤후짜]|까지|부터|으?로|정도|동안|타이머|알림|있다가)\s*)?)?(?:(\d+)\s*분\s*)?(?:(\d+)\s*초\s*)?(?:뒤|후|있다가)/g;
  for (const match of normalized.matchAll(pattern)) {
    const durationMs =
      Number(match[1] ?? 0) * DAY_MS +
      Number(match[2] ?? 0) * HOUR_MS +
      (match[3] ? 30 * MINUTE_MS : 0) +
      Number(match[4] ?? 0) * MINUTE_MS +
      Number(match[5] ?? 0) * SECOND_MS;
    if (durationMs > 0) {
      return { dueAtMs: now + durationMs, durationMs, matched: [[match.index, match.index + match[0].length]], kind: "timer" };
    }
  }
  const cue = Math.max(normalized.lastIndexOf("타이머"), normalized.lastIndexOf("알림"));
  const units = [...normalized.matchAll(/(?<!\d)(?<!\d\s*시\s*)(\d+)\s*(초|분(?!기)|시간)(\s*반(?=$|[^가-힣]|[에쯤경께이은만뒤후짜]|까지|부터|으?로|정도|동안|타이머|알림|있다가))?(?!\s*(?:반\s*)?전)/g)].filter(
    (unit) => unit.index + unit[0].length <= cue,
  );
  const durationMs = units.reduce(
    (total, unit) => total + unitToMs(Number(unit[1]), unit[2]) + (unit[3] ? unitToMs(30, unit[2] === "시간" ? "분" : "초") : 0),
    0,
  );
  const first = units[0];
  const last = units.at(-1);
  if (!first || !last || durationMs <= 0) {
    return undefined;
  }
  return {
    dueAtMs: now + durationMs,
    durationMs,
    matched: [[first.index, last.index + last[0].length]],
    kind: "timer"
  };
}

function parseAbsoluteDateTime(text: string, meridiem?: "am" | "pm"): ParsedTime | null | undefined {
  const normalized = text.replace(/\s+/g, " ").trim();
  const match = normalized.match(/(\d{4})[-.\/년]\s*(\d{1,2})[-.\/월]\s*(\d{1,2})일?\s*(?:(오전|오후|새벽|아침|밤|저녁|낮)\s*)?(\d{1,2})시(?!간)(?:\s*(?:(\d{1,2})(?:분|(?=$|[\s,.]|에|쯤|까지|부터|으?로|[~\-]\s*\d{1,2}\s*시(?!간)))|(반)(?=$|[^가-힣]|[에쯤경께이은만뒤후짜]|까지|부터|으?로|정도|동안|타이머|알림|있다가)))?/);
  if (!match) {
    return undefined;
  }
  if (!Number.isFinite(kstDateMs(Number(match[1]), Number(match[2]), Number(match[3]), 0, 0))) {
    return null;
  }
  const hour = normalizeHour(Number(match[5]), match[4] ?? impliedMarker(Number(match[5]), meridiem));
  const minute = match[6] ? Number(match[6]) : match[7] ? 30 : 0;
  const parts = addKstDays(Number(match[1]), Number(match[2]), Number(match[3]), Math.floor(hour / 24));
  const dueAtMs = kstDateMs(parts.year, parts.month, parts.day, hour % 24, minute);
  if (!Number.isFinite(dueAtMs)) {
    return undefined;
  }
  return {
    dueAtMs,
    matched: [[match.index ?? 0, (match.index ?? 0) + match[0].length]],
    kind: "schedule"
  };
}

function parseKoreanDateTime(text: string, now: number, meridiem?: "am" | "pm"): ParsedTime | null | undefined {
  const normalized = text.replace(/\s+/g, " ").trim();
  const time = normalized.match(/(?:(오전|오후|새벽|아침|밤|저녁|낮)\s*)?(\d{1,2})시(?!간)(?:\s*(?:(\d{1,2})(?:분|(?=$|[\s,.]|에|쯤|까지|부터|으?로|[~\-]\s*\d{1,2}\s*시(?!간)))(\s*전(?:까지)?(?=$|[\s,.]|에|쯤))?|(반)(?=$|[^가-힣]|[에쯤경께이은만뒤후짜]|까지|부터|으?로|정도|동안|타이머|알림|있다가)))?/);
  if (!time) {
    return undefined;
  }
  const today = nowKstParts(now);
  let year = today.year;
  let month = today.month;
  let day = today.day;
  let dateText = "";
  let dateIndex = 0;

  const monthDay = normalized.match(/(\d{1,2})월\s*(\d{1,2})일/);
  const dayOnly = normalized.match(/(?<![\d월]\s*)(?:(다?다음)\s*달\s*(?:에\s*)?)?(\d{1,2})일(?!\s*(?:뒤|후|있다가|동안|간|째))/);
  const timeStart = time.index ?? 0;
  const timeEnd = timeStart + time[0].length;
  const dayWords = [...normalized.matchAll(/(?:내일\s*모레|오늘|내일|모레|글피)(?=(의)|$|[^가-힣]|[은는도에엔부까중이만쯤로께요인]|오전|오후|아침|점심|저녁|밤|낮|새벽|정오|자정)/gu)];
  const standaloneDays = dayWords.filter((match) => !match[1]);
  const relativeDay = (standaloneDays.length ? standaloneDays : dayWords).sort(
    (a, b) => distanceFrom(a, timeStart, timeEnd) - distanceFrom(b, timeStart, timeEnd),
  )[0];
  const weekday = normalized.match(/(?:(이번|다음|다다음|다담)\s*주\s*)?([월화수목금토일])요일/);

  if (monthDay) {
    month = Number(monthDay[1]);
    day = Number(monthDay[2]);
    dateText = monthDay[0];
    dateIndex = monthDay.index ?? 0;
    if (!(kstDateMs(year, month, day, 23, 59) > now)) {
      year += 1;
    }
  } else if (dayOnly) {
    day = Number(dayOnly[2]);
    const ahead = dayOnly[1] === "다다음" ? 2 : dayOnly[1] || kstDateMs(year, month, day, 23, 59) <= now ? 1 : 0;
    year += Math.floor((month - 1 + ahead) / 12);
    month = ((month - 1 + ahead) % 12) + 1;
    dateText = dayOnly[0];
    dateIndex = dayOnly.index ?? 0;
  } else if (relativeDay) {
    const offset = ["오늘", "내일", "모레", "글피"].indexOf(relativeDay[0].slice(-2));
    const parts = addKstDays(today.year, today.month, today.day, offset);
    year = parts.year;
    month = parts.month;
    day = parts.day;
    dateText = relativeDay[0];
    dateIndex = relativeDay.index;
  } else if (weekday) {
    if (WEEK_QUALIFIER_PATTERN.test(normalized.slice(0, weekday.index))) {
      return null;
    }
    const weekOffset = weekday[1] === "다담" || weekday[1] === "다다음" ? 14 : weekday[1] === "다음" ? 7 : 0;
    const targetDay = weekdayIndex(weekday[2]);
    const currentDay = kstWeekday(today.year, today.month, today.day);
    let offset = targetDay - currentDay + weekOffset;
    if (offset <= 0 && weekOffset === 0) {
      offset += 7;
    }
    const parts = addKstDays(today.year, today.month, today.day, offset);
    year = parts.year;
    month = parts.month;
    day = parts.day;
    dateText = weekday[0];
    dateIndex = weekday.index ?? 0;
  }

  if (dateText && !Number.isFinite(kstDateMs(year, month, day, 0, 0))) {
    return null;
  }
  if (!dateText && hasUnreadDate(normalized.slice(0, time.index))) {
    return null;
  }
  const rawHour = Number(time[2]);
  const before = time[4]
    ? undefined
    : `${normalized.slice(0, timeStart)} ${normalized.slice(timeEnd)}`.match(/(?<!\d)(\d{1,3})\s*(분|시간)\s*전(?:에|까지)?(?=$|[\s,.]|에|쯤|알)/u);
  const beforeAt = before?.index ?? 0;
  const beforeIndex = beforeAt < timeStart ? beforeAt : beforeAt - 1 + time[0].length;
  const minutesBefore = time[4] ? Number(time[3]) : before ? Number(before[1]) * (before[2] === "시간" ? 60 : 1) : 0;
  const minute = time[4] ? 0 : time[3] ? Number(time[3]) : time[5] ? 30 : 0;
  const marker = time[1] ?? impliedMarker(rawHour, meridiem);
  const hours = marker || rawHour === 0 || rawHour >= 12 ? [normalizeHour(rawHour, marker)] : [rawHour, rawHour + 12];
  const offsets = dateText ? [0] : hours.some((hour) => hour >= 24) ? [-1, 0, 1] : [0, 1];
  const candidates = offsets.flatMap((offset) =>
    hours.map((hour) => {
      const parts = addKstDays(year, month, day, offset + Math.floor(hour / 24));
      return kstDateMs(parts.year, parts.month, parts.day, hour % 24, minute) - minutesBefore * MINUTE_MS;
    }),
  );
  const dueAtMs = candidates.find((ms) => ms > now) ?? candidates[0];
  if (!Number.isFinite(dueAtMs)) {
    return undefined;
  }

  return {
    dueAtMs,
    matched: [
      ...(dateText ? [[dateIndex, dateIndex + dateText.length] as [number, number]] : []),
      [timeStart, timeEnd],
      ...(before ? [[beforeIndex, beforeIndex + before[0].length] as [number, number]] : []),
    ],
    kind: "schedule"
  };
}

function hasUnreadDate(text: string): boolean {
  if (/말일|다음\s*달\s*(?:에\s*)?$|(?:이번|다음|다다음)\s*달\s*(?:말|초|중순)(?=$|\s|에|까지|쯤)|(?:이번|다음|다다음)\s*주\s*말(?=$|\s|에|까지|쯤)|째\s*주|마지막\s*주/u.test(text)) {
    return true;
  }
  return [...text.matchAll(/(?<!\S)(\d{4}\s*[-.\/년]\s*)?(\d{1,2})\s*([-.\/월])\s*(\d{1,2})\.?(?=$|\s|일|에)/gu)].some((match) => {
    const month = Number(match[2]);
    const day = Number(match[4]);
    const fraction = !match[1] && match[3] === "/" && COMMON_FRACTIONS.has(`${month}/${day}`);
    const score =
      !match[1] &&
      match[3] === "-" &&
      match[2].length === 1 &&
      match[4].length === 1 &&
      !/^(?:\s*$|일|에)/u.test(text.slice((match.index ?? 0) + match[0].length));
    return month >= 1 && month <= 12 && day >= 1 && day <= 31 && !fraction && !score;
  });
}

function extractScheduleTitle(text: string, parsedTime: ParsedTime): string {
  let value = text.replace(/\s+/g, " ").trim();
  for (const [start, end] of [...parsedTime.matched].sort((a, b) => b[0] - a[0])) {
    value = `${value.slice(0, start)} ${value.slice(end)}`;
  }
  value = value
    .replace(/프라나야/g, " ")
    .replace(POLITE_TAIL, "")
    .replace(/^\s*(?:(?:알려\s*줘|알려\s*주세요|알림|타이머|리마인더|리마인드|예약|등록|추가|생성|설정|맞춰)(?:\s*(?:해줘|해주세요|해|줘))?(?![가-힣])\s*)+/gi, " ")
    .replace(/(?:일정|스케줄|타이머|알림|리마인더|리마인드|예약)(?:을|를|에|로)?/gi, " ")
    .replace(/(?:등록|추가|생성|설정|맞춰|알려|예약|깨워)(?:\s*(?:해줘|해주세요|해|합니다|해라|줘|할게요?|(?:해\s*)?(?:놔|둬)))?$/gi, " ")
    .replace(/(?:해줘|해주세요|해|줘|부탁)$/gi, " ")
    .replace(/\s*(?<![으하])(?:이라고요|라고요|이라고|라고|이라)\s*$/g, " ")
    .replace(/(?:에|때|쯤)$/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleanupText(value);
}

function extractCancelTarget(text: string): string {
  const userText = extractUserText(text);
  const head = userText.slice(0, userText.match(CANCEL_COMMAND)?.index ?? 0);
  const body = /\S/u.test(head) ? head : userText.replace(/취소|삭제|지워|지우|없애|제거/gu, " ");
  return cleanupText(
    body
      .replace(/(?:일정|스케줄|타이머|알림|리마인더|리마인드|예약|항목)(?:을|를|은|는|이|가|도|에서)?/gu, " ")
      .replace(/해줘|해주세요|줘|(?<![가-힣])(?:해|좀|제발)(?![가-힣])/gu, " ")
  ).replace(/^(\S+\s*(?:번째|번|째|거|것|꺼))\s*(?:도|은|는|을|를)$/u, "$1");
}

function distanceFrom(match: RegExpMatchArray, start: number, end: number): number {
  const index = match.index ?? 0;
  return index + match[0].length <= start ? start - index - match[0].length : MAX_RULE_TEXT_CHARS + index - end;
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
  if (marker === "밤" && (hour === 12 || hour <= 4)) {
    return hour === 12 ? 24 : hour + 24;
  }
  let value = hour;
  if ((marker === "오후" || marker === "밤" || marker === "저녁" || (marker === "낮" && value < 7)) && value < 12) {
    value += 12;
  }
  if ((marker === "오전" || marker === "새벽") && value === 12) {
    value = 0;
  }
  return value;
}

function impliedMarker(hour: number, meridiem?: "am" | "pm"): string | undefined {
  if (!meridiem || hour < 1 || hour > 11) {
    return undefined;
  }
  return meridiem === "pm" ? "오후" : "오전";
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

function resolveNow(explicit?: number): number {
  if (typeof explicit === "number" && Number.isFinite(explicit) && explicit > 0) {
    return explicit;
  }
  return nowMs();
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

function nowKstParts(now: number): { year: number; month: number; day: number } {
  const date = new Date(now + KST_OFFSET_MS);
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
    "[일정]",
    "[타이머]"
  ]);
}

function isAddRequest(text: string): boolean {
  return hasAny(text, ["등록", "추가", "생성", "설정", "맞춰", "예약", "깨워"]) || /(?:뒤|후|있다가|시|분|초|에|때|쯤|고)\s*(?:좀\s*)?알려/u.test(text);
}

function isHowToQuestion(text: string): boolean {
  return /방법|어떻게|는\s*법/u.test(text);
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
    .replace(/(?:을|를|은|는|도|좀|제발|부탁)$/g, "")
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
