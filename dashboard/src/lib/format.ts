const FALSY = new Set(["", "0", "false", "off", "no"])

export function truthy(value: string | null | undefined) {
  return value != null && !FALSY.has(value.trim().toLowerCase())
}

export function formatUptime(seconds: number) {
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (days > 0) return `${days}일 ${hours}시간`
  if (hours > 0) return `${hours}시간 ${minutes}분`
  return `${minutes}분`
}

export const KEY_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/
