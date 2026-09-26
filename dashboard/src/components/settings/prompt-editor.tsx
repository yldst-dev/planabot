import { useState } from "react"

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

export function PromptEditor({ field, open, onOpenChange, initial }: PromptEditorProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 p-0 sm:max-w-3xl">
        {open ? <EditorBody field={field} initial={initial} onDone={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  )
}

function EditorBody({ field, initial, onDone }: { field: Field; initial: string; onDone: () => void }) {
  const edit = useChanges((state) => state.edit)
  const [text, setText] = useState(initial)

  return (
    <>
      <DialogHeader className="border-b p-5">
        <DialogTitle>{field.label}</DialogTitle>
        <DialogDescription className="flex items-center gap-2">
          <span className="font-mono text-xs">{field.key}</span>
          <Badge variant="outline" className="tabular-nums">
            {text.length.toLocaleString()}자
          </Badge>
        </DialogDescription>
      </DialogHeader>
      <Textarea
        value={text}
        autoFocus
        spellCheck={false}
        placeholder="비워 두면 기본 페르소나 프롬프트를 씁니다."
        onChange={(event) => setText(event.target.value)}
        className="h-[min(56vh,520px)] resize-none rounded-none border-0 p-5 leading-relaxed shadow-none focus-visible:ring-0"
      />
      <DialogFooter className="border-t p-4">
        <DialogClose asChild>
          <Button variant="outline">취소</Button>
        </DialogClose>
        <Button
          onClick={() => {
            edit(field, text)
            onDone()
          }}
        >
          반영
        </Button>
      </DialogFooter>
    </>
  )
}
