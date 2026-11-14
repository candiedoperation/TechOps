import { QueryObserver } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import { createHorizonQueryClient } from './query-client'

describe('Horizon publication query cache', () => {
  it('deduplicates in-flight reads, holds fresh results and shows stale data during revalidation', async () => {
    const client = createHorizonQueryClient()
    const queryKey = ['horizon', 'viewer', '/api/v1/rankings/members/fixture']
    const queryFn = vi.fn().mockResolvedValue('first')
    try {
      const options = { queryKey, queryFn }
      expect(await Promise.all([client.fetchQuery(options), client.fetchQuery(options)])).toEqual([
        'first',
        'first',
      ])
      expect(await client.fetchQuery(options)).toBe('first')
      expect(queryFn).toHaveBeenCalledTimes(1)
      client.setQueryData(queryKey, 'first', { updatedAt: Date.now() - 61_000 })
      queryFn.mockResolvedValue('revalidated')
      const observer = new QueryObserver(client, options)
      const unsubscribe = observer.subscribe(() => {})
      expect(observer.getCurrentResult()).toMatchObject({ data: 'first', isFetching: true })
      await vi.waitFor(() => expect(observer.getCurrentResult().data).toBe('revalidated'))
      unsubscribe()
      expect(queryFn).toHaveBeenCalledTimes(2)
    } finally {
      client.clear()
    }
  })

  it('evicts inactive reads when a new current publication arrives', async () => {
    const client = createHorizonQueryClient()
    const queryKey = ['horizon', 'viewer', 'rankings-current']
    const meta = { publicationPath: '/api/v1/rankings?season=FALL-2026&run=current' }
    const cachedMember = ['horizon', 'viewer', 'ranking-member']
    try {
      await client.fetchQuery({ queryKey, meta, queryFn: async () => ({ meta: { runId: 'one' } }) })
      client.setQueryData(cachedMember, 'old member')
      await client.fetchQuery({
        queryKey,
        meta,
        staleTime: 0,
        queryFn: async () => ({ meta: { runId: 'two' } }),
      })
      expect(client.getQueryData(cachedMember)).toBeUndefined()
      expect(client.getQueryData(queryKey)).toEqual({ meta: { runId: 'two' } })
    } finally {
      client.clear()
    }
  })
})
