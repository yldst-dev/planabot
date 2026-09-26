import { createElement } from "react"

import { groupIcon } from "@/lib/groups"

export function GroupIcon({ id, className }: { id: string; className?: string }) {
  return createElement(groupIcon(id), { className })
}
