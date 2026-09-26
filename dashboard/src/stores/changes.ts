import { create } from "zustand"

import type { Changes, Field } from "@/lib/types"

interface ChangesState {
  changes: Changes
  edit: (field: Field, value: string | null | undefined) => void
  drop: (keys: string[]) => void
  clear: () => void
}

export const useChanges = create<ChangesState>((set) => ({
  changes: {},
  edit: (field, value) =>
    set((state) => {
      const next = { ...state.changes }
      const unchanged = field.kind !== "secret" && value !== null && value === (field.value ?? "")
      if (value === undefined || unchanged) delete next[field.key]
      else next[field.key] = value
      return { changes: next }
    }),
  drop: (keys) =>
    set((state) => {
      const next = { ...state.changes }
      for (const key of keys) delete next[key]
      return { changes: next }
    }),
  clear: () => set({ changes: {} }),
}))

export function isDirty(changes: Changes, key: string) {
  return Object.hasOwn(changes, key)
}

export function effectiveValue(changes: Changes, field: Field) {
  if (!isDirty(changes, field.key)) return field.value
  const change = changes[field.key]
  return change === null ? field.env_value : change
}
