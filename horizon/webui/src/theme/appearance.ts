export const APPEARANCE_STORAGE_KEY = 'horizon-ui-theme'
export const SYSTEM_APPEARANCE_QUERY = '(prefers-color-scheme: dark)'
export type Appearance = 'system' | 'light' | 'dark'
export type ResolvedAppearance = 'light' | 'dark'

export function isAppearance(value: unknown): value is Appearance {
  return value === 'system' || value === 'light' || value === 'dark'
}

export function readAppearance(): Appearance {
  try {
    const stored = localStorage.getItem(APPEARANCE_STORAGE_KEY)
    return isAppearance(stored) ? stored : 'system'
  } catch {
    return 'system'
  }
}

export function applyAppearance(appearance: Appearance, systemIsDark: boolean) {
  const resolved: ResolvedAppearance =
    appearance === 'system' ? (systemIsDark ? 'dark' : 'light') : appearance
  const root = document.documentElement
  root.dataset.theme = resolved
  root.classList.remove('light', 'dark')
  root.classList.add(resolved)
  root.style.colorScheme = resolved
  return resolved
}
