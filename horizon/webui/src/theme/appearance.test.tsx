import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import themeInitSource from '../../public/theme-init.js?raw'
import shellHtml from '../../index.html?raw'
import { describe, expect, it, vi } from 'vitest'
import { AppearanceProvider } from './AppearanceProvider'
import { APPEARANCE_STORAGE_KEY } from './appearance'
import { SettingsPage } from '../features/settings/SettingsPage'

function systemAppearance(dark = false) {
  const listeners = new Set<(event: MediaQueryListEvent) => void>()
  const media = {
    matches: dark,
    media: '(prefers-color-scheme: dark)',
    addEventListener: vi.fn((_name: string, listener: (event: MediaQueryListEvent) => void) =>
      listeners.add(listener),
    ),
    removeEventListener: vi.fn((_name: string, listener: (event: MediaQueryListEvent) => void) =>
      listeners.delete(listener),
    ),
  }
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => media),
  )
  return {
    change: (next: boolean) =>
      act(() => {
        media.matches = next
        listeners.forEach((listener) => listener({ matches: next } as MediaQueryListEvent))
      }),
    listeners,
  }
}
function renderSettings() {
  return render(
    <AppearanceProvider>
      <SettingsPage />
    </AppearanceProvider>,
  )
}

describe('Horizon appearance', () => {
  it('defaults to System and responds live to operating-system changes', () => {
    const system = systemAppearance(false)
    renderSettings()
    expect(screen.getByRole('combobox', { name: 'Appearance' })).toHaveValue('system')
    expect(document.documentElement).toHaveAttribute('data-theme', 'light')
    system.change(true)
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
    expect(screen.getByRole('status')).toHaveTextContent('Following your device: dark')
  })
  it('persists manual selection, ignores OS changes, and restores after remount', async () => {
    const system = systemAppearance(false)
    const first = renderSettings()
    await userEvent
      .setup()
      .selectOptions(screen.getByRole('combobox', { name: 'Appearance' }), 'dark')
    expect(localStorage.getItem(APPEARANCE_STORAGE_KEY)).toBe('dark')
    system.change(true)
    system.change(false)
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
    first.unmount()
    renderSettings()
    expect(screen.getByRole('combobox', { name: 'Appearance' })).toHaveValue('dark')
    expect(document.documentElement.style.colorScheme).toBe('dark')
    await userEvent.setup().click(screen.getByRole('button', { name: 'Light appearance' }))
    expect(document.documentElement).toHaveAttribute('data-theme', 'light')
    expect(localStorage.getItem(APPEARANCE_STORAGE_KEY)).toBe('light')
  })
  it('returns to live System behavior after a manual preference', async () => {
    const system = systemAppearance(true)
    renderSettings()
    const select = screen.getByRole('combobox', { name: 'Appearance' })
    await userEvent.setup().selectOptions(select, 'light')
    expect(document.documentElement).toHaveAttribute('data-theme', 'light')
    await userEvent.setup().selectOptions(select, 'system')
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
    system.change(false)
    expect(document.documentElement).toHaveAttribute('data-theme', 'light')
  })
  it('handles corrupt or unavailable preference storage without crashing', async () => {
    systemAppearance(true)
    localStorage.setItem(APPEARANCE_STORAGE_KEY, 'not-a-theme')
    const first = renderSettings()
    expect(screen.getByRole('combobox')).toHaveValue('system')
    first.unmount()
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    renderSettings()
    await userEvent.setup().selectOptions(screen.getByRole('combobox'), 'light')
    expect(document.documentElement).toHaveAttribute('data-theme', 'light')
    expect(screen.getByRole('alert')).toHaveTextContent('could not save')
  })
  it('updates across tabs and removes the system listener on unmount', () => {
    const system = systemAppearance(false)
    const view = renderSettings()
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', { key: APPEARANCE_STORAGE_KEY, newValue: 'dark' }),
      )
    })
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
    view.unmount()
    expect(system.listeners.size).toBe(0)
  })
})

describe('Pre-render appearance initialization', () => {
  const runBootstrap = new Function('window', 'document', 'localStorage', themeInitSource)
  it.each([
    { stored: 'dark', osDark: false, expected: 'dark' },
    { stored: 'light', osDark: true, expected: 'light' },
    { stored: 'system', osDark: true, expected: 'dark' },
    { stored: 'invalid', osDark: false, expected: 'light' },
  ])('sets $expected before React mounts for $stored', ({ stored, osDark, expected }) => {
    localStorage.setItem(APPEARANCE_STORAGE_KEY, stored)
    runBootstrap({ matchMedia: () => ({ matches: osDark }) }, document, localStorage)
    expect(document.documentElement).toHaveAttribute('data-theme', expected)
    expect(document.documentElement.style.colorScheme).toBe(expected)
    expect(document.documentElement).toHaveClass(expected)
  })
  it('runs ahead of app module loading and recovers when storage is denied', () => {
    expect(shellHtml.indexOf('src="/theme-init.js"')).toBeLessThan(
      shellHtml.indexOf('type="module"'),
    )
    runBootstrap({ matchMedia: () => ({ matches: true }) }, document, {
      getItem: () => {
        throw new Error('blocked')
      },
    })
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
  })
})
