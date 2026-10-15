import { useQueryClient } from "@tanstack/react-query"
import { RotateCwIcon } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "@/components/ui/sidebar"
import { Spinner } from "@/components/ui/spinner"
import { useOverview } from "@/hooks/use-dashboard"
import { api, AuthError } from "@/lib/api"
import { useChanges } from "@/stores/changes"

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const RESTART_WAIT_MS = 240_000

export function RestartPanel() {
  const overview = useOverview()
  const changes = useChanges((state) => state.changes)
  const client = useQueryClient()
  const { state } = useSidebar()
  const [restarting, setRestarting] = useState(false)
  const pending = overview.data?.pending.length ?? 0
  const dirty = Object.keys(changes).length

  if (pending === 0 && !restarting) return null

  const restart = async () => {
    if (dirty > 0) {
      toast.error("저장하지 않은 변경이 있습니다.", { description: "먼저 저장하십시오." })
      return
    }
    setRestarting(true)
    const baseline = await api.overview().then((data) => data.uptime).catch(() => undefined)
    try {
      await api.restart()
    } catch (error) {
      setRestarting(false)
      toast.error("재시작 불가.", { description: (error as Error).message })
      return
    }
    const started = Date.now()
    const progress = toast.loading("재시작 중.", {
      description: "처리 중인 답변이 끝나면 다시 켜집니다. 몇 분 걸릴 수 있습니다.",
    })
    let unreachable = false
    while (Date.now() - started < RESTART_WAIT_MS) {
      await wait(2000)
      try {
        const next = await api.overview()
        const elapsed = (Date.now() - started) / 1000
        const fresh = unreachable || (baseline !== undefined && next.uptime + 5 < baseline + elapsed)
        if (fresh) {
          await client.invalidateQueries()
          setRestarting(false)
          toast.success("재시작 완료.", { id: progress, description: "저장한 설정이 적용되었습니다." })
          return
        }
      } catch (error) {
        if (error instanceof AuthError) {
          setRestarting(false)
          toast.success("재시작 완료.", { id: progress, description: "다시 로그인해 주십시오." })
          await client.invalidateQueries()
          return
        }
        unreachable = true
      }
    }
    setRestarting(false)
    toast.error("응답 없음.", { id: progress, description: "컨테이너 재시작 정책을 확인하십시오." })
  }

  const trigger =
    state === "collapsed" ? (
      <SidebarMenu>
        <SidebarMenuItem>
          <AlertDialogTrigger asChild>
            <SidebarMenuButton
              tooltip={`적용 대기 ${pending}개`}
              aria-label={restarting ? "재시작 중" : `적용 대기 ${pending}개, 재시작`}
              className="text-warning"
              disabled={restarting}
            >
              {restarting ? <Spinner /> : <RotateCwIcon />}
            </SidebarMenuButton>
          </AlertDialogTrigger>
        </SidebarMenuItem>
      </SidebarMenu>
    ) : (
      <div className="flex items-center gap-3 rounded-lg bg-warning/10 p-3">
        <div className="flex min-w-0 flex-1 flex-col text-xs leading-snug">
          <span className="font-semibold text-warning">
            {restarting ? "재시작 중" : `적용 대기 ${pending}개`}
          </span>
          <span className="text-muted-foreground">재시작하면 적용됩니다</span>
        </div>
        <AlertDialogTrigger asChild>
          <Button size="sm" className="bg-warning text-warning-foreground hover:bg-warning/90" disabled={restarting}>
            {restarting ? <Spinner /> : <RotateCwIcon />}
            재시작
          </Button>
        </AlertDialogTrigger>
      </div>
    )

  return (
    <AlertDialog>
      {trigger}
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogMedia className="bg-warning/10 text-warning">
            <RotateCwIcon />
          </AlertDialogMedia>
          <AlertDialogTitle>봇을 재시작합니다</AlertDialogTitle>
          <AlertDialogDescription>
            대기 중인 변경 {pending}개가 적용됩니다. 처리 중인 답변이 끝날 때까지 기다린 뒤 다시 켜지므로 몇 분 동안 봇이
            응답하지 않을 수 있습니다.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>취소</AlertDialogCancel>
          <AlertDialogAction onClick={restart}>재시작</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
