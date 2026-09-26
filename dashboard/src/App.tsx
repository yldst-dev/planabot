import { Navigate, Route, Routes } from "react-router"

import { DashboardLayout } from "@/components/dashboard-layout"
import { HaloMark } from "@/components/halo-mark"
import { Spinner } from "@/components/ui/spinner"
import { useSession } from "@/hooks/use-dashboard"
import { useRecovery } from "@/stores/recovery"
import { AuthPage, RecoveryCodeScreen } from "@/pages/auth"
import { GroupPage } from "@/pages/group"
import { OverviewPage } from "@/pages/overview"

export function App() {
  const session = useSession()
  const recoveryCode = useRecovery((state) => state.code)

  if (recoveryCode) return <RecoveryCodeScreen />

  if (session.isPending) {
    return (
      <div className="grid min-h-svh place-items-center">
        <div className="flex items-center gap-3 text-muted-foreground">
          <HaloMark />
          <Spinner />
        </div>
      </div>
    )
  }

  if (!session.data) {
    return <AuthPage session={{ enabled: true, configured: true, authenticated: false }} />
  }

  if (!session.data.authenticated) return <AuthPage session={session.data} />

  return (
    <Routes>
      <Route element={<DashboardLayout />}>
        <Route index element={<OverviewPage />} />
        <Route path="g/:groupId" element={<GroupPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
