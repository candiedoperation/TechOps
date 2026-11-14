import { describe, expect, it, vi } from 'vitest'
import { createReadTransport } from './transport'

describe('project HTTP revalidation', () => {
  it('uses the ETag to revalidate a public response and reuses the body for 304', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ count: 4 }, { headers: { ETag: '"one"' } }))
      .mockResolvedValueOnce(new Response(null, { status: 304 }))
    const client = createReadTransport({
      origin: window.location.origin,
      credentials: 'omit',
      onAccessDenied: vi.fn(),
      fetcher,
      revalidate: true,
    })
    const operation = { path: '/api/v1/projects', parse: (value: unknown) => value }
    expect(await client.get(operation)).toEqual({ count: 4 })
    expect(await client.get(operation)).toEqual({ count: 4 })
    expect(fetcher.mock.calls[1]?.[1]?.headers).toMatchObject({ 'If-None-Match': '"one"' })
  })
})
