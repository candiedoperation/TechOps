export interface HorizonSession {
  /** Canonical member identifier as returned by Horizon, not inferred from an email. */
  subject: string
  displayName: string
  /** From verified Horizon identity only; absent means no executive access. */
  isExec?: boolean
  /** UI hints only. The backend must enforce every data-access decision. */
  permissions: readonly string[]
}

export type AuthState =
  | { status: 'unavailable'; reason: string }
  | { status: 'loading' }
  | { status: 'anonymous' }
  | { status: 'expired' }
  | { status: 'forbidden'; message: string }
  | { status: 'authenticated'; session: HorizonSession }
  | { status: 'error'; message: string }

/** Implement against Horizon's agreed backend session contract, never People Portal cookies. */
export interface HorizonAuthAdapter {
  getState(signal?: AbortSignal): Promise<AuthState>
  signIn(returnTo: string): Promise<void>
  signOut(): Promise<void>
}
