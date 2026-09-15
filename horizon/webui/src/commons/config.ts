/**
 * Host integration surface.
 *
 * Horizon is deployed behind a same-origin API proxy, so `location.origin` is
 * the right default and nothing has to be configured for the common case. A
 * host that serves the bundle from somewhere else sets `window.PHI_API_BASE`
 * before the app boots; `index.html` carries the same one-line bootstrap the
 * vanilla shell did, so the value is already resolved by the time this module
 * is imported.
 */

/** A host may supply a token directly, or a provider that fetches one. */
export type HorizonTokenSource = string | (() => string | Promise<string | null | undefined>)

export interface HorizonWindow extends Window {
  PHI_API_BASE?: string
  PHI_API_TOKEN?: HorizonTokenSource
}

export function horizonWindow(win: Window = window): HorizonWindow {
  return win as HorizonWindow
}

/**
 * Resolve the API base exactly as the vanilla app did: an explicit
 * `PHI_API_BASE` wins, `file:` pages fall back to the local API, and every
 * other page is same-origin.
 *
 * A trailing slash is stripped so `${base}${path}` cannot produce `//audit`,
 * which some reverse proxies treat as a different route.
 */
export function resolveApiBase(win: Window = window): string {
  const configured = horizonWindow(win).PHI_API_BASE
  if (typeof configured === "string" && configured.trim()) {
    return configured.trim().replace(/\/+$/, "")
  }
  if (win.location.protocol === "file:") return "http://127.0.0.1:8000"
  return win.location.origin
}

/** Requests time out at two minutes, matching the vanilla client and the
 *  local proxy: an LLM-backed compute route legitimately takes minutes. */
export const REQUEST_TIMEOUT_MS = 120_000
