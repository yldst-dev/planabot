import {
  BracesIcon,
  BrainCircuitIcon,
  DatabaseIcon,
  DramaIcon,
  GlobeIcon,
  type LucideIcon,
  MusicIcon,
  PlugZapIcon,
  ScaleIcon,
  SearchIcon,
  SendIcon,
  ServerCogIcon,
  ShieldCheckIcon,
} from "lucide-react"

import type { Field, Group } from "@/lib/types"

export const CUSTOM_GROUP: Group = {
  id: "custom",
  section: "시스템",
  label: "사용자 지정",
  description: "목록에 없는 환경 변수를 직접 지정합니다",
}

const ICONS: Record<string, LucideIcon> = {
  telegram: SendIcon,
  access: ShieldCheckIcon,
  media: MusicIcon,
  model: BrainCircuitIcon,
  persona: DramaIcon,
  memory: DatabaseIcon,
  webfetch: GlobeIcon,
  codex: PlugZapIcon,
  search: SearchIcon,
  decision: ScaleIcon,
  system: ServerCogIcon,
  custom: BracesIcon,
}

export function groupIcon(id: string): LucideIcon {
  return ICONS[id] ?? BracesIcon
}

export function withCustom(groups: Group[]) {
  return [...groups, CUSTOM_GROUP]
}

export function findGroup(groups: Group[], id: string) {
  return withCustom(groups).find((group) => group.id === id)
}

export function sections(groups: Group[]) {
  const map = new Map<string, Group[]>()
  for (const group of withCustom(groups)) {
    map.set(group.section, [...(map.get(group.section) ?? []), group])
  }
  return [...map.entries()]
}

export function fieldsIn(fields: Field[], groupId: string) {
  return fields.filter((field) => field.group === groupId)
}
