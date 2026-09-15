/**
 * Insights -- the last eight weeks, one row per project.
 *
 * The contributor column appears only when at least one project met the
 * aggregation floor, and is blank (never zero) for the projects that did not:
 * a suppressed count and a team of nobody are different facts.
 *
 * Rows without a snapshot for the current week carry the same viewport-gated
 * placeholder the inventory uses, so opening this page does not spend a
 * compute request on every project in the portfolio.
 */

import { useNavigate } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"

import { errorMessage } from "@/api/client"
import { hasOwn, lastValue, metricValue } from "@/api/normalize"
import { latestSnapshotQuery } from "@/api/queries"
import { LazyCell } from "@/components/horizon/lazy-cell"
import { MetricWithBaseline, Monogram, NoData, PageHeading, StatusPill } from "@/components/horizon/primitives"
import { SnapshotMetaLine } from "@/components/horizon/snapshot-meta"
import { EmptyTableRow, ErrorPanel, TableSkeletonRows } from "@/components/horizon/states"
import { Card, CardContent } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useLazyWeekSignals } from "@/hooks/use-lazy-week-signals"

export function Insights() {
  const navigate = useNavigate()
  const latest = useQuery(latestSnapshotQuery())
  const projects = latest.data?.snapshot.projects ?? []
  const lazy = useLazyWeekSignals(latest.data)

  const showContributors = projects.some((project) => hasOwn(project.metrics, "active_contributors"))
  const columnCount = showContributors ? 5 : 4

  return (
    <div className="flex flex-col gap-6">
      <PageHeading
        eyebrow="Last 8 weeks"
        title="Insights"
        meta={latest.data ? <SnapshotMetaLine meta={latest.data.snapshot} /> : undefined}
      />

      {latest.isError ? (
        <ErrorPanel message={errorMessage(latest.error, "Snapshot unavailable.")} onRetry={() => latest.refetch()} />
      ) : (
        <Card>
          <CardContent>
            <div className="w-full overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Project</TableHead>
                    <TableHead>
                      Activity <span className="text-muted-foreground font-normal">days/wk</span>
                    </TableHead>
                    <TableHead>Open PRs</TableHead>
                    <TableHead>Review latency</TableHead>
                    {showContributors ? (
                      <TableHead>
                        Active contributors{" "}
                        <span className="text-muted-foreground font-normal">aggregate only</span>
                      </TableHead>
                    ) : null}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {latest.isPending ? (
                    <TableSkeletonRows columns={columnCount} />
                  ) : projects.length === 0 ? (
                    <EmptyTableRow columns={columnCount} message="No project metrics returned." />
                  ) : (
                    projects.map((project) => {
                      const state = lazy.rowState(project.id)
                      const open = () => navigate(`/projects/${encodeURIComponent(project.id)}`)
                      return (
                        <TableRow
                          key={project.id}
                          ref={state === "pending" ? lazy.observeRow(project.id) : undefined}
                          tabIndex={0}
                          role="link"
                          aria-label={`Open ${project.name}`}
                          className="cursor-pointer"
                          onClick={open}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault()
                              open()
                            }
                          }}
                        >
                          <TableCell>
                            <div className="flex items-center gap-3">
                              <Monogram short={project.short} statusClass={state ? null : project.statusClass} />
                              <div className="flex min-w-0 flex-col gap-1">
                                <span className="truncate text-sm font-medium">{project.name}</span>
                                <span className="text-muted-foreground truncate text-xs">{project.team}</span>
                              </div>
                              {state ? null : <StatusPill project={project} />}
                            </div>
                          </TableCell>
                          {state ? (
                            <LazyCell
                              state={state}
                              colSpan={columnCount - 1}
                              error={lazy.errorFor(project.id)}
                              onRetry={() => lazy.retry(project.id)}
                            />
                          ) : (
                            <>
                              <TableCell>
                                <MetricWithBaseline
                                  value={metricValue(project.metrics, "active_days", lastValue(project.series.activity))}
                                  baseline={project.seriesBaselines.activity?.[0] ?? null}
                                />
                              </TableCell>
                              <TableCell>
                                <MetricWithBaseline
                                  value={metricValue(project.metrics, "open_prs", lastValue(project.series.openPRs))}
                                  baseline={project.seriesBaselines.openPRs?.[0] ?? null}
                                />
                              </TableCell>
                              <TableCell>
                                <MetricWithBaseline
                                  value={metricValue(
                                    project.metrics,
                                    "review_latency_days",
                                    lastValue(project.series.reviewLatency),
                                  )}
                                  baseline={project.seriesBaselines.reviewLatency?.[0] ?? null}
                                  unit="d"
                                />
                              </TableCell>
                              {showContributors ? (
                                <TableCell>
                                  {hasOwn(project.metrics, "active_contributors") ? (
                                    <MetricWithBaseline
                                      value={project.metrics.active_contributors ?? null}
                                      baseline={project.seriesBaselines.contributors?.[0] ?? null}
                                    />
                                  ) : (
                                    <NoData />
                                  )}
                                </TableCell>
                              ) : null}
                            </>
                          )}
                        </TableRow>
                      )
                    })
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
