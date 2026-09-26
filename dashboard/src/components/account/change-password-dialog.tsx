import { KeyRoundIcon } from "lucide-react"
import { type FormEvent, useState } from "react"
import { toast } from "sonner"

import { NewPasswordFields, PasswordInput } from "@/components/auth/password-fields"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Spinner } from "@/components/ui/spinner"
import { useChangePassword } from "@/hooks/use-dashboard"
import { isNewPasswordReady } from "@/lib/password"

export function ChangePasswordDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {open ? <ChangePasswordForm onDone={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  )
}

function ChangePasswordForm({ onDone }: { onDone: () => void }) {
  const change = useChangePassword()
  const [current, setCurrent] = useState("")
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const ready = current.length > 0 && isNewPasswordReady(password, confirm)

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!ready) return
    change.mutate(
      { currentPassword: current, password },
      {
        onSuccess: () => {
          toast.success("비밀번호 변경 완료.", { description: "다른 기기의 로그인은 모두 끊겼습니다." })
          onDone()
        },
      },
    )
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-5">
      <DialogHeader>
        <DialogTitle>비밀번호 변경</DialogTitle>
        <DialogDescription>바꾸면 이 브라우저를 뺀 모든 로그인 세션이 끊깁니다. 복구 코드는 그대로입니다.</DialogDescription>
      </DialogHeader>
      <FieldGroup className="gap-5">
        <Field data-invalid={change.isError || undefined}>
          <FieldLabel htmlFor="current-password">현재 비밀번호</FieldLabel>
          <PasswordInput
            id="current-password"
            value={current}
            onChange={(value) => {
              if (change.isError) change.reset()
              setCurrent(value)
            }}
            autoComplete="current-password"
            autoFocus
            invalid={change.isError}
          />
          {change.isError ? <FieldError>{change.error.message}</FieldError> : null}
        </Field>
        <NewPasswordFields password={password} confirm={confirm} onPassword={setPassword} onConfirm={setConfirm} />
      </FieldGroup>
      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline">
            취소
          </Button>
        </DialogClose>
        <Button type="submit" disabled={!ready || change.isPending}>
          {change.isPending ? <Spinner /> : <KeyRoundIcon />}
          변경
        </Button>
      </DialogFooter>
    </form>
  )
}
