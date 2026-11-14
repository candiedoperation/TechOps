import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { AuthContext } from '../auth/context'
import type { AuthState } from '../auth/types'
import { createHorizonReadClient } from './client'
import { ReadClientContext } from './context'
import { createHorizonQueryClient } from './query-client'
import { useHorizonInfiniteReadQuery } from './use-horizon-query'
import {
  useProvisionalMemberRankings,
  useProvisionalProjectHealth,
} from './contracts/provisional/hooks'
import type { HorizonReadContractRegistry } from './contracts/registry'

const state: AuthState = {
  status: 'authenticated',
  session: { subject: 'pagination-fixture', displayName: 'Fixture', permissions: [] },
}
function setup(fetcher: typeof fetch) {
  const queryClient = createHorizonQueryClient()
  const client = createHorizonReadClient({
    origin: window.location.origin,
    enabled: () => true,
    getAuthState: async () => state,
    onAccessDenied: () => queryClient.clear(),
    fetcher,
  })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider
        value={{ state, signIn: vi.fn(), signOut: vi.fn(), invalidateSession: vi.fn() }}
      >
        <ReadClientContext.Provider value={client}>{children}</ReadClientContext.Provider>
      </AuthContext.Provider>
    </QueryClientProvider>
  )
  return { wrapper, queryClient }
}

describe('Horizon paginated reads', () => {
  it('follows only the server-provided next cursor and separates filters in the cache', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const next = new URL(String(input)).searchParams.has('cursor')
      return new Response(
        JSON.stringify({
          items: [next ? 'fixture-two' : 'fixture-one'],
          nextCursor: next ? null : 'server-fixture-cursor',
        }),
        { headers: { 'content-type': 'application/json' } },
      )
    })
    const { wrapper, queryClient } = setup(fetcher)
    const { result, rerender, unmount } = renderHook(
      ({ period }) =>
        useHorizonInfiniteReadQuery({
          feature: 'test-only-pages',
          parameters: { period },
          operationForCursor: (cursor) => ({
            path: '/test-only/pages' + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''),
            parse: (value: unknown) => {
              if (
                !value ||
                typeof value !== 'object' ||
                !('items' in value) ||
                !Array.isArray(value.items) ||
                !value.items.every((item) => typeof item === 'string') ||
                !('nextCursor' in value) ||
                !(value.nextCursor === null || typeof value.nextCursor === 'string')
              )
                throw new Error('Invalid fixture')
              return { items: value.items as string[], nextCursor: value.nextCursor }
            },
          }),
          getNextCursor: (page) => page.nextCursor,
        }),
      { wrapper, initialProps: { period: 'fixture-period-one' } },
    )
    await waitFor(() => expect(result.current.hasNextPage).toBe(true))
    await act(async () => {
      await result.current.fetchNextPage()
    })
    await waitFor(() => expect(result.current.data?.pages).toHaveLength(2))
    expect(result.current.data?.pages.flatMap((page) => page.items)).toEqual([
      'fixture-one',
      'fixture-two',
    ])
    expect(result.current.hasNextPage).toBe(false)
    expect(String(fetcher.mock.calls[1]?.[0])).toContain('cursor=server-fixture-cursor')
    rerender({ period: 'fixture-period-two' })
    await waitFor(() => expect(result.current.data?.pages).toHaveLength(1))
    expect(fetcher).toHaveBeenCalledTimes(3)
    unmount()
    queryClient.clear()
  })

  it('keeps pending draft contracts disconnected even if a builder is supplied', async () => {
    const fetcher = vi.fn()
    const { wrapper, queryClient } = setup(fetcher)
    const builder = vi.fn()
    const registry: HorizonReadContractRegistry = {
      reviewStatus: 'pending',
      rankings: builder,
      projectHealth: builder,
    }
    const { result, unmount } = renderHook(
      () => ({
        rankings: useProvisionalMemberRankings({ periodId: 'fixture' }, registry),
        health: useProvisionalProjectHealth({ periodId: 'fixture' }, registry),
      }),
      { wrapper },
    )
    expect(result.current.rankings.available).toBe(false)
    expect(result.current.health.available).toBe(false)
    await act(async () => {
      await result.current.rankings.refetch()
      await result.current.health.refetch()
    })
    expect(builder).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
    unmount()
    queryClient.clear()
  })

  it('aborts an in-flight read when its consumer unmounts', async () => {
    let requestSignal: AbortSignal | undefined
    const fetcher = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          requestSignal = init?.signal ?? undefined
          requestSignal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          )
        }),
    )
    const { wrapper, queryClient } = setup(fetcher)
    const { unmount } = renderHook(
      () =>
        useHorizonInfiniteReadQuery({
          feature: 'abort-fixture',
          operationForCursor: () => ({ path: '/test-only/cancel', parse: () => ({ next: null }) }),
          getNextCursor: () => null,
        }),
      { wrapper },
    )
    await waitFor(() => expect(fetcher).toHaveBeenCalledOnce())
    unmount()
    expect(requestSignal?.aborted).toBe(true)
    queryClient.clear()
  })
})
