/**
 * Member profiles -- People Portal membership joined to Gitea activity.
 *
 * Two artifacts from one pinned run: `analytics.json` and
 * `member-profiles.json`. Pinning matters here more than anywhere else,
 * because the page joins rows from both files: reading each as `latest` could
 * straddle a publish and pair a profile with another run's metrics.
 *
 * Gitea identities that matched no People Portal profile are kept visible as
 * their own rows rather than discarded -- the activity was really collected,
 * it just has no profile to attach to.
 *
 * Résumé files are fetched through the authenticated artifact route and handed
 * to the browser as a blob; no résumé URL is ever a plain link.
 */

import { useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { DownloadIcon, UsersRoundIcon } from "lucide-react"
import { toast } from "sonner"

import { errorMessage, requestBlob } from "@/api/client"
import { artifactJsonQuery, artifactManifestQuery, queryKeys } from "@/api/queries"
import { useOperatorSession } from "@/auth/use-operator-session"
import { OperatorSessionDialog } from "@/components/horizon/operator-session-dialog"
import { Eyebrow, MetricValue, Mono, NoData, PageHeading } from "@/components/horizon/primitives"
import { EmptyPanel, EmptyTableRow, ErrorPanel, LoadingPanel } from "@/components/horizon/states"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  artifactDisplayName,
  coverageWarnings,
  profileMetrics,
  profileName,
  profileOrganizations,
  type AnalyticsArtifact,
  type ArtifactMember,
  type MemberProfile,
  type ProfilesArtifact,
} from "@/lib/artifact-analytics"
import { formatCount, formatDate } from "@/lib/format"

const SORTS = [
  { key: "name", label: "Name" },
  { key: "applications", label: "Applications" },
  { key: "commits", label: "Commits" },
  { key: "pulls_merged", label: "Merged PRs" },
  { key: "reviews_submitted", label: "Reviews" },
  { key: "issues_opened", label: "Issues" },
  { key: "active_days", label: "Active days" },
] as const

type SortKey = (typeof SORTS)[number]["key"]

type Row =
  | { kind: "profile"; profile: MemberProfile; key: string }
  | { kind: "gitea"; member: ArtifactMember; key: string }

function profileSortValue(profile: MemberProfile, sort: SortKey): number | string {
  if (sort === "name") return profileName(profile).toLowerCase()
  if (sort === "applications") return Number(profile.people_portal?.applicationCount ?? 0)
  return Number(profileMetrics(profile)[sort] ?? 0)
}

function memberSortValue(member: ArtifactMember, sort: SortKey): number | string {
  if (sort === "name") return artifactDisplayName(member).toLowerCase()
  if (sort === "applications") return 0
  return Number(member[sort] ?? 0)
}

export function Profiles() {
  const { signedIn } = useOperatorSession()
  const [search, setSearch] = useState("")
  const [organization, setOrganization] = useState("all")
  const [sort, setSort] = useState<SortKey>("name")
  const [openProfile, setOpenProfile] = useState<MemberProfile | null>(null)
  const [openMember, setOpenMember] = useState<ArtifactMember | null>(null)

  const manifest = useQuery(artifactManifestQuery())
  const runId = manifest.data?.run_id ?? ""
  const artifactRoot = runId ? `/artifacts/${encodeURIComponent(runId)}` : ""

  const analytics = useQuery({
    ...artifactJsonQuery<AnalyticsArtifact>(runId, "analytics.json", queryKeys.artifactAnalytics(runId)),
    enabled: Boolean(runId),
  })
  const profilesArtifact = useQuery({
    ...artifactJsonQuery<ProfilesArtifact>(
      runId,
      "member-profiles.json",
      queryKeys.artifactProfiles(runId),
    ),
    enabled: Boolean(runId),
  })

  const members = useMemo(() => analytics.data?.members ?? [], [analytics.data])
  const profiles = useMemo(() => profilesArtifact.data?.profiles ?? [], [profilesArtifact.data])
  const summary = profilesArtifact.data?.summary ?? {}

  const organizations = useMemo(
    () => [...new Set((analytics.data?.organizations ?? []).map((org) => org.organization))].filter(Boolean),
    [analytics.data],
  )

  const warnings = useMemo(
    () => [
      ...new Set([
        ...(analytics.data?.warnings ?? []),
        ...coverageWarnings(analytics.data?.coverage ?? []),
        ...(summary.warnings ?? []),
        ...(profilesArtifact.isSuccess && !profilesArtifact.data
          ? ["Combined member profile artifact is not available; showing Gitea-only data"]
          : []),
      ]),
    ],
    [analytics.data, profilesArtifact.data, profilesArtifact.isSuccess, summary.warnings],
  )

  const rows = useMemo<Row[]>(() => {
    const query = search.trim().toLowerCase()

    const matchingProfiles = profiles.filter((profile) => {
      const matchesOrg = organization === "all" || profileOrganizations(profile).includes(organization)
      const searchable = [
        profileName(profile),
        profile.person_id,
        profile.member?.username,
        ...(profile.people_portal?.currentRoles ?? []),
        ...(profile.people_portal?.applicationTeamNames ?? []),
        ...profileOrganizations(profile),
        ...(profile.gitea?.identities ?? []).map((identity) => identity.login ?? ""),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
      return matchesOrg && (!query || searchable.includes(query))
    })

    /* Gitea rows already represented by a profile's linked identity are not
       repeated: the same person would otherwise appear twice. */
    const linkedLogins = new Set(
      profiles.flatMap((profile) =>
        (profile.gitea?.identities ?? []).map((identity) => identity.login).filter(Boolean),
      ),
    )

    const unlinked = members.filter((member) => {
      if (member.login && linkedLogins.has(member.login)) return false
      const matchesOrg = organization === "all" || (member.organizations ?? []).includes(organization)
      const searchable = [member.name, member.login, member.email, ...(member.organizations ?? [])]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
      return matchesOrg && (!query || searchable.includes(query))
    })

    const combined: Row[] = [
      ...matchingProfiles.map((profile, index) => ({
        kind: "profile" as const,
        profile,
        key: `profile:${profile.person_id ?? index}`,
      })),
      ...unlinked.map((member, index) => ({
        kind: "gitea" as const,
        member,
        key: `gitea:${member.login ?? index}`,
      })),
    ]

    return combined.sort((left, right) => {
      const leftValue = left.kind === "profile" ? profileSortValue(left.profile, sort) : memberSortValue(left.member, sort)
      const rightValue =
        right.kind === "profile" ? profileSortValue(right.profile, sort) : memberSortValue(right.member, sort)
      if (sort === "name") return String(leftValue).localeCompare(String(rightValue))
      return Number(rightValue) - Number(leftValue)
    })
  }, [members, organization, profiles, search, sort])

  const profileCount = rows.filter((row) => row.kind === "profile").length
  const unlinkedCount = rows.length - profileCount

  const failed = manifest.isError || analytics.isError || profilesArtifact.isError
  const error = manifest.error ?? analytics.error ?? profilesArtifact.error
  const pending = manifest.isPending || analytics.isPending || profilesArtifact.isPending

  const summaryCards: [string, number | null][] = [
    ["Member profiles", profiles.length],
    ["Applications", summary.applicationRecordsIncludedInProfiles ?? null],
    ["Résumé files", summary.retrievedResumeFiles ?? null],
    ["Profiles with notes", summary.profilesWithInterviewNotes ?? null],
    ["Gitea-linked profiles", summary.giteaMatchedProfiles ?? null],
    ["Contributor aliases", summary.giteaIdentityAliases ?? null],
    ["Organizations", analytics.data?.organizations?.length ?? null],
    ["Unlinked Gitea records", unlinkedCount],
  ]

  return (
    <div className="flex flex-col gap-6">
      <PageHeading
        eyebrow="Horizon / Gitea analytics dashboard"
        title="Member profiles"
        meta={
          <div className="flex flex-col gap-1">
            <p className="text-muted-foreground max-w-prose text-sm">
              A pooled, source-linked view of People Portal membership, applications, résumés and Gitea engineering
              activity, including unlinked contributor identities.
            </p>
            {runId ? (
              <Mono className="text-muted-foreground">
                Run {runId}
                {profilesArtifact.data?.generated_at
                  ? ` · profiles built ${formatDate(profilesArtifact.data.generated_at, true)}`
                  : ""}
              </Mono>
            ) : null}
          </div>
        }
        actions={
          <>
            <Badge variant={runId ? "secondary" : "outline"}>
              {runId ? `${profiles.length} profiles` : "No data"}
            </Badge>
            <OperatorSessionDialog />
          </>
        }
      />

      {failed ? (
        <ErrorPanel
          title="Profile data is not available yet"
          message={`${errorMessage(error)}${signedIn ? "" : " Artifact reads require an operator session outside local mode."}`}
          onRetry={() => {
            void manifest.refetch()
            void analytics.refetch()
            void profilesArtifact.refetch()
          }}
        />
      ) : null}

      {pending && !failed ? <LoadingPanel label="Loading the pinned profile run" /> : null}

      {!pending && !failed && !profiles.length && !members.length ? (
        <EmptyPanel
          title="No profiles were built for this run"
          description="Run the Gitea pipeline and the member-profile build, then reload this page."
          icon={<UsersRoundIcon className="size-8" />}
        />
      ) : null}

      {runId && !pending && !failed ? (
        <>
          {warnings.length ? (
            <details className="rounded-lg border p-3 text-sm" open>
              <summary className="cursor-pointer font-medium">
                {warnings.length} data-quality warning{warnings.length === 1 ? "" : "s"}
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
                <Label htmlFor="profile-search">Find a member</Label>
                <Input
                  id="profile-search"
                  type="search"
                  placeholder="Name, login, or email"
                  autoComplete="off"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="profile-org">Organization</Label>
                <Select value={organization} onValueChange={setOrganization}>
                  <SelectTrigger id="profile-org">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All organizations</SelectItem>
                    {organizations.map((name) => (
                      <SelectItem key={name} value={name}>
                        {name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="profile-sort">Sort members by</Label>
                <Select value={sort} onValueChange={(value) => setSort(value as SortKey)}>
                  <SelectTrigger id="profile-sort">
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

          <Card>
            <CardContent className="flex flex-col gap-3">
              <Eyebrow>
                {formatCount(profileCount)} profiles · {formatCount(unlinkedCount)} unlinked Gitea records
              </Eyebrow>
              <div className="w-full overflow-x-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Member</TableHead>
                      <TableHead>Roles / application teams</TableHead>
                      <TableHead>Applications</TableHead>
                      <TableHead>Hired</TableHead>
                      <TableHead>Notes</TableHead>
                      <TableHead>Résumés</TableHead>
                      <TableHead>Commits</TableHead>
                      <TableHead>Merged PRs</TableHead>
                      <TableHead>Reviews</TableHead>
                      <TableHead>Issues</TableHead>
                      <TableHead>Active days</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.length === 0 ? (
                      <EmptyTableRow
                        columns={11}
                        message="No profiles or unlinked Gitea records match the current filters."
                      />
                    ) : (
                      rows.map((row) =>
                        row.kind === "gitea" ? (
                          <GiteaOnlyRow
                            key={row.key}
                            member={row.member}
                            onOpen={() => setOpenMember(row.member)}
                          />
                        ) : (
                          <ProfileRow
                            key={row.key}
                            profile={row.profile}
                            onOpen={() => setOpenProfile(row.profile)}
                          />
                        ),
                      )
                    )}
                  </TableBody>
                </Table>
              </div>
              <p className="text-muted-foreground text-xs">
                Profiles use normalized People Portal email as the stable key; matched Gitea aliases are retained on
                the linked record. Metrics are descriptive indicators, not a performance score.
              </p>
            </CardContent>
          </Card>
        </>
      ) : null}

      <ProfileDialog
        profile={openProfile}
        artifactRoot={artifactRoot}
        onOpenChange={(open) => !open && setOpenProfile(null)}
      />
      <GiteaOnlyDialog member={openMember} onOpenChange={(open) => !open && setOpenMember(null)} />
    </div>
  )
}

function ProfileRow({ profile, onOpen }: { profile: MemberProfile; onOpen: () => void }) {
  const metrics = profileMetrics(profile)
  const portal = profile.people_portal ?? {}
  const matched = Boolean(profile.gitea?.matched)
  const resumeLabel = portal.resumeCount ? `${portal.resumeRetrievedCount ?? 0}/${portal.resumeCount}` : null
  const roleTeams = [...(portal.currentRoles ?? []), ...(portal.applicationTeamNames ?? [])]

  const giteaValue = (key: string) => (matched ? Number(metrics[key] ?? NaN) : NaN)

  return (
    <TableRow
      tabIndex={0}
      role="button"
      aria-label={`View ${profileName(profile)}`}
      className="cursor-pointer"
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault()
          onOpen()
        }
      }}
    >
      <TableCell>
        <div className="flex flex-col gap-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{profileName(profile)}</span>
            {!matched ? (
              <Badge variant="outline" className="bg-status-watch-surface text-status-watch">
                no Gitea match
              </Badge>
            ) : !profile.gitea?.match?.rosterRecordCount ? (
              <Badge variant="outline" className="bg-status-data-surface text-status-data">
                contributor identity only
              </Badge>
            ) : null}
            {(profile.provenance?.warnings ?? []).length ? (
              <Badge variant="outline" className="bg-status-watch-surface text-status-watch">
                incomplete
              </Badge>
            ) : null}
          </span>
          <Mono className="text-muted-foreground">{profile.person_id}</Mono>
        </div>
      </TableCell>
      <TableCell className="text-sm">{roleTeams.join(", ") || "—"}</TableCell>
      <TableCell className="tabular-nums">
        <MetricValue value={portal.applicationCount ?? null} format="count" />
      </TableCell>
      <TableCell className="tabular-nums">
        <MetricValue value={portal.stageCounts?.Hired ?? null} format="count" />
      </TableCell>
      <TableCell className="tabular-nums">
        <MetricValue value={portal.notesCount ?? null} format="count" />
      </TableCell>
      <TableCell className="text-sm tabular-nums">{resumeLabel ?? <NoData />}</TableCell>
      <TableCell className="tabular-nums">
        <MetricValue value={giteaValue("commits")} format="count" />
      </TableCell>
      <TableCell className="tabular-nums">
        <MetricValue value={giteaValue("pulls_merged")} format="count" />
      </TableCell>
      <TableCell className="tabular-nums">
        <MetricValue value={giteaValue("reviews_submitted")} format="count" />
      </TableCell>
      <TableCell className="tabular-nums">
        <MetricValue value={giteaValue("issues_opened")} format="count" />
      </TableCell>
      <TableCell className="tabular-nums">
        <MetricValue value={giteaValue("active_days")} format="count" />
      </TableCell>
    </TableRow>
  )
}

function GiteaOnlyRow({ member, onOpen }: { member: ArtifactMember; onOpen: () => void }) {
  return (
    <TableRow
      tabIndex={0}
      role="button"
      aria-label={`View ${artifactDisplayName(member)}`}
      className="cursor-pointer"
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault()
          onOpen()
        }
      }}
    >
      <TableCell>
        <div className="flex flex-col gap-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{artifactDisplayName(member)}</span>
            <Badge variant="outline" className="bg-status-pause-surface text-status-pause">
              unlinked Gitea
            </Badge>
          </span>
          <Mono className="text-muted-foreground">{member.email || member.login || "no email"}</Mono>
        </div>
      </TableCell>
      <TableCell className="text-sm">{(member.organizations ?? []).join(", ") || "—"}</TableCell>
      {/* People Portal columns genuinely do not apply to an unlinked identity. */}
      <TableCell>
        <NoData />
      </TableCell>
      <TableCell>
        <NoData />
      </TableCell>
      <TableCell>
        <NoData />
      </TableCell>
      <TableCell>
        <NoData />
      </TableCell>
      <TableCell className="tabular-nums">
        <MetricValue value={member.commits ?? null} format="count" />
      </TableCell>
      <TableCell className="tabular-nums">
        <MetricValue value={member.pulls_merged ?? null} format="count" />
      </TableCell>
      <TableCell className="tabular-nums">
        <MetricValue value={member.reviews_submitted ?? null} format="count" />
      </TableCell>
      <TableCell className="tabular-nums">
        <MetricValue value={member.issues_opened ?? null} format="count" />
      </TableCell>
      <TableCell className="tabular-nums">
        <MetricValue value={member.active_days ?? null} format="count" />
      </TableCell>
    </TableRow>
  )
}

/**
 * Fetch a résumé through the authenticated artifact route and hand the bytes
 * to the browser. The file is never exposed as a plain href: it lives behind
 * an operator-authenticated API route, not a static file server.
 */
async function downloadArtifact(path: string, filename: string) {
  try {
    const blob = await requestBlob(path)
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.download = filename
    link.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
  } catch (error) {
    toast.error(errorMessage(error, "The file could not be downloaded."))
  }
}

function ProfileDialog({
  profile,
  artifactRoot,
  onOpenChange,
}: {
  profile: MemberProfile | null
  artifactRoot: string
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={profile !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <Eyebrow>Member detail</Eyebrow>
          <DialogTitle>{profile ? profileName(profile) : ""}</DialogTitle>
          <DialogDescription>{profile?.person_id ?? ""}</DialogDescription>
        </DialogHeader>
        {profile ? <ProfileDialogBody profile={profile} artifactRoot={artifactRoot} /> : null}
      </DialogContent>
    </Dialog>
  )
}

function ProfileDialogBody({ profile, artifactRoot }: { profile: MemberProfile; artifactRoot: string }) {
  const portal = profile.people_portal ?? {}
  const metrics = profileMetrics(profile)
  const attributes = profile.member?.attributes ?? {}
  const identityAliases = (profile.gitea?.identities ?? []).flatMap((identity) => identity.identityAliases ?? [])
  const matchLabel =
    profile.gitea?.match?.method === "normalized_email_exact" ? "Exact normalized email" : "No deterministic match"

  const giteaRows: [string, unknown][] = [
    ["Commits", metrics.commits],
    ["Additions", metrics.additions],
    ["Deletions", metrics.deletions],
    ["PRs opened", metrics.pulls_opened],
    ["PRs merged", metrics.pulls_merged],
    ["Reviews", metrics.reviews_submitted],
    ["Approvals", metrics.reviews_approved],
    ["Issues", metrics.issues_opened],
    ["Active days", metrics.active_days],
    ["Blame lines", metrics.blame_lines],
  ]

  return (
    <div className="flex flex-col gap-5">
      <div className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-sm">
        <span>{String(attributes.major ?? "Major not recorded")}</span>
        <span>
          {attributes.expectedGrad ? `Graduation ${formatDate(attributes.expectedGrad)}` : "Graduation not recorded"}
        </span>
      </div>

      <section className="flex flex-col gap-1">
        <h3 className="text-sm font-medium">Membership and identity</h3>
        <p className="text-muted-foreground text-sm">
          {profile.member?.username || "No People Portal username"} · Current roles:{" "}
          {(portal.currentRoles ?? []).join(", ") || "No current roles recorded"}
        </p>
        <p className="text-muted-foreground text-sm">
          Historical application teams: {(portal.applicationTeamNames ?? []).join(", ") || "No application teams"}
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Résumé files</h3>
        {(portal.resumes ?? []).length === 0 ? (
          <p className="text-muted-foreground text-sm">No résumé record is linked to this profile.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {(portal.resumes ?? []).map((resume, index) => (
              <li key={index} className="flex flex-wrap items-center gap-2 text-sm">
                {resume.path && artifactRoot ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      downloadArtifact(
                        `${artifactRoot}/${resume.path}`,
                        resume.path?.split("/").pop() ?? "resume.pdf",
                      )
                    }
                  >
                    <DownloadIcon className="size-4" aria-hidden="true" />
                    Open résumé
                  </Button>
                ) : null}
                <span className="text-muted-foreground">
                  {resume.path
                    ? resume.retrieved
                      ? "Retrieved locally"
                      : "Available but not retrieved"
                    : resume.available
                      ? "Résumé available but not retrieved"
                      : "Résumé not available"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">People Portal applications</h3>
        {(portal.applications ?? []).length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No member-linked applications were found in this snapshot.
          </p>
        ) : (
          (portal.applications ?? []).map((application, index) => {
            const info = application.applicationInfo ?? {}
            const card = application.applicationCard ?? {}
            const stage = info.stage ?? card.stage ?? "Unknown"
            const roles = info.rolePreferences ?? card.rolePreferences
            const roleLabel = Array.isArray(roles)
              ? roles
                  .map((role) =>
                    typeof role === "string"
                      ? role
                      : ((role as Record<string, unknown>)?.role ??
                        (role as Record<string, unknown>)?.name ??
                        JSON.stringify(role)),
                  )
                  .join(", ")
              : typeof roles === "string"
                ? roles
                : "—"
            const history = Array.isArray(info.stageHistory)
              ? [...info.stageHistory].sort((left, right) =>
                  String(left.changedAt ?? "").localeCompare(String(right.changedAt ?? "")),
                )
              : []
            const responses = info.responses && typeof info.responses === "object" ? info.responses : {}

            return (
              <article key={index} className="flex flex-col gap-2 rounded-lg border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <strong className="text-sm font-medium">
                    {application.teamName ?? application.teamId ?? `Application ${index + 1}`}
                  </strong>
                  <Badge variant="secondary">{stage}</Badge>
                </div>
                <p className="text-muted-foreground text-xs">
                  Applied {info.appliedAt || card.appliedAt ? formatDate(info.appliedAt ?? card.appliedAt) : "date unavailable"}{" "}
                  · {info.stars ?? card.stars ?? "No rating"} stars
                </p>
                <p className="text-sm">
                  <strong>Role preferences:</strong> {roleLabel || "—"}
                </p>
                {info.notes ? (
                  <div className="flex flex-col gap-0.5">
                    <strong className="text-sm">Interview notes</strong>
                    <p className="text-muted-foreground text-sm">{info.notes}</p>
                  </div>
                ) : null}
                {history.length ? (
                  <div className="flex flex-col gap-0.5">
                    <strong className="text-sm">Stage history</strong>
                    <ul className="text-muted-foreground flex flex-col gap-0.5 pl-4 text-sm">
                      {history.map((event, eventIndex) => (
                        <li key={eventIndex} className="list-disc">
                          {event.stage ?? "Unknown"} · {event.changedAt ? formatDate(event.changedAt) : "undated"}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {Object.keys(responses).length ? (
                  <div className="flex flex-col gap-1">
                    <strong className="text-sm">Responses</strong>
                    {Object.entries(responses).map(([question, answer]) => (
                      <div key={question} className="flex flex-col gap-0.5">
                        <span className="text-muted-foreground text-xs">{question}</span>
                        <p className="text-sm">
                          {typeof answer === "object" && answer !== null ? JSON.stringify(answer) : String(answer ?? "—")}
                        </p>
                      </div>
                    ))}
                  </div>
                ) : null}
              </article>
            )
          })
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Gitea activity</h3>
        {profile.gitea?.matched ? (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {giteaRows.map(([label, value]) => (
                <div key={label} className="flex flex-col gap-0.5 rounded-md border p-2">
                  <span className="text-muted-foreground text-xs">{label}</span>
                  <strong className="text-sm font-semibold tabular-nums">
                    <MetricValue value={typeof value === "number" ? value : null} format="count" />
                  </strong>
                </div>
              ))}
            </div>
            <p className="text-muted-foreground text-sm">
              Match: {matchLabel} ·{" "}
              {profile.gitea?.match?.rosterRecordCount ? "Gitea roster member" : "contributor identity only"}
            </p>
            <p className="text-muted-foreground text-sm">
              Linked logins:{" "}
              {(profile.gitea.identities ?? [])
                .map((identity) => identity.login)
                .filter(Boolean)
                .join(", ") || "—"}
            </p>
            <p className="text-muted-foreground text-sm">
              Preserved contributor aliases: {formatCount(identityAliases.length)}
            </p>
          </>
        ) : (
          <p className="text-muted-foreground text-sm">No Gitea record matched this normalized email.</p>
        )}
      </section>

      <section className="flex flex-col gap-1">
        <h3 className="text-sm font-medium">Data quality and provenance</h3>
        <p className="text-muted-foreground text-sm">
          People Portal snapshot: {formatDate(profile.provenance?.peoplePortalGeneratedAt)} · Gitea snapshot:{" "}
          {formatDate(profile.provenance?.giteaGeneratedAt)}
        </p>
        <p className="text-muted-foreground text-sm">
          Gitea scope: {profile.provenance?.giteaHistoryScope ?? "unknown"} · Line ownership:{" "}
          {profile.provenance?.giteaBlame?.status ?? "unknown"} · Line stats:{" "}
          {String(metrics.commit_stats_status ?? "unknown")}
        </p>
        {(profile.provenance?.warnings ?? []).length ? (
          <ul className="text-muted-foreground flex flex-col gap-0.5 pl-4 text-sm">
            {(profile.provenance?.warnings ?? []).map((warning, index) => (
              <li key={index} className="list-disc">
                {warning}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground text-sm">No profile-specific warnings.</p>
        )}
      </section>
    </div>
  )
}

function GiteaOnlyDialog({
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
        ["PRs opened", member.pulls_opened],
        ["PRs merged", member.pulls_merged],
        ["Reviews", member.reviews_submitted],
        ["Approvals", member.reviews_approved],
        ["Issues", member.issues_opened],
        ["Active days", member.active_days],
        ["Blame lines", member.blame_lines],
      ]
    : []
  const candidates = [
    ...new Set((member?.identity_aliases ?? []).flatMap((alias) => alias.candidate_identities ?? [])),
  ]

  return (
    <Dialog open={member !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <Eyebrow>Gitea identity</Eyebrow>
          <DialogTitle>{member ? artifactDisplayName(member) : ""}</DialogTitle>
          <DialogDescription>
            This activity was collected from Gitea but is not attached to a People Portal profile. It stays visible
            here rather than being discarded.
          </DialogDescription>
        </DialogHeader>
        {member ? (
          <div className="flex flex-col gap-4">
            <Mono className="text-muted-foreground">
              {member.login || "—"} · {member.email || "no email"}
            </Mono>
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
            <p className="text-muted-foreground text-sm">
              Organizations: {(member.organizations ?? []).join(", ") || "—"}
            </p>
            {candidates.length ? (
              <p className="text-muted-foreground text-sm">Candidate roster identities: {candidates.join(", ")}</p>
            ) : null}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
