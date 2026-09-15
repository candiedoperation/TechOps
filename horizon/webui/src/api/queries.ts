/**
 * Query keys and fetchers.
 *
 * Keys are declared here rather than inline so a mutation can invalidate
 * exactly what it changed. Nothing in this file renders; the pages decide how
 * a pending, empty or failed query looks.
 */

import { queryOptions } from "@tanstack/react-query"

import { requestJson } from "./client"
import {
  normalizeLatestSnapshot,
  normalizeProject,
  normalizeSnapshotMeta,
  projectFromSnapshotResponse,
  record,
  snapshotMetaFromResponse,
} from "./normalize"
import type {
  AnalyticsMember,
  AnalyticsRun,
  AnalyticsTotals,
  LatestSnapshotResult,
  PortfolioDelivery,
  Project,
  ProgressAtResult,
  RecruitingAudit,
  RecruitingCandidateDetail,
  RecruitingOverview,
  SnapshotMeta,
} from "./types"

export const queryKeys = {
  latestSnapshot: ["snapshots", "latest"] as const,
  delivery: ["portfolio", "delivery"] as const,
  projectSnapshots: (projectId: string) => ["projects", projectId, "snapshots"] as const,
  projectSnapshotAt: (projectId: string, date: string) => ["projects", projectId, "snapshots", date] as const,
  progressAt: (date: string) => ["progress", "at", date] as const,
  analyticsSummary: ["analytics", "summary"] as const,
  analyticsOrganizations: ["analytics", "organizations"] as const,
  analyticsMembers: (params: MemberQueryParams) => ["analytics", "members", params] as const,
  analyticsMember: (login: string) => ["analytics", "members", "detail", login] as const,
  recruitingOverview: ["recruiting", "overview"] as const,
  recruitingAudit: (runId: string) => ["recruiting", "audit", runId] as const,
  recruitingCandidate: (login: string, runId: string | null) =>
    ["recruiting", "candidate", login, runId] as const,
  artifactManifest: ["artifacts", "latest", "manifest"] as const,
  artifactAnalytics: (runId: string) => ["artifacts", runId, "analytics"] as const,
  artifactProfiles: (runId: string) => ["artifacts", runId, "member-profiles"] as const,
}

/* ------------------------------------------------------------- portfolio */

export const latestSnapshotQuery = () =>
  queryOptions({
    queryKey: queryKeys.latestSnapshot,
    queryFn: async ({ signal }): Promise<LatestSnapshotResult> =>
      normalizeLatestSnapshot(await requestJson<unknown>("/snapshots/latest", { signal })),
  })

/**
 * Cache-only portfolio delivery facts. It backs four extra Overview tiles and
 * is deliberately allowed to come back null: a sync that has not run yet must
 * show "no data", never a zero that reads like an empty backlog.
 */
export const deliveryQuery = () =>
  queryOptions({
    queryKey: queryKeys.delivery,
    queryFn: async ({ signal }): Promise<PortfolioDelivery | null> => {
      const raw = record(await requestJson<unknown>("/portfolio/delivery", { signal }))
      const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null)
      return {
        open_prs: number(raw.open_prs),
        oldest_open_pr_days: number(raw.oldest_open_pr_days),
        branches_ahead: number(raw.branches_ahead),
        open_issues: number(raw.open_issues),
      }
    },
    /* A failure here must never take the status counts down with it. */
    retry: false,
  })

export interface ProjectProfileResult {
  project: Project
  meta: SnapshotMeta
}

/**
 * The live project profile. `baseProject` is the row from the portfolio
 * snapshot; merging it under the response is how identity fields (name, team,
 * repo) survive a snapshot endpoint that returns metrics only.
 */
export const projectProfileQuery = (projectId: string, baseProject: Project | undefined, baseMeta: SnapshotMeta) =>
  queryOptions({
    queryKey: queryKeys.projectSnapshots(projectId),
    queryFn: async ({ signal }): Promise<ProjectProfileResult> => {
      const raw = await requestJson<unknown>(`/projects/${encodeURIComponent(projectId)}/snapshots`, { signal })
      const responseMeta = snapshotMetaFromResponse(raw)
      /* Per field, the project's own snapshot metadata wins; the portfolio
         snapshot fills in whatever the project endpoint did not carry. */
      const meta: SnapshotMeta = {
        snapshotId: responseMeta.snapshotId ?? baseMeta.snapshotId,
        snapshotWeekStart: responseMeta.snapshotWeekStart ?? baseMeta.snapshotWeekStart,
        snapshotWeekEnd: responseMeta.snapshotWeekEnd ?? baseMeta.snapshotWeekEnd,
        generatedAt: responseMeta.generatedAt ?? baseMeta.generatedAt,
        ruleSetVersion: responseMeta.ruleSetVersion ?? baseMeta.ruleSetVersion,
        dataCompletenessPct: responseMeta.dataCompletenessPct ?? baseMeta.dataCompletenessPct,
        lastSyncAt: responseMeta.lastSyncAt ?? baseMeta.lastSyncAt,
      }
      const rawProject = projectFromSnapshotResponse(raw, projectId)
      if (!rawProject || typeof rawProject !== "object") {
        throw new Error("No snapshot was returned for this project.")
      }
      return {
        project: normalizeProject({ ...(baseProject ?? {}), ...record(rawProject) }, meta),
        meta,
      }
    },
  })

export interface ProjectAsOfResult {
  hasData: boolean
  project: Project | null
  meta: SnapshotMeta
}

/**
 * A project as of a past week.
 *
 * Deliberately does NOT merge the live project record: filling a historical
 * gap from today's data is exactly what made this view misleading before. A
 * week the server has no snapshot for says so.
 */
export const projectAsOfQuery = (projectId: string, date: string) =>
  queryOptions({
    queryKey: queryKeys.projectSnapshotAt(projectId, date),
    queryFn: async ({ signal }): Promise<ProjectAsOfResult> => {
      const raw = record(
        await requestJson<unknown>(
          `/projects/${encodeURIComponent(projectId)}/snapshots/at?date=${encodeURIComponent(date)}`,
          { signal },
        ),
      )
      const meta = normalizeSnapshotMeta(raw)
      return raw.has_data
        ? { hasData: true, project: normalizeProject(raw.project, meta), meta }
        : { hasData: false, project: null, meta }
    },
  })

/** Cache-only cumulative progress for a date. Names the projects it could not
 *  serve so the caller can decide whether to spend a compute request. */
export const progressAtQuery = (date: string) =>
  queryOptions({
    queryKey: queryKeys.progressAt(date),
    queryFn: async ({ signal }): Promise<ProgressAtResult> => {
      const raw = record(await requestJson<unknown>(`/progress/at?date=${encodeURIComponent(date)}`, { signal }))
      return {
        projects: Array.isArray(raw.projects) ? (raw.projects as ProgressAtResult["projects"]) : [],
        missing_project_ids: Array.isArray(raw.missing_project_ids)
          ? (raw.missing_project_ids as string[])
          : [],
        computable: Boolean(raw.computable),
      }
    },
  })

/* ------------------------------------------------------------- analytics */

export interface MemberQueryParams {
  sort: string
  organization: string
  search: string
  includeService: boolean
  includeUnmatched: boolean
}

export interface AnalyticsSummaryResult {
  run: AnalyticsRun | null
  totals: AnalyticsTotals | null
}

export const analyticsSummaryQuery = () =>
  queryOptions({
    queryKey: queryKeys.analyticsSummary,
    queryFn: async ({ signal }): Promise<AnalyticsSummaryResult> => {
      const raw = record(await requestJson<unknown>("/analytics/summary", { signal }))
      return {
        run: (raw.run as AnalyticsRun | undefined) ?? null,
        totals: (raw.totals as AnalyticsTotals | undefined) ?? null,
      }
    },
  })

/** The organization list comes from the run, not from the filtered rows, so
 *  narrowing to one organization can never empty the filter that produced it. */
export const analyticsOrganizationsQuery = () =>
  queryOptions({
    queryKey: queryKeys.analyticsOrganizations,
    queryFn: async ({ signal }): Promise<string[]> => {
      const raw = record(await requestJson<unknown>("/analytics/organizations", { signal }))
      const rows = Array.isArray(raw.organizations) ? raw.organizations : []
      return rows
        .map((row) => record(row).organization)
        .filter((name): name is string => typeof name === "string" && Boolean(name))
    },
  })

export const analyticsMembersQuery = (params: MemberQueryParams) =>
  queryOptions({
    queryKey: queryKeys.analyticsMembers(params),
    queryFn: async ({ signal }): Promise<AnalyticsMember[]> => {
      const query = new URLSearchParams({ sort: params.sort, limit: "1000" })
      if (params.organization !== "all") query.set("organization", params.organization)
      if (params.search.trim()) query.set("search", params.search.trim())
      if (!params.includeService) query.set("include_service", "false")
      if (!params.includeUnmatched) query.set("include_unmatched", "false")
      const raw = record(await requestJson<unknown>(`/analytics/members?${query.toString()}`, { signal }))
      return Array.isArray(raw.members) ? (raw.members as AnalyticsMember[]) : []
    },
  })

export const analyticsMemberQuery = (login: string) =>
  queryOptions({
    queryKey: queryKeys.analyticsMember(login),
    queryFn: async ({ signal }): Promise<AnalyticsMember | null> => {
      const raw = record(
        await requestJson<unknown>(`/analytics/members/${encodeURIComponent(login)}`, { signal }),
      )
      return (raw.member as AnalyticsMember | undefined) ?? null
    },
  })

/* ------------------------------------------------------------ recruiting */

export const recruitingOverviewQuery = () =>
  queryOptions({
    queryKey: queryKeys.recruitingOverview,
    queryFn: async ({ signal }): Promise<RecruitingOverview> => {
      const raw = record(await requestJson<unknown>("/recruiting/overview", { signal }))
      return {
        run: (raw.run as RecruitingOverview["run"]) ?? null,
        summary: (raw.summary as RecruitingOverview["summary"]) ?? {
          candidate_count: 0,
          reviewed_count: 0,
          pending_count: 0,
        },
        candidates: Array.isArray(raw.candidates) ? (raw.candidates as RecruitingOverview["candidates"]) : [],
      }
    },
  })

export const recruitingAuditQuery = (runId: string) =>
  queryOptions({
    queryKey: queryKeys.recruitingAudit(runId),
    queryFn: async ({ signal }): Promise<RecruitingAudit> =>
      await requestJson<RecruitingAudit>(`/recruiting/audit?run_id=${encodeURIComponent(runId)}`, { signal }),
  })

/**
 * One candidate's evidence. The run id is part of the key, so a detail fetched
 * under a superseded run can never be shown beside a newer queue -- the same
 * fail-closed rule the vanilla loader enforced by hand.
 */
export const recruitingCandidateQuery = (login: string, runId: string | null) =>
  queryOptions({
    queryKey: queryKeys.recruitingCandidate(login, runId),
    queryFn: async ({ signal }): Promise<RecruitingCandidateDetail | null> => {
      const query = runId ? `?run_id=${encodeURIComponent(runId)}` : ""
      const raw = record(
        await requestJson<unknown>(`/recruiting/candidates/${encodeURIComponent(login)}${query}`, { signal }),
      )
      return (raw.candidate as RecruitingCandidateDetail | undefined) ?? null
    },
  })

/* -------------------------------------------------------------- artifacts */

export interface ArtifactManifest {
  run_id: string
}

/** Pin the artifact version once, then read every file from that run. Reading
 *  `latest` per file could straddle two runs mid-publish. */
export const artifactManifestQuery = () =>
  queryOptions({
    queryKey: queryKeys.artifactManifest,
    queryFn: async ({ signal }): Promise<ArtifactManifest> => {
      const raw = record(await requestJson<unknown>("/artifacts/latest/manifest.json", { signal }))
      if (typeof raw.run_id !== "string" || !raw.run_id) {
        throw new Error("Artifact manifest has no run version.")
      }
      return { run_id: raw.run_id }
    },
  })

export const artifactJsonQuery = <T,>(runId: string, file: string, key: readonly unknown[]) =>
  queryOptions({
    queryKey: key,
    queryFn: async ({ signal }): Promise<T> =>
      await requestJson<T>(`/artifacts/${encodeURIComponent(runId)}/${file}`, { signal }),
  })
