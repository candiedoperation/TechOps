/**
 * One identity's Gitea contribution record.
 *
 * A member with all-zero metrics stays visible with an explicit no-activity
 * explanation, and the reason is spelled out: a member whose organizations
 * hold no repositories had nothing to contribute to, which is a different fact
 * from having had the opportunity and not taken it.
 */

import { Link, useParams } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { ArrowLeftIcon } from "lucide-react"

import { errorMessage } from "@/api/client"
import { analyticsMemberQuery, analyticsSummaryQuery } from "@/api/queries"
import { Eyebrow, MetricValue, Mono, PageHeading } from "@/components/horizon/primitives"
import { EmptyPanel, ErrorPanel, LoadingPanel } from "@/components/horizon/states"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { MemberBadge, RunMeta } from "@/components/horizon/member-chrome"
import { memberDisplayName } from "@/lib/members"
import { formatDate } from "@/lib/format"

export function MemberDetail() {
  const { login = "" } = useParams()
  const member = useQuery({ ...analyticsMemberQuery(login), enabled: Boolean(login) })
  const summary = useQuery(analyticsSummaryQuery())

  const backLink = (
    <Button variant="ghost" size="sm" asChild className="w-fit -translate-x-2">
      <Link to="/members">
        <ArrowLeftIcon className="size-4" aria-hidden="true" />
        Back to member directory
      </Link>
    </Button>
  )

  if (member.isPending) {
    return (
      <div className="flex flex-col gap-6">
        {backLink}
        <LoadingPanel label="Loading member record" />
      </div>
    )
  }

  if (member.isError) {
    return (
      <div className="flex flex-col gap-6">
        {backLink}
        <ErrorPanel message={errorMessage(member.error)} onRetry={() => member.refetch()} />
      </div>
    )
  }

  if (!member.data) {
    return (
      <div className="flex flex-col gap-6">
        {backLink}
        <EmptyPanel title="Identity not found" description={`No Gitea record was returned for ${login}.`} />
      </div>
    )
  }

  const record = member.data
  const organizations = record.organizations ?? []
  const repositories = record.repositories ?? []
  const activityWindow = record.first_activity
    ? `${formatDate(record.first_activity)} – ${formatDate(record.last_activity ?? record.first_activity)}`
    : "No activity"

  const stats: [string, number | null | undefined][] = [
    ["Commits", record.commits],
    ["Additions", record.additions],
    ["Deletions", record.deletions],
    ["Files touched", record.unique_files ?? record.files_changed],
    ["PRs opened", record.pulls_opened],
    ["PRs merged", record.pulls_merged],
    ["Reviews", record.reviews_submitted],
    ["Approvals", record.reviews_approved],
    ["Issues opened", record.issues_opened],
    ["Active days", record.active_days],
    ["Lines owned", record.blame_lines],
    ["Files owned", record.blame_files],
  ]

  return (
    <div className="flex flex-col gap-6">
      <PageHeading
        back={backLink}
        eyebrow="Member"
        title={
          <span className="flex flex-wrap items-center gap-2">
            {memberDisplayName(record)}
            <MemberBadge member={record} />
          </span>
        }
        meta={
          <div className="flex flex-col gap-1">
            <Mono className="text-muted-foreground">
              {record.login}
              {record.email ? ` · ${record.email}` : ""}
            </Mono>
            <RunMeta run={summary.data?.run} />
          </div>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {stats.map(([label, value]) => (
          <Card key={label}>
            <CardContent className="flex flex-col gap-1.5">
              <span className="text-muted-foreground text-xs font-medium">{label}</span>
              <span className="font-display text-2xl leading-none font-semibold tabular-nums">
                <MetricValue value={value ?? null} format="count" />
              </span>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Context</CardTitle>
          <Eyebrow>Descriptive indicators, not a score</Eyebrow>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-3">
          <div className="flex flex-col gap-1">
            <span className="text-muted-foreground text-xs font-medium">Organizations</span>
            <p className="text-sm">{organizations.length ? organizations.join(", ") : "—"}</p>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-muted-foreground text-xs font-medium">Repositories touched</span>
            <p className="text-sm">{repositories.length ? repositories.join(", ") : "—"}</p>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-muted-foreground text-xs font-medium">Activity window</span>
            <p className="text-sm">{activityWindow}</p>
            {record.has_activity ? null : (
              <p className="text-muted-foreground text-xs">
                No activity in the collected scope. This is an observed absence, not a missing measurement.
              </p>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
