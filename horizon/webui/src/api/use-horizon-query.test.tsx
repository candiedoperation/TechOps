import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { AuthContext } from '../auth/context'
import { AuthProvider } from '../auth/AuthProvider'
import type { AuthState } from '../auth/types'
import { createHorizonReadClient } from './client'
import { ReadClientContext } from './context'
import { createHorizonQueryClient } from './query-client'
import { HorizonReadProvider } from './HorizonReadProvider'
import { horizonQueryKeys, useHorizonReadQuery } from './use-horizon-query'

const authenticated: AuthState = {
  status: 'authenticated',
  session: { subject: 'fixture-only', displayName: 'Fixture', permissions: [] },
}
const operation = {
  path: '/test-only/hook',
  parse: (value: unknown) => {
    if (typeof value !== 'string') throw new Error('Invalid fixture')
    return value
  },
}

describe('Horizon React Query integration', () => {
  it('fetches through the typed client, caches by user and parameters, and supports refetch', async () => {
    const queryClient = createHorizonQueryClient()
    const fetcher = vi
      .fn()
      .mockImplementation(
        async () =>
          new Response('"test-only-result"', { headers: { 'content-type': 'application/json' } }),
      )
    const client = createHorizonReadClient({
      origin: window.location.origin,
      enabled: () => true,
      getAuthState: async () => authenticated,
      onAccessDenied: () => queryClient.clear(),
      fetcher,
    })
    let state: AuthState = authenticated
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <AuthContext.Provider
          value={{ state, signIn: vi.fn(), signOut: vi.fn(), invalidateSession: vi.fn() }}
        >
          <ReadClientContext.Provider value={client}>{children}</ReadClientContext.Provider>
        </AuthContext.Provider>
      </QueryClientProvider>
    )
    const { result, rerender, unmount } = renderHook(
      () =>
        useHorizonReadQuery({
          feature: 'fixture',
          parameters: { period: 'fixture-period' },
          operation,
        }),
      { wrapper },
    )
    await waitFor(() => expect(result.current.data).toBe('test-only-result'))
    expect(
      queryClient.getQueryData(
        horizonQueryKeys.read('fixture-only', 'fixture', { period: 'fixture-period' }),
      ),
    ).toBe('test-only-result')
    rerender()
    expect(fetcher).toHaveBeenCalledOnce()
    await act(async () => {
      await result.current.refetch()
    })
    expect(fetcher).toHaveBeenCalledTimes(2)
    state = { status: 'anonymous' }
    rerender()
    expect(result.current.data).toBeUndefined()
    expect(result.current.available).toBe(false)
    unmount()
    queryClient.clear()
  })

  it('keeps the production read gate closed even with a test-authenticated adapter and manual refetch', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const queryClient = createHorizonQueryClient()
    const adapter = { getState: async () => authenticated, signIn: vi.fn(), signOut: vi.fn() }
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <AuthProvider adapter={adapter}>
          <HorizonReadProvider>{children}</HorizonReadProvider>
        </AuthProvider>
      </QueryClientProvider>
    )
    const { result, unmount } = renderHook(
      () => useHorizonReadQuery({ feature: 'fixture', operation }),
      { wrapper },
    )
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.available).toBe(false)
    await act(async () => {
      await result.current.refetch()
    })
    expect(result.current.data).toBeUndefined()
    expect(fetcher).not.toHaveBeenCalled()
    unmount()
    queryClient.clear()
  })
})
