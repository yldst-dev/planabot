import { cn } from "@/lib/utils"

export function HaloMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative inline-grid size-5 shrink-0 place-items-center rounded-full border-2 border-primary",
        className,
      )}
    >
      <span className="size-[45%] rounded-full bg-primary" />
    </span>
  )
}
