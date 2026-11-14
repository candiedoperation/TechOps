import { array, boolean, date, nullable, number, object, oneOf, string } from './parse'

const rankingsPath = '/api/v1/rankings'
const roles = ['engineer', 'tech_lead'] as const

function parseRun(value: unknown) {
  const row = object(value)
  return {
    runId: string(row.rankingRunId),
    asOf: date(row.asOf),
    isFinal: boolean(row.isFinal),
    rubricVersion: string(row.rubricVersion),
    stale: boolean(row.stale),
  }
}

export type RankingRun = ReturnType<typeof parseRun>

function parseBucket(value: unknown) {
  const bucket = object(value)
  return {
    key: string(bucket.bucketKey),
    label: nullable(string)(bucket.label),
    score: nullable(number)(bucket.score),
    weight: number(bucket.weight),
  }
}

function parseRow(value: unknown) {
  const row = object(value)
  return {
    userPk: string(row.userPk),
    name: string(row.name),
    projectPk: string(row.projectPk),
    projectName: string(row.projectName),
    role: oneOf(row.role, roles),
    comparisonGroup: string(row.comparisonGroup),
    comparisonGroupLabel: nullable(string)(row.comparisonGroupLabel),
    overallScore: nullable(number)(row.overallScore),
    coverage: number(row.coverage),
    status: oneOf(row.status, ['ranked', 'unranked', 'insufficient_data', 'group_too_small']),
    rankInGroup: nullable(number)(row.rankInGroup),
    rankedInGroup: number(row.rankedInGroup),
    buckets: array(row.bucketScores ?? row.buckets, parseBucket),
  }
}

export type RankingRow = ReturnType<typeof parseRow>
export type RankingRole = RankingRow['role']

const parseProject = (value: unknown) => {
  const project = object(value)
  return { projectPk: string(project.projectPk), friendlyName: string(project.friendlyName) }
}

function parseRankingPage(value: unknown) {
  const result = object(value)
  return {
    meta: parseRun(result.meta ?? result),
    items: array(result.items, parseRow),
    projects: array(result.projects, parseProject),
    page: number(result.page),
    pageSize: number(result.pageSize),
    total: number(result.total),
  }
}

export const rankingOperations = {
  semesters: {
    path: '/api/semesters',
    parse: (value: unknown) =>
      array(value, (item) => {
        const row = object(item)
        return `${oneOf(row.seasonType, ['FALL', 'SPRING'])}-${number(row.seasonYear)}`
      }),
  },
  runs: (season: string) => ({
    path: `${rankingsPath}/runs?${new URLSearchParams({ season })}`,
    parse: (value: unknown) => array(value, parseRun),
  }),
  list: (filters: Record<string, string>) => ({
    path: `${rankingsPath}?${new URLSearchParams(filters)}`,
    parse: parseRankingPage,
  }),
}
