/** Proposed Horizon session JSON. No endpoint implementation or client secret belongs here. */
export type ProvisionalSessionResponse =
  | { state: 'anonymous' | 'expired' }
  | {
      state: 'authenticated'
      user: { subject: string; authentikUserPk: string; displayName: string }
      capabilities: readonly string[]
      expiresAt: string
    }

export interface ProvisionalAuthError {
  code: 'unauthenticated' | 'session_expired' | 'forbidden' | 'service_unavailable'
  message: string
  requestId?: string
}
