/**
 * One project's weekly snapshot profile.
 *
 * `?asOf=YYYY-MM-DD` switches it to a point-in-time view. That path is
 * deliberately separate: a historical profile resolves only from the
 * point-in-time endpoint and never falls back to the live snapshot, because
 * filling a past week's gaps with today's data is what made this view
 * misleading before. A week with no snapshot says so.
 */

import { useState } from "react"
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { ArrowLeftIcon, DatabaseIcon } from "lucide-react"

import { errorMessage } from "@/api/client"
import { hasOwn, lastValue, metricValue } from "@/api/normalize"
import { latestSnapshotQuery, projectAsOfQuery, projectProfileQuery } from "@/api/queries"
import { METRIC_DEFINITIONS, type AggregateMetricKey, type Project, type SnapshotMeta } from "@/api/types"
import { EvidenceList } from "@/components/horizon/evidence"
import { FeedbackDialog, type FeedbackTarget } from "@/components/horizon/feedback-dialog"
import {
  Eyebrow,
  MetricValue,
  MetricWithBaseline,
  Monogram,
  NoData,
  PageHeading,
  StatusPill,
} from "@/components/horizon/primitives"
import { ChartTimestampAxis, ChartYAxis, SparkChart } from "@/components/horizon/spark-chart"
import { AsOfBanner, SnapshotMetaLine } from "@/components/horizon/snapshot-meta"
import { EmptyPanel, ErrorPanel, LoadingPanel } from "@/components/horizon/states"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { formatAssessmentNumber, formatPercent, weekLabels } from "@/lib/format"
import { STATUS_PILL_CLASS, STATUS_STROKE_VAR, statusMetaFor } from "@/lib/status"
import { cn } from "@/lib/utils"

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export function ProjectProfile() {
  const { projectId = "" } = useParams()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const rawAsOf = searchParams.get("asOf")
  const asOf = rawAsOf && ISO_DATE.test(rawAsOf) ? rawAsOf : null

  const [feedbackTarget, setFeedbackTarget] = useState<FeedbackTarget | null>(null)

  const latest = useQuery(latestSnapshotQuery())
  const listed = latest.data?.snapshot.projects.find((project) => project.id === projectId)
  const baseMeta: SnapshotMeta = latest.data?.snapshot ?? {
    snapshotId: null,
    snapshotWeekStart: null,
    snapshotWeekEnd: null,
    generatedAt: null,
    ruleSetVersion: null,
    dataCompletenessPct: null,
    lastSyncAt: null,
  }

  const live = useQuery({
    ...projectProfileQuery(projectId, listed, baseMeta),
    enabled: Boolean(projectId) && !asOf && latest.isSuccess,
  })
  const historical = useQuery({
    ...projectAsOfQuery(projectId, asOf ?? ""),
    enabled: Boolean(projectId) && Boolean(asOf),
  })

  const active = asOf ? historical : live
  const project: Project | null = asOf ? (historical.data?.project ?? null) : (live.data?.project ?? null)
  const meta: SnapshotMeta = asOf ? (historical.data?.meta ?? baseMeta) : (live.data?.meta ?? baseMeta)

  const backLink = (
    <Button variant="ghost" size="sm" asChild className="w-fit -translate-x-2">
      <Link to="/projects">
        <ArrowLeftIcon className="size-4" aria-hidden="true" />
        Back to inventory
      </Link>
    </Button>
  )

  if (active.isPending || (!asOf && latest.isPending)) {
    return (
      <div className="flex flex-col gap-6">
        {backLink}
        <LoadingPanel label="Loading project snapshot" />
      </div>
    )
  }

  if (active.isError) {
    return (
      <div className="flex flex-col gap-6">
        {backLink}
        <ErrorPanel message={errorMessage(active.error, "Project snapshots could not be loaded.")} onRetry={() => active.refetch()} />
      </div>
    )
  }

  /* The point-in-time endpoint answered, and had no snapshot for this week. */
  if (asOf && historical.data && !historical.data.hasData) {
    return (
      <div className="flex flex-col gap-6">
        {backLink}
        <PageHeading
          title={listed?.name ?? "This project"}
          meta={listed ? <p className="text-muted-foreground text-sm">{listed.team} · {listed.repo}</p> : undefined}
        />
        <AsOfBanner
          date={asOf}
          kind="Historical snapshot"
          onBackToLive={() => navigate(`/projects/${encodeURIComponent(projectId)}`)}
        />
        <EmptyPanel
          title="No snapshot for this week"
          description="Horizon captured no weekly snapshot for this project on the selected date. Nothing is shown rather than filling the gap with current data."
          icon={<DatabaseIcon className="size-8" />}
        />
      </div>
    )
  }

  if (!project) {
    return (
      <div className="flex flex-col gap-6">
        {backLink}
        <ErrorPanel message="Project unavailable." onRetry={() => active.refetch()} />
      </div>
    )
  }

  const statusMeta = statusMetaFor(project.statusClass)
  const labels = weekLabels(meta.snapshotWeekStart)

  return (
    <div className="flex flex-col gap-6">
      <PageHeading
        back={backLink}
        title={
          <span className="flex flex-wrap items-center gap-3">
            <Monogram short={project.short} statusClass={project.statusClass} size="lg" />
            <span className="flex flex-col">
              <span>{project.name}</span>
              <span className="text-muted-foreground text-sm font-normal">
                {project.team} · {project.repo}
              </span>
            </span>
            <StatusPill project={project} />
          </span>
        }
        meta={<SnapshotMetaLine meta={meta} />}
      />

      {asOf ? (
        <AsOfBanner
          date={asOf}
          kind="Historical snapshot"
          onBackToLive={() => navigate(`/projects/${encodeURIComponent(projectId)}`)}
        />
      ) : null}

      <div
        className={cn(
          "flex flex-wrap items-center gap-3 rounded-lg border px-4 py-3",
          STATUS_PILL_CLASS[project.statusClass],
        )}
      >
        <strong className="text-sm font-semibold">{project.status}</strong>
        <span className="text-sm opacity-80">{statusMeta.copy}</span>
      </div>

      <SignalCard project={project} />
      <HealthAssessmentCard project={project} />

      <div className="grid gap-4 xl:grid-cols-2">
        {METRIC_DEFINITIONS.filter(
          ({ metricKey }) => metricKey !== "active_contributors" || hasOwn(project.metrics, "active_contributors"),
        ).map(({ label, key, metricKey, unit }) => {
          const series = project.series[key] ?? []
          const baseline = project.seriesBaselines[key]?.[0] ?? null
          const current = metricValue(project.metrics, metricKey, lastValue(series))
          return (
            <Card key={key}>
              <CardHeader>
                <CardTitle className="text-sm">
                  <MetricWithBaseline label={label} value={current} baseline={baseline} unit={unit} />
                </CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                <div className="flex items-stretch gap-2">
                  <ChartYAxis points={series} baseline={baseline} suffix={unit} label={label} />
                  <div className="min-w-0 flex-1">
                    <SparkChart
                      points={series}
                      baseline={baseline}
                      stroke={STATUS_STROKE_VAR[project.statusClass]}
                      width={520}
                      height={154}
                      suffix={unit}
                      labels={labels}
                      grid
                      ariaLabel={`${label} 8-week trend`}
                    />
                  </div>
                </div>
                <div className="flex gap-2">
                  <span className="w-12 shrink-0" aria-hidden="true" />
                  <ChartTimestampAxis labels={labels} />
                </div>
              </CardContent>
            </Card>
          )
        })}
      </div>

      <AggregateMetrics project={project} meta={meta} />

      <Card>
        <CardHeader className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Evidence</CardTitle>
          <Eyebrow>{formatPercent(project.dataCompletenessPct)} complete</Eyebrow>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <EvidenceList project={project} meta={meta} size="lg" />
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() =>
                setFeedbackTarget({
                  project,
                  snapshotId: project.snapshotId ?? meta.snapshotId,
                  warningId: project.evidence[0]?.id ?? null,
                })
              }
            >
              Add context
            </Button>
            <Button
              onClick={() =>
                setFeedbackTarget({
                  project,
                  snapshotId: project.snapshotId ?? meta.snapshotId,
                  warningId: project.evidence[0]?.id ?? null,
                })
              }
            >
              {statusMeta.cta} →
            </Button>
          </div>
        </CardContent>
      </Card>

      {project.history.length ? (
        <Card>
          <CardHeader>
            <CardTitle>Review history</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-3">
              {project.history.map((entry, index) => (
                <li key={index} className="flex flex-col gap-0.5 border-l-2 pl-3">
                  <span className="text-sm font-medium">{entry.action}</span>
                  <span className="text-muted-foreground text-xs">{entry.date}</span>
                  {entry.note ? <p className="text-sm">{entry.note}</p> : null}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      <FeedbackDialog target={feedbackTarget} onOpenChange={(open) => !open && setFeedbackTarget(null)} />
    </div>
  )
}

function SignalCard({ project }: { project: Project }) {
  const sourceLabel = project.signalSource === "llm" ? "LLM project signal" : "Weekly project signal"
  const provenance = [
    project.signalEvidenceTier ? `Evidence ${project.signalEvidenceTier}` : "",
    project.signalModel ? `Model ${project.signalModel}` : "",
  ]
    .filter(Boolean)
    .join(" · ")

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <Eyebrow>{sourceLabel}</Eyebrow>
          <CardTitle>{project.signal || "Signal unavailable"}</CardTitle>
        </div>
        {project.signalConfidence === null ? (
          <StatusPill project={project} />
        ) : (
          <Eyebrow>{`${Math.round(project.signalConfidence * 100)}% confidence`}</Eyebrow>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {project.signalDetail ? <p className="text-sm">{project.signalDetail}</p> : null}
        {provenance ? <span className="text-muted-foreground font-mono text-xs">{provenance}</span> : null}
      </CardContent>
    </Card>
  )
}

function HealthAssessmentCard({ project }: { project: Project }) {
  const assessment = project.healthAssessment

  if (!assessment) {
    return (
      <Card>
        <CardHeader className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <Eyebrow>Progress</Eyebrow>
            <CardTitle>{project.signal}</CardTitle>
          </div>
          <StatusPill project={project} />
        </CardHeader>
      </Card>
    )
  }

  const statusClass =
    assessment.statusClass === "risk" || assessment.statusClass === "watch" || assessment.statusClass === "clear"
      ? STATUS_PILL_CLASS[assessment.statusClass]
      : "bg-muted text-muted-foreground"
  const statusLabel = assessment.status ?? "Assessment returned"

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <Eyebrow>Project health</Eyebrow>
          <CardTitle>{statusLabel}</CardTitle>
        </div>
        <Badge variant="outline" className={statusClass}>
          {statusLabel}
        </Badge>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <AssessmentStat label="Score" value={formatAssessmentNumber(assessment.score)} />
          <AssessmentStat label="Confidence" value={formatAssessmentNumber(assessment.confidence, true)} />
          <AssessmentStat
            label="Expected week"
            value={
              assessment.expectedWeek === null || assessment.expectedWeek === undefined
                ? null
                : `Week ${assessment.expectedWeek}`
            }
          />
        </div>
        {assessment.explanation ? <p className="text-sm">{assessment.explanation}</p> : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <AssessmentBlock title="Blockers" items={assessment.blockers} />
          <AssessmentBlock title="Weekly tasks" items={assessment.weeklyTasks} />
        </div>
        {assessment.citations.length ? (
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">References</h3>
            <ul className="flex flex-col gap-1">
              {assessment.citations.map((citation, index) => {
                const label =
                  citation.label && citation.label !== citation.reference
                    ? `${citation.label} · ${citation.reference}`
                    : citation.reference
                const safeUrl = citation.url && /^https?:\/\//i.test(citation.url) ? citation.url : null
                return (
                  <li key={index} className="font-mono text-xs">
                    {safeUrl ? (
                      <a href={safeUrl} target="_blank" rel="noreferrer" className="underline underline-offset-4">
                        {label}
                      </a>
                    ) : (
                      label
                    )}
                  </li>
                )
              })}
            </ul>
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}

function AssessmentStat({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border p-3">
      <span className="text-muted-foreground text-xs">{label}</span>
      <strong className="text-base font-semibold tabular-nums">{value ?? <NoData />}</strong>
    </div>
  )
}

function AssessmentBlock({ title, items }: { title: string; items: { title: string; detail: string | null; week: string | number | null }[] }) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">{title}</h3>
      {items.length === 0 ? (
        <p className="text-muted-foreground text-sm">None</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((item, index) => (
            <li key={index} className="flex flex-col gap-0.5 rounded-md border p-2.5">
              <strong className="text-sm font-medium">{item.title}</strong>
              {item.week !== null && item.week !== undefined ? (
                <span className="text-muted-foreground text-xs">Week {item.week}</span>
              ) : null}
              {item.detail ? <span className="text-muted-foreground text-sm">{item.detail}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

const AGGREGATE_ROWS: [string, AggregateMetricKey, string][] = [
  ["Active days", "active_days", "d"],
  ["Days since activity", "days_since_activity", "d"],
  ["Open PRs", "open_prs", ""],
  ["Oldest open PR", "oldest_open_pr_days", "d"],
  ["Review latency", "review_latency_days", "d"],
  ["Merged PRs", "merged_count", ""],
]

function AggregateMetrics({ project, meta }: { project: Project; meta: SnapshotMeta }) {
  const rows = [...AGGREGATE_ROWS]
  /* Only shown when the aggregation floor was met; below it the metric is
     suppressed at the source and must not appear as zero. */
  if (hasOwn(project.metrics, "active_contributors")) {
    rows.push(["Active contributors (aggregate)", "active_contributors", ""])
  }

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle>Project aggregates</CardTitle>
        <Eyebrow>{meta.ruleSetVersion ?? "Current rules"}</Eyebrow>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {rows.map(([label, key, unit]) => (
            <div key={key} className="flex flex-col gap-0.5 rounded-lg border p-3">
              <span className="text-muted-foreground text-xs">{label}</span>
              <strong className="text-base font-semibold tabular-nums">
                <MetricValue value={project.metrics[key] ?? null} unit={unit} />
              </strong>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
