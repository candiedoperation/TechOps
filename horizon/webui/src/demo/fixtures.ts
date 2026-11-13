import type {
  ProvisionalComponentScore,
  ProvisionalCoverage,
  ProvisionalPublicationMetadata,
} from '../api/contracts/provisional/common'
import type { PortfolioSnapshot, PortfolioStatus } from '../api/contracts/provisional/portfolio'

/** Entirely fictional, deterministic, authored here. Not exported from a real service. */
export const rankingPeriods = [
  { id: 'fiction-fall-2026', label: 'Fall 2026' },
  { id: 'fiction-spring-2026', label: 'Spring 2026' },
  { id: 'fiction-fall-2025', label: 'Fall 2025' },
]
export const healthPeriods = [
  { id: 'fiction-2026-10-26', label: 'Week of October 26, 2026' },
  { id: 'fiction-2026-10-19', label: 'Week of October 19, 2026' },
  { id: 'fiction-2026-10-12', label: 'Week of October 12, 2026' },
  { id: 'fiction-2026-10-05', label: 'Week of October 5, 2026' },
]
export const fictionalMembers = [
  'Mira Solen',
  'Theo Marlow',
  'Iris Fenwick',
  'Rowan Vale',
  'Ada Bellweather',
  'Nico Starling',
  'Lena Wren',
  'Emil Moss',
].map((displayName, index) => ({ memberId: `fiction-member-${index + 1}`, displayName }))
export const fictionalProjects = [
  'Lantern Atlas',
  'Tidepool Notes',
  'Copper Kite',
  'Meadow Relay',
  'Juniper Beacon',
].map((name, index) => ({ projectId: `fiction-project-${index + 1}`, name }))

export function coverage(index: number): ProvisionalCoverage {
  return index % 5 === 4
    ? {
        state: 'missing',
        available: 0,
        expected: 5,
        gaps: ['No fictional evidence for this example'],
      }
    : index % 3 === 2
      ? {
          state: 'partial',
          available: 3,
          expected: 5,
          gaps: ['Two fictional reporting inputs are absent'],
        }
      : { state: 'complete', available: 5, expected: 5, gaps: [] }
}
export function publication(
  state: ProvisionalPublicationMetadata['state'] = 'current',
): ProvisionalPublicationMetadata {
  return {
    state,
    publishedAt: state === 'missing' ? null : '2026-10-26T12:00:00Z',
    sourceAsOf: state === 'missing' ? null : '2026-10-25T18:00:00Z',
    publicationId: state === 'missing' ? null : 'fictional-publication-001',
    runId: state === 'missing' ? null : 'fictional-run-001',
  }
}
export function components(
  index: number,
  period: number,
  project = false,
): ProvisionalComponentScore[] {
  return (
    project
      ? ['Delivery progress', 'Review flow', 'Ownership balance']
      : ['Engineering contribution', 'Delivery', 'Collaboration']
  ).map((label, dimension) => ({
    key: `fiction-dimension-${dimension}`,
    label,
    value:
      coverage(index + dimension).state === 'missing'
        ? null
        : Math.max(0, 92 - index * 5 - period * 3 - dimension * 4),
    unit: 'illustrative points / 100',
    coverage: coverage(index + dimension),
    evidence:
      coverage(index + dimension).state === 'missing'
        ? []
        : [
            {
              id: `fiction-evidence-${index}-${period}-${dimension}`,
              label: `Fictional ${project ? 'SOW checkpoint' : 'PR review'} ${index + 1}.${dimension + 1} — illustrative evidence only`,
              sourceType: 'fictional fixture',
              href: null,
            },
          ],
  }))
}
export function rankings(periodId: string) {
  const period = Math.max(
    0,
    rankingPeriods.findIndex((item) => item.id === periodId),
  )
  return fictionalMembers.map((member, index) => ({
    ...member,
    position: index + 1,
    overallScore: coverage(index).state === 'missing' ? null : 92 - index * 5 - period * 3,
    scoreUnit: 'illustrative points / 100',
    coverage: coverage(index),
  }))
}
export function projects(periodId: string) {
  const period = Math.max(
    0,
    healthPeriods.findIndex((item) => item.id === periodId),
  )
  return fictionalProjects.map((project, index) => ({
    ...project,
    healthLabel:
      coverage(index).state === 'missing'
        ? 'Insufficient evidence'
        : (index + period) % 3 === 1
          ? 'Needs attention'
          : 'On track',
    coverage: coverage(index),
  }))
}

export function portfolioSnapshot(snapshotId: string): PortfolioSnapshot {
  const period = Math.max(
    0,
    healthPeriods.findIndex((item) => item.id === snapshotId),
  )
  return {
    snapshotId,
    snapshots: healthPeriods,
    publication: publication(),
    changes: [
      'Fictional checkpoint: Lantern Atlas has additional review evidence.',
      'Fictional checkpoint: a project has limited coverage; no completion is inferred.',
    ],
    projects: fictionalProjects.map((project, index) => {
      const companyIndex = Math.floor(index / 2)
      const status: PortfolioStatus =
        index === 4
          ? 'insufficient'
          : (['clear', 'watch', 'risk', 'clear'] as const)[(index + period) % 4]!
      return {
        id: project.projectId,
        companyId: `fiction-company-${companyIndex}`,
        company: ['Fable Works', 'Northstar Collective', 'Meadow Lab'][companyIndex]!,
        name: project.name,
        semester: 'Fall 2026',
        status,
        summary: `Fictional ${project.name} reporting checkpoint. Source completeness is shown separately from delivery.`,
        concerns:
          status === 'watch' || status === 'risk'
            ? [
                'Fictional evidence gap: review activity needs inspection. This is not a verified project failure.',
              ]
            : [],
        activityDays: index === 4 ? null : Math.max(1, 5 - index - period),
        openPrs: index === 4 ? null : index + period + 1,
        reviewLatencyDays: index === 4 ? null : 1.5 + index + period / 2,
        oldestPrDays: index === 4 ? null : 3 + index,
        branchesAhead: null,
        openIssues: null,
      }
    }),
  }
}
