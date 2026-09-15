/**
 * Chart maths, kept out of the component file so the domain rule is testable
 * on its own.
 *
 * `chartDomain` returning null is the load-bearing case: a series with no
 * observations has no domain, and the caller must draw an "insufficient data"
 * plate rather than an axis through zero.
 */

import type { Series } from "@/api/types"

export interface ChartDomain {
  domainMin: number
  domainMax: number
}

export function chartDomain(points: Series, baseline: number | null = null): ChartDomain | null {
  const values = points.filter((value): value is number => value !== null)
  if (!values.length) return null
  const all = baseline !== null ? values.concat([baseline]) : values
  const min = Math.min(...all)
  const max = Math.max(...all)
  const span = max - min || Math.max(1, max * 0.2)
  return { domainMin: min - span * 0.2, domainMax: max + span * 0.2 }
}

export function formatChartTick(value: number, suffix: string, step: number): string {
  const precision = step >= 10 ? 0 : step >= 1 ? 1 : step >= 0.1 ? 2 : 3
  return `${Number(value.toFixed(precision))}${suffix}`
}
