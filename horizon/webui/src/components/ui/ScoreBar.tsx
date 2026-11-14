import type { CSSProperties } from 'react'
import { CountUp } from './CountUp'
import './motion.css'

/** Values and bounds must be supplied by a reviewed rubric, never inferred from missing data. */
export function ScoreBar({
  value,
  maximum,
  label,
  animate = false,
}: {
  value: number | null
  maximum: number
  label: string
  animate?: boolean
}) {
  if (
    value === null ||
    !Number.isFinite(value) ||
    !Number.isFinite(maximum) ||
    maximum <= 0 ||
    value < 0 ||
    value > maximum
  )
    return <span aria-label={`${label}: not available`}>Not available</span>
  return (
    <span className="score-bar">
      <span>
        {animate ? <CountUp value={value} /> : value} / {maximum}
      </span>
      <span className="score-track" aria-hidden="true">
        <span className="score-fill" style={{ '--score-level': `${(value / maximum) * 100}%` } as CSSProperties} />
      </span>
      <meter className="sr-only" aria-label={label} min={0} max={maximum} value={value} />
    </span>
  )
}
