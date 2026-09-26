import { useQueryClient } from "@tanstack/react-query"
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  KeyRoundIcon,
  LifeBuoyIcon,
  LockKeyholeIcon,
  LogInIcon,
  ShieldCheckIcon,
  TerminalIcon,
} from "lucide-react"
import { type FormEvent, type ReactNode, useState } from "react"

import { CopyButton } from "@/components/auth/copy-button"
import { NewPasswordFields, PasswordInput } from "@/components/auth/password-fields"
import { RecoveryCodePanel } from "@/components/auth/recovery-code-panel"
import { HaloMark } from "@/components/halo-mark"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { Kbd } from "@/components/ui/kbd"
import { Spinner } from "@/components/ui/spinner"
import { queryKeys, useLogin, useRecover, useSetup } from "@/hooks/use-dashboard"
import { isNewPasswordReady, RESET_COMMAND } from "@/lib/password"
import type { Session } from "@/lib/types"
import { useRecovery } from "@/stores/recovery"

function AuthShell({ title, description, children }: { title: string; description: ReactNode; children: ReactNode }) {
  return (
    <main className="grid min-h-svh place-items-center p-4">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <div className="flex flex-col gap-3">
          <HaloMark className="size-8 border-[3px]" />
          <div>
            <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{description}</p>
          </div>
        </div>
        {children}
      </div>
    </main>
  )
}

export function AuthPage({ session }: { session: Session }) {
  const [mode, setMode] = useState<"login" | "recover">("login")

  if (!session.enabled) {
    return (
      <main className="grid min-h-svh place-items-center p-4">
        <Empty className="max-w-md border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LockKeyholeIcon />
            </EmptyMedia>
            <EmptyTitle>대시보드 비활성</EmptyTitle>
            <EmptyDescription>
              <Kbd>PLANABOT_DASHBOARD_ENABLED=0</Kbd> 설정을 지우고 봇을 재시작하십시오.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </main>
    )
  }

  if (!session.configured) return <SetupForm />
  if (mode === "recover") return <RecoverForm onBack={() => setMode("login")} />
  return <LoginForm onForgot={() => setMode("recover")} />
}

function SetupForm() {
  const setup = useSetup()
  const [code, setCode] = useState("")
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const clearing = <T,>(set: (value: T) => void) => (value: T) => {
    if (setup.isError) setup.reset()
    set(value)
  }
  const ready = code.trim().length > 0 && isNewPasswordReady(password, confirm)

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (ready) setup.mutate({ setupCode: code, password })
  }

  return (
    <AuthShell title="비밀번호 설정" description="선생님. 첫 접속입니다. 관리자 비밀번호를 정하십시오.">
      <form onSubmit={submit}>
        <FieldGroup className="gap-5">
          <Field data-invalid={setup.isError || undefined}>
            <FieldLabel htmlFor="setup-code">설정 코드</FieldLabel>
            <InputGroup className="h-10">
              <InputGroupAddon>
                <TerminalIcon />
              </InputGroupAddon>
              <InputGroupInput
                id="setup-code"
                value={code}
                autoFocus
                autoComplete="one-time-code"
                spellCheck={false}
                placeholder="XXXX-XXXX-XXXX"
                className="font-mono tracking-wider uppercase"
                onChange={(event) => clearing(setCode)(event.target.value)}
              />
            </InputGroup>
            {setup.isError ? (
              <FieldError>{setup.error.message}</FieldError>
            ) : (
              <FieldDescription>
                봇 로그에 찍힌 코드입니다. <code className="font-mono text-xs">docker logs planabot</code>에서
                "설정 코드"를 찾으십시오.
              </FieldDescription>
            )}
          </Field>
          <NewPasswordFields
            password={password}
            confirm={confirm}
            onPassword={clearing(setPassword)}
            onConfirm={clearing(setConfirm)}
          />
          <Button type="submit" size="lg" disabled={!ready || setup.isPending}>
            {setup.isPending ? <Spinner /> : <ShieldCheckIcon />}
            비밀번호 설정
          </Button>
        </FieldGroup>
      </form>
    </AuthShell>
  )
}

function LoginForm({ onForgot }: { onForgot: () => void }) {
  const login = useLogin()
  const [password, setPassword] = useState("")

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (password) login.mutate(password, { onSuccess: () => setPassword("") })
  }

  return (
    <AuthShell title="planabot 설정" description="선생님. 비밀번호를 입력하십시오.">
      <form onSubmit={submit}>
        <FieldGroup className="gap-5">
          <Field data-invalid={login.isError || undefined}>
            <div className="flex items-center justify-between">
              <FieldLabel htmlFor="password">비밀번호</FieldLabel>
              <Button type="button" variant="link" size="sm" className="h-auto p-0 text-xs" onClick={onForgot}>
                비밀번호를 잊으셨습니까?
              </Button>
            </div>
            <PasswordInput
              id="password"
              value={password}
              onChange={(value) => {
                if (login.isError) login.reset()
                setPassword(value)
              }}
              autoComplete="current-password"
              autoFocus
              invalid={login.isError}
            />
            {login.isError ? (
              <FieldError>{login.error.message}</FieldError>
            ) : (
              <FieldDescription>세션은 12시간 유지됩니다.</FieldDescription>
            )}
          </Field>
          <Button type="submit" size="lg" disabled={!password || login.isPending}>
            {login.isPending ? <Spinner /> : <LogInIcon />}
            로그인
          </Button>
        </FieldGroup>
      </form>
    </AuthShell>
  )
}

function RecoverForm({ onBack }: { onBack: () => void }) {
  const recover = useRecover()
  const [code, setCode] = useState("")
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const clearing = <T,>(set: (value: T) => void) => (value: T) => {
    if (recover.isError) recover.reset()
    set(value)
  }
  const ready = code.trim().length > 0 && isNewPasswordReady(password, confirm)

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (ready) recover.mutate({ recoveryCode: code, password })
  }

  return (
    <AuthShell title="비밀번호 재설정" description="처음 비밀번호를 정할 때 받은 복구 코드로 새 비밀번호를 정합니다.">
      <form onSubmit={submit}>
        <FieldGroup className="gap-5">
          <Field data-invalid={recover.isError || undefined}>
            <FieldLabel htmlFor="recovery-code">복구 코드</FieldLabel>
            <InputGroup className="h-10">
              <InputGroupAddon>
                <KeyRoundIcon />
              </InputGroupAddon>
              <InputGroupInput
                id="recovery-code"
                value={code}
                autoFocus
                autoComplete="off"
                spellCheck={false}
                placeholder="XXXX-XXXX-XXXX-XXXX-XXXX"
                className="font-mono tracking-wider uppercase"
                onChange={(event) => clearing(setCode)(event.target.value)}
              />
            </InputGroup>
            {recover.isError ? (
              <FieldError>{recover.error.message}</FieldError>
            ) : (
              <FieldDescription>한 번 쓰면 새 복구 코드로 바뀝니다.</FieldDescription>
            )}
          </Field>
          <NewPasswordFields
            password={password}
            confirm={confirm}
            onPassword={clearing(setPassword)}
            onConfirm={clearing(setConfirm)}
          />
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="lg" onClick={onBack}>
              <ArrowLeftIcon />
              로그인
            </Button>
            <Button type="submit" size="lg" className="flex-1" disabled={!ready || recover.isPending}>
              {recover.isPending ? <Spinner /> : <ShieldCheckIcon />}
              재설정
            </Button>
          </div>
        </FieldGroup>
      </form>
      <div className="flex flex-col gap-2 rounded-lg border p-4 text-sm">
        <div className="flex items-center gap-2 font-medium">
          <LifeBuoyIcon className="size-4 text-muted-foreground" />
          복구 코드도 없습니까?
        </div>
        <p className="text-xs text-muted-foreground">
          서버에서 아래 명령을 실행하면 비밀번호가 지워지고 새 설정 코드가 출력됩니다. 그 코드로 처음처럼 다시
          설정하십시오.
        </p>
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-md bg-muted px-2 py-1.5 font-mono text-xs" title={RESET_COMMAND}>
            {RESET_COMMAND}
          </code>
          <CopyButton value={RESET_COMMAND} />
        </div>
      </div>
    </AuthShell>
  )
}

export function RecoveryCodeScreen() {
  const client = useQueryClient()
  const code = useRecovery((state) => state.code)
  const reason = useRecovery((state) => state.reason)
  const dismiss = useRecovery((state) => state.dismiss)
  const [saved, setSaved] = useState(false)

  if (!code) return null

  const proceed = async () => {
    dismiss()
    await client.invalidateQueries({ queryKey: queryKeys.session })
  }

  return (
    <AuthShell
      title={reason === "setup" ? "설정 완료" : "재설정 완료"}
      description="비밀번호를 잊었을 때 쓸 복구 코드입니다. 이 화면을 벗어나면 다시 볼 수 없습니다."
    >
      <RecoveryCodePanel code={code} />
      <label className="flex items-start gap-3 text-sm">
        <Checkbox checked={saved} onCheckedChange={(value) => setSaved(value === true)} className="mt-0.5" />
        <span>복구 코드를 비밀번호 관리자 같은 안전한 곳에 저장했습니다.</span>
      </label>
      <Button size="lg" disabled={!saved} onClick={proceed}>
        대시보드로 이동
        <ArrowRightIcon />
      </Button>
    </AuthShell>
  )
}
