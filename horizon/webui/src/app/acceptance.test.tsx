import { render, screen } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { AuthContext } from '../auth/context'
import type { AuthState } from '../auth/types'
import { ProtectedRoute } from '../auth/ProtectedRoute'
import { AppearanceProvider } from '../theme/AppearanceProvider'
import { AppLayout } from '../components/layout/AppLayout'
import { ScoreBar } from '../components/ui/ScoreBar'
import { isRunStale } from '../api/publication'

function withAuth(state: AuthState, child: React.ReactNode) {
  return render(
    <AppearanceProvider>
      <AuthContext.Provider
        value={{
          state,
          signIn: vi.fn(async () => {}),
          signOut: vi.fn(async () => {}),
          invalidateSession: vi.fn(),
        }}
      >
        <MemoryRouter>{child}</MemoryRouter>
      </AuthContext.Provider>
    </AppearanceProvider>,
  )
}
describe('T6.1 executive access and shared components', () => {
  it.each([undefined, false, true])(
    'shows ranking navigation only with verified isExec=true (%s)',
    (isExec) => {
      withAuth(
        {
          status: 'authenticated',
          session: { subject: 'test-subject', displayName: 'Test user', permissions: [], isExec },
        },
        <Routes>
          <Route element={<AppLayout />} path="/" />
        </Routes>,
      )
      expect(Boolean(screen.queryByRole('link', { name: 'Member Rankings' }))).toBe(isExec === true)
    },
  )
  it.each([undefined, false])('blocks non-executive direct routes (%s)', (isExec) => {
    withAuth(
      {
        status: 'authenticated',
        session: { subject: 'test-subject', displayName: 'Test user', permissions: [], isExec },
      },
      <ProtectedRoute executiveOnly>
        <p>Private fixture</p>
      </ProtectedRoute>,
    )
    expect(screen.getByText('Access restricted')).toBeInTheDocument()
    expect(screen.queryByText('Private fixture')).not.toBeInTheDocument()
  })
  it('permits verified executives and redirects anonymous direct requests', () => {
    withAuth(
      {
        status: 'authenticated',
        session: {
          subject: 'test-subject',
          displayName: 'Test user',
          permissions: [],
          isExec: true,
        },
      },
      <ProtectedRoute executiveOnly>
        <p>Private fixture</p>
      </ProtectedRoute>,
    )
    expect(screen.getByText('Private fixture')).toBeInTheDocument()
  })
  it('uses the sign-in route for anonymous visitors without mounting protected content', () => {
    withAuth(
      { status: 'anonymous' },
      <Routes>
        <Route
          path="/"
          element={
            <ProtectedRoute executiveOnly>
              <p>Private fixture</p>
            </ProtectedRoute>
          }
        />
        <Route path="/sign-in" element={<p>Sign in fixture</p>} />
      </Routes>,
    )
    expect(screen.getByText('Sign in fixture')).toBeInTheDocument()
    expect(screen.queryByText('Private fixture')).not.toBeInTheDocument()
  })
  it('preserves missing scores and uses only explicit meter bounds', () => {
    render(
      <>
        <ScoreBar value={75} maximum={100} label="Test score" />
        <ScoreBar value={null} maximum={100} label="Missing" />
      </>,
    )
    expect(screen.getByRole('meter', { name: 'Test score' })).toHaveAttribute('value', '75')
    expect(screen.getByLabelText('Missing: not available')).toHaveTextContent('Not available')
    expect(screen.queryByRole('meter', { name: 'Missing' })).not.toBeInTheDocument()
  })
  it('marks run age strictly greater than eight days and never substitutes cache age', () => {
    const now = Date.parse('2026-11-08T12:00:00Z')
    expect(isRunStale('2026-10-31T12:00:00Z', now)).toBe(false)
    expect(isRunStale('2026-10-31T11:59:59Z', now)).toBe(true)
    expect(isRunStale(null, now)).toBeNull()
    expect(isRunStale('bad date', now)).toBeNull()
  })
})
