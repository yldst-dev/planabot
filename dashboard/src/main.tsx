import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { HashRouter } from "react-router"

import { App } from "@/App"
import { ThemeProvider } from "@/components/theme-provider"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { queryKeys } from "@/hooks/use-dashboard"
import { AuthError } from "@/lib/api"

import "./index.css"

const client: QueryClient = new QueryClient({
  queryCache: new QueryCache({ onError: handleAuthError }),
  mutationCache: new MutationCache({ onError: handleAuthError }),
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      refetchOnWindowFocus: true,
      retry: (count, error) => !(error instanceof AuthError) && count < 2,
    },
  },
})

function handleAuthError(error: Error) {
  if (error instanceof AuthError) {
    client.setQueryData(queryKeys.session, { enabled: true, configured: true, authenticated: false })
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <TooltipProvider delayDuration={300}>
          <HashRouter>
            <App />
          </HashRouter>
          <Toaster position="bottom-center" />
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
)
