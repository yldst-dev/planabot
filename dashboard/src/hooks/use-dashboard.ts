import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { Changes } from "@/lib/types"
import { useChanges } from "@/stores/changes"
import { useRecovery } from "@/stores/recovery"

export const queryKeys = {
  session: ["session"] as const,
  overview: ["overview"] as const,
  settings: ["settings"] as const,
}

export function useSession() {
  return useQuery({ queryKey: queryKeys.session, queryFn: api.session, retry: false })
}

export function useOverview() {
  return useQuery({ queryKey: queryKeys.overview, queryFn: api.overview, refetchInterval: 30_000 })
}

export function useSettings() {
  return useQuery({ queryKey: queryKeys.settings, queryFn: api.settings })
}

export function useLogin() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: api.login,
    onSuccess: () => client.invalidateQueries(),
  })
}

export function useSetup() {
  const show = useRecovery((state) => state.show)
  return useMutation({
    mutationFn: ({ setupCode, password }: { setupCode: string; password: string }) => api.setup(setupCode, password),
    onSuccess: (data) => show(data.recovery_code, "setup"),
  })
}

export function useRecover() {
  const show = useRecovery((state) => state.show)
  return useMutation({
    mutationFn: ({ recoveryCode, password }: { recoveryCode: string; password: string }) =>
      api.recover(recoveryCode, password),
    onSuccess: (data) => show(data.recovery_code, "recover"),
  })
}

export function useChangePassword() {
  return useMutation({
    mutationFn: ({ currentPassword, password }: { currentPassword: string; password: string }) =>
      api.changePassword(currentPassword, password),
  })
}

export function useRegenerateRecovery() {
  return useMutation({ mutationFn: api.regenerateRecovery })
}

export function useLogout() {
  const client = useQueryClient()
  const clear = useChanges((state) => state.clear)
  return useMutation({
    mutationFn: api.logout,
    onSettled: () => {
      clear()
      client.removeQueries({ queryKey: queryKeys.overview })
      client.removeQueries({ queryKey: queryKeys.settings })
      client.setQueryData(queryKeys.session, { enabled: true, configured: true, authenticated: false })
    },
  })
}

export function useSave() {
  const client = useQueryClient()
  const drop = useChanges((state) => state.drop)
  return useMutation({
    mutationFn: (changes: Changes) => api.save(changes),
    onSuccess: (data, changes) => {
      drop(Object.keys(changes))
      client.setQueryData(queryKeys.settings, data)
      return client.invalidateQueries({ queryKey: queryKeys.overview })
    },
  })
}
