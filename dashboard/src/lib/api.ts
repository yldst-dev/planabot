import type { Changes, Overview, RecoveryCode, Session, SettingsResponse } from "@/lib/types"

export class AuthError extends Error {}

export class ApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

async function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: { "content-type": "application/json", "x-planabot-dashboard": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = (await response.json().catch(() => ({}))) as { error?: string }
  if (response.status === 401) {
    throw new AuthError(data.error ?? "인증 필요.")
  }
  if (!response.ok) {
    throw new ApiError(data.error ?? `오류. ${response.status}`, response.status)
  }
  return data as T
}

export const api = {
  session: () => request<Session>("/api/session"),
  setup: (setupCode: string, password: string) =>
    request<RecoveryCode>("/api/setup", "POST", { setup_code: setupCode, password }),
  login: (password: string) => request<{ ok: boolean }>("/api/login", "POST", { password }),
  recover: (recoveryCode: string, password: string) =>
    request<RecoveryCode>("/api/recover", "POST", { recovery_code: recoveryCode, password }),
  changePassword: (currentPassword: string, password: string) =>
    request<{ ok: boolean }>("/api/password", "POST", { current_password: currentPassword, password }),
  regenerateRecovery: (password: string) => request<RecoveryCode>("/api/recovery-code", "POST", { password }),
  logout: () => request<{ ok: boolean }>("/api/logout", "POST"),
  overview: () => request<Overview>("/api/overview"),
  settings: () => request<SettingsResponse>("/api/settings"),
  save: (changes: Changes) => request<SettingsResponse>("/api/settings", "PUT", { changes }),
  restart: () => request<{ ok: boolean }>("/api/restart", "POST"),
}
