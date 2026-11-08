export type ReadApiErrorKind =
  'unavailable' | 'unauthorized' | 'forbidden' | 'network' | 'http' | 'invalid-response'

export class ReadApiError extends Error {
  readonly kind: ReadApiErrorKind
  readonly status?: number
  constructor(kind: ReadApiErrorKind, message: string, status?: number) {
    super(message)
    this.name = 'ReadApiError'
    this.kind = kind
    this.status = status
  }
}

/** The feature supplies a confirmed endpoint and runtime response validator. */
export interface ReadOperation<T> {
  path: string
  parse: (value: unknown) => T
}

export interface TransportOptions {
  origin: string
  credentials: RequestCredentials
  onAccessDenied: (status: 401 | 403) => void
  fetcher?: typeof fetch
  allowPath?: (url: URL) => boolean
  requireDemoResponse?: boolean
}

/** Shared HTTP behavior; callers must enforce session access or the isolated demo policy. */
export function createReadTransport(options: TransportOptions) {
  return {
    async get<T>(operation: ReadOperation<T>, signal?: AbortSignal): Promise<T> {
      const origin = new URL(options.origin)
      if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password) {
        throw new ReadApiError('unavailable', 'Invalid Horizon API origin.')
      }
      // Session-cookie requests remain same-origin. A future cross-origin deployment
      // needs a separately reviewed cookie/CORS contract before enabling it.
      if (origin.origin !== window.location.origin) {
        throw new ReadApiError(
          'unavailable',
          'Horizon API requests must use the application origin.',
        )
      }
      if (
        !operation.path.startsWith('/') ||
        operation.path.startsWith('//') ||
        /[\\\r\n]/.test(operation.path)
      ) {
        throw new ReadApiError('unavailable', 'Expected a same-origin Horizon read path.')
      }
      const url = new URL(operation.path, origin.origin)
      if (url.origin !== origin.origin || url.hash)
        throw new ReadApiError('unavailable', 'Invalid Horizon read path.')
      if (options.allowPath && !options.allowPath(url))
        throw new ReadApiError(
          'unavailable',
          'This read path is not permitted in this environment.',
        )
      let response: Response
      try {
        response = await (options.fetcher ?? fetch)(url, {
          method: 'GET',
          headers: { Accept: 'application/json' },
          credentials: options.credentials,
          redirect: 'error',
          cache: 'no-store',
          signal,
        })
      } catch (error) {
        if (signal?.aborted) throw error
        throw new ReadApiError('network', 'Horizon could not be reached. Please try again.')
      }
      if (options.requireDemoResponse && response.headers.get('x-horizon-demo') !== 'fictional')
        throw new ReadApiError(
          'unavailable',
          'Demo interception was not confirmed. No response will be displayed.',
        )
      if (response.status === 401 || response.status === 403) {
        options.onAccessDenied(response.status)
        throw new ReadApiError(
          response.status === 401 ? 'unauthorized' : 'forbidden',
          response.status === 401
            ? 'Your Horizon session has expired.'
            : 'You do not have access to this information.',
          response.status,
        )
      }
      if (!response.ok)
        throw new ReadApiError('http', 'Horizon could not complete this request.', response.status)
      if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
        throw new ReadApiError('invalid-response', 'Horizon returned an unexpected response.')
      }
      try {
        return operation.parse(await response.json())
      } catch {
        throw new ReadApiError('invalid-response', 'Horizon returned an unexpected response.')
      }
    },
  }
}
