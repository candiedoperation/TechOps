/**
 * Boot.
 *
 * HashRouter, not BrowserRouter. Horizon's dashboard is served as static files
 * behind a proxy that does not rewrite unknown paths to index.html, so a path
 * route would hard-404 on refresh and on every deep link. The hash form is
 * also byte-compatible with the URLs the vanilla app wrote
 * (`#/projects/:id?asOf=…`), so existing bookmarks keep working through the
 * rewrite.
 */

import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { HashRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { Toaster } from "sonner"

import "./index.css"
import "./globals.css"
import App from "./App.tsx"
import { OperatorSessionProvider } from "./auth/OperatorSessionProvider.tsx"
import { normalizeLegacyHash } from "./lib/legacy-hash.ts"

/* Rewrite a `#view=…&project=…` bookmark before the router reads the URL. */
normalizeLegacyHash()

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      /* Snapshots are immutable once written, and the analytics and recruiting
         runs are versioned, so nothing here goes stale on a timer. Refetching
         on window focus would also re-spend compute requests on a cold
         portfolio, which is exactly what the lazy paths avoid. */
      staleTime: 60_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
})

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <OperatorSessionProvider>
        <HashRouter>
          {/* Sonner renders an aria-live region with role="status" toasts. */}
          <Toaster richColors position="top-right" />
          <App />
        </HashRouter>
      </OperatorSessionProvider>
    </QueryClientProvider>
  </StrictMode>,
)
