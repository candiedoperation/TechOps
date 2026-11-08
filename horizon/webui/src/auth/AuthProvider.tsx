import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { horizonAuthAdapter } from './adapter'
import { AuthContext } from './context'
import type { AuthState, HorizonAuthAdapter } from './types'

export function AuthProvider({
  children,
  adapter = horizonAuthAdapter,
}: {
  children: ReactNode
  adapter?: HorizonAuthAdapter
}) {
  const [state, setState] = useState<AuthState>({ status: 'loading' })
  const queryClient = useQueryClient()

  useEffect(() => {
    const controller = new AbortController()
    queryClient.clear()
    setState({ status: 'loading' })
    adapter.getState(controller.signal).then(
      (nextState) => {
        if (!controller.signal.aborted) setState(nextState)
      },
      () => {
        if (!controller.signal.aborted)
          setState({ status: 'error', message: 'Unable to verify your Horizon session.' })
      },
    )
    return () => {
      controller.abort()
    }
  }, [adapter, queryClient])

  const signIn = useCallback(
    async (returnTo: string) => {
      // Only an internal path can be passed to a future redirect implementation.
      if (!returnTo.startsWith('/') || returnTo.startsWith('//') || /[\\\r\n]/.test(returnTo)) {
        throw new Error('Invalid return location')
      }
      await adapter.signIn(returnTo)
    },
    [adapter],
  )

  const signOut = useCallback(async () => {
    // Hide protected content and cancel/clear cached data even if logout fails.
    setState({ status: 'loading' })
    queryClient.clear()
    try {
      await adapter.signOut()
      setState({ status: 'anonymous' })
    } catch {
      setState({ status: 'error', message: 'Sign-out could not be confirmed. Please try again.' })
      throw new Error('Sign-out could not be confirmed')
    }
  }, [adapter, queryClient])

  const invalidateSession = useCallback(
    (status: 401 | 403 = 401) => {
      queryClient.clear()
      setState(
        status === 403
          ? {
              status: 'forbidden',
              message: 'Your account is not authorized to view this Horizon information.',
            }
          : { status: 'expired' },
      )
    },
    [queryClient],
  )

  return (
    <AuthContext.Provider value={{ state, signIn, signOut, invalidateSession }}>
      {children}
    </AuthContext.Provider>
  )
}
