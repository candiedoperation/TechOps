import type { HorizonReadClient } from '../api/client'
import { createReadTransport, ReadApiError, type ReadOperation } from '../api/transport'
import { demoAllowed, isDemoPath } from './policy'
import type { DemoScenario } from './scenarios'

export function createDemoReadClient({
  origin,
  ready,
  scenario,
  fetcher,
  buildAllowsDemo = __HORIZON_DEMO_BUILD_ALLOWED__,
  development = import.meta.env.DEV,
  setting = import.meta.env.VITE_HORIZON_DEMO,
}: {
  origin: string
  ready: () => boolean
  scenario: DemoScenario
  fetcher?: typeof fetch
  buildAllowsDemo?: boolean
  development?: boolean
  setting?: unknown
}): HorizonReadClient {
  const enabled = () =>
    demoAllowed(buildAllowsDemo, development, setting, new URL(origin).hostname) && ready()
  const transport = createReadTransport({
    origin,
    credentials: 'omit',
    allowPath: isDemoPath,
    requireDemoResponse: true,
    onAccessDenied: () => {},
    fetcher,
  })
  return {
    accessMode: 'demo',
    scope: `fictional-demo-v1:${scenario}`,
    isAvailable: enabled,
    get<T>(operation: ReadOperation<T>, signal?: AbortSignal) {
      if (!enabled())
        return Promise.reject(
          new ReadApiError('unavailable', 'The local demo environment is not enabled.'),
        )
      return transport.get(operation, signal)
    },
  }
}
