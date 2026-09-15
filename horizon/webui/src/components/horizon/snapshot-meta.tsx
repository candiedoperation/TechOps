/**
 * The snapshot framing strip.
 *
 * Weekly snapshots are immutable, so every number on a page belongs to one
 * identified week. This line says which week, how complete the data behind it
 * was, and when the sources were last synced -- present on each surface that
 * shows snapshot-derived figures.
 */

import { CalendarIcon } from "lucide-react"

import type { SnapshotMeta } from "@/api/types"
import { Badge } from "@/components/ui/badge"
import { formatDate, formatPercent, formatWeekRange } from "@/lib/format"
import { cn } from "@/lib/utils"

export function SnapshotMetaLine({ meta, className }: { meta: SnapshotMeta; className?: string }) {
  return (
    <div className={cn("text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-xs", className)}>
      <span>{formatWeekRange(meta.snapshotWeekStart, meta.snapshotWeekEnd)}</span>
      <span>Data completeness {formatPercent(meta.dataCompletenessPct)}</span>
      <span>Last sync {formatDate(meta.lastSyncAt, true)}</span>
      {meta.ruleSetVersion ? <span className="font-mono">{meta.ruleSetVersion}</span> : null}
    </div>
  )
}

export function WeekChip({ meta }: { meta: SnapshotMeta }) {
  return (
    <Badge variant="outline" className="gap-1.5 py-1">
      <CalendarIcon className="size-3.5" aria-hidden="true" />
      {formatWeekRange(meta.snapshotWeekStart, meta.snapshotWeekEnd)}
    </Badge>
  )
}

/**
 * Shown above a profile or checkpoint that is not live, so a historical view
 * can never be mistaken for the current one.
 */
export function AsOfBanner({
  date,
  kind,
  onBackToLive,
}: {
  date: string
  kind: "Historical snapshot" | "Cumulative"
  onBackToLive?: () => void
}) {
  return (
    <div className="border-status-data/30 bg-status-data-surface text-status-data flex flex-wrap items-center gap-3 rounded-lg border px-4 py-2.5 text-sm">
      <CalendarIcon className="size-4" aria-hidden="true" />
      <span className="font-medium">As of {formatDate(date)}</span>
      <span className="opacity-80">{kind}</span>
      {onBackToLive ? (
        <button
          type="button"
          onClick={onBackToLive}
          className="ml-auto underline underline-offset-4 hover:no-underline"
        >
          Back to live ×
        </button>
      ) : null}
    </div>
  )
}
