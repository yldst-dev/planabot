import {
  ActivityIcon,
  ArrowUpRightIcon,
  BotIcon,
  BrainCircuitIcon,
  CircleCheckIcon,
  GitForkIcon,
  HardDriveIcon,
  type LucideIcon,
  TagIcon,
} from "lucide-react"
import type { ReactNode } from "react"
import { Link } from "react-router"

import { GroupIcon } from "@/components/group-icon"
import { Badge } from "@/components/ui/badge"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Item, ItemActions, ItemContent, ItemGroup, ItemMedia, ItemTitle } from "@/components/ui/item"
import { Skeleton } from "@/components/ui/skeleton"
import { useOverview, useSettings } from "@/hooks/use-dashboard"
import { formatUptime } from "@/lib/format"
import { fieldsIn, findGroup, withCustom } from "@/lib/groups"
import { cn } from "@/lib/utils"

export function OverviewPage() {
  const overview = useOverview()
  const settings = useSettings()

  if (!overview.data || !settings.data) {
    return (
      <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-5 px-4 py-5 md:px-8">
        <Skeleton className="h-24 w-full" />
        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
          <Skeleton className="h-72" />
          <Skeleton className="h-72" />
        </div>
      </div>
    )
  }

  const o = overview.data
  const { groups, fields } = settings.data
  const byKey = new Map(fields.map((field) => [field.key, field]))

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-6 px-4 py-5 md:px-8">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">개요</h1>
        <p className="text-sm text-muted-foreground">실행 중인 봇의 상태와 설정 구성을 한눈에 봅니다.</p>
      </div>

      <dl className="grid grid-cols-2 overflow-hidden rounded-lg border md:grid-cols-3 xl:grid-cols-5 [&>div]:border-b [&>div]:border-r">
        <Stat icon={TagIcon} label="버전" value={`v${o.version}`} sub={`가동 ${formatUptime(o.uptime)}`} />
        <Stat icon={BotIcon} label="텔레그램 봇" value={o.bot_username ? `@${o.bot_username}` : "연결 전"} sub="봇 계정" />
        <Stat icon={BrainCircuitIcon} label="주 제공자" value={o.provider ?? "google"} sub={o.model ?? "모델 기본값"} />
        <Stat icon={GitForkIcon} label="보조 제공자" value={o.aux_provider ?? "주 제공자와 같음"} sub="검색어와 전달문" />
        <Stat
          icon={ActivityIcon}
          label="planabrain 서버"
          value={
            <span className="flex items-center gap-2">
              <span className={cn("size-2 rounded-full", o.planabrain_server ? "bg-success" : "bg-muted-foreground/50")} />
              {o.planabrain_server ? "응답 중" : "대기 중"}
            </span>
          }
          sub={`허용 채팅 ${o.allowed_chats} · 사용자 ${o.allowed_users}`}
        />
      </dl>

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
        <section className="flex min-w-0 flex-col gap-3">
          <SectionTitle title="적용 대기" count={o.pending.length} tone="warning" />
          {o.pending.length === 0 ? (
            <Empty className="border border-dashed py-10">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <CircleCheckIcon />
                </EmptyMedia>
                <EmptyTitle>대기 중인 변경 없음</EmptyTitle>
                <EmptyDescription>실행 중인 설정과 저장된 설정이 같습니다.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ItemGroup className="gap-1">
              {o.pending.map((key) => {
                const field = byKey.get(key)
                const group = field ? findGroup(groups, field.group) : undefined
                return (
                  <Item key={key} size="sm" variant="outline" asChild>
                    <Link to={field ? `/g/${field.group}?focus=${key}` : "/g/custom"}>
                      <ItemMedia variant="icon" className="text-warning">
                        <GroupIcon id={field?.group ?? "custom"} />
                      </ItemMedia>
                      <ItemContent className="min-w-0">
                        <ItemTitle className="w-full truncate">{field?.label ?? key}</ItemTitle>
                        <code className="truncate font-mono text-[11.5px] text-muted-foreground">{key}</code>
                      </ItemContent>
                      <ItemActions className="text-xs text-muted-foreground">{group?.label}</ItemActions>
                    </Link>
                  </Item>
                )
              })}
            </ItemGroup>
          )}
          <p className="flex items-start gap-2 text-xs text-muted-foreground">
            <HardDriveIcon className="mt-0.5 size-3.5 shrink-0" />
            <span className="min-w-0 break-all">
              저장한 값은 <code className="font-mono">{o.state_path}</code>에 남고, 재시작할 때 env보다 먼저 적용됩니다.
            </span>
          </p>
        </section>

        <section className="flex min-w-0 flex-col gap-3">
          <SectionTitle title="분류별 구성" hint="지정됨/전체" />
          <div className="grid gap-x-6 sm:grid-cols-2">
            {withCustom(groups).map((group) => {
              const inGroup = fieldsIn(fields, group.id)
              const set = inGroup.filter((field) => field.source !== "unset").length
              const mine = inGroup.filter((field) => field.source === "dashboard").length
              return (
                <Link
                  key={group.id}
                  to={`/g/${group.id}`}
                  className="group flex h-10 items-center gap-3 border-b px-1 text-sm transition-colors hover:bg-muted/50"
                >
                  <GroupIcon id={group.id} className="size-4 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{group.label}</span>
                  {mine > 0 ? (
                    <Badge className="border-transparent bg-primary/12 text-primary tabular-nums">대시보드 {mine}</Badge>
                  ) : null}
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {set}/{inGroup.length}
                  </span>
                  <ArrowUpRightIcon className="size-3.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                </Link>
              )
            })}
          </div>
        </section>
      </div>
    </div>
  )
}

function Stat({ icon: Icon, label, value, sub }: { icon: LucideIcon; label: string; value: ReactNode; sub: string }) {
  return (
    <div className="-mr-px -mb-px flex min-w-0 flex-col gap-1 p-4">
      <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="size-3.5" />
        {label}
      </dt>
      <dd className="truncate text-lg font-semibold tracking-tight">{value}</dd>
      <dd className="truncate text-xs text-muted-foreground">{sub}</dd>
    </div>
  )
}

function SectionTitle({ title, count, hint, tone }: { title: string; count?: number; hint?: string; tone?: "warning" }) {
  return (
    <div className="flex items-center justify-between border-b pb-2">
      <h2 className="text-sm font-medium text-muted-foreground">{title}</h2>
      {count ? (
        <Badge className={cn("tabular-nums", tone === "warning" && "border-transparent bg-warning/12 text-warning")}>{count}개</Badge>
      ) : hint ? (
        <span className="text-xs text-muted-foreground">{hint}</span>
      ) : null}
    </div>
  )
}
