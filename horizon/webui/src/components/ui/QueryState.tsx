import type { ReactNode } from 'react'
import { EmptyState, ErrorState, LoadingState, StaleState } from './States'
import { ReadApiError } from '../../api/client'
import type { PublicationFreshness } from '../../api/publication'

/** Auth/access failures always take precedence over previously cached data. */
export function QueryState<T>({
  available,
  data,
  pending,
  error,
  stale,
  freshness,
  updatedAt,
  refreshing,
  onRefresh,
  isEmpty,
  children,
}: {
  available: boolean
  data: T | undefined
  pending: boolean
  error: Error | null
  stale?: boolean
  /** From an approved response parser only; never derive publication state from cache age. */
  freshness?: PublicationFreshness
  updatedAt?: string
  refreshing?: boolean
  onRefresh: () => void
  isEmpty: (value: T) => boolean
  children: (value: T) => ReactNode
}) {
  if (!available)
    return (
      <EmptyState
        title="Data connection pending"
        description="This view will be available after Horizon sign-in and authorized read APIs are connected."
        locked
      />
    )
  if (error instanceof ReadApiError && ['unauthorized', 'forbidden'].includes(error.kind)) {
    return (
      <EmptyState
        title={error.kind === 'unauthorized' ? 'Session expired' : 'Access restricted'}
        description={error.message}
        locked
      />
    )
  }
  if (freshness?.state === 'missing')
    return (
      <EmptyState
        title="No published result"
        description="The backend reports that a published result is missing for this view."
      />
    )
  if (data === undefined) {
    if (error) return <ErrorState onRetry={onRefresh} />
    if (pending) return <LoadingState />
    return <EmptyState description="No published result is available yet." />
  }
  return (
    <>
      {freshness?.state === 'provisional' && (
        <div className="stale-notice" role="status">
          Provisional result — not a final published assessment.
        </div>
      )}
      {(freshness?.state === 'stale' || stale || error) && (
        <StaleState
          updatedAt={freshness?.publishedAt ?? updatedAt}
          onRefresh={onRefresh}
          refreshing={refreshing}
        />
      )}
      {isEmpty(data) ? <EmptyState description="No results match this view." /> : children(data)}
    </>
  )
}
