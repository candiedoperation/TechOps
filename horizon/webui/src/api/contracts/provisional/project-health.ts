import type {
  ProvisionalComponentScore,
  ProvisionalCoverage,
  ProvisionalEvidenceReference,
  ProvisionalFilter,
  ProvisionalPage,
  ProvisionalPeriod,
  ProvisionalReadOptions,
  ProvisionalResult,
} from './common'

/** Provisional T6.3 types. Health labels and dimensions must come from the approved rubric. */
export interface ProvisionalProjectHealthSummary {
  projectId: string
  name: string
  healthLabel: string | null
  coverage: ProvisionalCoverage
}
export interface ProvisionalProjectHealthDetail {
  projectId: string
  name: string
  periodId: string
  components: readonly ProvisionalComponentScore[]
  evidence: readonly ProvisionalEvidenceReference[]
  coverage: ProvisionalCoverage
}
export interface ProvisionalProjectHealthTrend {
  periodId: string
  components: readonly ProvisionalComponentScore[]
}
export interface ProvisionalProjectHealthPeriods {
  periods: readonly ProvisionalPeriod[]
  availableFilters: readonly ProvisionalFilter[]
}
export type ProvisionalProjectHealthList = ProvisionalPage<ProvisionalProjectHealthSummary>
export type ProvisionalProjectHealthResult = ProvisionalResult<ProvisionalProjectHealthDetail>
export type ProvisionalProjectHealthHistory = ProvisionalPage<ProvisionalProjectHealthTrend>
export type ProvisionalProjectHealthOptions = ProvisionalReadOptions
