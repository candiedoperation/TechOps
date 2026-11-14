import { useState, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import type { ReadOperation } from '../../api/client'
import type { PortfolioSnapshot } from '../../api/contracts/provisional/portfolio'
import { useHorizonReadQuery } from '../../api/use-horizon-query'
import { useMockSource } from '../../api/data-source'
import { PortfolioContext } from './context'

export function PortfolioProvider({
  children,
  operationForSnapshot,
}: {
  children: ReactNode
  operationForSnapshot?: (snapshot: string) => ReadOperation<PortfolioSnapshot>
}) {
  const mockSource = useMockSource()
  const [selected, selectSnapshot] = useState('')
  const { pathname } = useLocation()
  const active =
    ['/dashboard', '/projects', '/project-health', '/insights'].includes(pathname) ||
    pathname.startsWith('/projects/')
  const query = useHorizonReadQuery({
    feature: 'portfolio',
    parameters: { snapshot: selected },
    operation: active
      ? (operationForSnapshot?.(selected) ??
        (mockSource
          ? {
              path: `/mock/portfolio?${new URLSearchParams({ snapshot: selected })}`,
              parse: (value: unknown) => value as PortfolioSnapshot,
            }
          : undefined))
      : undefined,
  })
  return (
    <PortfolioContext.Provider
      value={{ snapshotId: selected || query.data?.snapshotId || '', selectSnapshot, query }}
    >
      {children}
    </PortfolioContext.Provider>
  )
}
