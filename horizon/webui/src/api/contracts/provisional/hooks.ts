/** Draft feature hooks. No operations are registered until backend review is complete.
 * These are deliberately not mounted as live data sources on the current preview pages.
 */
import {
  canUseReadContracts,
  horizonReadContracts,
  type HorizonReadContractRegistry,
} from '../registry'
import { useHorizonInfiniteReadQuery, useHorizonReadQuery } from '../../use-horizon-query'
import type { ProvisionalReadOptions } from './common'

function listKey(options: ProvisionalReadOptions): Readonly<Record<string, string>> {
  return {
    period: options.periodId,
    pageSize: String(options.pageSize ?? ''),
    filters: JSON.stringify(
      Object.entries(options.filters ?? {}).sort(([a], [b]) => a.localeCompare(b)),
    ),
  }
}

export function useProvisionalRankingPeriods(registry = horizonReadContracts) {
  return useHorizonReadQuery({
    feature: 'ranking-periods',
    operation: canUseReadContracts(registry) ? registry.rankingPeriods?.() : undefined,
  })
}
export function useProvisionalMemberRankings(
  options: Omit<ProvisionalReadOptions, 'cursor'>,
  registry = horizonReadContracts,
) {
  const build = canUseReadContracts(registry) ? registry.rankings : undefined
  return useHorizonInfiniteReadQuery({
    feature: 'rankings',
    parameters: listKey(options),
    available: Boolean(options.periodId),
    operationForCursor: build ? (cursor) => build({ ...options, cursor }) : undefined,
    getNextCursor: (page) => page.page.nextCursor,
  })
}
export function useProvisionalMemberProfile(
  memberId: string,
  periodId: string,
  registry = horizonReadContracts,
) {
  return useHorizonReadQuery({
    feature: 'member',
    parameters: { memberId, periodId },
    available: Boolean(memberId && periodId),
    operation: canUseReadContracts(registry) ? registry.member?.(memberId, periodId) : undefined,
  })
}
export function useProvisionalRankingHistory(memberId: string, registry = horizonReadContracts) {
  const build = canUseReadContracts(registry) ? registry.rankingHistory : undefined
  return useHorizonInfiniteReadQuery({
    feature: 'ranking-history',
    parameters: { memberId },
    available: Boolean(memberId),
    operationForCursor: build ? (cursor) => build(memberId, cursor) : undefined,
    getNextCursor: (page) => page.page.nextCursor,
  })
}
export function useProvisionalHealthPeriods(registry = horizonReadContracts) {
  return useHorizonReadQuery({
    feature: 'health-periods',
    operation: canUseReadContracts(registry) ? registry.healthPeriods?.() : undefined,
  })
}
export function useProvisionalProjectHealth(
  options: Omit<ProvisionalReadOptions, 'cursor'>,
  registry = horizonReadContracts,
) {
  const build = canUseReadContracts(registry) ? registry.projectHealth : undefined
  return useHorizonInfiniteReadQuery({
    feature: 'project-health',
    parameters: listKey(options),
    available: Boolean(options.periodId),
    operationForCursor: build ? (cursor) => build({ ...options, cursor }) : undefined,
    getNextCursor: (page) => page.page.nextCursor,
  })
}
export function useProvisionalProjectDetails(
  projectId: string,
  periodId: string,
  registry = horizonReadContracts,
) {
  return useHorizonReadQuery({
    feature: 'project',
    parameters: { projectId, periodId },
    available: Boolean(projectId && periodId),
    operation: canUseReadContracts(registry) ? registry.project?.(projectId, periodId) : undefined,
  })
}
export function useProvisionalHealthHistory(
  projectId: string,
  registry: HorizonReadContractRegistry = horizonReadContracts,
) {
  const build = canUseReadContracts(registry) ? registry.healthHistory : undefined
  return useHorizonInfiniteReadQuery({
    feature: 'health-history',
    parameters: { projectId },
    available: Boolean(projectId),
    operationForCursor: build ? (cursor) => build(projectId, cursor) : undefined,
    getNextCursor: (page) => page.page.nextCursor,
  })
}
