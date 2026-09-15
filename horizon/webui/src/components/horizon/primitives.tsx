/**
 * Horizon's small, repeated pieces of vocabulary.
 *
 * `MetricValue` is the important one: it is the only component allowed to
 * render a metric, and a value it was given as `null` renders as an explicit
 * "no data" dash with a screen-reader label -- never `0`.
 */

import type { ReactNode } from "react"

import { finiteNumber } from "@/api/normalize"
import type { Project, StatusClass } from "@/api/types"
import { Badge } from "@/components/ui/badge"
import { MISSING, MISSING_LABEL, formatCount } from "@/lib/format"
import { STATUS_PILL_CLASS, STATUS_SOLID_CLASS } from "@/lib/status"
import { cn } from "@/lib/utils"

export function StatusPill({ project, className }: { project: Pick<Project, "status" | "statusClass">; className?: string }) {
  return (
    <Badge variant="outline" className={cn("font-medium", STATUS_PILL_CLASS[project.statusClass], className)}>
      {project.status}
    </Badge>
  )
}

/** The two-letter project tile. `statusClass` of `null` renders it neutral,
 *  which is what a project with no snapshot for the selected week gets. */
export function Monogram({
  short,
  statusClass,
  size = "sm",
}: {
  short: string
  statusClass: StatusClass | null
  size?: "sm" | "md" | "lg"
}) {
  const sizeClass = size === "lg" ? "size-12 text-base" : size === "md" ? "size-10 text-sm" : "size-9 text-xs"
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-lg font-semibold tracking-tight",
        sizeClass,
        statusClass ? STATUS_SOLID_CLASS[statusClass] : "bg-muted text-muted-foreground",
      )}
    >
      {short}
    </span>
  )
}

/** The one spelling of "we have no observation for this". */
export function NoData({ className }: { className?: string }) {
  return (
    <span className={cn("text-muted-foreground", className)}>
      <span aria-hidden="true">{MISSING}</span>
      <span className="sr-only">{MISSING_LABEL}</span>
    </span>
  )
}

/**
 * A measured value, or an explicit absence.
 *
 * `0` is a real observation and prints as `0`; `null` and `undefined` are
 * missing measurements and print as the dash. The two are never collapsed.
 */
export function MetricValue({
  value,
  unit = "",
  className,
  format = "number",
}: {
  value: number | null | undefined
  unit?: string
  className?: string
  format?: "number" | "count"
}) {
  const number = finiteNumber(value)
  if (number === null) return <NoData className={className} />
  return (
    <span className={className}>
      {format === "count" ? formatCount(number) : Number(number.toFixed(2))}
      {unit}
    </span>
  )
}

/**
 * A metric with its baseline, as the tables and chart captions show it. The
 * delta arrow is suppressed when either side is missing rather than being
 * computed against an assumed zero.
 */
export function MetricWithBaseline({
  label,
  value,
  baseline,
  unit = "",
}: {
  label?: string
  value: number | null | undefined
  baseline: number | null | undefined
  unit?: string
}) {
  const current = finiteNumber(value)
  const base = finiteNumber(baseline)
  const delta = current === null || base === null ? null : current - base
  const arrow = delta === null || Math.abs(delta) < 0.05 ? "" : delta > 0 ? "▲" : "▼"

  return (
    <span className="flex flex-col gap-0.5">
      {label ? <span className="text-muted-foreground text-xs">{label}</span> : null}
      <span className="text-sm font-medium tabular-nums">
        <MetricValue value={current} unit={unit} />
        {base !== null && current !== null ? (
          <em className="text-muted-foreground ml-1.5 text-xs font-normal not-italic">
            {arrow} vs {Number(base.toFixed(2))}
            {unit} baseline
          </em>
        ) : null}
      </span>
    </span>
  )
}

export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn("text-muted-foreground text-xs font-medium tracking-[0.14em] uppercase", className)}>
      {children}
    </span>
  )
}

export function PageHeading({
  eyebrow,
  title,
  meta,
  actions,
  back,
}: {
  eyebrow?: ReactNode
  title: ReactNode
  meta?: ReactNode
  actions?: ReactNode
  back?: ReactNode
}) {
  return (
    <div className="flex flex-col gap-3">
      {back}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1.5">
          {eyebrow ? <Eyebrow>{eyebrow}</Eyebrow> : null}
          <h1 className="font-display text-2xl leading-tight font-semibold tracking-tight">{title}</h1>
          {meta}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </div>
  )
}

/** Mono text for identifiers: run ids, logins, references. */
export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("font-mono text-xs", className)}>{children}</span>
}
