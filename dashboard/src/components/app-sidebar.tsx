import {
  ChevronsUpDownIcon,
  KeyRoundIcon,
  LayoutDashboardIcon,
  LifeBuoyIcon,
  LogOutIcon,
  MonitorIcon,
  MoonIcon,
  SearchIcon,
  SunIcon,
  UserRoundIcon,
} from "lucide-react"
import { useState } from "react"
import { NavLink, useLocation } from "react-router"

import { ChangePasswordDialog } from "@/components/account/change-password-dialog"
import { RecoveryCodeDialog } from "@/components/account/recovery-code-dialog"
import { GroupIcon } from "@/components/group-icon"
import { HaloMark } from "@/components/halo-mark"
import { RestartPanel } from "@/components/restart-panel"
import { type Theme, useTheme } from "@/lib/theme"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Kbd, KbdGroup } from "@/components/ui/kbd"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar"
import { useLogout, useOverview, useSettings } from "@/hooks/use-dashboard"
import { fieldsIn, sections } from "@/lib/groups"
import { cn } from "@/lib/utils"
import { isDirty, useChanges } from "@/stores/changes"

const THEMES: { value: Theme; label: string; icon: typeof SunIcon }[] = [
  { value: "system", label: "시스템", icon: MonitorIcon },
  { value: "light", label: "밝게", icon: SunIcon },
  { value: "dark", label: "어둡게", icon: MoonIcon },
]

export function AppSidebar({ onSearch }: { onSearch: () => void }) {
  const settings = useSettings()
  const overview = useOverview()
  const changes = useChanges((state) => state.changes)
  const location = useLocation()
  const groups = settings.data?.groups ?? []
  const fields = settings.data?.fields ?? []

  return (
    <Sidebar collapsible="icon" variant="sidebar">
      <SidebarHeader className="gap-1">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild tooltip="planabot">
              <NavLink to="/">
                <span className="grid size-8 shrink-0 place-items-center">
                  <HaloMark />
                </span>
                <span className="flex min-w-0 flex-col leading-tight group-data-[collapsible=icon]:hidden">
                  <span className="font-semibold tracking-tight">planabot</span>
                  <span className="text-xs text-muted-foreground">
                    {overview.data ? `v${overview.data.version}` : "설정"}
                  </span>
                </span>
              </NavLink>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={onSearch}
              tooltip="설정 검색"
              className="border border-sidebar-border bg-background/60 text-muted-foreground shadow-none group-data-[collapsible=icon]:border-transparent group-data-[collapsible=icon]:bg-transparent"
            >
              <SearchIcon />
              <span className="flex-1 group-data-[collapsible=icon]:hidden">설정 검색</span>
              <KbdGroup className="group-data-[collapsible=icon]:hidden">
                <Kbd>⌘</Kbd>
                <Kbd>K</Kbd>
              </KbdGroup>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent className="gap-0">
        <SidebarGroup>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton asChild isActive={location.pathname === "/"} tooltip="개요">
                <NavLink to="/">
                  <LayoutDashboardIcon />
                  <span>개요</span>
                </NavLink>
              </SidebarMenuButton>
              {overview.data && overview.data.pending.length > 0 ? (
                <SidebarMenuBadge className="text-warning">{overview.data.pending.length}</SidebarMenuBadge>
              ) : null}
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>

        {sections(groups).map(([section, items]) => (
          <SidebarGroup key={section} className="py-1">
            <SidebarGroupLabel>{section}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {items.map((group) => {
                  const inGroup = fieldsIn(fields, group.id)
                  const dirty = inGroup.some((field) => isDirty(changes, field.key))
                  const pending = inGroup.some((field) => field.pending)
                  const overrides = inGroup.filter((field) => field.source === "dashboard").length
                  const path = `/g/${group.id}`
                  return (
                    <SidebarMenuItem key={group.id}>
                      <SidebarMenuButton asChild isActive={location.pathname === path} tooltip={group.label}>
                        <NavLink to={path}>
                          <GroupIcon id={group.id} />
                          <span>{group.label}</span>
                        </NavLink>
                      </SidebarMenuButton>
                      {dirty || pending || overrides > 0 ? (
                        <SidebarMenuBadge className="gap-1.5">
                          {dirty || pending ? (
                            <span
                              className={cn("size-1.5 rounded-full", dirty ? "bg-primary" : "bg-warning")}
                              aria-label={dirty ? "저장하지 않은 변경" : "재시작 대기"}
                            />
                          ) : null}
                          {overrides > 0 ? <span className="tabular-nums">{overrides}</span> : null}
                        </SidebarMenuBadge>
                      ) : null}
                    </SidebarMenuItem>
                  )
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarFooter>
        <RestartPanel />
        <AccountMenu />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}

function AccountMenu() {
  const { theme, setTheme } = useTheme()
  const logout = useLogout()
  const current = THEMES.find((item) => item.value === theme) ?? THEMES[0]
  const [dialog, setDialog] = useState<"password" | "recovery" | null>(null)

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton size="lg" tooltip="계정과 테마">
              <span className="grid size-8 shrink-0 place-items-center rounded-md bg-sidebar-accent">
                <UserRoundIcon className="size-4" />
              </span>
              <span className="flex min-w-0 flex-1 flex-col leading-tight group-data-[collapsible=icon]:hidden">
                <span className="text-sm font-medium">관리자</span>
                <span className="text-xs text-muted-foreground">{current.label} 테마</span>
              </span>
              <ChevronsUpDownIcon className="text-muted-foreground group-data-[collapsible=icon]:hidden" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" className="w-(--radix-dropdown-menu-trigger-width) min-w-56">
            <DropdownMenuLabel className="text-xs text-muted-foreground">테마</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={theme} onValueChange={(value) => setTheme(value as Theme)}>
              {THEMES.map((item) => (
                <DropdownMenuRadioItem key={item.value} value={item.value}>
                  <item.icon />
                  {item.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs text-muted-foreground">보안</DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => setDialog("password")}>
              <KeyRoundIcon />
              비밀번호 변경
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setDialog("recovery")}>
              <LifeBuoyIcon />
              복구 코드 재발급
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => logout.mutate()}>
              <LogOutIcon />
              로그아웃
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <ChangePasswordDialog open={dialog === "password"} onOpenChange={(open) => setDialog(open ? "password" : null)} />
        <RecoveryCodeDialog open={dialog === "recovery"} onOpenChange={(open) => setDialog(open ? "recovery" : null)} />
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
