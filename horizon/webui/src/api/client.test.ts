import { describe, expect, it, vi } from 'vitest'
import { createHorizonReadClient, type ReadClientOptions, type ReadOperation } from './client'
import { createHorizonQueryClient } from './query-client'

// These URLs and data exist only as isolated test fixtures, not production contracts.
const operation: ReadOperation<{ count: number }> = {
  path: '/test-only/read',
  parse: (value) => {
    if (
      !value ||
      typeof value !== 'object' ||
      !('count' in value) ||
      typeof value.count !== 'number'
    )
      throw new Error('Invalid fixture')
    return { count: value.count }
  },
}
function setup(overrides: Partial<ReadClientOptions> = {}) {
  const fetcher = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ count: 3 }), {
      headers: { 'content-type': 'application/json' },
    }),
  )
  const denied = vi.fn()
  const client = createHorizonReadClient({
    origin: window.location.origin,
    enabled: () => true,
    getAuthState: async () => ({
      status: 'authenticated',
      session: { subject: 'test-subject', displayName: 'Fixture', permissions: [] },
    }),
    onAccessDenied: denied,
    fetcher,
    ...overrides,
  })
  return { client, fetcher, denied }
}

describe('Horizon read transport', () => {
  it('performs no request while the API release gate is closed', async () => {
    const { client, fetcher } = setup({ enabled: () => false })
    await expect(client.get(operation)).rejects.toMatchObject({ kind: 'unavailable' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('refuses to fetch without an authenticated Horizon session', async () => {
    const { client, fetcher, denied } = setup({
      getAuthState: async () => ({ status: 'anonymous' }),
    })
    await expect(client.get(operation)).rejects.toMatchObject({ kind: 'unauthorized' })
    expect(fetcher).not.toHaveBeenCalled()
    expect(denied).toHaveBeenCalledOnce()
  })

  it('uses GET, same-origin credentials, JSON, and request cancellation', async () => {
    const { client, fetcher } = setup()
    const controller = new AbortController()
    await expect(client.get(operation, controller.signal)).resolves.toEqual({ count: 3 })
    expect(fetcher).toHaveBeenCalledWith(
      new URL(operation.path, window.location.origin),
      expect.objectContaining({
        method: 'GET',
        credentials: 'same-origin',
        redirect: 'error',
        cache: 'no-store',
        signal: controller.signal,
      }),
    )
  })

  it.each([401, 403])('clears protected cache and does not parse a %s body', async (status) => {
    const queryClient = createHorizonQueryClient()
    queryClient.setQueryData(['horizon', 'test-subject'], ['private-fixture'])
    const { client, fetcher } = setup({ onAccessDenied: () => queryClient.clear() })
    const parse = vi.fn()
    fetcher.mockResolvedValue(new Response('private body must not be exposed', { status }))
    await expect(client.get({ ...operation, parse })).rejects.toMatchObject({
      kind: status === 401 ? 'unauthorized' : 'forbidden',
      status,
    })
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0)
    expect(parse).not.toHaveBeenCalled()
  })

  it.each([
    'https://untrusted.example/read',
    '//untrusted.example/read',
    '/\\untrusted.example/read',
    '/read#fragment',
  ])('rejects an invalid read path: %s', async (path) => {
    const { client, fetcher } = setup()
    await expect(client.get({ ...operation, path })).rejects.toMatchObject({ kind: 'unavailable' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('does not send session credentials to another origin', async () => {
    const { client, fetcher } = setup({ origin: 'https://untrusted.example' })
    await expect(client.get(operation)).rejects.toMatchObject({ kind: 'unavailable' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('rejects invalid response shapes', async () => {
    const { client, fetcher } = setup()
    fetcher.mockResolvedValue(
      new Response('{"count":"invalid"}', { headers: { 'content-type': 'application/json' } }),
    )
    await expect(client.get(operation)).rejects.toMatchObject({ kind: 'invalid-response' })
  })

  it('rejects an HTML login page instead of treating it as data', async () => {
    const { client, fetcher } = setup()
    fetcher.mockResolvedValue(
      new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } }),
    )
    await expect(client.get(operation)).rejects.toMatchObject({ kind: 'invalid-response' })
  })

  it('does not expose raw server errors', async () => {
    const { client, fetcher } = setup()
    fetcher.mockResolvedValue(new Response('private stack trace', { status: 500 }))
    await expect(client.get(operation)).rejects.toMatchObject({
      kind: 'http',
      message: 'Horizon could not complete this request.',
    })
  })

  it('handles network failure with a safe error', async () => {
    const { client, fetcher } = setup()
    fetcher.mockRejectedValue(new Error('sensitive connection detail'))
    await expect(client.get(operation)).rejects.toMatchObject({
      kind: 'network',
      message: 'Horizon could not be reached. Please try again.',
    })
  })

  it('caches validated reads and refetches after invalidation', async () => {
    const { client, fetcher } = setup()
    const queryClient = createHorizonQueryClient()
    const query = {
      queryKey: ['horizon', 'test-subject', 'fixture'],
      queryFn: ({ signal }: { signal: AbortSignal }) => client.get(operation, signal),
    }
    await queryClient.fetchQuery(query)
    await queryClient.fetchQuery(query)
    expect(fetcher).toHaveBeenCalledOnce()
    await queryClient.invalidateQueries({ queryKey: ['horizon'] })
    fetcher.mockResolvedValue(
      new Response('{"count":4}', { headers: { 'content-type': 'application/json' } }),
    )
    await expect(queryClient.fetchQuery(query)).resolves.toEqual({ count: 4 })
    expect(fetcher).toHaveBeenCalledTimes(2)
    queryClient.clear()
  })
})
