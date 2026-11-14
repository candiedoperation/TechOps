import { queryOptions, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMockSource } from './data-source'
import type { HorizonReadClient } from './client'
import { createReadTransport, type ReadOperation } from './transport'

let publicTransport: ReturnType<typeof createReadTransport> | undefined

function options<T>(operation: ReadOperation<T>, mock: HorizonReadClient | null) {
  return queryOptions({
    queryKey: ['public-projects', mock?.scope ?? 'api', operation.path],
    meta: { publicationPath: operation.path },
    // Pending overrides remain live, including on historical runs.
    staleTime: operation.path.includes('/sow-timeline?') ? 5_000 : undefined,
    queryFn: ({ signal }) => {
      if (mock) return mock.get(operation, signal)
      publicTransport ??= createReadTransport({
        origin: import.meta.env.VITE_HORIZON_API_BASE_URL || window.location.origin,
        credentials: 'omit',
        allowPath: (url) =>
          /^\/api\/v1\/projects(?:\/[^/]+(?:\/(?:sow-timeline|history))?)?$/.test(url.pathname),
        onAccessDenied: () => {},
        revalidate: true,
      })
      return publicTransport.get(operation, signal)
    },
  })
}

export function usePublicProjectQuery<T>(operation: ReadOperation<T>, enabled = true) {
  return useQuery({ ...options(operation, useMockSource()), enabled })
}

export function useProjectPrefetch() {
  const queries = useQueryClient()
  const mock = useMockSource()
  return <T>(operation: ReadOperation<T>) => queries.prefetchQuery(options(operation, mock))
}
