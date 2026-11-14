import type { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from './context'
import { EmptyState, ErrorState, LoadingState } from '../components/ui/States'

/** Mount protected children only after a verified Horizon session exists. */
export function ProtectedRoute({
  children,
  permission,
  executiveOnly = false,
}: {
  children: ReactNode
  permission?: string
  executiveOnly?: boolean
}) {
  const { state } = useAuth()
  const location = useLocation()
  if (state.status === 'loading') return <LoadingState label="Checking your Horizon session" />
  if (state.status === 'anonymous' || state.status === 'expired')
    return (
      <Navigate
        to="/sign-in"
        state={{
          returnTo: location.pathname + location.search + location.hash,
          reason: state.status,
        }}
        replace
      />
    )
  if (state.status === 'unavailable')
    return <EmptyState title="Protected workspace unavailable" description={state.reason} locked />
  if (state.status === 'error') return <ErrorState description={state.message} />
  if (state.status === 'forbidden')
    return <EmptyState title="Access restricted" description={state.message} locked />
  if (
    (executiveOnly && state.session.isExec !== true) ||
    (permission && !state.session.permissions.includes(permission))
  ) {
    return (
      <EmptyState
        title="Access restricted"
        description="Your Horizon account does not have access to this page."
        locked
      />
    )
  }
  return children
}
