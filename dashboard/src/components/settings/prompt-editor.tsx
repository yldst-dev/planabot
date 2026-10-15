import { useState } from "react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
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
import { Textarea } from "@/components/ui/textarea"
import type { Field } from "@/lib/types"
import { useChanges } from "@/stores/changes"

interface PromptEditorProps {
  field: Field
  open: boolean
  onOpenChange: (open: boolean) => void
  initial: string
}

const MAX_BYTES = 32768
const encoder = new TextEncoder()

export function PromptEditor({ field, open, onOpenChange, initial }: PromptEditorProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? <EditorBody field={field} initial={initial} onDone={() => onOpenChange(false)} /> : null}
    </Dialog>
  )
}

function EditorBody({ field, initial, onDone }: { field: Field; initial: string; onDone: () => void }) {
  const edit = useChanges((state) => state.edit)
  const [text, setText] = useState(initial)
  const bytes = encoder.encode(text).length
  const over = bytes > MAX_BYTES
  const apply = () => {
    edit(field, text)
    onDone()
  }
  const guard = (event: Event) => {
    if (text === initial) return
    event.preventDefault()
    toast("편집 중인 초안이 있습니다.", { description: "반영하거나 취소를 눌러 닫으십시오." })
  }

  return (
    <DialogContent
      className="gap-0 p-0 sm:max-w-3xl"
      onInteractOutside={guard}
      onEscapeKeyDown={guard}
      onKeyDown={(event) => {
        const key = event.key.toLowerCase()
        const mod = event.metaKey || event.ctrlKey
        if (key === "/" || (mod && (key === "k" || key === "s"))) event.stopPropagation()
        if (!mod || key !== "s") return
        event.preventDefault()
        if (over) {
          toast.error("반영 불가.", { description: "32,768바이트를 넘었습니다. 내용을 줄여 주십시오." })
          return
        }
        apply()
        toast("초안을 반영했습니다.", { description: "⌘S를 한 번 더 누르면 저장합니다." })
      }}
    >
      <DialogHeader className="border-b p-5">
        <DialogTitle>{field.label}</DialogTitle>
        <DialogDescription className="flex items-center gap-2">
          <span className="font-mono text-xs">{field.key}</span>
          <Badge variant={over ? "destructive" : "outline"} className="tabular-nums">
            {bytes.toLocaleString()} / {MAX_BYTES.toLocaleString()}바이트
          </Badge>
        </DialogDescription>
      </DialogHeader>
      <Textarea
        value={text}
        autoFocus
        spellCheck={false}
        placeholder="비워 두면 기본 페르소나 프롬프트를 씁니다."
        aria-invalid={over || undefined}
        onChange={(event) => setText(event.target.value)}
        className="h-[min(56vh,520px)] resize-none rounded-none border-0 p-5 leading-relaxed shadow-none focus-visible:ring-0"
      />
      <DialogFooter className="border-t p-4">
        <DialogClose asChild>
          <Button variant="outline">취소</Button>
        </DialogClose>
        <Button onClick={apply} disabled={over}>
          반영
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}
