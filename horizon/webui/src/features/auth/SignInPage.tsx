import { useState } from 'react'
import { useLocation } from 'react-router-dom'
import { ShieldCheck } from 'lucide-react'
import { useAuth } from '../../auth/context'
import { Card } from '../../components/ui/Card'
import { ErrorState, LoadingState } from '../../components/ui/States'

export function SignInPage() {
  const { state, signIn } = useAuth()
  const location = useLocation()
  const [error, setError] = useState(false)
  if (state.status === 'loading')
    return <LoadingState label="Checking Horizon sign-in availability" />
  const returnTo: unknown = (location.state as { returnTo?: unknown } | null)?.returnTo
  return (
    <div className="sign-in-page">
      <span className="sign-in-emblem">
        <ShieldCheck size={30} aria-hidden="true" />
      </span>
      <p className="eyebrow">YOUR HORIZON ACCOUNT</p>
      <h1>A secure way into your workspace.</h1>
      <p className="sign-in-description">
        Horizon will use App Dev Club’s Authentik sign-in. Member and project information stays
        locked until your access can be verified.
      </p>
      <Card
        title="Sign in to Horizon"
        description={
          state.status === 'unavailable'
            ? state.reason
            : 'Continue with your Horizon identity provider.'
        }
      >
        {(state.status === 'error' || state.status === 'forbidden') && (
          <p className="auth-message" role="alert">
            {state.message}
          </p>
        )}
        {state.status === 'expired' && (
          <p className="auth-message" role="status">
            Your Horizon session expired. Sign in again to continue.
          </p>
        )}
        {state.status === 'authenticated' ? (
          <p className="principle-copy">Your Horizon session is verified.</p>
        ) : (
          <button
            className="button button-primary sign-in-button"
            disabled={state.status !== 'anonymous' && state.status !== 'expired'}
            onClick={() => {
              void signIn(typeof returnTo === 'string' ? returnTo : '/dashboard').catch(() => {
                setError(true)
              })
            }}
          >
            Continue with Authentik
          </button>
        )}
        {error && (
          <ErrorState description="Sign-in could not be started. Please try again later." />
        )}
        <p className="auth-footnote">
          A Horizon session will be required. Your People Portal session is not used by this
          application.
        </p>
      </Card>
    </div>
  )
}
