import { RefreshCwIcon, TriangleAlertIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Spinner } from "@/components/ui/spinner"
import { ApiError } from "@/lib/api"

const FALLBACK_MESSAGE = "서버에 연결하지 못했습니다. 잠시 뒤 다시 시도해 주십시오."

function describe(error: unknown) {
  return error instanceof ApiError && (error.status === 503 || error.status === 403) ? error.message : FALLBACK_MESSAGE
}

export function LoadError({ error, onRetry, retrying }: { error?: unknown; onRetry: () => void; retrying?: boolean }) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <TriangleAlertIcon />
        </EmptyMedia>
        <EmptyTitle>불러오기 실패.</EmptyTitle>
        <EmptyDescription>{describe(error)}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button variant="outline" onClick={onRetry} disabled={retrying}>
          {retrying ? <Spinner /> : <RefreshCwIcon />}
          다시 시도
        </Button>
      </EmptyContent>
    </Empty>
  )
}
