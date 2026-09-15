/**
 * Operator session token, held in page memory only.
 *
 * This is the port of `assets/operator-session.js`, and it keeps that file's
 * one hard rule: the token is never written to localStorage, sessionStorage,
 * a cookie, the URL, or checked-in HTML. It lives in this module's closure for
 * the lifetime of the page and is gone on sign-out or reload.
 *
 * Two sources feed it:
 *  - an operator who signed in through the "Operator session" control, and
 *  - `window.PHI_API_TOKEN`, which a host integration may set to either a
 *    string or a (possibly async) provider function.
 *
 * The operator-entered token wins, so signing in inside a hosted page does
 * what the operator expects.
 *
 * It is a plain module rather than a hook because the fetch layer is not a
 * React component; `OperatorSessionProvider` keeps this in step with its state.
 */

import { horizonWindow, type HorizonTokenSource } from "@/commons/config"

let sessionToken: string | null = null

const listeners = new Set<() => void>()

function notify() {
  for (const listener of listeners) listener()
}

/** Subscribe to sign-in / sign-out. Returns the unsubscribe function. */
export function subscribeToSession(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Whether an operator has signed in during this page's lifetime. */
export function hasOperatorToken(): boolean {
  return sessionToken !== null
}

export function setOperatorToken(token: string): void {
  const trimmed = token.trim()
  sessionToken = trimmed ? trimmed : null
  notify()
}

export function clearOperatorToken(): void {
  sessionToken = null
  notify()
}

/**
 * Read the host-supplied token. `window.PHI_API_TOKEN` is documented as a
 * string *or* an async provider, so both are honoured and a provider that
 * throws is reported rather than swallowed -- an expired host session should
 * say so, not look like an empty token.
 */
async function hostToken(source: HorizonTokenSource | undefined): Promise<string | null> {
  const value = typeof source === "function" ? await source() : source
  return typeof value === "string" && value.trim() ? value.trim() : null
}

/** The token to send, or null when the page has no session at all. */
export async function resolveAuthToken(win: Window = window): Promise<string | null> {
  if (sessionToken) return sessionToken
  try {
    return await hostToken(horizonWindow(win).PHI_API_TOKEN)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(detail || "The API session token could not be obtained.")
  }
}

/**
 * Authorization header for a request, or an empty object when unauthenticated
 * (local and demo deployments serve public data with no token configured).
 *
 * `X-Reviewer-Id` is deliberately absent: the server assigns reviewer identity
 * from the bearer token, and a client-asserted reviewer id would be an
 * identity claim the UI is not entitled to make.
 */
export async function authHeaders(win: Window = window): Promise<Record<string, string>> {
  const token = await resolveAuthToken(win)
  if (!token) return {}
  return { Authorization: /^bearer\s/i.test(token) ? token : `Bearer ${token}` }
}
