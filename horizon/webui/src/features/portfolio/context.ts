import { createContext, useContext } from 'react'
import type { PortfolioSnapshot } from '../../api/contracts/provisional/portfolio'
import type { useHorizonReadQuery } from '../../api/use-horizon-query'

export const PortfolioContext = createContext<{
  snapshotId: string
  selectSnapshot: (id: string) => void
  query: ReturnType<typeof useHorizonReadQuery<PortfolioSnapshot>>
} | null>(null)
export function usePortfolio() {
  const value = useContext(PortfolioContext)
  if (!value) throw new Error('Portfolio views require PortfolioProvider')
  return value
}
