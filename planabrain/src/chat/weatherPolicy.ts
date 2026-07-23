const FORECAST_HORIZON_DAYS = 10;

const WEATHER_PATTERN = /(날씨|기온|강수|비\s*(?:와|가|오|내)|눈\s*(?:이|오|내)|습도|예보)/u;
const CLIMATE_PATTERN = /(평년|기후|월평균|평균\s*(?:기온|강수|습도)|통계|경향)/u;
const CURRENT_DATE_PATTERN = /현재 시각:\s*(\d{4})-(\d{2})-(\d{2})/u;
const TARGET_DATE_PATTERN =
  /(?:(\d{4})\s*년\s*)?(\d{1,2})\s*월(?:\s*(?:(\d{1,2})\s*일|(초순?|중순?|말(?:경|쯤)?)))?/u;

export function buildLongRangeWeatherReply(
  currentTurnText: string,
  questionWithMetadata: string,
): string | null {
  if (!WEATHER_PATTERN.test(currentTurnText) || CLIMATE_PATTERN.test(currentTurnText)) {
    return null;
  }
  const currentDate = parseCurrentDate(questionWithMetadata);
  const targetDate = parseTargetDate(currentTurnText, currentDate);
  if (!currentDate || !targetDate) {
    return null;
  }
  const distance = daysBetween(currentDate, targetDate);
  if (distance <= FORECAST_HORIZON_DAYS) {
    return null;
  }
  return [
    "확인 불가.",
    "선생님.",
    "요청하신 시점은 현재 확인 가능한 단기 예보 범위를 벗어납니다.",
    "정확한 날씨로 단정할 수 없습니다.",
    "예보 범위에 들어온 뒤 다시 확인해 주세요.",
    "평년 기후 정보는 별도로 확인할 수 있습니다.",
  ].join("\n");
}

function parseCurrentDate(input: string): Date | null {
  const match = input.match(CURRENT_DATE_PATTERN);
  if (!match) {
    return null;
  }
  return createUtcDate(
    Number.parseInt(match[1] ?? "", 10),
    Number.parseInt(match[2] ?? "", 10),
    Number.parseInt(match[3] ?? "", 10),
  );
}

function parseTargetDate(input: string, currentDate: Date | null): Date | null {
  if (!currentDate) {
    return null;
  }
  const match = input.match(TARGET_DATE_PATTERN);
  if (!match) {
    return null;
  }
  const month = Number.parseInt(match[2] ?? "", 10);
  const explicitYear = match[1] ? Number.parseInt(match[1], 10) : null;
  const currentYear = currentDate.getUTCFullYear();
  const currentMonth = currentDate.getUTCMonth() + 1;
  const year = explicitYear ?? (month < currentMonth ? currentYear + 1 : currentYear);
  const explicitDay = match[3] ? Number.parseInt(match[3], 10) : null;
  const day = explicitDay ?? resolveMonthPhaseDay(match[4]);
  return createUtcDate(year, month, day);
}

function resolveMonthPhaseDay(phase: string | undefined): number {
  if (phase?.startsWith("초")) {
    return 5;
  }
  if (phase?.startsWith("말")) {
    return 25;
  }
  return 15;
}

function createUtcDate(year: number, month: number, day: number): Date | null {
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    year < 1970 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return null;
  }
  const value = new Date(Date.UTC(year, month - 1, day));
  if (
    value.getUTCFullYear() !== year ||
    value.getUTCMonth() !== month - 1 ||
    value.getUTCDate() !== day
  ) {
    return null;
  }
  return value;
}

function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / 86_400_000);
}
