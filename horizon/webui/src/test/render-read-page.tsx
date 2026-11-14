import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { vi } from 'vitest'
import { ReadClientContext } from '../api/context'
import { createHorizonReadClient } from '../api/client'
import { AuthContext } from '../auth/context'
import type { AuthState } from '../auth/types'

const state: AuthState = {
  status: 'authenticated',
  session: { subject: 'test', displayName: 'Fixture exec', isExec: true, permissions: [] },
}

// eslint-disable-next-line react-refresh/only-export-components
function Location() {
  const location = useLocation()
  return (
    <output aria-label="Location">
      {location.pathname}
      {location.search}
    </output>
  )
}

// Mock JSON at the HTTP boundary so URL construction, transport and parsing run normally.
export function renderReadPage(
  path: string,
  element: ReactNode,
  handler: (url: URL) => unknown,
  publicRead = false,
) {
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const value = handler(new URL(String(input)))
    return value === undefined ? new Response(null, { status: 404 }) : Response.json(value)
  })
  const client = createHorizonReadClient({
    origin: window.location.origin,
    enabled: () => true,
    getAuthState: async () => state,
    onAccessDenied: vi.fn(),
    fetcher,
  })
  if (publicRead) vi.stubGlobal('fetch', fetcher)
  render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <AuthContext.Provider
          value={{
            state,
            invalidateSession: vi.fn(),
            signIn: vi.fn(),
            signOut: vi.fn(),
          }}
        >
          <ReadClientContext.Provider value={client}>
            {element}
            <Location />
          </ReadClientContext.Provider>
        </AuthContext.Provider>
      </QueryClientProvider>
    </MemoryRouter>,
  )
  return fetcher
}
