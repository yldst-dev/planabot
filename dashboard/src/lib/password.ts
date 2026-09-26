export const MIN_PASSWORD_CHARS = 8

export interface PasswordCheck {
  label: string
  ok: boolean
}

export function passwordChecks(password: string, confirm: string): PasswordCheck[] {
  return [
    { label: `${MIN_PASSWORD_CHARS}자 이상`, ok: [...password].length >= MIN_PASSWORD_CHARS },
    { label: "앞뒤 공백 없음", ok: password.length > 0 && password.trim() === password },
    { label: "확인 입력과 일치", ok: confirm.length > 0 && password === confirm },
  ]
}

export function isNewPasswordReady(password: string, confirm: string) {
  return passwordChecks(password, confirm).every((check) => check.ok)
}

export function passwordStrength(password: string) {
  if (!password) return 0
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((rule) => rule.test(password)).length
  const length = [...password].length
  let score = 0
  if (length >= MIN_PASSWORD_CHARS) score += 1
  if (length >= 12) score += 1
  if (classes >= 2) score += 1
  if (classes >= 3 && length >= 14) score += 1
  return score
}

export const STRENGTH_LABELS = ["너무 짧음", "약함", "보통", "좋음", "강함"]

export const RESET_COMMAND = "docker exec planabot planabot dashboard-reset-password"
