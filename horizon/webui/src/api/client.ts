import type { AuthState } from '../auth/types'
import { createReadTransport, ReadApiError, type ReadOperation } from './transport'
export { ReadApiError } from './transport'
export type { ReadOperation, ReadApiErrorKind } from './transport'

export interface ReadClientOptions {
  origin: string
  enabled: () => boolean
  getAuthState: () => Promise<AuthState>
  onAccessDenied: (status: 401 | 403) => void
  fetcher?: typeof fetch
}
export interface HorizonReadClient {
  readonly accessMode: 'session' | 'demo'
  readonly scope: string
  isAvailable(): boolean
  get<T>(operation: ReadOperation<T>, signal?: AbortSignal): Promise<T>
}

/** Production/session guard. Demo never supplies an AuthState or changes this gate. */
export function createHorizonReadClient(options: ReadClientOptions): HorizonReadClient {
  const transport = createReadTransport({ ...options, credentials: 'same-origin' })
  return {
    accessMode: 'session',
    scope: 'session',
    isAvailable: options.enabled,
    async get<T>(operation: ReadOperation<T>, signal?: AbortSignal): Promise<T> {
      if (!options.enabled())
        throw new ReadApiError('unavailable', 'Horizon read APIs are not connected yet.')
      const auth = await options.getAuthState()
      if (auth.status !== 'authenticated') {
        const status = auth.status === 'forbidden' ? 403 : 401
        options.onAccessDenied(status)
        throw new ReadApiError(
          status === 403 ? 'forbidden' : 'unauthorized',
          status === 403
            ? 'You do not have access to this information.'
            : 'A verified Horizon session is required.',
          status,
        )
      }
      return transport.get(operation, signal)
    },
  }
}
