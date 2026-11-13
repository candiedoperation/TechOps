import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { useAuth } from '../auth/context'
import { ReadApiError, type ReadOperation } from './client'
import { useHorizonReadClient } from './context'

export const horizonQueryKeys = {
  all: ['horizon'] as const,
  read: (subject: string | null, feature: string, parameters: Readonly<Record<string, string>>) =>
    ['horizon', subject, feature, parameters] as const,
}

/** No default URL or fabricated domain response types. Register an agreed read contract first. */
export function useHorizonReadQuery<T>({
  feature,
  parameters = {},
  operation,
  available = true,
}: {
  feature: string
  parameters?: Readonly<Record<string, string>>
  operation?: ReadOperation<T>
  available?: boolean
}) {
  const { state } = useAuth()
  const client = useHorizonReadClient()
  const subject =
    client.accessMode === 'demo'
      ? client.scope
      : state.status === 'authenticated'
        ? state.session.subject
        : null
  const permitted =
    available &&
    Boolean(operation) &&
    client.isAvailable() &&
    (state.status === 'authenticated' ||
      (import.meta.env.DEV && __HORIZON_DEMO_BUILD_ALLOWED__ && client.accessMode === 'demo'))
  const result = useQuery({
    queryKey: horizonQueryKeys.read(subject, feature, parameters),
    queryFn: ({ signal }) => {
      if (!permitted || !operation)
        throw new ReadApiError(
          'unavailable',
          'No approved and authorized Horizon read is available.',
        )
      return client.get(operation, signal)
    },
    enabled: permitted,
  })
  // A disabled query can still have cached results. Do not return those across auth boundaries.
  const accessDenied =
    result.error instanceof ReadApiError &&
    ['unauthorized', 'forbidden'].includes(result.error.kind)
  return {
    ...result,
    data: permitted && !accessDenied ? result.data : undefined,
    available: permitted,
  }
}

/** Cursor pagination stays opt-in; the API, not the UI, supplies the next cursor. */
export function useHorizonInfiniteReadQuery<T>({
  feature,
  parameters = {},
  operationForCursor,
  getNextCursor,
  available = true,
}: {
  feature: string
  parameters?: Readonly<Record<string, string>>
  operationForCursor?: (cursor: string | null) => ReadOperation<T>
  getNextCursor: (page: T) => string | null
  available?: boolean
}) {
  const { state } = useAuth()
  const client = useHorizonReadClient()
  const subject =
    client.accessMode === 'demo'
      ? client.scope
      : state.status === 'authenticated'
        ? state.session.subject
        : null
  const permitted =
    available &&
    Boolean(operationForCursor) &&
    client.isAvailable() &&
    (state.status === 'authenticated' ||
      (import.meta.env.DEV && __HORIZON_DEMO_BUILD_ALLOWED__ && client.accessMode === 'demo'))
  const result = useInfiniteQuery({
    queryKey: [...horizonQueryKeys.read(subject, feature, parameters), 'infinite'],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => {
      if (!permitted || !operationForCursor)
        throw new ReadApiError(
          'unavailable',
          'No approved and authorized Horizon read is available.',
        )
      return client.get(operationForCursor(pageParam), signal)
    },
    getNextPageParam: (lastPage) => getNextCursor(lastPage) ?? undefined,
    enabled: permitted,
  })
  const accessDenied =
    result.error instanceof ReadApiError &&
    ['unauthorized', 'forbidden'].includes(result.error.kind)
  return {
    ...result,
    data: permitted && !accessDenied ? result.data : undefined,
    available: permitted,
  }
}
