import { BracesIcon, PlusIcon } from "lucide-react"
import { type FormEvent, useEffect, useState } from "react"
import { Navigate, useParams, useSearchParams } from "react-router"
import { toast } from "sonner"

import { GroupIcon } from "@/components/group-icon"
import { SettingRow } from "@/components/settings/setting-row"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { useSave, useSettings } from "@/hooks/use-dashboard"
import { KEY_PATTERN } from "@/lib/format"
import { fieldsIn, findGroup } from "@/lib/groups"
import type { Field } from "@/lib/types"

export function GroupPage() {
  const { groupId = "" } = useParams()
  const [params, setParams] = useSearchParams()
  const settings = useSettings()
  const focus = params.get("focus")
  const ready = Boolean(settings.data)

  useEffect(() => {
    if (!focus || !ready) return
    document.getElementById(`row-${focus}`)?.scrollIntoView({ block: "center" })
    document.getElementById(`field-${focus}`)?.focus({ preventScroll: true })
    const timer = window.setTimeout(() => setParams({}, { replace: true }), 1800)
    return () => window.clearTimeout(timer)
  }, [focus, ready, setParams])

  if (settings.isPending) return <GroupSkeleton />
  if (!settings.data) return null

  const group = findGroup(settings.data.groups, groupId)
  if (!group) return <Navigate to="/" replace />

  const fields = fieldsIn(settings.data.fields, group.id)
  const configured = fields.filter((field) => field.source !== "unset").length
  const mine = fields.filter((field) => field.source === "dashboard").length
  const columns = fields.length > 5 ? split(fields) : [fields]

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-4 px-4 py-5 md:px-8">
      <div className="flex flex-wrap items-center gap-3">
        <span className="grid size-9 place-items-center rounded-lg border bg-muted/40">
          <GroupIcon id={group.id} className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-semibold tracking-tight">{group.label}</h1>
          <p className="text-sm text-muted-foreground">{group.description}</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="tabular-nums">
            지정 {configured}/{fields.length}
          </Badge>
          {mine > 0 ? (
            <Badge className="border-transparent bg-primary/12 text-primary tabular-nums">대시보드 {mine}</Badge>
          ) : null}
        </div>
      </div>

      {group.id === "custom" ? <AddKeyForm existing={settings.data.fields} /> : null}

      {fields.length === 0 ? (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <BracesIcon />
            </EmptyMedia>
            <EmptyTitle>지정한 키 없음</EmptyTitle>
            <EmptyDescription>목록에 없는 환경 변수를 위에서 추가하면 여기에 나타납니다.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className={columns.length > 1 ? "grid gap-x-10 xl:grid-cols-2" : "grid"}>
          {columns.map((column, index) => (
            <div key={index} className="@container/rows min-w-0 border-t xl:border-t">
              {column.map((field) => (
                <SettingRow key={field.key} field={field} highlighted={focus === field.key} />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function split(fields: Field[]) {
  const half = Math.ceil(fields.length / 2)
  return [fields.slice(0, half), fields.slice(half)]
}

function AddKeyForm({ existing }: { existing: Field[] }) {
  const save = useSave()
  const [key, setKey] = useState("")
  const [value, setValue] = useState("")

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const normalized = key.trim().toUpperCase()
    if (!KEY_PATTERN.test(normalized)) {
      toast.error("키 형식 오류.", { description: "대문자, 숫자, 밑줄만 씁니다." })
      return
    }
    if (existing.some((field) => field.key === normalized)) {
      toast.error("이미 있는 키입니다.")
      return
    }
    save.mutate({ [normalized]: value }, {
      onSuccess: () => {
        setKey("")
        setValue("")
        toast.success("추가 완료.", { description: "재시작하면 적용됩니다." })
      },
      onError: (error) => toast.error("추가 불가.", { description: error.message }),
    })
  }

  return (
    <form onSubmit={submit} className="grid gap-2 rounded-lg border bg-muted/30 p-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto]">
      <Input
        value={key}
        onChange={(event) => setKey(event.target.value.toUpperCase())}
        placeholder="PLANABRAIN_NEW_OPTION"
        aria-label="키"
        spellCheck={false}
        className="font-mono text-xs"
      />
      <Input value={value} onChange={(event) => setValue(event.target.value)} placeholder="값" aria-label="값" spellCheck={false} />
      <Button type="submit" disabled={!key.trim() || save.isPending}>
        {save.isPending ? <Spinner /> : <PlusIcon />}
        추가하고 저장
      </Button>
    </form>
  )
}

function GroupSkeleton() {
  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-4 px-4 py-5 md:px-8">
      <Skeleton className="h-9 w-64" />
      {Array.from({ length: 6 }, (_, index) => (
        <Skeleton key={index} className="h-14 w-full" />
      ))}
    </div>
  )
}
