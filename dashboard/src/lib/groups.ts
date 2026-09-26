import {
  BoxIcon,
  BracesIcon,
  BrainCircuitIcon,
  CloudIcon,
  DatabaseIcon,
  DramaIcon,
  FlaskConicalIcon,
  GemIcon,
  GlobeIcon,
  LayersIcon,
  type LucideIcon,
  MusicIcon,
  NetworkIcon,
  PlugZapIcon,
  RouteIcon,
  SendIcon,
  ServerCogIcon,
  ShieldCheckIcon,
  ZapIcon,
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
  google: GemIcon,
  vertexexpress: CloudIcon,
  openrouter: RouteIcon,
  ollama: BoxIcon,
  cerebras: ZapIcon,
  modelstudio: LayersIcon,
  geminiweb: NetworkIcon,
  sub2api: PlugZapIcon,
  geminimock: FlaskConicalIcon,
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
