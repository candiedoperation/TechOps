/**
 * Shapes and roll-ups for the versioned pipeline artifacts.
 *
 * `analytics.json` and `member-profiles.json` are read from one pinned run
 * (see `artifactManifestQuery`), never from `latest` per file -- reading two
 * files as `latest` could straddle a publish and join rows from different
 * runs.
 *
 * The roll-ups below mirror the vanilla `analytics/app.js` and
 * `profiles/app.js` helpers, including their treatment of missingness:
 * `sumAvailable` returns null when *nothing* was collected, so an
 * uncollected blame run shows as "no data" rather than a total of zero.
 */

export interface ArtifactRepository {
  name: string
  organization?: string
  default_branch?: string | null
  branches?: unknown[]
  commits?: unknown[]
  pulls?: { merged?: boolean }[]
  issue_count?: number | null
  html_url?: string | null
}

export interface ArtifactOrganization {
  organization: string
  member_count?: number | null
  repositories?: ArtifactRepository[]
}

export interface ArtifactMember {
  login?: string
  name?: string | null
  email?: string | null
  organizations?: string[]
  repositories?: string[]
  roster_member?: boolean
  service_or_admin?: boolean
  commits?: number | null
  additions?: number | null
  deletions?: number | null
  unique_files?: number | null
  files_changed?: number | null
  pulls_opened?: number | null
  pulls_merged?: number | null
  reviews_submitted?: number | null
  reviews_approved?: number | null
  issues_opened?: number | null
  active_days?: number | null
  blame_lines?: number | null
  blame_files?: number | null
  first_activity?: string | null
  last_activity?: string | null
  identity_aliases?: { candidate_identities?: string[] }[]
}

export interface CoverageEvent {
  status?: string
  path?: string
}

export interface AnalyticsArtifact {
  generated_at?: string | null
  api_calls?: number | null
  history_scope?: string | null
  blame?: { status?: string | null }
  warnings?: string[]
  coverage?: CoverageEvent[]
  members?: ArtifactMember[]
  organizations?: ArtifactOrganization[]
}

export interface RepositoryRow extends ArtifactRepository {
  organization: string
  commitCount: number
  pullCount: number
  mergedCount: number
}

export interface OrganizationRow {
  name: string
  roster: number
  activeMembers: number
  repositories: number
  branches: number
  commits: number
  pulls: number
  merged: number
  issues: number
  /** Null when line ownership was not collected at all for this run. */
  blameLines: number | null
}

export function memberHasActivity(member: ArtifactMember): boolean {
  return (["commits", "pulls_opened", "reviews_submitted", "issues_opened", "blame_lines"] as const).some(
    (key) => Number(member[key] ?? 0) > 0,
  )
}

function sumAvailable(members: ArtifactMember[], key: "blame_lines"): number | null {
  const values = members.map((member) => member[key]).filter((value) => value !== null && value !== undefined)
  return values.length ? values.reduce((total, value) => total + Number(value ?? 0), 0) : null
}

export function makeRepositoryRows(organizations: ArtifactOrganization[]): RepositoryRow[] {
  return organizations.flatMap((organization) =>
    (organization.repositories ?? []).map((repo) => ({
      ...repo,
      organization: repo.organization ?? organization.organization,
      commitCount: (repo.commits ?? []).length,
      pullCount: (repo.pulls ?? []).length,
      mergedCount: (repo.pulls ?? []).filter((pull) => pull.merged).length,
    })),
  )
}

export function makeOrganizationRows(
  organizations: ArtifactOrganization[],
  members: ArtifactMember[],
): OrganizationRow[] {
  return organizations.map((organization) => {
    const name = organization.organization
    const repos = organization.repositories ?? []
    const orgMembers = members.filter((member) => (member.organizations ?? []).includes(name))
    return {
      name,
      roster: organization.member_count ?? orgMembers.length,
      activeMembers: orgMembers.filter(memberHasActivity).length,
      repositories: repos.length,
      branches: repos.reduce((total, repo) => total + (repo.branches ?? []).length, 0),
      commits: repos.reduce((total, repo) => total + (repo.commits ?? []).length, 0),
      pulls: repos.reduce((total, repo) => total + (repo.pulls ?? []).length, 0),
      merged: repos.reduce((total, repo) => total + (repo.pulls ?? []).filter((pull) => pull.merged).length, 0),
      issues: repos.reduce((total, repo) => total + Number(repo.issue_count ?? 0), 0),
      blameLines: sumAvailable(orgMembers, "blame_lines"),
    }
  })
}

/** Endpoints the collector could not read in full. Each one means a gap in
 *  the run -- a repository with pull requests disabled returns 404 and
 *  contributes no PR, review or approval rows at all. */
export function coverageWarnings(coverage: CoverageEvent[]): string[] {
  const gaps = coverage.filter((event) => event && event.status && event.status !== "complete")
  const grouped = new Map<string, number>()
  for (const event of gaps) {
    const key = `${event.status}:${event.path || "unknown endpoint"}`
    grouped.set(key, (grouped.get(key) ?? 0) + 1)
  }
  return [...grouped.entries()].slice(0, 20).map(([key, count]) => {
    const [status, path] = key.split(":", 2)
    return `Gitea ${status} coverage for ${path}${count > 1 ? ` (${count} occurrences)` : ""}`
  })
}

export function artifactDisplayName(member: ArtifactMember): string {
  return member.name || member.login || member.email || "Unmatched identity"
}

export function safeExternalUrl(url: string | null | undefined): string | null {
  return typeof url === "string" && /^https?:\/\//i.test(url) ? url : null
}

/* --------------------------------------------------------------- profiles */

export interface ProfileResume {
  path?: string | null
  retrieved?: boolean
  available?: boolean
}

export interface ProfileApplication {
  teamName?: string | null
  teamId?: string | null
  applicationInfo?: {
    stage?: string | null
    rolePreferences?: unknown
    stageHistory?: { stage?: string | null; changedAt?: string | null }[]
    responses?: Record<string, unknown>
    notes?: string | null
    appliedAt?: string | null
    stars?: number | null
  }
  applicationCard?: { stage?: string | null; rolePreferences?: unknown; appliedAt?: string | null; stars?: number | null }
}

export interface MemberProfile {
  person_id: string
  member?: { name?: string | null; username?: string | null; attributes?: Record<string, unknown> }
  people_portal?: {
    currentRoles?: string[]
    applicationTeamNames?: string[]
    applicationCount?: number | null
    notesCount?: number | null
    resumeCount?: number | null
    resumeRetrievedCount?: number | null
    resumes?: ProfileResume[]
    applications?: ProfileApplication[]
    stageCounts?: Record<string, number>
  }
  gitea?: {
    matched?: boolean
    match?: { method?: string; rosterRecordCount?: number | null }
    identities?: { login?: string | null; identityAliases?: string[] }[]
    metrics?: Record<string, unknown>
  }
  provenance?: {
    peoplePortalGeneratedAt?: string | null
    giteaGeneratedAt?: string | null
    giteaHistoryScope?: string | null
    giteaBlame?: { status?: string | null }
    warnings?: string[]
  }
}

export interface ProfilesArtifact {
  generated_at?: string | null
  summary?: Record<string, number | null | undefined> & { warnings?: string[] }
  profiles?: MemberProfile[]
}

export function profileMetrics(profile: MemberProfile): Record<string, unknown> {
  return profile.gitea?.metrics ?? {}
}

export function profileName(profile: MemberProfile): string {
  return profile.member?.name || profile.member?.username || profile.person_id || "Member"
}

export function profileOrganizations(profile: MemberProfile): string[] {
  const organizations = profileMetrics(profile).organizations
  return Array.isArray(organizations) ? (organizations as string[]) : []
}
