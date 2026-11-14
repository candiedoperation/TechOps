import { useMemo, type ReactNode } from 'react'
import { useAuth } from '../auth/context'
import { horizonIntegrations } from '../app/integrations'
import { createHorizonReadClient } from './client'
import { useMockSource } from './data-source'
import { ReadClientContext } from './context'

export function HorizonReadProvider({ children }: { children: ReactNode }) {
  const mockSource = useMockSource()
  const { state, invalidateSession } = useAuth()
  const client = useMemo(
    () =>
      createHorizonReadClient({
        origin: import.meta.env.VITE_HORIZON_API_BASE_URL || window.location.origin,
        enabled: () => horizonIntegrations.authorizedReadApis,
        getAuthState: async () => state,
        onAccessDenied: invalidateSession,
      }),
    [state, invalidateSession],
  )
  return (
    <ReadClientContext.Provider value={mockSource ?? client}>{children}</ReadClientContext.Provider>
  )
}
