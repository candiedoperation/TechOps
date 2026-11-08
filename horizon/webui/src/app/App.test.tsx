import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { App } from './App'

function renderApp(path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  )
}

describe('Horizon workspace', () => {
  it('opens the dashboard without fetching protected information', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    renderApp()
    expect(
      await screen.findByRole('heading', { name: 'Your Horizon, at a glance.' }),
    ).toBeInTheDocument()
    expect(
      screen.getByText('No rankings, project scores, or evidence have been loaded.', {
        exact: false,
      }),
    ).toBeInTheDocument()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('navigates between all three routes while preserving the shell', async () => {
    const user = userEvent.setup()
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    renderApp('/dashboard')
    const nav = screen.getByRole('navigation', { name: 'Primary navigation' })
    expect(within(nav).queryByRole('link', { name: 'Member Rankings' })).not.toBeInTheDocument()
    await user.click(within(nav).getByRole('link', { name: 'Projects' }))
    expect(
      await screen.findByRole('heading', { name: 'All projects', level: 1 }),
    ).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Portfolio snapshot' })).toBeDisabled()
    await user.click(within(nav).getByRole('link', { name: 'Dashboard' }))
    expect(
      await screen.findByRole('heading', { name: 'Your Horizon, at a glance.' }),
    ).toBeInTheDocument()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('supports direct feature links and does not show invented records', async () => {
    renderApp('/rankings')
    expect(await screen.findByText('Protected workspace unavailable')).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Semester' })).toBeDisabled()
    const table = screen.getByRole('table', { name: 'Member rankings' })
    expect(within(table).getAllByRole('row')).toHaveLength(2)
  })

  it('does not fabricate sign-in or provide an authentication bypass', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    renderApp('/sign-in')
    expect(await screen.findByRole('button', { name: 'Continue with Authentik' })).toBeDisabled()
    expect(
      screen.getByText('Your People Portal session is not used by this application.', {
        exact: false,
      }),
    ).toBeInTheDocument()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('provides a useful fallback for unknown routes', () => {
    renderApp('/not-a-feature')
    expect(
      screen.getByRole('heading', { name: 'This page is beyond the horizon' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to dashboard' })).toHaveAttribute(
      'href',
      '/dashboard',
    )
  })

  it('opens the mobile navigation and closes it after route selection', async () => {
    const user = userEvent.setup()
    renderApp()
    await user.click(screen.getByRole('button', { name: 'Open navigation' }))
    const dialog = screen.getByRole('dialog', { name: 'Workspace navigation' })
    expect(dialog).toHaveAttribute('open')
    await user.click(within(dialog).getByRole('link', { name: 'Projects' }))
    expect(dialog).not.toHaveAttribute('open')
    expect(
      await screen.findByRole('heading', { name: 'All projects', level: 1 }),
    ).toBeInTheDocument()
  })
})
