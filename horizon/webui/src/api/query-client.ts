import { QueryCache, QueryClient } from '@tanstack/react-query'
import { ReadApiError } from './client'

export function createHorizonQueryClient() {
  const current = new Map<string, { runId: string; asOf?: string }>()
  const cache = new QueryCache({
    onSuccess(data, query) {
      const path = query.meta?.publicationPath
      if (typeof path !== 'string' || data === null || typeof data !== 'object') return
      const url = new URL(path, window.location.origin)
      const requestedRun = url.searchParams.get('run') ?? 'current'
      const season = url.searchParams.get('season')
      if (!season || !['current', 'latest'].includes(requestedRun)) return
      if (!/^\/api\/v1\/(rankings|projects)(?:\/|$)/.test(url.pathname)) return
      const publication = (data as { meta?: { runId?: string; asOf?: string } }).meta
      if (!publication?.runId) return
      const { runId, asOf } = publication
      const domain = url.pathname.split('/')[3]
      const key = JSON.stringify([domain, season, query.queryKey[1]])
      const previous = current.get(key)
      if (previous?.asOf && asOf && Date.parse(asOf) < Date.parse(previous.asOf)) return
      if (current.size >= 64 && !current.has(key)) current.delete(current.keys().next().value!)
      current.set(key, { runId, asOf })
      if (previous && previous.runId !== runId) {
        const otherQueries = (entry: { queryHash: string; queryKey: readonly unknown[] }) =>
          entry.queryHash !== query.queryHash &&
          ['horizon', 'public-projects'].includes(String(entry.queryKey[0]))
        client.removeQueries({ type: 'inactive', predicate: otherQueries })
        void client.invalidateQueries({ predicate: otherQueries }, { cancelRefetch: false })
      }
    },
  })
  const client = new QueryClient({
    queryCache: cache,
    defaultOptions: {
      queries: {
        staleTime: 60_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: true,
        retry: (failureCount, error) => {
          if (error instanceof ReadApiError && !['network', 'http'].includes(error.kind))
            return false
          if (error instanceof ReadApiError && error.status && error.status < 500) return false
          return failureCount < 2
        },
      },
    },
  })
  cache.subscribe((event) => {
    if (event.type !== 'added' || cache.getAll().length <= 128) return
    const inactive = cache
      .getAll()
      .filter(
        (query) =>
          query !== event.query && !query.getObserversCount() && query.state.fetchStatus === 'idle',
      )
    inactive.sort((a, b) => a.state.dataUpdatedAt - b.state.dataUpdatedAt)
    for (const query of inactive.slice(0, cache.getAll().length - 128)) cache.remove(query)
  })
  return client
}
