import type { ProvisionalPublicationMetadata } from './common'

/** Presentation draft for T6.6, NOT an approved live API or persisted data model. */
export type PortfolioStatus = 'clear' | 'watch' | 'risk' | 'insufficient'
export interface PortfolioProject {
  id: string
  companyId: string
  company: string
  name: string
  semester: string
  status: PortfolioStatus
  summary: string
  concerns: string[]
  activityDays: number | null
  openPrs: number | null
  reviewLatencyDays: number | null
  oldestPrDays: number | null
  branchesAhead: number | null
  openIssues: number | null
}
export interface PortfolioSnapshot {
  snapshotId: string
  snapshots: { id: string; label: string }[]
  projects: PortfolioProject[]
  changes: string[]
  publication: ProvisionalPublicationMetadata
}
