/**
 * Projects -- the portfolio inventory.
 *
 * Two things share this page, as they did in the vanilla app:
 *  - the filtered project table, whose rows compute their weekly signal only
 *    when they scroll into view (see `useLazyWeekSignals`); and
 *  - the cumulative-progress list for a chosen date, which appears above the
 *    table once a date is picked.
 *
 * The filter and the date both live in the query string, so a link to a
 * filtered or dated view is shareable and Back restores it.
 */

import { useNavigate, useSearchParams } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { CalendarIcon, Loader2Icon } from "lucide-react"

import { errorMessage } from "@/api/client"
import { latestSnapshotQuery } from "@/api/queries"
import type { Project } from "@/api/types"
import { LazyCell } from "@/components/horizon/lazy-cell"
import { Monogram, PageHeading, StatusPill } from "@/components/horizon/primitives"
import { EmptyTableRow, ErrorPanel, LoadingPanel, TableSkeletonRows } from "@/components/horizon/states"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useLazyWeekSignals } from "@/hooks/use-lazy-week-signals"
import { useProgressAt, type ProgressAtState, type ProgressEntry } from "@/hooks/use-progress-at"
import { formatDate, formatPercent, todayIsoDate } from "@/lib/format"
import { PROJECT_FILTERS, filterProjects, isProjectFilter, type ProjectFilter } from "@/lib/status"
import { cn } from "@/lib/utils"

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export function Projects() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()

  const filterParam = searchParams.get("filter")
  const filter: ProjectFilter = isProjectFilter(filterParam) ? filterParam : "All projects"
  /* A malformed date is dropped rather than honoured: it would be fed straight
     into an API query string. */
  const rawAsOf = searchParams.get("asOf")
  const asOf = rawAsOf && ISO_DATE.test(rawAsOf) ? rawAsOf : null

  const latest = useQuery(latestSnapshotQuery())
  const projects = latest.data?.snapshot.projects ?? []
  const lazy = useLazyWeekSignals(latest.data)
  const progress = useProgressAt(asOf, true)

  const filtered = filterProjects(projects, filter)

  function setQuery(next: { filter?: ProjectFilter; asOf?: string | null }) {
    const params = new URLSearchParams(searchParams)
    const nextFilter = next.filter ?? filter
    if (nextFilter === "All projects") params.delete("filter")
    else params.set("filter", nextFilter)
    const nextAsOf = next.asOf === undefined ? asOf : next.asOf
    if (nextAsOf) params.set("asOf", nextAsOf)
    else params.delete("asOf")
    setSearchParams(params)
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeading
        eyebrow="Portfolio inventory"
        title="All projects"
        actions={
          <div className="flex items-center gap-2">
            <Label htmlFor="progress-date" className="text-muted-foreground text-xs">
              <CalendarIcon className="size-3.5" aria-hidden="true" />
              View progress as of
            </Label>
            <Input
              id="progress-date"
              type="date"
              max={todayIsoDate()}
              value={asOf ?? ""}
              className="w-40"
              onChange={(event) => setQuery({ asOf: event.target.value || null })}
            />
            {asOf ? (
              <Button variant="ghost" size="sm" onClick={() => setQuery({ asOf: null })}>
                Back to live ×
              </Button>
            ) : null}
          </div>
        }
      />

      {asOf ? (
        <ProgressPanel
          date={asOf}
          progress={progress}
          projectNames={Object.fromEntries(projects.map((project) => [project.id, project]))}
        />
      ) : null}

      <Card>
        <CardHeader className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle>Project inventory</CardTitle>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter projects">
            {PROJECT_FILTERS.map((option) => (
              <Button
                key={option}
                size="sm"
                variant={option === filter ? "default" : "outline"}
                aria-pressed={option === filter}
                onClick={() => setQuery({ filter: option })}
              >
                {option}
              </Button>
            ))}
          </div>
        </CardHeader>
        <CardContent>
          {latest.isError ? (
            <ErrorPanel
              message={errorMessage(latest.error, "Snapshot unavailable.")}
              onRetry={() => latest.refetch()}
            />
          ) : (
            <div className="w-full overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Project</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Signal</TableHead>
                    <TableHead>Active</TableHead>
                    <TableHead>Coverage</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {latest.isPending ? (
                    <TableSkeletonRows columns={5} />
                  ) : filtered.length === 0 ? (
                    <EmptyTableRow columns={5} message="No projects match this filter." />
                  ) : (
                    filtered.map((project) => {
                      const state = lazy.rowState(project.id)
                      return (
                        <TableRow
                          key={project.id}
                          ref={state === "pending" ? lazy.observeRow(project.id) : undefined}
                          tabIndex={0}
                          role="link"
                          aria-label={`Open ${project.name}`}
                          className="cursor-pointer"
                          onClick={() => navigate(`/projects/${encodeURIComponent(project.id)}`)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault()
                              navigate(`/projects/${encodeURIComponent(project.id)}`)
                            }
                          }}
                        >
                          <TableCell>
                            <div className="flex items-center gap-3">
                              <Monogram short={project.short} statusClass={state ? null : project.statusClass} />
                              <div className="flex min-w-0 flex-col">
                                <span className="truncate text-sm font-medium">{project.name}</span>
                                <span className="text-muted-foreground truncate text-xs">
                                  {project.team} · {project.repo}
                                </span>
                              </div>
                            </div>
                          </TableCell>
                          {state ? (
                            <LazyCell
                              state={state}
                              colSpan={4}
                              error={lazy.errorFor(project.id)}
                              onRetry={() => lazy.retry(project.id)}
                            />
                          ) : (
                            <>
                              <TableCell>
                                <StatusPill project={project} />
                              </TableCell>
                              <TableCell className="max-w-[22rem]">
                                <span className="text-sm">{project.signal}</span>
                              </TableCell>
                              <TableCell>
                                <span className="text-muted-foreground text-xs">{project.lastActivity}</span>
                              </TableCell>
                              <TableCell>
                                <span className="text-muted-foreground text-xs">
                                  {formatPercent(project.dataCompletenessPct)}
                                </span>
                              </TableCell>
                            </>
                          )}
                        </TableRow>
                      )
                    })
                  )}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

/* ------------------------------------------------------- progress fan-out */

function ProgressPanel({
  date,
  progress,
  projectNames,
}: {
  date: string
  progress: ProgressAtState
  projectNames: Record<string, Project>
}) {
  if (progress.isLoading) return <LoadingPanel label={`Loading portfolio progress as of ${formatDate(date)}`} />
  if (progress.error) {
    return (
      <ErrorPanel message={errorMessage(progress.error, "Progress unavailable.")} onRetry={progress.refetch} />
    )
  }

  const ids = Object.keys(progress.entries)

  return (
    <Card>
      <CardHeader>
        <CardTitle>Portfolio progress as of {formatDate(date)}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {ids.length === 0 ? (
          <p className="text-muted-foreground text-sm">No projects were returned for this date.</p>
        ) : (
          ids.map((id) => (
            <ProgressRow
              key={id}
              projectId={id}
              entry={progress.entries[id]}
              fallback={projectNames[id]}
              date={date}
              onRetry={() => progress.retryProject(id)}
            />
          ))
        )}
      </CardContent>
    </Card>
  )
}

function ProgressRow({
  projectId,
  entry,
  fallback,
  date,
  onRetry,
}: {
  projectId: string
  entry: ProgressEntry | undefined
  fallback: Project | undefined
  date: string
  onRetry: () => void
}) {
  const navigate = useNavigate()
  const name = fallback?.name ?? projectId
  const context = fallback ? `${fallback.team} · ${fallback.repo}` : ""

  if (!entry || entry.state === "pending") {
    return (
      <div className="flex items-center gap-3 rounded-lg border p-3">
        <Monogram short={fallback?.short ?? projectId.slice(0, 2).toUpperCase()} statusClass={null} />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium">{name}</span>
          <span className="text-muted-foreground truncate text-xs">{context}</span>
        </div>
        <span className="text-muted-foreground flex items-center gap-2 text-xs" aria-live="polite">
          <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
          Computing progress…
        </span>
      </div>
    )
  }

  if (entry.state === "error") {
    return (
      <div className="flex items-center gap-3 rounded-lg border p-3">
        <Monogram short={fallback?.short ?? projectId.slice(0, 2).toUpperCase()} statusClass={null} />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium">{name}</span>
          <span className="text-muted-foreground truncate text-xs">{context}</span>
        </div>
        <Button variant="outline" size="sm" onClick={onRetry} title={entry.error}>
          Could not compute — Retry
        </Button>
      </div>
    )
  }

  const project = entry.data
  const fidelity =
    project.weeksTotal && project.weeksDeepJudged !== undefined && project.weeksDeepJudged !== null
      ? `${project.weeksDeepJudged} of ${project.weeksTotal} weeks reviewed in depth`
      : ""

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border p-3">
      <Monogram short={fallback?.short ?? project.name.slice(0, 2).toUpperCase()} statusClass={project.statusClass} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium">{project.name}</span>
          <StatusPill project={project} />
        </span>
        <span className="text-muted-foreground truncate text-xs">
          {project.team} · {project.repo}
        </span>
      </div>
      <div className={cn("flex min-w-0 flex-col", "max-w-sm")}>
        <strong className="truncate text-sm font-medium">{project.headline ?? ""}</strong>
        {fidelity ? <span className="text-muted-foreground font-mono text-[10px]">{fidelity}</span> : null}
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={() =>
          navigate(`/projects/${encodeURIComponent(projectId)}/progress?asOf=${encodeURIComponent(date)}`)
        }
      >
        View progress
      </Button>
    </div>
  )
}
