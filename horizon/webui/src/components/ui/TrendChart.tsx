import { memo, useEffect, useRef, useState } from 'react'
import { whenVisible } from './motion'
import { shortDate } from '../../format'
import './trend-chart.css'

export interface TrendPoint {
  id: string
  at: string
  value: number | null
}

const left = 45
const right = 580
const top = 12
const bottom = 126

export const TrendChart = memo(function TrendChart({
  title,
  points,
  maximum,
  rank = false,
  unit = '',
  bars = false,
}: {
  title: string
  points: TrendPoint[]
  maximum?: number
  rank?: boolean
  unit?: string
  bars?: boolean
}) {
  const chart = useRef<HTMLElement>(null)
  const [active, setActive] = useState<string | null>(null)
  useEffect(() => {
    const node = chart.current
    if (!node) return
    return whenVisible(node, () => { node.dataset.motion = 'ready' })
  }, [points])
  const values = points.flatMap(({ value }) => (value === null ? [] : [value]))
  if (!values.length)
    return (
      <section>
        <h3>{title}</h3>
        <p>No published values.</p>
      </section>
    )
  const ordered = [...points].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  const first = ordered[0]!
  const last = ordered.at(-1)!
  const start = Date.parse(first.at)
  const end = Date.parse(last.at)
  const min = rank ? 1 : 0
  const max = maximum ?? Math.max(min + 1, ...values)
  const coordinates = ordered.map((point) => {
    const x =
      start === end
        ? (left + right) / 2
        : left + ((Date.parse(point.at) - start) * (right - left)) / (end - start)
    const fraction = point.value === null ? null : (point.value - min) / (max - min)
    const y =
      fraction === null
        ? null
        : rank
          ? top + fraction * (bottom - top)
          : bottom - fraction * (bottom - top)
    return { ...point, x, y }
  })
  return (
    <figure ref={chart} className="trend-chart">
      <figcaption>{title}</figcaption>
      <svg viewBox="0 0 600 146" aria-hidden="true" onPointerLeave={() => setActive(null)}>
        {[top, (top + bottom) / 2, bottom].map((y) => <line key={y} className="trend-grid" x1={left} y1={y} x2={right} y2={y} />)}
        <path className="trend-axis" d={`M ${left} ${top} V ${bottom} H ${right}`} />
        <text x={left - 6} y={top + 4} textAnchor="end">
          {rank ? min : max}
          {unit}
        </text>
        <text x={left - 6} y={bottom} textAnchor="end">
          {rank ? max : min}
          {unit}
        </text>
        <text x={left} y={142}>
          {shortDate.format(new Date(first.at))}
        </text>
        {start !== end && (
          <text x={right} y={142} textAnchor="end">
            {shortDate.format(new Date(last.at))}
          </text>
        )}
        {coordinates.map((point, index) => {
          const previous = coordinates[index - 1]
          if (point.y === null) return null
          return (
            <g key={point.id} onPointerEnter={() => setActive(point.id)} onClick={() => setActive((current) => current === point.id ? null : point.id)}>
              {!bars && previous && previous.y !== null && (
                <line
                  className="trend-line"
                  pathLength={1}
                  x1={previous.x}
                  y1={previous.y}
                  x2={point.x}
                  y2={point.y}
                />
              )}
              {bars && <rect className="trend-bar" x={point.x - 8} y={point.y} width={16} height={bottom - point.y} rx={3} />}
              <circle className={bars ? 'trend-point trend-bar-point' : 'trend-point'} cx={point.x} cy={point.y} r={4}>
                <title>
                  {shortDate.format(new Date(point.at))} · {point.value}
                  {unit}
                </title>
              </circle>
            </g>
          )
        })}
      </svg>
      {active && coordinates.filter((point) => point.id === active).map((point) => (
        <span className="trend-tooltip" key={point.id}>
          {shortDate.format(new Date(point.at))} · {point.value}{unit}
        </span>
      ))}
      <details>
        <summary>Chart data</summary>
        <ul>
          {ordered.map((point) => (
            <li key={point.id}>
              <time dateTime={point.at}>{shortDate.format(new Date(point.at))}</time>
              {' · '}
              {point.value === null ? 'Unavailable' : `${point.value}${unit}`}
            </li>
          ))}
        </ul>
      </details>
    </figure>
  )
})
