import { CheckIcon, EyeIcon, EyeOffIcon, LockKeyholeIcon, XIcon } from "lucide-react"
import { useState } from "react"

import { Field, FieldLabel } from "@/components/ui/field"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group"
import { passwordChecks, passwordStrength, STRENGTH_LABELS } from "@/lib/password"
import { cn } from "@/lib/utils"

interface PasswordInputProps {
  id: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  autoComplete: string
  autoFocus?: boolean
  invalid?: boolean
}

export function PasswordInput({ id, value, onChange, placeholder, autoComplete, autoFocus, invalid }: PasswordInputProps) {
  const [visible, setVisible] = useState(false)
  return (
    <InputGroup className="h-10">
      <InputGroupAddon>
        <LockKeyholeIcon />
      </InputGroupAddon>
      <InputGroupInput
        id={id}
        type={visible ? "text" : "password"}
        value={value}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        placeholder={placeholder}
        spellCheck={false}
        aria-invalid={invalid || undefined}
        onChange={(event) => onChange(event.target.value)}
      />
      <InputGroupAddon align="inline-end">
        <InputGroupButton
          size="icon-xs"
          aria-label={visible ? "비밀번호 숨기기" : "비밀번호 보기"}
          onClick={() => setVisible((current) => !current)}
        >
          {visible ? <EyeOffIcon /> : <EyeIcon />}
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  )
}

interface NewPasswordFieldsProps {
  password: string
  confirm: string
  onPassword: (value: string) => void
  onConfirm: (value: string) => void
  autoFocus?: boolean
}

export function NewPasswordFields({ password, confirm, onPassword, onConfirm, autoFocus }: NewPasswordFieldsProps) {
  const checks = passwordChecks(password, confirm)
  const strength = passwordStrength(password)

  return (
    <>
      <Field>
        <FieldLabel htmlFor="new-password">새 비밀번호</FieldLabel>
        <PasswordInput
          id="new-password"
          value={password}
          onChange={onPassword}
          autoComplete="new-password"
          autoFocus={autoFocus}
        />
        <div className="flex items-center gap-3">
          <div className="grid flex-1 grid-cols-4 gap-1" aria-hidden>
            {[1, 2, 3, 4].map((step) => (
              <span
                key={step}
                className={cn(
                  "h-1 rounded-full bg-muted transition-colors",
                  strength >= step && (strength <= 1 ? "bg-destructive" : strength === 2 ? "bg-warning" : "bg-success"),
                )}
              />
            ))}
          </div>
          <span className="w-14 text-right text-xs text-muted-foreground">
            {password ? STRENGTH_LABELS[strength] : ""}
          </span>
        </div>
      </Field>
      <Field>
        <FieldLabel htmlFor="confirm-password">새 비밀번호 확인</FieldLabel>
        <PasswordInput id="confirm-password" value={confirm} onChange={onConfirm} autoComplete="new-password" />
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {checks.map((check) => (
            <li
              key={check.label}
              className={cn("flex items-center gap-1", check.ok ? "text-success" : "text-muted-foreground")}
            >
              {check.ok ? <CheckIcon className="size-3.5" /> : <XIcon className="size-3.5" />}
              {check.label}
            </li>
          ))}
        </ul>
      </Field>
    </>
  )
}
