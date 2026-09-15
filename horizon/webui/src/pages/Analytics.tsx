/**
 * Gitea analytics -- the read-only view of one pinned pipeline run.
 *
 * The run version is pinned from `/artifacts/latest/manifest.json` and every
 * file is then read from `/artifacts/{run_id}/…` through the authenticated API
 * route, never from a generic static file server.
 *
 * Collection warnings are shown first, because a run with warnings is a run
 * that is *missing* data: a repository with pull requests disabled returns 404
 * and contributes no PR, review or approval rows at all.
 */

import { useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { DatabaseIcon, ExternalLinkIcon } from "lucide-react"

import { errorMessage } from "@/api/client"
import { artifactJsonQuery, artifactManifestQuery, queryKeys } from "@/api/queries"
import { useOperatorSession } from "@/auth/use-operator-session"
import { OperatorSessionDialog } from "@/components/horizon/operator-session-dialog"
import { Eyebrow, MetricValue, Mono, PageHeading } from "@/components/horizon/primitives"
import { EmptyPanel, EmptyTableRow, ErrorPanel, LoadingPanel } from "@/components/horizon/states"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  artifactDisplayName,
  coverageWarnings,
  makeOrganizationRows,
  makeRepositoryRows,
  safeExternalUrl,
  type AnalyticsArtifact,
  type ArtifactMember,
} from "@/lib/artifact-analytics"
import { formatCount, formatDate } from "@/lib/format"

const SORTS = [
  { key: "commits", label: "Commits" },
  { key: "blame_lines", label: "Blame lines" },
  { key: "pulls_merged", label: "Merged PRs" },
  { key: "reviews_submitted", label: "Reviews" },
  { key: "additions", label: "Additions" },
  { key: "active_days", label: "Active days" },
  { key: "name", label: "Name" },
] as const

type SortKey = (typeof SORTS)[number]["key"]

export function Analytics() {
  const { signedIn } = useOperatorSession()
  const [search, setSearch] = useState("")
  const [organization, setOrganization] = useState("all")
  const [sort, setSort] = useState<SortKey>("commits")
  const [selected, setSelected] = useState<ArtifactMember | null>(null)

  const manifest = useQuery(artifactManifestQuery())
  const runId = manifest.data?.run_id ?? ""
  const analytics = useQuery({
    ...artifactJsonQuery<AnalyticsArtifact>(runId, "analytics.json", queryKeys.artifactAnalytics(runId)),
    enabled: Boolean(runId),
  })

  const data = analytics.data
  const members = useMemo(() => data?.members ?? [], [data])
  const repositories = useMemo(() => makeRepositoryRows(data?.organizations ?? []), [data])
  const organizations = useMemo(
    () => makeOrganizationRows(data?.organizations ?? [], members),
    [data, members],
  )

  const warnings = useMemo(
    () => [...new Set([...(data?.warnings ?? []), ...coverageWarnings(data?.coverage ?? [])])],
    [data],
  )

  const filteredMembers = useMemo(() => {
    const query = search.trim().toLowerCase()
    return members
      .filter((member) => {
        const matchesOrg = organization === "all" || (member.organizations ?? []).includes(organization)
        const searchable = [member.name, member.login, member.email, ...(member.organizations ?? [])]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
        return matchesOrg && (!query || searchable.includes(query))
      })
      .sort((left, right) => {
        if (sort === "name") return artifactDisplayName(left).localeCompare(artifactDisplayName(right))
        return Number(right[sort] ?? 0) - Number(left[sort] ?? 0)
      })
  }, [members, organization, search, sort])

  const summaryCards: [string, number | null][] = [
    ["Organizations", data?.organizations?.length ?? null],
    ["Repositories", repositories.length],
    ["Roster memberships", (data?.organizations ?? []).reduce((total, org) => total + Number(org.member_count ?? 0), 0)],
    [
      "Roster members",
      members.filter((member) => member.roster_member !== false && !member.service_or_admin).length,
    ],
    ["Unmatched identities", members.filter((member) => member.roster_member === false).length],
    ["Repository commits", repositories.reduce((total, repo) => total + repo.commitCount, 0)],
    ["Pull requests", repositories.reduce((total, repo) => total + repo.pullCount, 0)],
    ["Issues", repositories.reduce((total, repo) => total + Number(repo.issue_count ?? 0), 0)],
  ]

  const failed = manifest.isError || analytics.isError
  const error = manifest.error ?? analytics.error

  return (
    <div className="flex flex-col gap-6">
      <PageHeading
        eyebrow="Horizon / engineering insights"
        title="Gitea analytics"
        meta={
          <div className="flex flex-col gap-1">
            <p className="text-muted-foreground max-w-prose text-sm">
              A read-only view of repository activity, collaboration and current code ownership. These are
              descriptive activity indicators, not a performance score.
            </p>
            {runId ? (
              <Mono className="text-muted-foreground">
                Run {runId}
                {data?.generated_at ? ` · updated ${formatDate(data.generated_at, true)}` : ""}
                {data?.api_calls !== null && data?.api_calls !== undefined
                  ? ` · ${formatCount(data.api_calls)} API calls`
                  : ""}
              </Mono>
            ) : null}
          </div>
        }
        actions={
          <>
            <Badge variant={runId ? "secondary" : "outline"}>
              {runId ? (data?.history_scope ?? "Latest run") : "No data"}
            </Badge>
            <OperatorSessionDialog />
          </>
        }
      />

      {failed ? (
        <ErrorPanel
          title="Analytics data is not available yet"
          message={`${errorMessage(error)}${signedIn ? "" : " Artifact reads require an operator session outside local mode."}`}
          onRetry={() => {
            void manifest.refetch()
            void analytics.refetch()
          }}
        />
      ) : null}

      {(manifest.isPending || analytics.isPending) && !failed ? (
        <LoadingPanel label="Loading the pinned analytics run" />
      ) : null}

      {data ? (
        <>
          {warnings.length ? (
            <details className="rounded-lg border p-3 text-sm" open>
              <summary className="cursor-pointer font-medium">
                {warnings.length} collection warning{warnings.length === 1 ? "" : "s"} — some data is missing from
                this run
              </summary>
              <ul className="mt-2 flex flex-col gap-1 pl-4">
                {warnings.map((warning, index) => (
                  <li key={index} className="list-disc">
                    <Mono>{warning}</Mono>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {summaryCards.map(([label, value]) => (
              <Card key={label}>
                <CardContent className="flex flex-col gap-1.5">
                  <span className="text-muted-foreground text-xs font-medium">{label}</span>
                  <span className="font-display text-2xl leading-none font-semibold tabular-nums">
                    <MetricValue value={value} format="count" />
                  </span>
                </CardContent>
              </Card>
            ))}
          </div>

          <Card>
            <CardContent className="grid gap-4 sm:grid-cols-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="analytics-search">Find a member</Label>
                <Input
                  id="analytics-search"
                  type="search"
                  placeholder="Name, login, or email"
                  autoComplete="off"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="analytics-org">Organization</Label>
                <Select value={organization} onValueChange={setOrganization}>
                  <SelectTrigger id="analytics-org">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All organizations</SelectItem>
                    {organizations.map((org) => (
                      <SelectItem key={org.name} value={org.name}>
                        {org.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="analytics-sort">Sort members by</Label>
                <Select value={sort} onValueChange={(value) => setSort(value as SortKey)}>
                  <SelectTrigger id="analytics-sort">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SORTS.map((option) => (
                      <SelectItem key={option.key} value={option.key}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </CardContent>
          </Card>

          <Tabs defaultValue="members">
            <TabsList>
              <TabsTrigger value="members">Members</TabsTrigger>
              <TabsTrigger value="repositories">Repositories</TabsTrigger>
              <TabsTrigger value="organizations">Organizations</TabsTrigger>
            </TabsList>

            <TabsContent value="members">
              <Card>
                <CardContent className="flex flex-col gap-3">
                  <Eyebrow>
                    {formatCount(filteredMembers.length)} of {formatCount(members.length)} records
                  </Eyebrow>
                  <div className="w-full overflow-x-auto rounded-md border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Member</TableHead>
                          <TableHead>Organizations</TableHead>
                          <TableHead>Commits</TableHead>
                          <TableHead>Additions</TableHead>
                          <TableHead>Deletions</TableHead>
                          <TableHead>Files</TableHead>
                          <TableHead>PRs</TableHead>
                          <TableHead>Merged</TableHead>
                          <TableHead>Reviews</TableHead>
                          <TableHead>Approved</TableHead>
                          <TableHead>Issues</TableHead>
                          <TableHead>Active days</TableHead>
                          <TableHead>Blame lines</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {filteredMembers.length === 0 ? (
                          <EmptyTableRow columns={13} message="No members match the current filters." />
                        ) : (
                          filteredMembers.map((member) => (
                            <TableRow
                              key={member.login ?? artifactDisplayName(member)}
                              tabIndex={0}
                              role="button"
                              aria-label={`View ${artifactDisplayName(member)}`}
                              className="cursor-pointer"
                              onClick={() => setSelected(member)}
                              onKeyDown={(event) => {
                                if (event.key === "Enter" || event.key === " ") {
                                  event.preventDefault()
                                  setSelected(member)
                                }
                              }}
                            >
                              <TableCell>
                                <div className="flex flex-col gap-1">
                                  <span className="flex items-center gap-2">
                                    <span className="text-sm font-medium">{artifactDisplayName(member)}</span>
                                    {member.service_or_admin ? (
                                      <Badge
                                        variant="outline"
                                        className="bg-status-pause-surface text-status-pause"
                                        title="Admin or automation account; not comparable with member rows"
                                      >
                                        service
                                      </Badge>
                                    ) : member.roster_member === false ? (
                                      <Badge
                                        variant="outline"
                                        className="bg-status-watch-surface text-status-watch"
                                        title="Commit identity that could not be matched to a Gitea roster member; may duplicate a member row"
                                      >
                                        unmatched
                                      </Badge>
                                    ) : null}
                                  </span>
                                  <Mono className="text-muted-foreground">
                                    {member.login || member.email || "unmatched identity"}
                                  </Mono>
                                </div>
                              </TableCell>
                              <TableCell className="text-sm">
                                {(member.organizations ?? []).join(", ") || "—"}
                              </TableCell>
                              <NumberCell value={member.commits} />
                              <NumberCell value={member.additions} />
                              <NumberCell value={member.deletions} />
                              <NumberCell value={member.unique_files ?? member.files_changed} />
                              <NumberCell value={member.pulls_opened} />
                              <NumberCell value={member.pulls_merged} />
                              <NumberCell value={member.reviews_submitted} />
                              <NumberCell value={member.reviews_approved} />
                              <NumberCell value={member.issues_opened} />
                              <NumberCell value={member.active_days} />
                              <NumberCell value={member.blame_lines} />
                            </TableRow>
                          ))
                        )}
                      </TableBody>
                    </Table>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="repositories">
              <Card>
                <CardContent className="flex flex-col gap-3">
                  <Eyebrow>{formatCount(repositories.length)} repositories</Eyebrow>
                  <div className="w-full overflow-x-auto rounded-md border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Repository</TableHead>
                          <TableHead>Organization</TableHead>
                          <TableHead>Default branch</TableHead>
                          <TableHead>Branches</TableHead>
                          <TableHead>Commits</TableHead>
                          <TableHead>PRs</TableHead>
                          <TableHead>Merged</TableHead>
                          <TableHead>Issues</TableHead>
                          <TableHead>Links</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {repositories.length === 0 ? (
                          <EmptyTableRow columns={9} message="No repositories were collected." />
                        ) : (
                          [...repositories]
                            .sort((a, b) => b.commitCount - a.commitCount || a.name.localeCompare(b.name))
                            .map((repo) => {
                              const url = safeExternalUrl(repo.html_url)
                              return (
                                <TableRow key={`${repo.organization}/${repo.name}`}>
                                  <TableCell>
                                    <div className="flex flex-col">
                                      <span className="text-sm font-medium">{repo.name}</span>
                                      <Mono className="text-muted-foreground">
                                        {repo.organization}/{repo.name}
                                      </Mono>
                                    </div>
                                  </TableCell>
                                  <TableCell className="text-sm">{repo.organization}</TableCell>
                                  <TableCell className="text-sm">{repo.default_branch || "—"}</TableCell>
                                  <NumberCell value={(repo.branches ?? []).length} />
                                  <NumberCell value={repo.commitCount} />
                                  <NumberCell value={repo.pullCount} />
                                  <NumberCell value={repo.mergedCount} />
                                  <NumberCell value={repo.issue_count} />
                                  <TableCell>
                                    {url ? (
                                      <a
                                        href={url}
                                        target="_blank"
                                        rel="noreferrer"
                                        aria-label={`Open ${repo.name} in Gitea`}
                                      >
                                        <ExternalLinkIcon className="size-4" aria-hidden="true" />
                                      </a>
                                    ) : (
                                      <span className="text-muted-foreground">—</span>
                                    )}
                                  </TableCell>
                                </TableRow>
                              )
                            })
                        )}
                      </TableBody>
                    </Table>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="organizations">
              <Card>
                <CardContent className="flex flex-col gap-3">
                  <Eyebrow>{formatCount(organizations.length)} organizations</Eyebrow>
                  <div className="w-full overflow-x-auto rounded-md border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Organization</TableHead>
                          <TableHead>Roster</TableHead>
                          <TableHead>Active members</TableHead>
                          <TableHead>Repositories</TableHead>
                          <TableHead>Branches</TableHead>
                          <TableHead>Commits</TableHead>
                          <TableHead>PRs</TableHead>
                          <TableHead>Merged</TableHead>
                          <TableHead>Issues</TableHead>
                          <TableHead>Blame lines</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {organizations.length === 0 ? (
                          <EmptyTableRow columns={10} message="No organizations were collected." />
                        ) : (
                          [...organizations]
                            .sort((a, b) => b.commits - a.commits || a.name.localeCompare(b.name))
                            .map((org) => (
                              <TableRow key={org.name}>
                                <TableCell className="text-sm font-medium">{org.name}</TableCell>
                                <NumberCell value={org.roster} />
                                <NumberCell value={org.activeMembers} />
                                <NumberCell value={org.repositories} />
                                <NumberCell value={org.branches} />
                                <NumberCell value={org.commits} />
                                <NumberCell value={org.pulls} />
                                <NumberCell value={org.merged} />
                                <NumberCell value={org.issues} />
                                <NumberCell value={org.blameLines} />
                              </TableRow>
                            ))
                        )}
                      </TableBody>
                    </Table>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>

          <p className="text-muted-foreground text-xs">
            {data.history_scope?.includes("all discovered")
              ? "Commit history includes discovered branches; diff stats are requested for every selected commit and marked unavailable when collection fails."
              : "Commit history uses the default branch."}{" "}
            {data.blame?.status === "disabled"
              ? "Line ownership was not collected for this run."
              : `Line ownership status: ${data.blame?.status ?? "unknown"}.`}{" "}
            Metrics are descriptive indicators, not a score.
          </p>
        </>
      ) : null}

      {!data && !failed && !manifest.isPending && !analytics.isPending ? (
        <EmptyPanel
          title="Analytics data is not available yet"
          description="Run the pipeline from the project folder, then reload this page."
          icon={<DatabaseIcon className="size-8" />}
        />
      ) : null}

      <MemberDialog member={selected} onOpenChange={(open) => !open && setSelected(null)} />
    </div>
  )
}

function NumberCell({ value }: { value: number | null | undefined }) {
  return (
    <TableCell className="tabular-nums">
      <MetricValue value={value ?? null} format="count" />
    </TableCell>
  )
}

function MemberDialog({
  member,
  onOpenChange,
}: {
  member: ArtifactMember | null
  onOpenChange: (open: boolean) => void
}) {
  const metrics: [string, number | null | undefined][] = member
    ? [
        ["Commits", member.commits],
        ["Additions", member.additions],
        ["Deletions", member.deletions],
        ["Files changed", member.files_changed],
        ["PRs opened", member.pulls_opened],
        ["PRs merged", member.pulls_merged],
        ["Reviews", member.reviews_submitted],
        ["Approvals", member.reviews_approved],
        ["Issues", member.issues_opened],
        ["Active days", member.active_days],
        ["Blame lines", member.blame_lines],
        ["Blame files", member.blame_files],
      ]
    : []

  const first = member?.first_activity ? formatDate(member.first_activity, true) : ""
  const last = member?.last_activity ? formatDate(member.last_activity, true) : ""
  const activityWindow =
    first || last ? `${first || "Unknown start"} → ${last || "Unknown end"}` : "No recorded activity in the collected scope"

  return (
    <Dialog open={member !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <Eyebrow>Member detail</Eyebrow>
          <DialogTitle>{member ? artifactDisplayName(member) : ""}</DialogTitle>
          <DialogDescription>
            {member ? `${member.login || "—"} · ${member.email || "no email"}` : ""}
          </DialogDescription>
        </DialogHeader>
        {member ? (
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {metrics.map(([label, value]) => (
                <div key={label} className="flex flex-col gap-0.5 rounded-md border p-2">
                  <span className="text-muted-foreground text-xs">{label}</span>
                  <strong className="text-sm font-semibold tabular-nums">
                    <MetricValue value={value ?? null} format="count" />
                  </strong>
                </div>
              ))}
            </div>
            <DetailRow label="Organizations" value={(member.organizations ?? []).join(", ") || "—"} />
            <DetailRow label="Repositories touched" value={(member.repositories ?? []).join(", ") || "—"} />
            <DetailRow label="Activity window" value={activityWindow} />
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <h3 className="text-sm font-medium">{label}</h3>
      <p className="text-muted-foreground text-sm">{value}</p>
    </div>
  )
}
