/**
 * The eight-week trend line.
 *
 * Two rules carried over from the vanilla chart, both of them about honesty:
 *
 *  1. A series with no observations at all draws nothing. It renders an
 *     "Insufficient data" plate instead, because an axis through zero would
 *     assert eight weeks of measured inactivity.
 *  2. A gap inside a series breaks the path. The line is drawn as separate
 *     segments rather than interpolated across a week nobody measured.
 */

import { useId } from "react"

import type { Series } from "@/api/types"
import { chartDomain, formatChartTick } from "@/lib/chart"
import { cn } from "@/lib/utils"

export interface SparkChartProps {
  points: Series
  baseline?: number | null
  /** Token reference such as `var(--status-risk)`. Never a literal colour. */
  stroke: string
  width?: number
  height?: number
  suffix?: string
  labels?: string[]
  area?: boolean
  grid?: boolean
  ariaLabel?: string
  className?: string
}

export function SparkChart({
  points,
  baseline = null,
  stroke,
  width = 220,
  height = 56,
  suffix = "",
  labels,
  area = true,
  grid = false,
  ariaLabel = "8-week trend",
  className,
}: SparkChartProps) {
  const clipId = useId()
  const domain = chartDomain(points, baseline)

  if (!domain) {
    return (
      <div
        className={cn(
          "text-muted-foreground bg-muted/40 flex items-center justify-center rounded-md border border-dashed text-xs",
          className,
        )}
        style={{ width: "100%", height }}
        role="img"
        aria-label="Insufficient data for this trend"
      >
        Insufficient data
      </div>
    )
  }

  const { domainMin, domainMax } = domain
  const stepX = points.length > 1 ? width / (points.length - 1) : width
  const y = (value: number) => height - 6 - ((value - domainMin) / (domainMax - domainMin)) * (height - 12)

  const segments: [number, number][][] = []
  let current: [number, number][] = []
  points.forEach((value, index) => {
    if (value === null) {
      if (current.length) segments.push(current)
      current = []
      return
    }
    current.push([index * stepX, y(value)])
  })
  if (current.length) segments.push(current)

  const formatSegment = (segment: [number, number][]) =>
    segment.map(([x, yy]) => `${x.toFixed(1)} ${yy.toFixed(1)}`).join(" L ")
  const path = segments.map((segment) => `M${formatSegment(segment)}`).join(" ")
  const areaPath = segments
    .map(
      (segment) =>
        `M${formatSegment(segment)} L${segment[segment.length - 1][0].toFixed(1)} ${height} L${segment[0][0].toFixed(1)} ${height} Z`,
    )
    .join(" ")
  const lastSegment = segments[segments.length - 1]
  const last = lastSegment?.[lastSegment.length - 1]

  return (
    <svg
      className={cn("overflow-visible", className)}
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      height={height}
      preserveAspectRatio="none"
      role="img"
      aria-label={ariaLabel}
    >
      <clipPath id={clipId}>
        <rect x="0" y="0" width={width} height={height} />
      </clipPath>
      {grid
        ? [0.25, 0.5, 0.75].map((fraction) => (
            <line
              key={fraction}
              x1="0"
              y1={(height * fraction).toFixed(1)}
              x2={width}
              y2={(height * fraction).toFixed(1)}
              stroke="var(--border)"
              strokeWidth="1"
            />
          ))
        : null}
      {baseline !== null ? (
        <line
          x1="0"
          y1={y(baseline).toFixed(1)}
          x2={width}
          y2={y(baseline).toFixed(1)}
          stroke="var(--muted-foreground)"
          strokeWidth="1"
          strokeDasharray="4 3"
          opacity="0.7"
        />
      ) : null}
      {area ? <path d={areaPath} fill={stroke} opacity="0.12" clipPath={`url(#${clipId})`} /> : null}
      <path d={path} stroke={stroke} strokeWidth="1.75" fill="none" vectorEffect="non-scaling-stroke" />
      {last ? <circle cx={last[0].toFixed(1)} cy={last[1].toFixed(1)} r="3.5" fill={stroke} /> : null}
      {points.map((value, index) => {
        if (value === null) return null
        const label = labels?.[index] ?? `Week ${index + 1}`
        return (
          <g key={index}>
            <circle cx={(index * stepX).toFixed(1)} cy={y(value).toFixed(1)} r="2.7" fill={stroke} />
            <circle cx={(index * stepX).toFixed(1)} cy={y(value).toFixed(1)} r="9" fill="transparent">
              <title>{`${label}: ${value}${suffix}`}</title>
            </circle>
          </g>
        )
      })}
    </svg>
  )
}

export function ChartYAxis({
  points,
  baseline = null,
  suffix = "",
  label = "chart",
}: {
  points: Series
  baseline?: number | null
  suffix?: string
  label?: string
}) {
  const domain = chartDomain(points, baseline)
  if (!domain) return <div className="w-12 shrink-0" aria-hidden="true" />
  const step = (domain.domainMax - domain.domainMin) / 4
  const ticks = Array.from({ length: 5 }, (_, index) => domain.domainMax - step * index)
  return (
    <div
      className="text-muted-foreground flex w-12 shrink-0 flex-col justify-between py-1 text-right font-mono text-[10px]"
      aria-label={`${label} y-axis`}
    >
      {ticks.map((tick, index) => (
        <span key={index}>{formatChartTick(tick, suffix, step)}</span>
      ))}
    </div>
  )
}

export function ChartTimestampAxis({ labels }: { labels: string[] }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div
        className="text-muted-foreground flex justify-between font-mono text-[10px]"
        aria-label="Weekly chart timestamps"
      >
        {labels.map((label, index) => (
          <span key={index} title={`Week ${index + 1}: ${label}`}>
            {label}
          </span>
        ))}
      </div>
      <span className="text-muted-foreground text-[10px]">
        Weekly timestamp · hover a point for its value
      </span>
    </div>
  )
}
