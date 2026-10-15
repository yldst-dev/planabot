import { create } from "zustand"

import type { Changes, Field } from "@/lib/types"

interface ChangesState {
  changes: Changes
  invalid: { key: string; message: string } | null
  edit: (field: Field, value: string | null | undefined) => void
  drop: (keys: string[]) => void
  settle: (sent: Changes) => void
  fail: (key: string, message: string) => void
  clear: () => void
}

export const useChanges = create<ChangesState>((set) => ({
  changes: {},
  invalid: null,
  edit: (field, value) =>
    set((state) => {
      const next = { ...state.changes }
      const unchanged = field.kind !== "secret" && value !== null && value === (field.value ?? "")
      if (value === undefined || unchanged) delete next[field.key]
      else next[field.key] = value
      return { changes: next, invalid: state.invalid?.key === field.key ? null : state.invalid }
    }),
  drop: (keys) =>
    set((state) => {
      const next = { ...state.changes }
      for (const key of keys) delete next[key]
      return { changes: next, invalid: state.invalid && keys.includes(state.invalid.key) ? null : state.invalid }
    }),
  settle: (sent) =>
    set((state) => {
      const next = { ...state.changes }
      for (const [key, value] of Object.entries(sent)) {
        if (Object.hasOwn(next, key) && next[key] === value) delete next[key]
      }
      return { changes: next, invalid: null }
    }),
  fail: (key, message) => set({ invalid: { key, message } }),
  clear: () => set({ changes: {}, invalid: null }),
}))

export function isDirty(changes: Changes, key: string) {
  return Object.hasOwn(changes, key)
}

export function effectiveValue(changes: Changes, field: Field) {
  if (!isDirty(changes, field.key)) return field.value
  const change = changes[field.key]
  return change === null ? field.env_value : change
}
