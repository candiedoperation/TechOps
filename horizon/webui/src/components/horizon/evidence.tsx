/**
 * Evidence-linked warnings.
 *
 * A warning is only ever shown with the raw references that produced it --
 * `normalizeEvidence` drops any item that arrives without them, so anything
 * rendered here is inspectable. The metric trend beside each item is the same
 * series the rule evaluated, not a redrawn summary.
 */

import { finiteNumber, lastValue, metricValue } from "@/api/normalize"
import { METRIC_DEFINITIONS, type EvidenceItem, type Project, type SnapshotMeta } from "@/api/types"
import { HorizonIcon } from "@/components/horizon/icons"
import { MetricWithBaseline, Mono } from "@/components/horizon/primitives"
import { SparkChart } from "@/components/horizon/spark-chart"
import { weekLabels } from "@/lib/format"
import { EVIDENCE_MARKER_CLASS, STATUS_STROKE_VAR } from "@/lib/status"
import { cn } from "@/lib/utils"

function metricDefinitionFor(metric: string | null) {
  return METRIC_DEFINITIONS.find(({ key, metricKey }) => key === metric || metricKey === metric)
}

function EvidenceMarker({ item }: { item: EvidenceItem }) {
  return (
    <span
      className={cn("flex size-9 shrink-0 items-center justify-center rounded-lg", EVIDENCE_MARKER_CLASS[item.type])}
    >
      <HorizonIcon name={item.icon} className="size-4" />
    </span>
  )
}

export function EvidenceRow({
  project,
  item,
  meta,
  size = "sm",
}: {
  project: Project
  item: EvidenceItem
  meta: SnapshotMeta
  size?: "sm" | "lg"
}) {
  const definition = metricDefinitionFor(item.metric)
  const series = definition ? (project.series[definition.key] ?? []) : []
  const baseline =
    finiteNumber(item.baseline) ?? (definition ? (project.seriesBaselines[definition.key]?.[0] ?? null) : null)
  const current =
    finiteNumber(item.current) ??
    (definition ? metricValue(project.metrics, definition.metricKey, lastValue(series)) : null)
  const detail = [item.window ? `Window ${item.window}` : "", item.threshold ? `Trigger ${item.threshold}` : ""]
    .filter(Boolean)
    .join(" · ")
  const hasSeries = series.some((value) => value !== null)

  return (
    <div className="flex items-start gap-3 rounded-lg border p-3">
      <EvidenceMarker item={item} />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <strong className="text-sm font-medium">{item.title}</strong>
          <MetricWithBaseline value={current} baseline={baseline} unit={definition?.unit ?? item.unit} />
        </div>
        {definition && hasSeries ? (
          <SparkChart
            points={series}
            baseline={baseline}
            stroke={STATUS_STROKE_VAR[project.statusClass]}
            width={size === "lg" ? 420 : 220}
            height={size === "lg" ? 56 : 36}
            suffix={definition.unit}
            labels={weekLabels(meta.snapshotWeekStart)}
            area={size === "lg"}
            ariaLabel={`${item.title} 8-week trend`}
          />
        ) : null}
        {detail ? <span className="text-muted-foreground text-xs">{detail}</span> : null}
        <details className="text-muted-foreground text-xs">
          <summary className="cursor-pointer select-none">
            {item.sources.length} source {item.sources.length === 1 ? "reference" : "references"}
          </summary>
          <ul className="mt-1.5 flex flex-col gap-1 pl-4">
            {item.sources.map((source, index) => (
              <li key={`${source}-${index}`} className="list-disc">
                <Mono>{source}</Mono>
              </li>
            ))}
          </ul>
        </details>
      </div>
    </div>
  )
}

/**
 * The evidence block for one project.
 *
 * Insufficient data and planned pause are their own statements rather than an
 * empty list: "we suppressed evaluation" and "we evaluated and found nothing"
 * are different facts and must not look alike.
 */
export function EvidenceList({
  project,
  meta,
  size = "sm",
}: {
  project: Project
  meta: SnapshotMeta
  size?: "sm" | "lg"
}) {
  if (project.statusClass === "data") {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-dashed p-3">
        <span className={cn("flex size-9 items-center justify-center rounded-lg", EVIDENCE_MARKER_CLASS.blue)}>
          <HorizonIcon name="database" className="size-4" />
        </span>
        <div className="flex flex-col">
          <strong className="text-sm font-medium">Insufficient data</strong>
          <span className="text-muted-foreground text-xs">
            No trusted evidence was available for this snapshot week, so no warning was raised.
          </span>
        </div>
      </div>
    )
  }

  if (project.statusClass === "pause") {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-dashed p-3">
        <span className={cn("flex size-9 items-center justify-center rounded-lg", EVIDENCE_MARKER_CLASS.blue)}>
          <HorizonIcon name="pause" className="size-4" />
        </span>
        <div className="flex flex-col">
          <strong className="text-sm font-medium">Paused</strong>
          <span className="text-muted-foreground text-xs">
            A planned pause short-circuits rule evaluation; inactivity here is expected.
          </span>
        </div>
      </div>
    )
  }

  if (!project.evidence.length) {
    return (
      <div className="flex items-center gap-3 rounded-lg border p-3">
        <span className={cn("flex size-9 items-center justify-center rounded-lg", EVIDENCE_MARKER_CLASS.teal)}>
          <HorizonIcon name="check-circle" className="size-4" />
        </span>
        <strong className="text-sm font-medium">No concern detected</strong>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {project.evidence.map((item, index) => (
        <EvidenceRow key={item.id ?? index} project={project} item={item} meta={meta} size={size} />
      ))}
    </div>
  )
}
