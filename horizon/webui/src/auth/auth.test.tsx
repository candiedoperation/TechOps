import { render, screen, waitFor } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { createHorizonQueryClient } from '../api/query-client'
import { AuthProvider } from './AuthProvider'
import { ProtectedRoute } from './ProtectedRoute'
import { useAuth } from './context'
import { horizonAuthAdapter } from './adapter'
import type { AuthState, HorizonAuthAdapter } from './types'

const session: AuthState = {
  status: 'authenticated',
  session: {
    subject: 'test-only-subject',
    displayName: 'Test fixture',
    permissions: ['fixture:read'],
  },
}
function adapterFor(state: AuthState): HorizonAuthAdapter {
  return { getState: vi.fn().mockResolvedValue(state), signIn: vi.fn(), signOut: vi.fn() }
}

function Controls() {
  const { state, signOut, signIn } = useAuth()
  return (
    <>
      <span>{state.status}</span>
      <button
        onClick={() => {
          void signOut().catch(() => {})
        }}
      >
        Log out
      </button>
      <button
        onClick={() => {
          void signIn('//untrusted.example').catch(() => {})
        }}
      >
        Invalid redirect
      </button>
    </>
  )
}

function renderAuth(adapter: HorizonAuthAdapter, permission?: string) {
  const client = createHorizonQueryClient()
  const childMounted = vi.fn()
  function SecretContent() {
    childMounted()
    return <p>Protected test content</p>
  }
  render(
    <QueryClientProvider client={client}>
      <AuthProvider adapter={adapter}>
        <MemoryRouter initialEntries={['/private?period=test']}>
          <Controls />
          <Routes>
            <Route
              path="/private"
              element={
                <ProtectedRoute permission={permission}>
                  <SecretContent />
                </ProtectedRoute>
              }
            />
            <Route path="/sign-in" element={<p>Sign-in route</p>} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  )
  return { client, childMounted }
}

describe('Horizon authentication boundary', () => {
  it('keeps the production adapter unavailable and rejects auth operations', async () => {
    expect(await horizonAuthAdapter.getState()).toMatchObject({ status: 'unavailable' })
    await expect(horizonAuthAdapter.signIn('/dashboard')).rejects.toThrow()
    await expect(horizonAuthAdapter.signOut()).rejects.toThrow()
  })

  it.each<AuthState>([
    { status: 'unavailable', reason: 'Not connected' },
    { status: 'error', message: 'No session verification' },
    { status: 'loading' },
  ])('does not mount protected children in $status state', async (state) => {
    const { childMounted } = renderAuth(adapterFor(state))
    await waitFor(() => expect(screen.getByText(state.status, { exact: true })).toBeInTheDocument())
    expect(childMounted).not.toHaveBeenCalled()
    expect(screen.queryByText('Protected test content')).not.toBeInTheDocument()
  })

  it('redirects anonymous visitors to the sign-in route', async () => {
    const { childMounted } = renderAuth(adapterFor({ status: 'anonymous' }))
    expect(await screen.findByText('Sign-in route')).toBeInTheDocument()
    expect(childMounted).not.toHaveBeenCalled()
  })
  it('redirects an expired session without mounting protected content', async () => {
    const { childMounted } = renderAuth(adapterFor({ status: 'expired' }))
    expect(await screen.findByText('Sign-in route')).toBeInTheDocument()
    expect(childMounted).not.toHaveBeenCalled()
  })
  it('shows an authorization error without treating it as a login success', async () => {
    const { childMounted } = renderAuth(
      adapterFor({ status: 'forbidden', message: 'Access requires approval.' }),
    )
    expect(await screen.findByText('Access restricted')).toBeInTheDocument()
    expect(childMounted).not.toHaveBeenCalled()
  })

  it('mounts children only for a verified session with the required permission', async () => {
    renderAuth(adapterFor(session), 'fixture:read')
    expect(await screen.findByText('Protected test content')).toBeInTheDocument()
  })

  it('rejects a missing permission without mounting feature children', async () => {
    const { childMounted } = renderAuth(adapterFor(session), 'fixture:denied')
    expect(await screen.findByText('Access restricted')).toBeInTheDocument()
    expect(childMounted).not.toHaveBeenCalled()
  })

  it('hides protected content and clears cached data when logout fails', async () => {
    const adapter = adapterFor(session)
    adapter.signOut = vi.fn().mockRejectedValue(new Error('Private server detail'))
    const { client } = renderAuth(adapter)
    await screen.findByText('Protected test content')
    client.setQueryData(['horizon', 'test-only-subject'], ['sensitive-fixture'])
    await userEvent.setup().click(screen.getByRole('button', { name: 'Log out' }))
    expect(
      await screen.findByText('Sign-out could not be confirmed. Please try again.'),
    ).toBeInTheDocument()
    expect(screen.queryByText('Protected test content')).not.toBeInTheDocument()
    expect(client.getQueryCache().getAll()).toHaveLength(0)
  })

  it('does not pass external return targets to the auth adapter', async () => {
    const adapter = adapterFor({ status: 'anonymous' })
    renderAuth(adapter)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Invalid redirect' }))
    expect(adapter.signIn).not.toHaveBeenCalled()
  })
})
