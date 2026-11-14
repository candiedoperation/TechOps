import { percent } from '../../format'

const displayNumber = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 })

export function formatMetric(value: number, unit: string | null) {
  if (unit === 'ratio') return percent.format(value)
  const formatted = displayNumber.format(value)
  if (unit === 'rating' || unit === 'rating_1_3') return `${formatted} / 3`
  return unit ? `${formatted} ${unit}` : formatted
}
