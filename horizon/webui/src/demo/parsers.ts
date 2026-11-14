import type {
  ProvisionalComponentScore,
  ProvisionalCoverage,
  ProvisionalEvidenceReference,
  ProvisionalPage,
  ProvisionalPublicationMetadata,
  ProvisionalResult,
} from '../api/contracts/provisional/common'
import type {
  ProvisionalMemberProfile,
  ProvisionalRankingHistoryEntry,
  ProvisionalRankingPeriods,
  ProvisionalRankingSummary,
} from '../api/contracts/provisional/rankings'
import type {
  ProvisionalProjectHealthDetail,
  ProvisionalProjectHealthPeriods,
  ProvisionalProjectHealthSummary,
  ProvisionalProjectHealthTrend,
} from '../api/contracts/provisional/project-health'
import type { PortfolioProject, PortfolioSnapshot } from '../api/contracts/provisional/portfolio'

/** Runtime validators for the fictional wire contract, not assertions of backend approval. */
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected object')
  return value as Record<string, unknown>
}

export function parsePortfolio(value: unknown): PortfolioSnapshot {
  const row = object(value)
  return {
    snapshotId: string(row.snapshotId),
    snapshots: array(row.snapshots, (value) => {
      const period = object(value)
      return { id: string(period.id), label: string(period.label) }
    }),
    publication: metadata(row.publication),
    changes: array(row.changes, string),
    projects: array(row.projects, (value): PortfolioProject => {
      const project = object(value)
      const status = project.status
      if (
        status !== 'clear' &&
        status !== 'watch' &&
        status !== 'risk' &&
        status !== 'insufficient'
      )
        throw new Error('Invalid portfolio status')
      return {
        id: string(project.id),
        companyId: string(project.companyId),
        company: string(project.company),
        name: string(project.name),
        semester: string(project.semester),
        status,
        summary: string(project.summary),
        concerns: array(project.concerns, string),
        activityDays: numberOrNull(project.activityDays),
        openPrs: numberOrNull(project.openPrs),
        reviewLatencyDays: numberOrNull(project.reviewLatencyDays),
        oldestPrDays: numberOrNull(project.oldestPrDays),
        branchesAhead: numberOrNull(project.branchesAhead),
        openIssues: numberOrNull(project.openIssues),
      }
    }),
  }
}
function string(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Expected string')
  return value
}
function numberOrNull(value: unknown): number | null {
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new Error('Expected finite number')
  return value
}
function nullableString(value: unknown) {
  return value === null ? null : string(value)
}
function array<T>(value: unknown, parse: (item: unknown) => T): T[] {
  if (!Array.isArray(value)) throw new Error('Expected array')
  return value.map(parse)
}
function coverage(value: unknown): ProvisionalCoverage {
  const row = object(value)
  const state = row.state
  if (state !== 'complete' && state !== 'partial' && state !== 'missing')
    throw new Error('Invalid coverage')
  return {
    state,
    available: numberOrNull(row.available),
    expected: numberOrNull(row.expected),
    gaps: array(row.gaps, string),
  }
}
function metadata(value: unknown): ProvisionalPublicationMetadata {
  const row = object(value)
  const state = row.state
  if (!['current', 'stale', 'provisional', 'missing'].includes(String(state)))
    throw new Error('Invalid publication state')
  return {
    state: state as ProvisionalPublicationMetadata['state'],
    publishedAt: nullableString(row.publishedAt),
    sourceAsOf: nullableString(row.sourceAsOf),
    publicationId: nullableString(row.publicationId),
    runId: nullableString(row.runId),
  }
}
function evidence(value: unknown): ProvisionalEvidenceReference {
  const row = object(value)
  if (row.href !== null) throw new Error('Fictional evidence must not link to external sources')
  return {
    id: string(row.id),
    label: string(row.label),
    sourceType: string(row.sourceType),
    href: null,
  }
}
function component(value: unknown): ProvisionalComponentScore {
  const row = object(value)
  return {
    key: string(row.key),
    label: string(row.label),
    value: numberOrNull(row.value),
    unit: nullableString(row.unit),
    coverage: coverage(row.coverage),
    evidence: array(row.evidence, evidence),
  }
}
export function parsePage<T>(parseItem: (value: unknown) => T) {
  return (value: unknown): ProvisionalPage<T> => {
    const row = object(value)
    return {
      items: array(row.items, parseItem),
      page: { nextCursor: nullableString(object(row.page).nextCursor) },
      publication: metadata(row.publication),
      capabilities: array(row.capabilities, string),
    }
  }
}
export function parseResult<T>(parseItem: (value: unknown) => T) {
  return (value: unknown): ProvisionalResult<T> => {
    const row = object(value)
    return {
      data: row.data === null ? null : parseItem(row.data),
      publication: metadata(row.publication),
      capabilities: array(row.capabilities, string),
    }
  }
}
export function parseRanking(value: unknown): ProvisionalRankingSummary {
  const row = object(value)
  return {
    memberId: string(row.memberId),
    displayName: string(row.displayName),
    position: numberOrNull(row.position),
    overallScore: numberOrNull(row.overallScore),
    scoreUnit: nullableString(row.scoreUnit),
    coverage: coverage(row.coverage),
  }
}
export function parseProject(value: unknown): ProvisionalProjectHealthSummary {
  const row = object(value)
  return {
    projectId: string(row.projectId),
    name: string(row.name),
    healthLabel: nullableString(row.healthLabel),
    coverage: coverage(row.coverage),
  }
}
export function parseMemberDetail(value: unknown): ProvisionalMemberProfile {
  const row = object(value)
  return {
    memberId: string(row.memberId),
    displayName: string(row.displayName),
    periodId: string(row.periodId),
    components: array(row.components, component),
    coverage: coverage(row.coverage),
  }
}
export function parseProjectDetail(value: unknown): ProvisionalProjectHealthDetail {
  const row = object(value)
  return {
    projectId: string(row.projectId),
    name: string(row.name),
    periodId: string(row.periodId),
    components: array(row.components, component),
    evidence: array(row.evidence, evidence),
    coverage: coverage(row.coverage),
  }
}
export function parseRankingHistory(value: unknown): ProvisionalRankingHistoryEntry {
  const row = object(value)
  return {
    periodId: string(row.periodId),
    overallScore: numberOrNull(row.overallScore),
    scoreUnit: nullableString(row.scoreUnit),
    coverage: coverage(row.coverage),
  }
}
export function parseHealthHistory(value: unknown): ProvisionalProjectHealthTrend {
  const row = object(value)
  return { periodId: string(row.periodId), components: array(row.components, component) }
}
export function parsePeriods(
  value: unknown,
): ProvisionalRankingPeriods & ProvisionalProjectHealthPeriods {
  const row = object(value)
  return {
    periods: array(row.periods, (item) => {
      const entry = object(item)
      return { id: string(entry.id), label: string(entry.label) }
    }),
    availableFilters: array(row.availableFilters, (item) => {
      const entry = object(item)
      return {
        key: string(entry.key),
        label: string(entry.label),
        options: array(entry.options, (option) => {
          const pair = object(option)
          return { value: string(pair.value), label: string(pair.label) }
        }),
      }
    }),
  }
}
