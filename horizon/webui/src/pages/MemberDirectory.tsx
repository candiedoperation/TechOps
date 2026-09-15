/**
 * Member directory -- named per-person contribution metrics from `/analytics/*`.
 *
 * Every surface here repeats the framing the collector's own report carries:
 * these are descriptive activity indicators, **not a performance score**.
 *
 * Three things follow from that and are load-bearing:
 *  - a run's collection warnings are shown, because a warning means part of
 *    the run is *missing*, not zero;
 *  - unmatched identities and service accounts are badged, because an
 *    unmatched row may be a second identity for somebody already listed; and
 *  - a null metric renders as "no data", never as 0.
 *
 * This surface is independent of the portfolio snapshot: a failing
 * `/snapshots/latest` must not take it down.
 */

import { useEffect, useState } from "react"
import { Link, useNavigate, useSearchParams } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { UsersIcon } from "lucide-react"

import { errorMessage } from "@/api/client"
import {
  analyticsMembersQuery,
  analyticsOrganizationsQuery,
  analyticsSummaryQuery,
  type MemberQueryParams,
} from "@/api/queries"
import { MemberBadge, RunMeta, RunWarnings } from "@/components/horizon/member-chrome"
import { Eyebrow, MetricValue, Mono, PageHeading } from "@/components/horizon/primitives"
import { EmptyPanel, EmptyTableRow, ErrorPanel, TableSkeletonRows } from "@/components/horizon/states"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  MEMBER_COLUMNS,
  MEMBER_SORTS,
  MEMBER_SORT_KEYS,
  MEMBER_TABLE_COLUMN_COUNT,
  memberDisplayName,
  memberMetric,
} from "@/lib/members"

export function MemberDirectory() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()

  const sortParam = searchParams.get("sort")
  const sort = sortParam && MEMBER_SORT_KEYS.includes(sortParam) ? sortParam : "commits"
  const organization = searchParams.get("org") ?? "all"

  /* The search box re-queries the server rather than filtering in place, so it
     is debounced; the selects and checkboxes fire immediately. */
  const [searchInput, setSearchInput] = useState("")
  const [search, setSearch] = useState("")
  const [includeService, setIncludeService] = useState(true)
  const [includeUnmatched, setIncludeUnmatched] = useState(true)

  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(searchInput), 250)
    return () => window.clearTimeout(timer)
  }, [searchInput])

  const params: MemberQueryParams = { sort, organization, search, includeService, includeUnmatched }

  const summary = useQuery(analyticsSummaryQuery())
  const organizations = useQuery(analyticsOrganizationsQuery())
  const members = useQuery(analyticsMembersQuery(params))

  function setQuery(next: { sort?: string; org?: string }) {
    const updated = new URLSearchParams(searchParams)
    const nextSort = next.sort ?? sort
    if (nextSort === "commits") updated.delete("sort")
    else updated.set("sort", nextSort)
    const nextOrg = next.org ?? organization
    if (nextOrg === "all") updated.delete("org")
    else updated.set("org", nextOrg)
    setSearchParams(updated)
  }

  const totals = summary.data?.totals
  const run = summary.data?.run

  const totalCards: [string, number | null | undefined][] = [
    ["Roster members", totals?.roster_members],
    ["Active members", totals?.active_members],
    ["Unmatched identities", totals?.unmatched_identities],
    ["Repositories", totals?.repositories],
    ["Commits", totals?.commits],
    ["Merged PRs", totals?.merged_pull_requests],
    ["Issues", totals?.issues],
    ["Lines owned", totals?.blame_lines],
  ]

  return (
    <div className="flex flex-col gap-6">
      <PageHeading eyebrow="Gitea activity" title="Member directory" meta={<RunMeta run={run} />} />

      {summary.isError ? (
        <ErrorPanel message={errorMessage(summary.error)} onRetry={() => summary.refetch()} />
      ) : null}

      {!summary.isPending && !summary.isError && !run ? (
        <EmptyPanel
          title="No analytics data"
          description="No Gitea member-analytics run has been ingested yet."
          icon={<UsersIcon className="size-8" />}
        />
      ) : null}

      <RunWarnings run={run} />

      {totals ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {totalCards.map(([label, value]) => (
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
      ) : null}

      <Card>
        <CardContent className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="member-search">Find a member</Label>
            <Input
              id="member-search"
              type="search"
              placeholder="Name, login, or email"
              autoComplete="off"
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="member-org">Organization</Label>
            <Select value={organization} onValueChange={(value) => setQuery({ org: value })}>
              <SelectTrigger id="member-org">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All organizations</SelectItem>
                {(organizations.data ?? []).map((name) => (
                  <SelectItem key={name} value={name}>
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="member-sort">Sort by</Label>
            <Select value={sort} onValueChange={(value) => setQuery({ sort: value })}>
              <SelectTrigger id="member-sort">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MEMBER_SORTS.map((option) => (
                  <SelectItem key={option.key} value={option.key}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col justify-end gap-2">
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={includeUnmatched}
                onCheckedChange={(checked) => setIncludeUnmatched(checked === true)}
              />
              Unmatched identities
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={includeService}
                onCheckedChange={(checked) => setIncludeService(checked === true)}
              />
              Service accounts
            </label>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Contribution</CardTitle>
          <Eyebrow>Descriptive indicators, not a score</Eyebrow>
        </CardHeader>
        <CardContent>
          {members.isError ? (
            <ErrorPanel message={errorMessage(members.error)} onRetry={() => members.refetch()} />
          ) : (
            <div className="w-full overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Member</TableHead>
                    <TableHead>Organizations</TableHead>
                    {MEMBER_COLUMNS.map((column) => (
                      <TableHead key={column.key} className="text-right whitespace-nowrap">
                        {column.label}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {members.isPending ? (
                    <TableSkeletonRows columns={MEMBER_TABLE_COLUMN_COUNT} />
                  ) : (members.data ?? []).length === 0 ? (
                    <EmptyTableRow columns={MEMBER_TABLE_COLUMN_COUNT} message="No members match the current filters." />
                  ) : (
                    (members.data ?? []).map((member) => {
                      const open = () => navigate(`/members/${encodeURIComponent(member.login)}`)
                      return (
                        <TableRow
                          key={member.login}
                          tabIndex={0}
                          role="link"
                          aria-label={`View ${memberDisplayName(member)}`}
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
                            <div className="flex flex-col gap-1">
                              <span className="flex items-center gap-2">
                                <span className="text-sm font-medium">{memberDisplayName(member)}</span>
                                <MemberBadge member={member} />
                              </span>
                              <Mono className="text-muted-foreground">{member.login}</Mono>
                            </div>
                          </TableCell>
                          <TableCell className="text-sm">{(member.organizations ?? []).join(", ") || "—"}</TableCell>
                          {MEMBER_COLUMNS.map((column) => (
                            <TableCell key={column.key} className="text-right tabular-nums">
                              <MetricValue value={memberMetric(member, column.key)} format="count" />
                            </TableCell>
                          ))}
                        </TableRow>
                      )
                    })
                  )}
                </TableBody>
              </Table>
            </div>
          )}
          <p className="text-muted-foreground mt-3 text-xs">
            Volume is shaped by task size, role, collaboration style, generated code and repository history. These
            numbers should not be used alone for personnel decisions.{" "}
            <Link to="/analytics" className="underline underline-offset-4">
              Open the full Gitea analytics run
            </Link>
            .
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
