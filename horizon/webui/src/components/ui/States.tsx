import { AlertCircle, Clock3, Inbox, LoaderCircle, LockKeyhole, RefreshCw } from 'lucide-react'
import type { ReactNode } from 'react'

export function LoadingState({ label = 'Loading Horizon data' }: { label?: string }) {
  return (
    <div className="content-state" role="status">
      <LoaderCircle className="animate-spin state-icon" aria-hidden="true" />
      <p>{label}</p>
      <div className="skeleton-lines" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
    </div>
  )
}

export function EmptyState({
  title = 'Nothing here yet',
  description,
  locked = false,
  action,
}: {
  title?: string
  description: string
  locked?: boolean
  action?: ReactNode
}) {
  const Icon = locked ? LockKeyhole : Inbox
  return (
    <div className="content-state">
      <span className="state-icon-box">
        <Icon aria-hidden="true" />
      </span>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  )
}

export function ErrorState({
  description = 'Something went wrong while loading this information.',
  onRetry,
}: {
  description?: string
  onRetry?: () => void
}) {
  return (
    <div className="content-state error-state" role="alert">
      <span className="state-icon-box">
        <AlertCircle aria-hidden="true" />
      </span>
      <h3>Unable to load information</h3>
      <p>{description}</p>
      {onRetry && (
        <button className="button button-secondary" onClick={onRetry}>
          <RefreshCw size={15} aria-hidden="true" />
          Try again
        </button>
      )}
    </div>
  )
}

export function StaleState({
  updatedAt,
  onRefresh,
  refreshing = false,
}: {
  updatedAt?: string
  onRefresh?: () => void
  refreshing?: boolean
}) {
  const date = updatedAt ? new Date(updatedAt) : null
  const validDate = date && Number.isFinite(date.getTime())
  return (
    <div className="stale-notice" role="status">
      <Clock3 size={17} aria-hidden="true" />
      <p>
        This information may be out of date.
        {validDate && (
          <>
            {' '}
            Last updated <time dateTime={date.toISOString()}>{date.toLocaleString()}</time>.
          </>
        )}
      </p>
      {onRefresh && (
        <button className="text-button" onClick={onRefresh} disabled={refreshing}>
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      )}
    </div>
  )
}
