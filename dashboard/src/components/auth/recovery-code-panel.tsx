import { CopyButton } from "@/components/auth/copy-button"

export function RecoveryCodePanel({ code }: { code: string }) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-muted/40 p-4">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium text-muted-foreground">복구 코드</span>
        <CopyButton value={code} />
      </div>
      <code className="select-all text-center font-mono text-lg font-medium tracking-wider break-all">{code}</code>
    </div>
  )
}
