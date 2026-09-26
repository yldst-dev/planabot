import { EyeIcon, EyeOffIcon, FileTextIcon, KeyRoundIcon, PencilLineIcon } from "lucide-react"
import { useState } from "react"

import { PromptEditor } from "@/components/settings/prompt-editor"
import { Button } from "@/components/ui/button"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { truthy } from "@/lib/format"
import type { Field } from "@/lib/types"
import { effectiveValue, isDirty, useChanges } from "@/stores/changes"

const UNSET = "__unset__"

export function SettingControl({ field, id }: { field: Field; id: string }) {
  const changes = useChanges((state) => state.changes)
  const edit = useChanges((state) => state.edit)
  const value = effectiveValue(changes, field)
  const dirty = isDirty(changes, field.key)

  switch (field.kind) {
    case "bool": {
      const on = truthy(value)
      const unset = value == null && !dirty
      return (
        <div className="flex h-9 items-center gap-3">
          <Switch id={id} checked={on} onCheckedChange={(checked) => edit(field, checked ? "1" : "0")} />
          <span className="text-sm text-muted-foreground">{unset ? "코드 기본값" : on ? "켬" : "끔"}</span>
        </div>
      )
    }
    case "select": {
      const options = value && !field.options.includes(value) ? [value, ...field.options] : field.options
      return (
        <Select value={value || UNSET} onValueChange={(next) => edit(field, next === UNSET ? "" : next)}>
          <SelectTrigger id={id} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper">
            <SelectItem value={UNSET}>
              <span className="text-muted-foreground">지정 안 함</span>
            </SelectItem>
            {options.map((option) => (
              <SelectItem key={option} value={option}>
                {option}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )
    }
    case "textarea":
      return <TextareaControl field={field} id={id} value={value} />
    case "secret":
      return <SecretControl field={field} id={id} />
    default:
      return (
        <Input
          id={id}
          value={value ?? ""}
          placeholder={field.placeholder}
          inputMode={field.kind === "number" ? "decimal" : undefined}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => edit(field, event.target.value)}
        />
      )
  }
}

function SecretControl({ field, id }: { field: Field; id: string }) {
  const changes = useChanges((state) => state.changes)
  const edit = useChanges((state) => state.edit)
  const [visible, setVisible] = useState(false)
  const change = changes[field.key]
  const typed = typeof change === "string" ? change : ""
  const hint = change === null ? field.env_hint : field.hint

  return (
    <InputGroup>
      <InputGroupAddon>
        <KeyRoundIcon />
      </InputGroupAddon>
      <InputGroupInput
        id={id}
        type={visible ? "text" : "password"}
        value={typed}
        autoComplete="new-password"
        spellCheck={false}
        placeholder={hint ? `${hint}  새 값 입력` : "설정 안 됨"}
        onChange={(event) => edit(field, event.target.value === "" ? undefined : event.target.value)}
      />
      {typed ? (
        <InputGroupAddon align="inline-end">
          <InputGroupButton
            size="icon-xs"
            aria-label={visible ? "입력값 숨기기" : "입력값 보기"}
            onClick={() => setVisible((current) => !current)}
          >
            {visible ? <EyeOffIcon /> : <EyeIcon />}
          </InputGroupButton>
        </InputGroupAddon>
      ) : null}
    </InputGroup>
  )
}

function TextareaControl({ field, id, value }: { field: Field; id: string; value: string | null }) {
  const [open, setOpen] = useState(false)
  const preview = value ? value.replace(/\s+/g, " ").slice(0, 48) : "기본 프롬프트 사용"

  return (
    <>
      <Button id={id} variant="outline" className="w-full justify-start font-normal" onClick={() => setOpen(true)}>
        <FileTextIcon className="text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-left">{preview}</span>
        <PencilLineIcon className="text-muted-foreground" />
      </Button>
      <PromptEditor field={field} open={open} onOpenChange={setOpen} initial={value ?? ""} />
    </>
  )
}
