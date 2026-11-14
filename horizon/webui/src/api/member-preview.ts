import type { RankingRow } from './contracts/rankings'

export const memberPreviewKey = (subject: string, userPk: string, season: string, run: string) =>
  ['horizon', subject, 'member-preview', { userPk, season, run }] as const

export type MemberPreview = Pick<
  RankingRow,
  | 'userPk'
  | 'name'
  | 'projectPk'
  | 'projectName'
  | 'role'
  | 'overallScore'
  | 'rankInGroup'
  | 'rankedInGroup'
  | 'comparisonGroupLabel'
  | 'status'
  | 'coverage'
  | 'buckets'
>
