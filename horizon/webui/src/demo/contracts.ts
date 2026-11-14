import type { HorizonReadContractRegistry } from '../api/contracts/registry'
import type { ProvisionalReadOptions } from '../api/contracts/provisional/common'
import { DEMO_PREFIX } from './policy'
import type { DemoScenario } from './scenarios'
import {
  parseHealthHistory,
  parseMemberDetail,
  parsePage,
  parsePeriods,
  parseProject,
  parseProjectDetail,
  parseRanking,
  parseRankingHistory,
  parseResult,
} from './parsers'

export function createDemoContracts(scenario: DemoScenario): HorizonReadContractRegistry {
  function path(name: string, parameters: Record<string, string> = {}) {
    return `${DEMO_PREFIX}${name}?${new URLSearchParams({ ...parameters, scenario })}`
  }
  function options(value: ProvisionalReadOptions) {
    return {
      periodId: value.periodId,
      cursor: value.cursor ?? '',
      pageSize: String(value.pageSize ?? 3),
      ...value.filters,
    }
  }
  return {
    reviewStatus: 'demo',
    rankingPeriods: () => ({ path: path('ranking-periods'), parse: parsePeriods }),
    healthPeriods: () => ({ path: path('health-periods'), parse: parsePeriods }),
    rankings: (value) => ({
      path: path('rankings', options(value)),
      parse: parsePage(parseRanking),
    }),
    projectHealth: (value) => ({
      path: path('health', options(value)),
      parse: parsePage(parseProject),
    }),
    member: (id, periodId) => ({
      path: path(`members/${encodeURIComponent(id)}`, { periodId }),
      parse: parseResult(parseMemberDetail),
    }),
    project: (id, periodId) => ({
      path: path(`projects/${encodeURIComponent(id)}`, { periodId }),
      parse: parseResult(parseProjectDetail),
    }),
    rankingHistory: (id, cursor) => ({
      path: path(`members/${encodeURIComponent(id)}/history`, { cursor: cursor ?? '' }),
      parse: parsePage(parseRankingHistory),
    }),
    healthHistory: (id, cursor) => ({
      path: path(`projects/${encodeURIComponent(id)}/history`, { cursor: cursor ?? '' }),
      parse: parsePage(parseHealthHistory),
    }),
  }
}
