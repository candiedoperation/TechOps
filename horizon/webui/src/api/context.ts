import { createContext, useContext } from 'react'
import type { HorizonReadClient } from './client'

export const ReadClientContext = createContext<HorizonReadClient | null>(null)

export function useHorizonReadClient() {
  const client = useContext(ReadClientContext)
  if (!client) throw new Error('Horizon read hooks must be inside HorizonReadProvider')
  return client
}
