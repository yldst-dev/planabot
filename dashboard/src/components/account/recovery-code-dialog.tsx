import { RefreshCwIcon } from "lucide-react"
import { type FormEvent, useState } from "react"

import { PasswordInput } from "@/components/auth/password-fields"
import { RecoveryCodePanel } from "@/components/auth/recovery-code-panel"
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
import { Field, FieldError, FieldLabel } from "@/components/ui/field"
import { Spinner } from "@/components/ui/spinner"
import { useRegenerateRecovery } from "@/hooks/use-dashboard"

export function RecoveryCodeDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">{open ? <RecoveryCodeForm /> : null}</DialogContent>
    </Dialog>
  )
}

function RecoveryCodeForm() {
  const regenerate = useRegenerateRecovery()
  const [password, setPassword] = useState("")

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (password) regenerate.mutate(password, { onSuccess: () => setPassword("") })
  }

  if (regenerate.data) {
    return (
      <div className="flex flex-col gap-5">
        <DialogHeader>
          <DialogTitle>새 복구 코드</DialogTitle>
          <DialogDescription>이전 복구 코드는 더 이상 쓸 수 없습니다. 창을 닫으면 다시 볼 수 없습니다.</DialogDescription>
        </DialogHeader>
        <RecoveryCodePanel code={regenerate.data.recovery_code} />
        <DialogFooter>
          <DialogClose asChild>
            <Button>저장했습니다</Button>
          </DialogClose>
        </DialogFooter>
      </div>
    )
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-5">
      <DialogHeader>
        <DialogTitle>복구 코드 재발급</DialogTitle>
        <DialogDescription>복구 코드를 잃어버렸거나 노출됐을 때 새로 받습니다. 이전 코드는 즉시 무효가 됩니다.</DialogDescription>
      </DialogHeader>
      <Field data-invalid={regenerate.isError || undefined}>
        <FieldLabel htmlFor="confirm-current">현재 비밀번호</FieldLabel>
        <PasswordInput
          id="confirm-current"
          value={password}
          onChange={(value) => {
            if (regenerate.isError) regenerate.reset()
            setPassword(value)
          }}
          autoComplete="current-password"
          autoFocus
          invalid={regenerate.isError}
        />
        {regenerate.isError ? <FieldError>{regenerate.error.message}</FieldError> : null}
      </Field>
      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline">
            취소
          </Button>
        </DialogClose>
        <Button type="submit" disabled={!password || regenerate.isPending}>
          {regenerate.isPending ? <Spinner /> : <RefreshCwIcon />}
          재발급
        </Button>
      </DialogFooter>
    </form>
  )
}
