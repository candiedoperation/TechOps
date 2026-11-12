import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ReadApiError } from '../../api/client'
import { QueryState } from './QueryState'

function show(overrides: Partial<Parameters<typeof QueryState<string[]>>[0]> = {}) {
  const onRefresh = vi.fn()
  render(
    <QueryState<string[]>
      available
      data={undefined}
      pending={false}
      error={null}
      onRefresh={onRefresh}
      isEmpty={(rows) => rows.length === 0}
      {...overrides}
    >
      {(rows) => <p>{rows.join(', ')}</p>}
    </QueryState>,
  )
  return onRefresh
}

describe('Reusable query states', () => {
  it('announces loading accessibly', () => {
    show({ pending: true })
    expect(screen.getByRole('status')).toHaveTextContent('Loading Horizon data')
  })
  it('distinguishes an empty response', () => {
    show({ data: [] })
    expect(screen.getByText('No results match this view.')).toBeInTheDocument()
  })
  it('provides retry after an initial failure without exposing the raw error', async () => {
    const retry = show({ error: new Error('private detail') })
    expect(screen.getByRole('alert')).toHaveTextContent('Unable to load information')
    expect(screen.queryByText('private detail')).not.toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }))
    expect(retry).toHaveBeenCalledOnce()
  })
  it('keeps valid cached data visible with a freshness warning after a background failure', async () => {
    const refresh = show({
      data: ['Test-only cached value'],
      error: new Error('network'),
      updatedAt: '2026-10-31T00:00:00Z',
    })
    expect(screen.getByText('Test-only cached value')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('may be out of date')
    await userEvent.setup().click(screen.getByRole('button', { name: 'Refresh' }))
    expect(refresh).toHaveBeenCalledOnce()
  })
  it.each([401, 403])('never shows cached data after access denial %s', (status) => {
    show({
      data: ['private fixture'],
      error: new ReadApiError(
        status === 401 ? 'unauthorized' : 'forbidden',
        'Access denied',
        status,
      ),
    })
    expect(screen.queryByText('private fixture')).not.toBeInTheDocument()
    expect(
      screen.getByText(status === 401 ? 'Session expired' : 'Access restricted'),
    ).toBeInTheDocument()
  })
  it('hides cached results while the connection is unavailable', () => {
    show({ available: false, data: ['private fixture'] })
    expect(screen.queryByText('private fixture')).not.toBeInTheDocument()
    expect(screen.getByText('Data connection pending')).toBeInTheDocument()
  })
  it.each(['current', 'stale', 'provisional', 'missing'] as const)(
    'uses backend-provided %s publication metadata',
    (state) => {
      show({ data: ['fixture'], freshness: { state, publishedAt: null } })
      if (state === 'stale')
        expect(screen.getByRole('status')).toHaveTextContent('may be out of date')
      if (state === 'provisional')
        expect(screen.getByRole('status')).toHaveTextContent('Provisional result')
      if (state === 'missing') {
        expect(screen.getByText('No published result')).toBeInTheDocument()
        expect(screen.queryByText('fixture')).not.toBeInTheDocument()
      }
      if (state === 'current') {
        expect(screen.getByText('fixture')).toBeInTheDocument()
        expect(screen.queryByRole('status')).not.toBeInTheDocument()
      }
    },
  )
})
