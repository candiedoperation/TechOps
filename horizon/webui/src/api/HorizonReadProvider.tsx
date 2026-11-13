import { useMemo, type ReactNode } from 'react'
import { useAuth } from '../auth/context'
import { horizonIntegrations } from '../app/integrations'
import { createHorizonReadClient } from './client'
import { ReadClientContext } from './context'

export function HorizonReadProvider({ children }: { children: ReactNode }) {
  const { state, invalidateSession } = useAuth()
  const client = useMemo(
    () =>
      createHorizonReadClient({
        origin: window.location.origin,
        enabled: () => horizonIntegrations.authorizedReadApis,
        getAuthState: async () => state,
        onAccessDenied: invalidateSession,
      }),
    [state, invalidateSession],
  )
  return <ReadClientContext.Provider value={client}>{children}</ReadClientContext.Provider>
}
