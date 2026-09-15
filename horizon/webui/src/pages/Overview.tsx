/**
 * Overview -- the portfolio's current standing, from `/snapshots/latest`.
 *
 * The four status tiles are filters: each one navigates to the inventory with
 * the matching chip applied, so a count can never disagree with the list it
 * claims to summarize.
 *
 * The delivery row below them comes from `/portfolio/delivery` and is allowed
 * to be missing. Contributor headcount is deliberately absent: the identity
 * map is empty, so that endpoint can only count distinct author strings -- a
 * headline figure of "people" built from that would be wrong.
 */

import { useEffect } from "react"
import { useNavigate, useSearchParams } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import {
  CalendarIcon,
  CircleCheckIcon,
  DatabaseIcon,
  FolderIcon,
  GitPullRequestIcon,
  MessageSquareIcon,
  TriangleAlertIcon,
  ActivityIcon,
  type LucideIcon,
} from "lucide-react"

import { errorMessage } from "@/api/client"
import { deliveryQuery, latestSnapshotQuery } from "@/api/queries"
import { Eyebrow, NoData, PageHeading } from "@/components/horizon/primitives"
import { WeekChip } from "@/components/horizon/snapshot-meta"
import { ErrorPanel, StatGridSkeleton } from "@/components/horizon/states"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { todayIsoDate } from "@/lib/format"
import { isActiveProject, isAttentionProject, type ProjectFilter } from "@/lib/status"
import { cn } from "@/lib/utils"

function StatTile({
  label,
  value,
  foot,
  icon: Icon,
  accentClass,
  onClick,
}: {
  label: string
  value: number | string | null
  foot: string
  icon: LucideIcon
  accentClass: string
  onClick?: () => void
}) {
  const body = (
    <CardContent className="flex flex-col gap-2">
      <span className="text-muted-foreground flex items-center justify-between text-xs font-medium">
        <span>{label}</span>
        <span className={cn("flex size-7 items-center justify-center rounded-md", accentClass)}>
          <Icon className="size-4" aria-hidden="true" />
        </span>
      </span>
      <span className="font-display text-3xl leading-none font-semibold tabular-nums">
        {value === null || value === undefined ? <NoData /> : value}
      </span>
      <span className="text-muted-foreground text-xs">{foot}</span>
    </CardContent>
  )

  if (!onClick) return <Card>{body}</Card>

  return (
    <button type="button" onClick={onClick} className="focus-visible:ring-ring/50 rounded-xl text-left focus-visible:ring-[3px] focus-visible:outline-none">
      <Card className="hover:border-primary/40 h-full transition-colors">{body}</Card>
    </button>
  )
}

export function Overview() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const asOf = searchParams.get("asOf")

  const latest = useQuery(latestSnapshotQuery())
  const delivery = useQuery(deliveryQuery())

  /* Overview is always live. Asking for a date here is a request to see the
     portfolio at that date, which lives entirely on the inventory page. */
  useEffect(() => {
    if (asOf) navigate(`/projects?asOf=${encodeURIComponent(asOf)}`, { replace: true })
  }, [asOf, navigate])

  const projects = latest.data?.snapshot.projects ?? []
  const attention = projects.filter(isAttentionProject)
  const clear = projects.filter((project) => project.statusClass === "clear")
  const insufficient = projects.filter((project) => project.statusClass === "data")
  const active = projects.filter(isActiveProject)

  const goToFilter = (filter: ProjectFilter) =>
    navigate(`/projects?filter=${encodeURIComponent(filter)}`)

  const oldestOpenPr = delivery.data?.oldest_open_pr_days
  const oldestLabel =
    typeof oldestOpenPr === "number" ? `${Math.round(oldestOpenPr)}d` : null

  return (
    <div className="flex flex-col gap-6">
      <PageHeading
        eyebrow="Overview"
        title="Portfolio snapshot"
        actions={
          <>
            {latest.data ? <WeekChip meta={latest.data.snapshot} /> : null}
            <div className="flex items-center gap-2">
              <Label htmlFor="overview-progress-date" className="text-muted-foreground text-xs">
                <CalendarIcon className="size-3.5" aria-hidden="true" />
                View progress as of
              </Label>
              <Input
                id="overview-progress-date"
                type="date"
                max={todayIsoDate()}
                className="w-40"
                onChange={(event) => {
                  if (event.target.value) {
                    navigate(`/projects?asOf=${encodeURIComponent(event.target.value)}`)
                  }
                }}
              />
            </div>
          </>
        }
      />

      {latest.isPending ? <StatGridSkeleton /> : null}

      {latest.isError ? (
        <ErrorPanel message={errorMessage(latest.error, "Snapshot unavailable.")} onRetry={() => latest.refetch()} />
      ) : null}

      {latest.data ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatTile
              label="Active projects"
              value={active.length}
              foot="Current"
              icon={FolderIcon}
              accentClass="bg-muted text-muted-foreground"
              onClick={() => goToFilter("Active projects")}
            />
            <StatTile
              label="Need attention"
              value={attention.length}
              foot="Review"
              icon={TriangleAlertIcon}
              accentClass="bg-status-watch-surface text-status-watch"
              onClick={() => goToFilter("Needs attention")}
            />
            <StatTile
              label="Clear"
              value={clear.length}
              foot="Server status"
              icon={CircleCheckIcon}
              accentClass="bg-status-clear-surface text-status-clear"
              onClick={() => goToFilter("Clear")}
            />
            <StatTile
              label="Insufficient data"
              value={insufficient.length}
              foot="Suppressed"
              icon={DatabaseIcon}
              accentClass="bg-status-data-surface text-status-data"
              onClick={() => goToFilter("Insufficient data")}
            />
          </div>

          <div className="flex flex-col gap-3">
            <Eyebrow>In flight</Eyebrow>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <StatTile
                label="Open PRs"
                value={delivery.data?.open_prs ?? null}
                foot="Open"
                icon={GitPullRequestIcon}
                accentClass="bg-muted text-muted-foreground"
              />
              <StatTile
                label="Oldest open PR"
                value={oldestLabel}
                foot="Oldest"
                icon={CalendarIcon}
                accentClass="bg-status-watch-surface text-status-watch"
              />
              <StatTile
                label="Branches ahead"
                value={delivery.data?.branches_ahead ?? null}
                foot="Ahead"
                icon={ActivityIcon}
                accentClass="bg-status-data-surface text-status-data"
              />
              <StatTile
                label="Open issues"
                value={delivery.data?.open_issues ?? null}
                foot="Open"
                icon={MessageSquareIcon}
                accentClass="bg-status-clear-surface text-status-clear"
              />
            </div>
            {delivery.isError ? (
              <p className="text-muted-foreground text-xs">
                Delivery facts are unavailable for this snapshot, so these four read as no data rather than zero.
              </p>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  )
}
