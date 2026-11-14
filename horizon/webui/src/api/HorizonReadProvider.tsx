import { useMemo, type ReactNode } from 'react'
import { useAuth } from '../auth/context'
import { horizonIntegrations } from '../app/integrations'
import { createHorizonReadClient } from './client'
import { ReadClientContext } from './context'

export function HorizonReadProvider({ children }: { children: ReactNode }) {
  const { state, invalidateSession, getAccessToken } = useAuth()
  const client = useMemo(
    () =>
      createHorizonReadClient({
        origin: window.location.origin,
        enabled: () => horizonIntegrations.authorizedReadApis,
        getAuthState: async () => state,
        getAccessToken,
        onAccessDenied: invalidateSession,
      }),
    [state, invalidateSession, getAccessToken],
  )
  return <ReadClientContext.Provider value={client}>{children}</ReadClientContext.Provider>
}
