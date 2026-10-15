import { ImportIcon } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field"
import { Spinner } from "@/components/ui/spinner"
import { useImportEnv } from "@/hooks/use-dashboard"
import type { Field as SettingField, Group } from "@/lib/types"

export function EnvImportDialog({
  open,
  onOpenChange,
  groups,
  fields,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  groups: Group[]
  fields: SettingField[]
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {open ? <ImportForm groups={groups} fields={fields} onDone={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  )
}

function ImportForm({ groups, fields, onDone }: { groups: Group[]; fields: SettingField[]; onDone: () => void }) {
  const importEnv = useImportEnv()
  const [selected, setSelected] = useState(() => new Set(fields.map((field) => field.key)))
  const sections = groups
    .map((group) => ({ group, items: fields.filter((field) => field.group === group.id) }))
    .filter((section) => section.items.length > 0)

  const toggle = (key: string, checked: boolean) =>
    setSelected((current) => {
      const next = new Set(current)
      if (checked) next.add(key)
      else next.delete(key)
      return next
    })

  const submit = () =>
    importEnv.mutate([...selected], {
      onSuccess: (data) => {
        toast.success("가져오기 완료.", { description: `${data.imported.length}개 값을 대시보드에 저장했습니다.` })
        const skipped = data.skipped ?? []
        if (skipped.length > 0) {
          toast.warning(`${skipped.length}개는 가져오지 않았습니다.`, {
            description: skipped.map((item) => `${item.key}: ${item.message}`).join(" · "),
          })
        }
        onDone()
      },
      onError: (error) => toast.error("가져오기 불가.", { description: error.message }),
    })

  return (
    <div className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>env 값 가져오기</DialogTitle>
        <DialogDescription>
          env에만 있는 값을 대시보드 저장 파일로 복사합니다. 실행 중인 값과 같아서 재시작하지 않아도 됩니다.
        </DialogDescription>
      </DialogHeader>
      <Field orientation="horizontal">
        <Checkbox
          id="import-all"
          checked={selected.size === fields.length}
          onCheckedChange={(checked) => setSelected(new Set(checked === true ? fields.map((field) => field.key) : []))}
        />
        <FieldLabel htmlFor="import-all">
          전체 선택 {selected.size}/{fields.length}
        </FieldLabel>
      </Field>
      <div className="-mx-1 max-h-80 overflow-y-auto border-y px-1 py-3">
        <FieldGroup>
          {sections.map(({ group, items }) => (
            <FieldSet key={group.id}>
              <FieldLegend variant="label">{group.label}</FieldLegend>
              {items.map((field) => (
                <Field key={field.key} orientation="horizontal">
                  <Checkbox
                    id={`import-${field.key}`}
                    checked={selected.has(field.key)}
                    onCheckedChange={(checked) => toggle(field.key, checked === true)}
                  />
                  <FieldContent>
                    <FieldLabel htmlFor={`import-${field.key}`}>{field.label}</FieldLabel>
                    <FieldDescription>
                      <span className="block truncate" title={field.key}>
                        <code className="font-mono">{field.key}</code> {preview(field)}
                      </span>
                    </FieldDescription>
                  </FieldContent>
                </Field>
              ))}
            </FieldSet>
          ))}
        </FieldGroup>
      </div>
      <p className="text-xs text-muted-foreground">
        가져온 값은 Dokploy 환경 변수에서 지워도 됩니다. 봇 토큰과 상태 검사 비밀값 같은 env 전용 값은 가져오지 않으니 Dokploy에 그대로 두십시오. 저장 파일이 있는 볼륨을 지우면 가져온 값도 함께 사라집니다.
      </p>
      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline">
            취소
          </Button>
        </DialogClose>
        <Button type="button" onClick={submit} disabled={selected.size === 0 || importEnv.isPending}>
          {importEnv.isPending ? <Spinner /> : <ImportIcon />}
          {selected.size}개 가져오기
        </Button>
      </DialogFooter>
    </div>
  )
}

function preview(field: SettingField) {
  if (field.kind === "secret") return field.env_hint ?? ""
  const value = (field.env_value ?? "").replace(/\s+/g, " ")
  return value.length > 40 ? `${value.slice(0, 40)}…` : value
}
