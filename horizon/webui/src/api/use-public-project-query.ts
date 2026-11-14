import { useQuery } from '@tanstack/react-query'
import { useMockSource } from './data-source'
import { createReadTransport, type ReadOperation } from './transport'

/** The public Track 5 publication paths never carry a session or its credentials. */
export function usePublicProjectQuery<T>(operation: ReadOperation<T>, enabled = true) {
  const mock = useMockSource()
  return useQuery({
    queryKey: ['public-projects', mock?.scope ?? 'api', operation.path],
    enabled,
    queryFn: ({ signal }) =>
      mock
        ? mock.get(operation, signal)
        : createReadTransport({
            origin: import.meta.env.VITE_HORIZON_API_BASE_URL || window.location.origin,
            credentials: 'omit',
            allowPath: (url) =>
              /^\/api\/v1\/projects(?:\/[^/]+(?:\/(?:sow-timeline|history))?)?$/.test(url.pathname),
            onAccessDenied: () => {},
          }).get(operation, signal),
  })
}
