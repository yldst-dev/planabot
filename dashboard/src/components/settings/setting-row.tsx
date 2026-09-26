import { RotateCcwIcon, Undo2Icon } from "lucide-react"

import { SettingControl } from "@/components/settings/setting-control"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { Field as SettingField } from "@/lib/types"
import { cn } from "@/lib/utils"
import { isDirty, useChanges } from "@/stores/changes"

export function SettingRow({
  field,
  groupLabel,
  highlighted,
}: {
  field: SettingField
  groupLabel?: string
  highlighted?: boolean
}) {
  const changes = useChanges((state) => state.changes)
  const edit = useChanges((state) => state.edit)
  const drop = useChanges((state) => state.drop)
  const dirty = isDirty(changes, field.key)
  const restoring = dirty && changes[field.key] === null
  const id = `field-${field.key}`

  return (
    <Field
      id={`row-${field.key}`}
      orientation="horizontal"
      data-dirty={dirty || undefined}
      className={cn(
        "flex-col items-stretch gap-3 rounded-none border-b py-3.5 transition-colors @md/rows:flex-row @md/rows:items-center",
        highlighted && "rounded-md bg-primary/5 ring-2 ring-primary/40 ring-offset-4 ring-offset-background",
      )}
    >
      <FieldContent className="min-w-0 gap-0.5">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <FieldLabel htmlFor={id} className={cn("font-medium", dirty && "text-primary")}>
            {field.label}
          </FieldLabel>
          {restoring ? (
            <Badge variant="outline">env로 복원 예정</Badge>
          ) : field.source === "dashboard" ? (
            <Badge className="border-transparent bg-primary/12 text-primary">대시보드</Badge>
          ) : field.source === "env" ? (
            <Badge variant="outline" className="text-muted-foreground">
              env
            </Badge>
          ) : null}
          {field.pending ? (
            <Badge className="border-transparent bg-warning/12 text-warning">재시작 대기</Badge>
          ) : null}
        </div>
        <code className="truncate font-mono text-[11.5px] text-muted-foreground/80" title={field.key}>
          {groupLabel ? `${groupLabel} · ${field.key}` : field.key}
        </code>
        {field.help ? (
          <FieldDescription className="truncate text-xs" title={field.help}>
            {field.help}
          </FieldDescription>
        ) : null}
      </FieldContent>
      <div className="flex w-full shrink-0 items-center gap-1.5 @md/rows:w-[46%] @md/rows:max-w-80">
        <div className="min-w-0 flex-1">
          <SettingControl field={field} id={id} />
        </div>
        {dirty ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="편집 취소" onClick={() => drop([field.key])}>
                <Undo2Icon />
              </Button>
            </TooltipTrigger>
            <TooltipContent>편집 취소</TooltipContent>
          </Tooltip>
        ) : field.source === "dashboard" ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="env 값으로 되돌리기" onClick={() => edit(field, null)}>
                <RotateCcwIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent>대시보드 값을 지우고 env 값으로 되돌립니다</TooltipContent>
          </Tooltip>
        ) : (
          <span className="size-8 shrink-0" aria-hidden />
        )}
      </div>
    </Field>
  )
}
