import { create } from "zustand"

export type RecoveryReason = "setup" | "recover"

interface RecoveryState {
  code: string | null
  reason: RecoveryReason | null
  show: (code: string, reason: RecoveryReason) => void
  dismiss: () => void
}

export const useRecovery = create<RecoveryState>((set) => ({
  code: null,
  reason: null,
  show: (code, reason) => set({ code, reason }),
  dismiss: () => set({ code: null, reason: null }),
}))
