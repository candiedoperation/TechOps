import type {
  ProvisionalComponentScore,
  ProvisionalCoverage,
  ProvisionalFilter,
  ProvisionalPage,
  ProvisionalPeriod,
  ProvisionalReadOptions,
  ProvisionalResult,
} from './common'

/** Provisional T6.2 types; not a production API contract. */
export interface ProvisionalRankingSummary {
  memberId: string
  displayName: string
  position: number | null
  overallScore: number | null
  scoreUnit: string | null
  coverage: ProvisionalCoverage
}
export interface ProvisionalMemberProfile {
  memberId: string
  displayName: string
  periodId: string
  components: readonly ProvisionalComponentScore[]
  coverage: ProvisionalCoverage
}
export interface ProvisionalRankingHistoryEntry {
  periodId: string
  overallScore: number | null
  scoreUnit: string | null
  coverage: ProvisionalCoverage
}
export interface ProvisionalRankingPeriods {
  periods: readonly ProvisionalPeriod[]
  availableFilters: readonly ProvisionalFilter[]
}
export type ProvisionalRankingList = ProvisionalPage<ProvisionalRankingSummary>
export type ProvisionalMemberDetail = ProvisionalResult<ProvisionalMemberProfile>
export type ProvisionalRankingHistory = ProvisionalPage<ProvisionalRankingHistoryEntry>
export type ProvisionalRankingListOptions = ProvisionalReadOptions
