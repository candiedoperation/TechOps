/** HTTP models implemented by horizon/server, still pending Track 4/7 storage/policy approval.
 * Not compatible with the older cursor-based demo registry. No live builder is registered.
 * Source of truth: horizon/server/openapi.json. Keep auth/release gates closed.
 */
import { isRunStale, type PublicationFreshness } from '../../publication'

export interface DraftT62Me {
  userPk: string
  name: string
  isExec: boolean
  projects: { projectPk: string; friendlyName: string }[]
}
export interface DraftT62Semester {
  seasonType: 'FALL' | 'SPRING'
  seasonYear: number
}
export interface DraftT62Run {
  rankingRunId: string
  asOf: string
  isFinal: boolean
  rubricVersion: string
  stale: boolean
}
export interface DraftT62Ranking {
  userPk: string
  name: string
  projectPk: string
  projectName: string
  role: 'engineer' | 'tech_lead'
  comparisonGroup: string
  overallScore: number | null
  coverage: number
  status: 'ranked' | 'unranked' | 'insufficient_data'
  rankInGroup: number | null
  rankedInGroup: number
  buckets: { bucketKey: string; weight: number; score: number | null }[]
}
export interface DraftT62RankingPage extends DraftT62Run {
  items: DraftT62Ranking[]
  page: number
  pageSize: number
  total: number
}
export interface DraftT62MemberDetail extends DraftT62Run {
  userPk: string
  items: {
    ranking: DraftT62Ranking
    metrics: {
      metricKey: string
      rawValue: number | null
      percentile: number | null
      missingReason: string | null
    }[]
    evidence: { evidenceId: string; sourceType: string; reference: string }[]
    explanations: { text: string; modelVersion: string; sourceType: 'claude_generated' }[]
  }[]
  history: {
    rankingRunId: string
    asOf: string
    projectPk: string
    role: 'engineer' | 'tech_lead'
    overallScore: number | null
    rankInGroup: number | null
  }[]
}
/** Called only after runtime response validation. It does not enable a live request. */
export function rankingPublication(run: DraftT62Run, now = Date.now()): PublicationFreshness {
  return {
    state: run.stale || isRunStale(run.asOf, now) === true ? 'stale' : 'current',
    publishedAt: run.asOf,
  }
}
