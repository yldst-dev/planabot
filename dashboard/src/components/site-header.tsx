import { SaveIcon, Undo2Icon } from "lucide-react"
import { useEffect } from "react"
import { useLocation } from "react-router"
import { toast } from "sonner"

import { GroupIcon } from "@/components/group-icon"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { Separator } from "@/components/ui/separator"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { Spinner } from "@/components/ui/spinner"
import { useSave, useSettings } from "@/hooks/use-dashboard"
import { findGroup } from "@/lib/groups"
import { useChanges } from "@/stores/changes"

export function SiteHeader() {
  const location = useLocation()
  const settings = useSettings()
  const changes = useChanges((state) => state.changes)
  const clear = useChanges((state) => state.clear)
  const save = useSave()
  const count = Object.keys(changes).length

  const groupId = location.pathname.startsWith("/g/") ? location.pathname.slice(3) : null
  const group = groupId ? findGroup(settings.data?.groups ?? [], groupId) : null

  const submit = () => {
    if (count === 0 || save.isPending) return
    save.mutate(changes, {
      onSuccess: () => toast.success("저장 완료.", { description: "재시작하면 적용됩니다." }),
      onError: (error) => toast.error("저장 불가.", { description: error.message }),
    })
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault()
        submit()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  })

  useEffect(() => {
    const onUnload = (event: BeforeUnloadEvent) => {
      if (count > 0) event.preventDefault()
    }
    window.addEventListener("beforeunload", onUnload)
    return () => window.removeEventListener("beforeunload", onUnload)
  }, [count])

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mx-1 data-vertical:h-4 data-vertical:self-center" />
      <Breadcrumb className="min-w-0 flex-1">
        <BreadcrumbList>
          <BreadcrumbItem className="hidden sm:inline-flex">{group ? group.section : "planabot"}</BreadcrumbItem>
          <BreadcrumbSeparator className="hidden sm:inline-flex" />
          <BreadcrumbItem>
            <BreadcrumbPage className="flex items-center gap-2 font-medium">
              {group ? <GroupIcon id={group.id} className="size-4 text-muted-foreground" /> : null}
              {group ? group.label : "개요"}
            </BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
      {count > 0 ? (
        <div className="flex items-center gap-2">
          <span className="hidden text-sm text-muted-foreground tabular-nums sm:inline">변경 {count}개</span>
          <Button variant="ghost" size="sm" onClick={() => clear()}>
            <Undo2Icon />
            되돌리기
          </Button>
          <Button size="sm" onClick={submit} disabled={save.isPending}>
            {save.isPending ? <Spinner /> : <SaveIcon />}
            저장
            <Kbd className="hidden bg-primary-foreground/15 text-primary-foreground sm:inline-flex">⌘S</Kbd>
          </Button>
        </div>
      ) : null}
    </header>
  )
}
