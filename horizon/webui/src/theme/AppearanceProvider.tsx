import { useCallback, useLayoutEffect, useState, type ReactNode } from 'react'
import { AppearanceContext } from './context'
import {
  APPEARANCE_STORAGE_KEY,
  SYSTEM_APPEARANCE_QUERY,
  applyAppearance,
  isAppearance,
  readAppearance,
  type Appearance,
} from './appearance'

/** Same three preferences as People Portal, with live system updates and safe storage access. */
export function AppearanceProvider({ children }: { children: ReactNode }) {
  const [appearance, setPreference] = useState<Appearance>(readAppearance)
  const [systemIsDark, setSystemIsDark] = useState(
    () => window.matchMedia(SYSTEM_APPEARANCE_QUERY).matches,
  )
  const [storageAvailable, setStorageAvailable] = useState(true)
  const resolved = appearance === 'system' ? (systemIsDark ? 'dark' : 'light') : appearance

  useLayoutEffect(() => {
    const media = window.matchMedia(SYSTEM_APPEARANCE_QUERY)
    setSystemIsDark(media.matches)
    const onChange = (event: MediaQueryListEvent) => {
      setSystemIsDark(event.matches)
    }
    media.addEventListener('change', onChange)
    return () => {
      media.removeEventListener('change', onChange)
    }
  }, [])

  useLayoutEffect(() => {
    applyAppearance(appearance, systemIsDark)
  }, [appearance, systemIsDark])

  useLayoutEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === APPEARANCE_STORAGE_KEY || event.key === null) {
        setPreference(isAppearance(event.newValue) ? event.newValue : 'system')
      }
    }
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener('storage', onStorage)
    }
  }, [])

  const setAppearance = useCallback((next: Appearance) => {
    setPreference(next)
    // Apply synchronously for keyboard/selection feedback; the effect keeps OS changes in sync.
    applyAppearance(next, window.matchMedia(SYSTEM_APPEARANCE_QUERY).matches)
    try {
      localStorage.setItem(APPEARANCE_STORAGE_KEY, next)
      setStorageAvailable(true)
    } catch {
      setStorageAvailable(false)
    }
  }, [])

  return (
    <AppearanceContext.Provider value={{ appearance, resolved, setAppearance, storageAvailable }}>
      {children}
    </AppearanceContext.Provider>
  )
}
