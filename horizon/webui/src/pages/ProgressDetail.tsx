/**
 * One project's cumulative-progress checkpoint.
 *
 * Deliberately NOT the weekly-snapshot profile. A checkpoint answers "where
 * does this project stand, cumulatively, as of this date", so it renders the
 * checkpoint's own fields -- trajectory, work to date, milestones, open
 * concerns -- and never a single week's metrics or series.
 *
 * Reached by deep link or refresh as well as from the inventory, so it reads
 * the same cache-only endpoint the list does but computes at most the ONE
 * project the URL names: running the portfolio fan-out here would spend an
 * LLM request per project to render a single-project screen.
 */

import { Link, Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { ArrowLeftIcon } from "lucide-react"

import { errorMessage } from "@/api/client"
import { finiteNumber } from "@/api/normalize"
import { latestSnapshotQuery } from "@/api/queries"
import type { CheckpointItem } from "@/api/types"
import { Eyebrow, Monogram, NoData, PageHeading, StatusPill } from "@/components/horizon/primitives"
import { AsOfBanner } from "@/components/horizon/snapshot-meta"
import { EmptyPanel, ErrorPanel, LoadingPanel } from "@/components/horizon/states"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { useProgressAt } from "@/hooks/use-progress-at"
import { formatDate } from "@/lib/format"
import { SEVERITY_CHIP_CLASS, SEVERITY_LABELS, TRAJECTORY_LABELS, WORK_LEVEL_LABELS } from "@/lib/status"
import { cn } from "@/lib/utils"

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export function ProgressDetail() {
  const { projectId = "" } = useParams()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const rawAsOf = searchParams.get("asOf")
  const asOf = rawAsOf && ISO_DATE.test(rawAsOf) ? rawAsOf : null

  const latest = useQuery(latestSnapshotQuery())
  const listed = latest.data?.snapshot.projects.find((project) => project.id === projectId)
  /* Only this project is computed on this screen; the portfolio fan-out
     belongs to the inventory page. */
  const progress = useProgressAt(asOf, Boolean(asOf), projectId)

  /* A checkpoint only exists relative to a date, so an undated progress link
     is not addressable. Send it to the inventory, where a date can be picked. */
  if (!asOf) return <Navigate to="/projects" replace />

  const entry = progress.entries[projectId]
  const fallbackName = listed?.name ?? projectId

  const backLink = (
    <Button variant="ghost" size="sm" asChild className="w-fit -translate-x-2">
      <Link to={`/projects?asOf=${encodeURIComponent(asOf)}`}>
        <ArrowLeftIcon className="size-4" aria-hidden="true" />
        Back to portfolio progress as of {formatDate(asOf)}
      </Link>
    </Button>
  )

  if (progress.isLoading || !entry || entry.state === "pending") {
    return (
      <div className="flex flex-col gap-6">
        {backLink}
        <PageHeading title={fallbackName} />
        <AsOfBanner date={asOf} kind="Cumulative" />
        <LoadingPanel label="Computing cumulative progress" />
      </div>
    )
  }

  if (entry.state === "error" || progress.error) {
    return (
      <div className="flex flex-col gap-6">
        {backLink}
        <PageHeading title={fallbackName} />
        <AsOfBanner date={asOf} kind="Cumulative" />
        <ErrorPanel
          message={entry.state === "error" ? entry.error : errorMessage(progress.error)}
          onRetry={() => progress.retryProject(projectId)}
        />
      </div>
    )
  }

  const project = entry.data

  /* A checkpoint the server had nothing to build from: say so rather than
     dressing an empty synthesis up as a verdict. */
  if (!project?.checkpointId) {
    return (
      <div className="flex flex-col gap-6">
        {backLink}
        <PageHeading title={project?.name ?? fallbackName} />
        <AsOfBanner date={asOf} kind="Cumulative" />
        <EmptyPanel
          title="No progress data"
          description="No cumulative checkpoint could be built for this project up to the selected date."
        />
      </div>
    )
  }

  const confidence = finiteNumber(project.confidence)
  const fidelityBits: string[] = []
  if (project.weeksTotal) {
    const deep = project.weeksDeepJudged ?? 0
    const shallow = project.weeksTotal - deep
    fidelityBits.push(
      `${deep} of ${project.weeksTotal} weeks reviewed in depth${shallow > 0 ? `; the other ${shallow} counted from commit metadata only` : ""}`,
    )
  }
  if (project.historyTruncated) fidelityBits.push("history was truncated, so older activity may be missing")
  if (project.isProvisional) fidelityBits.push("provisional — this date falls in the current, in-progress week")
  if (project.generatedAt) fidelityBits.push(`synthesized ${formatDate(project.generatedAt, true)}`)

  return (
    <div className="flex flex-col gap-6">
      <PageHeading
        back={backLink}
        title={
          <span className="flex flex-wrap items-center gap-3">
            <Monogram
              short={listed?.short ?? project.name.slice(0, 2).toUpperCase()}
              statusClass={project.statusClass}
              size="lg"
            />
            <span className="flex flex-col">
              <span>{project.name}</span>
              <span className="text-muted-foreground text-sm font-normal">
                {project.team} · {project.repo}
              </span>
            </span>
            <StatusPill project={project} />
          </span>
        }
        actions={
          <Button variant="outline" size="sm" onClick={() => navigate(`/projects/${encodeURIComponent(projectId)}`)}>
            Open weekly profile
          </Button>
        }
      />

      <AsOfBanner date={asOf} kind="Cumulative" />

      {project.narrative ? (
        <Card>
          <CardContent className="flex flex-col gap-2">
            <Eyebrow>Summary</Eyebrow>
            <p className="text-sm leading-relaxed">{project.narrative}</p>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader className="flex flex-col gap-1">
          <Eyebrow>Cumulative progress</Eyebrow>
          <CardTitle>{project.headline ?? "Cumulative progress"}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="flex flex-col gap-0.5 rounded-lg border p-3">
              <span className="text-muted-foreground text-xs">Trajectory</span>
              <strong className="text-base font-semibold">
                {TRAJECTORY_LABELS[project.trajectory ?? "unknown"] ?? "Unknown"}
              </strong>
            </div>
            <div className="flex flex-col gap-0.5 rounded-lg border p-3">
              <span className="text-muted-foreground text-xs">Work to date</span>
              <strong className="text-base font-semibold">
                {project.workToDate ? (WORK_LEVEL_LABELS[project.workToDate] ?? project.workToDate) : <NoData />}
              </strong>
            </div>
            <div className="flex flex-col gap-0.5 rounded-lg border p-3">
              <span className="text-muted-foreground text-xs">Confidence</span>
              <strong className="text-base font-semibold tabular-nums">
                {confidence === null ? <NoData /> : `${Math.round(confidence * 100)}%`}
              </strong>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <CheckpointBlock
              title="Milestones to date"
              items={project.milestones}
              empty="No grounded milestones were recorded up to this date."
            />
            <CheckpointBlock
              title="Open concerns"
              items={project.openConcerns}
              empty="No open concerns were recorded up to this date."
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <NoteBlock
              title="Recommendations"
              items={project.recommendations}
              empty="No recommendations were returned."
            />
            <NoteBlock title="Data gaps" items={project.dataGaps} empty="No data gaps were reported." />
          </div>

          {fidelityBits.length ? (
            <p className="text-muted-foreground text-xs">{fidelityBits.join(" · ")}</p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  )
}

function CheckpointBlock({
  title,
  items,
  empty,
}: {
  title: string
  items: CheckpointItem[] | undefined
  empty: string
}) {
  const list = items ?? []
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">{title}</h3>
      {list.length === 0 ? (
        <p className="text-muted-foreground text-sm">{empty}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {list.map((item, index) => (
            <li key={index} className="flex flex-col gap-1 rounded-md border p-2.5">
              <span className="flex flex-wrap items-center gap-2">
                <strong className="text-sm font-medium">{item.text}</strong>
                {item.severity ? (
                  <Badge variant="outline" className={cn(SEVERITY_CHIP_CLASS[item.severity])}>
                    {SEVERITY_LABELS[item.severity] ?? item.severity}
                  </Badge>
                ) : null}
              </span>
              {item.evidence?.length ? (
                <ul className="text-muted-foreground flex flex-col gap-0.5 pl-4 font-mono text-xs">
                  {item.evidence
                    .filter((reference) => typeof reference === "string" && reference.trim())
                    .map((reference, referenceIndex) => (
                      <li key={referenceIndex} className="list-disc">
                        {reference}
                      </li>
                    ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function NoteBlock({ title, items, empty }: { title: string; items: string[] | undefined; empty: string }) {
  const list = (items ?? []).filter((item) => typeof item === "string" && item.trim())
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">{title}</h3>
      {list.length === 0 ? (
        <p className="text-muted-foreground text-sm">{empty}</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {list.map((item, index) => (
            <li key={index} className="rounded-md border p-2.5 text-sm">
              {item}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
