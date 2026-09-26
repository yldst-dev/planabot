import { LayoutDashboardIcon, MonitorIcon, MoonIcon, SunIcon } from "lucide-react"
import { useEffect } from "react"
import { useNavigate } from "react-router"

import { GroupIcon } from "@/components/group-icon"
import { useTheme } from "@/lib/theme"
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command"
import { useSettings } from "@/hooks/use-dashboard"
import { findGroup, withCustom } from "@/lib/groups"

export function CommandMenu({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate()
  const settings = useSettings()
  const { setTheme } = useTheme()
  const groups = settings.data?.groups ?? []
  const fields = settings.data?.fields ?? []

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const typing = event.target instanceof HTMLElement && event.target.closest("input, textarea, select")
      if ((event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) || (event.key === "/" && !typing)) {
        event.preventDefault()
        onOpenChange(!open)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, onOpenChange])

  const go = (path: string) => {
    onOpenChange(false)
    navigate(path)
  }

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title="설정 검색" description="페이지와 설정 항목을 찾습니다">
      <Command>
        <CommandInput placeholder="키, 이름, 설명으로 검색" />
        <CommandList className="max-h-[min(420px,60vh)]">
          <CommandEmpty>일치하는 항목 없음.</CommandEmpty>
          <CommandGroup heading="페이지">
            <CommandItem value="개요 overview" onSelect={() => go("/")}>
              <LayoutDashboardIcon />
              개요
            </CommandItem>
            {withCustom(groups).map((group) => {
              return (
                <CommandItem
                  key={group.id}
                  value={`page ${group.label} ${group.section} ${group.id}`}
                  onSelect={() => go(`/g/${group.id}`)}
                >
                  <GroupIcon id={group.id} />
                  {group.label}
                  <CommandShortcut>{group.section}</CommandShortcut>
                </CommandItem>
              )
            })}
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup heading="설정 항목">
            {fields.map((field) => {
              return (
                <CommandItem
                  key={field.key}
                  value={`${field.key} ${field.label} ${field.help} ${findGroup(groups, field.group)?.label ?? ""}`}
                  onSelect={() => go(`/g/${field.group}?focus=${field.key}`)}
                >
                  <GroupIcon id={field.group} />
                  <span className="truncate">{field.label}</span>
                  <span className="truncate font-mono text-xs text-muted-foreground">{field.key}</span>
                </CommandItem>
              )
            })}
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup heading="테마">
            <CommandItem value="theme system 시스템 테마" onSelect={() => setTheme("system")}>
              <MonitorIcon />
              시스템 테마
            </CommandItem>
            <CommandItem value="theme light 밝은 테마" onSelect={() => setTheme("light")}>
              <SunIcon />
              밝은 테마
            </CommandItem>
            <CommandItem value="theme dark 어두운 테마" onSelect={() => setTheme("dark")}>
              <MoonIcon />
              어두운 테마
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  )
}
