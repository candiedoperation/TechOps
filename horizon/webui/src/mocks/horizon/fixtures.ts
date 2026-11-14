import { ReadApiError, type HorizonReadClient } from '../../api/client'
import type { ProjectMeta, ProjectSummary, SowTask } from '../../api/contracts/projects'
import type { RankingRow, RankingRun } from '../../api/contracts/rankings'
import type { MemberDocument } from '../../api/contracts/member'

import type { PortfolioProject, PortfolioSnapshot } from '../../api/contracts/provisional/portfolio'

const latencyMs = 280
const hour = 60 * 60 * 1000
const clock = new Date()
const year = clock.getUTCFullYear()
const currentSeason = `${clock.getUTCMonth() < 6 ? 'SPRING' : 'FALL'}-${year}`
const otherSeason = `${currentSeason.startsWith('FALL') ? 'SPRING' : 'FALL'}-${year}`

function fixtureFor(season: string) {
  const current = season === currentSeason
  const date = (days: number) =>
    new Date(clock.getTime() + (days - (current ? 0 : 210)) * 24 * hour).toISOString().slice(0, 10)
  const runs = Array.from({ length: 6 }, (_, index): RankingRun => ({
    runId: `8734931c-8aab-47be-9918-4e7dea80${current ? '0' : '1'}00${index}`,
    asOf: `${date(-7 * index - 1)}T12:00:00Z`,
    isFinal: index === (current ? 2 : 0),
    rubricVersion: 'v1',
    stale: !current || index > 1,
  }))
  const wireRun = (run: RankingRun) => ({ ...run, rankingRunId: run.runId })
  const projects = [
    { projectPk: 'beacon', friendlyName: 'Project Beacon', hasSow: true },
    { projectPk: 'atlas', friendlyName: 'Project Atlas', hasSow: false },
    { projectPk: 'meridian', friendlyName: 'Project Meridian', hasSow: true },
    { projectPk: 'orchard', friendlyName: 'Project Orchard', hasSow: false },
    { projectPk: 'signal', friendlyName: 'Project Signal', hasSow: false },
    { projectPk: 'trellis', friendlyName: 'Project Trellis', hasSow: false },
  ]
  const ranks = [
    [0, 'member-a', 'Avery Example', 'engineer', 'ranked', 1, 92, 0.94],
    [0, 'member-b', 'Morgan Example', 'engineer', 'ranked', 2, 82, 0.87],
    [0, 'member-c', 'Jordan Example', 'engineer', 'group_too_small', null, null, 0.7],
    [1, 'member-a', 'Avery Example', 'engineer', 'insufficient_data', null, null, 0.3],
    [1, 'member-d', 'Casey Example', 'engineer', 'ranked', 1, 78, 0.78],
    [2, 'member-e', 'Riley Example', 'engineer', 'ranked', 1, 87, 0.9],
    [2, 'member-f', 'Quinn Example', 'engineer', 'ranked', 2, 75, 0.79],
    [0, 'lead-a', 'Cameron Example', 'tech_lead', 'ranked', 1, 90, 0.95],
    [2, 'lead-b', 'Skyler Example', 'tech_lead', 'ranked', 2, 84, 0.86],
  ] as const
  function rows(run: RankingRun): RankingRow[] {
    return ranks.map(([index, userPk, name, role, status, rankInGroup, score, coverage]) => {
      const project = projects[index]!
      const engineer = role === 'engineer'
      const overallScore = score === null ? null : score - runs.indexOf(run) * 2
      return {
        userPk,
        name,
        projectPk: project.projectPk,
        projectName: project.friendlyName,
        role,
        comparisonGroup: engineer ? project.projectPk : 'club',
        comparisonGroupLabel: engineer ? project.friendlyName : 'App Dev',
        overallScore,
        coverage,
        status,
        rankInGroup,
        rankedInGroup: 2,
        buckets: (engineer
          ? [
              'code_ownership',
              'delivery',
              'consistency',
              'review_collaboration',
              'peer_ratings',
              'club_engagement',
            ]
          : [
              'team_delivery',
              'review_unblocking',
              'leadership_ratings',
              'team_consistency',
              'own_code',
              'club_engagement',
            ]
        ).map((key, index) => ({
          key,
          label: null,
          weight: [0.3, 0.2, 0.15, 0.15, 0.1, 0.1][index]!,
          score: overallScore === null ? null : overallScore - index,
        })),
      }
    })
  }
  function summary(project: (typeof projects)[number], run: RankingRun): ProjectSummary {
    const done = project.hasSow ? Math.max(0, 5 - runs.indexOf(run)) : 0
    return {
      ...project,
      windowStart: date(-85),
      windowEnd: date(27),
      tasksTotal: project.hasSow ? 12 : 0,
      tasksDue: project.hasSow ? 7 : 0,
      tasksDone: done,
      tasksPartial: project.hasSow ? 2 : 0,
      tasksOverdue: project.hasSow ? 2 : 0,
      percentComplete: Math.round((done / 12) * 100),
      riskCounts: project.hasSow ? { review_delay: 1, overdue: 2 } : {},
    }
  }
  const pr = {
    number: 16,
    url: 'https://git.example.com/demo/beacon/pulls/16',
    confidence: 0.91,
    reason: 'Includes the published release guide.',
  }
  const taskSpecs = [
    ['Kickoff and acceptance criteria', -32, 'done'],
    ['Publish the release guide', -27, 'done'],
    ['Configure preview builds', -22, 'done'],
    ['Verify account settings', -16, 'done'],
    ['Complete navigation QA', -12, 'done'],
    ['Review keyboard interactions', -8, 'overdue'],
    ['Finish stakeholder handoff', -3, 'overdue'],
    ['Test mobile sign-in', 2, 'in_progress'],
    ['Document the support workflow', 6, 'in_progress'],
    ['Confirm launch checklist', 12, 'not_started'],
    ['Collect pilot feedback', 20, 'not_started'],
    ['Archive pilot notes', null, 'not_started'],
  ] as const satisfies ReadonlyArray<readonly [string, number | null, SowTask['timelineStatus']]>
  const timelineTasks = taskSpecs.map(([title, due, timelineStatus], index) => ({
    taskKey: `SOW-${index + 1}`,
    title,
    dueDate: due === null ? null : date(due),
    timelineStatus,
    owners: index === 11 ? [] : [{ name: index % 2 ? 'Avery Example' : 'Morgan Example' }],
    description: title + ' and record the result in the project notes.',
    acceptanceCriteria: ['The project lead reviews the published result.'],
    sourceRef: `Section ${index + 1}`,
    matchedPrs: index === 1 ? [pr] : [],
    override:
      index === 1
        ? { status: 'done', reason: 'Verified by the project lead.', setAt: date(-22) }
        : null,
    pendingOverride:
      index === 6
        ? { status: 'in_progress', reason: 'Handoff review has started.', setAt: date(0) }
        : null,
  }))
  function member(row: RankingRow): MemberDocument {
    const scored = row.status === 'ranked'
    return {
      member: row,
      overall: {
        score: row.overallScore,
        rank: row.rankInGroup,
        rankedInGroup: row.rankedInGroup,
        comparisonGroupLabel: row.comparisonGroupLabel!,
        coverage: row.coverage,
        status: row.status,
      },
      explanation: {
        generated: scored,
        text: scored
          ? 'The published evidence shows steady delivery and consistent code ownership.'
          : 'The available evidence covers part of the rubric.',
        dataGaps: ['no_review_requests'],
      },
      buckets: [
        {
          label: 'Delivery against the SOW',
          weight: 0.2,
          score: scored ? 86 : null,
          note: 'Based on verified task matches.',
          metrics: [
            {
              label: 'On-time completion',
              rawValue: scored ? 0.75 : null,
              unit: 'ratio',
              percentile: scored ? 84 : null,
              missingReason: scored ? null : 'no_sow',
              evidence: scored
                ? [
                    { type: 'pr', ...pr },
                    { type: 'sow_task', taskKey: 'SOW-2', projectPk: 'beacon' },
                  ]
                : [],
            },
          ],
        },
        {
          label: 'Review and collaboration',
          weight: 0.15,
          score: null,
          note: null,
          metrics: [
            {
              label: 'Review turnaround',
              unit: 'hours',
              rawValue: null,
              percentile: null,
              missingReason: 'no_review_requests',
              evidence: [],
            },
          ],
        },
      ],
      history: [...runs].reverse().map((run) => {
        const published = rows(run).find(
          (item) => item.userPk === row.userPk && item.projectPk === row.projectPk,
        )!
        return {
          runId: run.runId,
          asOf: run.asOf,
          score: published.overallScore,
          rank: published.rankInGroup,
        }
      }),
    }
  }
  const portfolio = [
    [
      'northstar',
      'Northstar Studio',
      'watch',
      'Two handoff tasks are awaiting review.',
      4,
      6,
      1.5,
      9,
      2,
      11,
    ],
    [
      'northstar',
      'Northstar Studio',
      'insufficient',
      'Initial reporting is still being collected.',
      null,
      2,
      null,
      3,
      1,
      4,
    ],
    [
      'fieldwork',
      'Fieldwork Labs',
      'clear',
      'Release milestones are on schedule.',
      5,
      3,
      0.8,
      4,
      1,
      7,
    ],
    [
      'fieldwork',
      'Fieldwork Labs',
      'risk',
      'The integration review is overdue.',
      3,
      8,
      3.2,
      14,
      4,
      15,
    ],
    [
      'common-ground',
      'Common Ground',
      'clear',
      'The pilot is ready for its next review.',
      5,
      2,
      1,
      2,
      0,
      5,
    ],
    [
      'common-ground',
      'Common Ground',
      'watch',
      'The team is working through a review backlog.',
      4,
      5,
      2.4,
      7,
      3,
      9,
    ],
  ] as const satisfies ReadonlyArray<
    readonly [
      string,
      string,
      PortfolioProject['status'],
      string,
      number | null,
      number,
      number | null,
      number,
      number,
      number,
    ]
  >
  function portfolioSnapshot(run: RankingRun): PortfolioSnapshot {
    const age = runs.indexOf(run)
    return {
      snapshotId: run.runId,
      snapshots: runs.map((entry) => ({
        id: entry.runId,
        label: new Intl.DateTimeFormat(undefined, {
          dateStyle: 'medium',
          timeZone: 'UTC',
        }).format(new Date(entry.asOf)),
      })),
      publication: {
        state: run.stale ? 'stale' : 'current',
        publishedAt: run.asOf,
        sourceAsOf: run.asOf,
        publicationId: run.runId,
        runId: run.runId,
      },
      projects: portfolio.map(
        (
          [
            companyId,
            company,
            status,
            summary,
            activityDays,
            openPrs,
            reviewLatencyDays,
            oldestPrDays,
            branchesAhead,
            openIssues,
          ],
          index,
        ) => ({
          id: projects[index]!.projectPk,
          name: projects[index]!.friendlyName,
          companyId,
          company,
          semester: season,
          status: age > 0 && index === 0 ? 'risk' : status,
          summary,
          concerns: status === 'watch' || status === 'risk' ? [summary] : [],
          activityDays,
          openPrs: openPrs + age,
          reviewLatencyDays,
          oldestPrDays: oldestPrDays + age,
          branchesAhead,
          openIssues: openIssues + age,
        }),
      ),
      changes:
        age === 0
          ? [
              'Project Beacon closed three pull requests and moved from At Risk to Watch.',
              'Project Meridian completed its release review.',
              'Project Signal cleared its oldest open pull request.',
            ]
          : [
              'Project Orchard flagged an overdue integration review.',
              'Project Atlas began collecting weekly activity.',
            ],
    }
  }
  return (url: URL) => {
    const selection = url.searchParams.get('run') || url.searchParams.get('snapshot') || 'current'
    const run = ['current', 'latest'].includes(selection)
      ? runs[0]
      : runs.find((entry) => (selection === 'final' ? entry.isFinal : entry.runId === selection))
    if (!run) return undefined
    if (url.pathname === '/mock/portfolio') return portfolioSnapshot(run)
    const meta: ProjectMeta = { runId: run.runId, asOf: run.asOf, stale: run.stale }
    if (url.pathname === '/api/v1/rankings/runs') return runs.map(wireRun)
    if (url.pathname === '/api/v1/rankings') {
      const role = url.searchParams.get('role') ?? 'engineer'
      const project = role === 'engineer' ? url.searchParams.get('projectPk') : null
      const matches = rows(run).filter(
        (item) => item.role === role && (!project || project === item.projectPk),
      )
      const page = Number(url.searchParams.get('page') ?? 1)
      return {
        ...wireRun(run),
        page,
        pageSize: 25,
        total: matches.length,
        projects,
        items: matches.slice((page - 1) * 25, page * 25).map((row) => ({
          ...row,
          buckets: row.buckets.map((bucket) => ({ ...bucket, bucketKey: bucket.key })),
        })),
      }
    }
    if (url.pathname.startsWith('/api/v1/rankings/members/')) {
      const key = decodeURIComponent(url.pathname.split('/').at(-1)!)
      const items = rows(run)
        .filter((row) => row.userPk === key)
        .map((row) => ({ document: member(row) }))
      return items.length ? { ...wireRun(run), items } : undefined
    }
    if (url.pathname === '/api/v1/projects')
      return { meta, data: projects.map((project) => summary(project, run)) }
    const match = /^\/api\/v1\/projects\/([^/]+)(?:\/(history|sow-timeline))?$/.exec(url.pathname)
    const project = projects.find((item) => item.projectPk === match?.[1])
    if (!project) return undefined
    const projectSummary = summary(project, run)
    if (match?.[2] === 'history')
      return [...runs].reverse().map((publication) => ({
        runId: publication.runId,
        asOf: publication.asOf,
        ...summary(project, publication),
      }))
    if (match?.[2] === 'sow-timeline')
      return {
        meta,
        data: project.hasSow
          ? {
              sow: { title: `${project.friendlyName} delivery plan` },
              progress: {
                percentComplete: projectSummary.percentComplete,
                done: projectSummary.tasksDone,
                total: 12,
                overdue: 2,
              },
              tasks: timelineTasks,
            }
          : { sow: null, progress: null, tasks: [] },
      }
    return {
      meta,
      data: {
        summary: projectSummary,
        detail: {
          metrics: Array.from({ length: 12 }, (_, index) => ({
            week: date((index - 11) * 7),
            prsMerged: [2, 4, 3, 5, 4, 6][index % 6]!,
            medianFirstReviewHours: 21 - index,
            medianOpenPrAgeHours: index === 7 ? null : 30 - index,
          })),
          riskFlags: project.hasSow
            ? [
                {
                  label: 'Review delay',
                  severity: 'Medium',
                  description: 'Two tasks are waiting for review.',
                },
              ]
            : [],
          ownership: { active_owners: 3, files_majority_owned: 18 },
          findings: [
            {
              title: 'Faster reviews',
              description: 'Median time to first review fell across the last three weeks.',
            },
          ],
        },
      },
    }
  }
}

const seasons = new Map([currentSeason, otherSeason].map((season) => [season, fixtureFor(season)]))

export const mockSource: HorizonReadClient = {
  accessMode: 'session',
  scope: 'horizon-fixture',
  isAvailable: () => true,
  async get(operation, signal) {
    await new Promise<void>((resolve, reject) => {
      signal?.throwIfAborted()
      const cancel = () => {
        clearTimeout(timer)
        reject(signal?.reason)
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', cancel)
        resolve()
      }, latencyMs)
      signal?.addEventListener('abort', cancel, { once: true })
    })
    const url = new URL(operation.path, 'https://horizon.invalid')
    const value =
      url.pathname === '/api/semesters'
        ? [...seasons.keys()].map((season) => ({
            seasonType: season.split('-')[0],
            seasonYear: year,
          }))
        : seasons.get(
            url.searchParams.get('season') ??
              (url.pathname === '/mock/portfolio' ? currentSeason : ''),
          )?.(url)
    if (value === undefined)
      throw new ReadApiError('http', 'No demo publication matches this selection.', 404)
    return operation.parse(value)
  },
}
