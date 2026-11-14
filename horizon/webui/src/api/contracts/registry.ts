import type { ReadOperation } from '../client'
import type {
  ProvisionalRankingHistory,
  ProvisionalRankingList,
  ProvisionalRankingListOptions,
  ProvisionalRankingPeriods,
  ProvisionalMemberDetail,
} from './provisional/rankings'
import type {
  ProvisionalProjectHealthHistory,
  ProvisionalProjectHealthList,
  ProvisionalProjectHealthOptions,
  ProvisionalProjectHealthPeriods,
  ProvisionalProjectHealthResult,
} from './provisional/project-health'

/** Builders must provide confirmed paths and runtime parsers. Types below remain draft
 * until reconciled with backend OpenAPI and moved out of provisional/. No URLs default here.
 */
export interface HorizonReadContractRegistry {
  reviewStatus: 'pending' | 'approved' | 'demo'
  rankingPeriods?: () => ReadOperation<ProvisionalRankingPeriods>
  rankings?: (options: ProvisionalRankingListOptions) => ReadOperation<ProvisionalRankingList>
  member?: (memberId: string, periodId: string) => ReadOperation<ProvisionalMemberDetail>
  rankingHistory?: (
    memberId: string,
    cursor: string | null,
  ) => ReadOperation<ProvisionalRankingHistory>
  healthPeriods?: () => ReadOperation<ProvisionalProjectHealthPeriods>
  projectHealth?: (
    options: ProvisionalProjectHealthOptions,
  ) => ReadOperation<ProvisionalProjectHealthList>
  project?: (projectId: string, periodId: string) => ReadOperation<ProvisionalProjectHealthResult>
  healthHistory?: (
    projectId: string,
    cursor: string | null,
  ) => ReadOperation<ProvisionalProjectHealthHistory>
}

/** No approved contracts exist in this checkout. No production path or parser is registered. */
export const horizonReadContracts: HorizonReadContractRegistry = Object.freeze({
  reviewStatus: 'pending',
})

/** Fictional contracts are never approved production contracts. */
export function canUseReadContracts(registry: HorizonReadContractRegistry) {
  return (
    registry.reviewStatus === 'approved' ||
    (import.meta.env.DEV && __HORIZON_DEMO_BUILD_ALLOWED__ && registry.reviewStatus === 'demo')
  )
}
