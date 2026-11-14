import { createContext, useContext } from 'react'
import type { HorizonReadClient } from './client'

export function parseDataSource(value: string | undefined) {
  if (value === 'api') return 'api'
  if (!value || value === 'mock') return 'mock'
  throw new Error('VITE_HORIZON_DATA_SOURCE must be mock or api.')
}

export const MockSourceContext = createContext<HorizonReadClient | null>(null)

export function useMockSource() {
  return useContext(MockSourceContext)
}

export async function loadMockSource() {
  // Vite folds this direct comparison, excluding fixtures from API-mode builds.
  if (import.meta.env.VITE_HORIZON_DATA_SOURCE !== 'api') {
    return (await import('../mocks/horizon/fixtures')).mockSource
  }
  return null
}
