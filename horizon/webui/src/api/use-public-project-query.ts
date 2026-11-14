import { useQuery } from '@tanstack/react-query'
import { createReadTransport, type ReadOperation } from './transport'

/** The public Track 5 publication paths never carry a session or its credentials. */
export function usePublicProjectQuery<T>(operation: ReadOperation<T>, enabled = true) {
  return useQuery({
    queryKey: ['public-projects', operation.path],
    enabled,
    queryFn: ({ signal }) =>
      createReadTransport({
        origin: window.location.origin,
        credentials: 'omit',
        allowPath: (url) =>
          /^\/api\/v1\/projects(?:\/[^/]+(?:\/(?:sow-timeline|history))?)?$/.test(url.pathname),
        onAccessDenied: () => {},
      }).get(operation, signal),
  })
}
