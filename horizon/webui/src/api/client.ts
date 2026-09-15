/**
 * The single HTTP path out of the dashboard.
 *
 * Everything the UI reads or writes goes through `requestJson`, so the bearer
 * token, the timeout, `credentials: "omit"` and the error shaping are decided
 * in exactly one place.
 */

import { REQUEST_TIMEOUT_MS, resolveApiBase } from "@/commons/config"
import { authHeaders } from "@/auth/session"

/** An HTTP failure that reached us with a status. Pages use `status` to tell
 *  "you are not signed in" apart from "this genuinely failed". */
export class ApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = "ApiError"
    this.status = status
  }
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return null
}

/**
 * FastAPI returns a list of validation objects in `detail` and a plain string
 * everywhere else. Flatten both into one readable sentence rather than showing
 * a raw `[object Object]` to a reviewer.
 */
export function formatErrorDetail(detail: unknown): string | null {
  if (typeof detail === "string") return detail.trim() || null
  if (Array.isArray(detail)) {
    const messages = detail
      .map((item) => {
        if (typeof item === "string") return item
        if (!item || typeof item !== "object") return ""
        const record = item as Record<string, unknown>
        const field = asArray(record.loc)
          .filter((part) => part !== "body")
          .join(".")
        const message = firstString(record.msg, record.message) ?? ""
        return field && message ? `${field}: ${message}` : message
      })
      .filter(Boolean)
    return messages.length ? messages.join("; ") : null
  }
  if (detail && typeof detail === "object") {
    const record = detail as Record<string, unknown>
    return formatErrorDetail(firstString(record.msg, record.message, record.error))
  }
  return null
}

export interface RequestOptions {
  method?: string
  /** Serialized to JSON; the Content-Type header is set for you. */
  body?: unknown
  signal?: AbortSignal
  headers?: Record<string, string>
}

function combineSignals(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  if (!signal) return timeout
  /* TanStack Query passes its own signal so an unmounted page's request is
     dropped; both must be able to abort the fetch. */
  if (typeof AbortSignal.any === "function") return AbortSignal.any([signal, timeout])
  return signal
}

export async function requestJson<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const hasBody = options.body !== undefined
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...(await authHeaders()),
    ...(hasBody ? { "Content-Type": "application/json" } : {}),
    ...(options.headers ?? {}),
  }

  const response = await fetch(`${resolveApiBase()}${path}`, {
    credentials: "omit",
    method: options.method ?? "GET",
    body: hasBody ? JSON.stringify(options.body) : undefined,
    signal: combineSignals(options.signal),
    headers,
  })

  let payload: unknown = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }

  if (!response.ok) {
    const detail =
      payload && typeof payload === "object"
        ? (payload as Record<string, unknown>).detail ??
          (payload as Record<string, unknown>).message ??
          (payload as Record<string, unknown>).error
        : null
    const message = formatErrorDetail(detail)
    if (response.status === 401) {
      const reason = message || "Authentication is required"
      throw new ApiError(
        `${/[.!?]$/.test(reason) ? reason : `${reason}.`} Open an operator session, or configure an API token in the host integration.`,
        401,
      )
    }
    if (response.status === 403) {
      throw new ApiError(message || "Your account does not have access to this data.", 403)
    }
    throw new ApiError(message || `Request failed (${response.status})`, response.status)
  }

  return payload as T
}

/**
 * Artifact bytes (résumé PDFs, pipeline JSON) rather than a decoded body.
 * Used by the Profiles surface, which hands the blob straight to a download
 * instead of parsing it.
 */
export async function requestBlob(path: string, signal?: AbortSignal): Promise<Blob> {
  const response = await fetch(`${resolveApiBase()}${path}`, {
    credentials: "omit",
    cache: "no-store",
    signal: combineSignals(signal),
    headers: await authHeaders(),
  })
  if (response.status === 401) {
    throw new ApiError("Open an operator session to authenticate.", 401)
  }
  if (!response.ok) {
    throw new ApiError(`Request returned HTTP ${response.status}`, response.status)
  }
  return response.blob()
}

export function errorMessage(error: unknown, fallback = "Unavailable"): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "string" && error.trim()) return error
  return fallback
}
