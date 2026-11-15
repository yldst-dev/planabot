export function readIntSetting(raw: string | undefined, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const trimmed = raw?.trim() ?? "";
  const value = /^\d+$/u.test(trimmed) ? Number(trimmed) : Number.NaN;
  return value >= min && value <= max ? value : fallback;
}
