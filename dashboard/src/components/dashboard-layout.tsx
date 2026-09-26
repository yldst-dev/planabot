import { useState } from "react"
import { Outlet } from "react-router"

import { AppSidebar } from "@/components/app-sidebar"
import { CommandMenu } from "@/components/command-menu"
import { SiteHeader } from "@/components/site-header"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"

export function DashboardLayout() {
  const [searchOpen, setSearchOpen] = useState(false)

  return (
    <SidebarProvider className="h-svh overflow-hidden">
      <AppSidebar onSearch={() => setSearchOpen(true)} />
      <SidebarInset className="min-h-0 overflow-hidden">
        <SiteHeader />
        <div id="content" className="min-h-0 flex-1 overflow-y-auto">
          <Outlet />
        </div>
      </SidebarInset>
      <CommandMenu open={searchOpen} onOpenChange={setSearchOpen} />
    </SidebarProvider>
  )
}
