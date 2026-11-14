import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { App } from '../app/App'
import { loadMockSource, parseDataSource } from './data-source'
import { rankingOperations } from './contracts/rankings'
import { projectOperations } from './contracts/projects'
import { memberOperation } from './contracts/member'

afterEach(() => vi.unstubAllEnvs())

describe('Horizon data sources', () => {
  it.each([
    [undefined, 'mock'],
    ['', 'mock'],
    ['mock', 'mock'],
    ['api', 'api'],
  ] as const)('resolves %s to %s', (input, source) => expect(parseDataSource(input)).toBe(source))

  it('loads no fixture client in API mode', async () => {
    vi.stubEnv('VITE_HORIZON_DATA_SOURCE', 'api')
    expect(await loadMockSource()).toBeNull()
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    )
    expect(screen.queryByText('Demo data')).not.toBeInTheDocument()
  })

  it('marks the demo shell and validates fixtures through the real response parsers', async () => {
    vi.stubEnv('VITE_HORIZON_DATA_SOURCE', 'mock')
    const client = await loadMockSource()
    expect(client).toBeTruthy()
    if (!client) throw new Error('Fixture client unavailable.')
    render(
      <MemoryRouter>
        <App mockSource={client} />
      </MemoryRouter>,
    )
    expect(screen.getByText('Demo data')).toBeInTheDocument()
    const [season] = await client.get(rankingOperations.semesters)
    const selection = { season: season!, run: 'current' }
    const [runs, rankings, member, timeline, history, detail] = await Promise.all([
      client.get(rankingOperations.runs(season!)),
      client.get(rankingOperations.list({ ...selection, role: 'engineer' })),
      client.get(memberOperation('member-a', selection)),
      client.get(projectOperations.timeline('beacon', selection)),
      client.get(projectOperations.history('beacon', season!)),
      client.get(projectOperations.detail('beacon', selection)),
    ])
    expect(runs).toHaveLength(6)
    expect(new Set(rankings.items.map((row) => row.status))).toEqual(
      new Set(['ranked', 'group_too_small', 'insufficient_data']),
    )
    expect(member).toHaveLength(2)
    expect(timeline.data?.tasks).toHaveLength(12)
    expect(history).toHaveLength(6)
    expect(detail.data.detail.metrics).toHaveLength(12)
    expect((await client.get(projectOperations.timeline('atlas', selection))).data).toBeNull()
  })
})
