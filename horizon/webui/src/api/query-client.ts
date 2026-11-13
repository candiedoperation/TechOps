import { QueryClient } from '@tanstack/react-query'
import { ReadApiError } from './client'

export function createHorizonQueryClient() {
  return new QueryClient({
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
}
