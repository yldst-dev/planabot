import { create } from "zustand"

import type { Changes, Field } from "@/lib/types"

interface ChangesState {
  changes: Changes
  sending: Record<string, number>
  invalid: { key: string; message: string } | null
  edit: (field: Field, value: string | null | undefined) => void
  drop: (keys: string[]) => void
  send: (sent: Changes) => void
  settle: (sent: Changes) => void
  release: (sent: Changes, fields: Field[]) => void
  fail: (key: string, message: string) => void
  clear: () => void
}

const matchesServer = (field: Field, value: string | null | undefined) =>
  field.kind !== "secret" && value === (field.value ?? "")

function hold(sending: Record<string, number>, sent: Changes, step: number) {
  const next = { ...sending }
  for (const key of Object.keys(sent)) {
    const count = (next[key] ?? 0) + step
    if (count > 0) next[key] = count
    else delete next[key]
  }
  return next
}

export const useChanges = create<ChangesState>((set) => ({
  changes: {},
  sending: {},
  invalid: null,
  edit: (field, value) =>
    set((state) => {
      const next = { ...state.changes }
      const unchanged = matchesServer(field, value) && !Object.hasOwn(state.sending, field.key)
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
  send: (sent) => set((state) => ({ sending: hold(state.sending, sent, 1) })),
  settle: (sent) =>
    set((state) => {
      const next = { ...state.changes }
      for (const [key, value] of Object.entries(sent)) {
        if (Object.hasOwn(next, key) && next[key] === value) delete next[key]
      }
      const invalid = state.invalid && Object.hasOwn(sent, state.invalid.key) ? null : state.invalid
      return { changes: next, sending: hold(state.sending, sent, -1), invalid }
    }),
  release: (sent, fields) =>
    set((state) => {
      const sending = hold(state.sending, sent, -1)
      const next = { ...state.changes }
      for (const field of fields) {
        const settled = Object.hasOwn(sent, field.key) && !Object.hasOwn(sending, field.key)
        if (settled && Object.hasOwn(next, field.key) && matchesServer(field, next[field.key])) delete next[field.key]
      }
      const invalid = state.invalid && !Object.hasOwn(next, state.invalid.key) ? null : state.invalid
      return { changes: next, sending, invalid }
    }),
  fail: (key, message) => set((state) => (Object.hasOwn(state.changes, key) ? { invalid: { key, message } } : {})),
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
