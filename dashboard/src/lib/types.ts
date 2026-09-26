export type FieldKind = "text" | "secret" | "bool" | "number" | "select" | "textarea"

export type FieldSource = "dashboard" | "env" | "unset"

export interface Group {
  id: string
  section: string
  label: string
  description: string
}

export interface Field {
  key: string
  group: string
  label: string
  help: string
  kind: FieldKind
  options: string[]
  placeholder: string
  value: string | null
  env_value: string | null
  hint: string | null
  env_hint: string | null
  source: FieldSource
  pending: boolean
  custom: boolean
}

export interface SettingsResponse {
  groups: Group[]
  fields: Field[]
  pending: string[]
}

export interface Overview {
  version: string
  uptime: number
  bot_username: string | null
  provider: string | null
  model: string | null
  aux_provider: string | null
  planabrain_server: boolean
  overrides: number
  pending: string[]
  state_path: string
  allowed_chats: number
  allowed_users: number
}

export interface Session {
  enabled: boolean
  configured: boolean
  authenticated: boolean
}

export interface RecoveryCode {
  recovery_code: string
}

export type Changes = Record<string, string | null>
