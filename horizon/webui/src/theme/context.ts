import { createContext, useContext } from 'react'
import type { Appearance, ResolvedAppearance } from './appearance'

export interface AppearanceContextValue {
  appearance: Appearance
  resolved: ResolvedAppearance
  setAppearance: (appearance: Appearance) => void
  storageAvailable: boolean
}

export const AppearanceContext = createContext<AppearanceContextValue | null>(null)
export function useAppearance() {
  const context = useContext(AppearanceContext)
  if (!context) throw new Error('useAppearance must be used within AppearanceProvider')
  return context
}
