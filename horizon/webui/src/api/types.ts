/**
 * The shapes the dashboard works with after normalization.
 *
 * The API answers with snake_case, sometimes camelCase, and occasionally with
 * a field absent altogether. `normalize.ts` collapses that into these types,
 * and every one of them keeps missing data as `null` rather than `0` -- the
 * distinction the whole product rests on.
 */

/** Untyped JSON as it arrives. Narrowed by the normalizers, never rendered. */
export type RawRecord = Record<string, unknown>

export type StatusClass = "risk" | "watch" | "clear" | "data" | "pause"

export type MetricSeriesKey = "activity" | "openPRs" | "reviewLatency" | "contributors"

export type AggregateMetricKey =
  | "active_days"
  | "days_since_activity"
  | "open_prs"
  | "oldest_open_pr_days"
  | "review_latency_days"
  | "merged_count"
  | "active_contributors"

export interface MetricDefinition {
  label: string
  key: MetricSeriesKey
  metricKey: AggregateMetricKey
  unit: string
}

export const METRIC_DEFINITIONS: readonly MetricDefinition[] = [
  { label: "Activity", key: "activity", metricKey: "active_days", unit: "d" },
  { label: "Open PRs", key: "openPRs", metricKey: "open_prs", unit: "" },
  { label: "Review latency", key: "reviewLatency", metricKey: "review_latency_days", unit: "d" },
  { label: "Active contributors", key: "contributors", metricKey: "active_contributors", unit: "" },
]

export const AGGREGATE_METRIC_KEYS: readonly AggregateMetricKey[] = [
  "active_days",
  "days_since_activity",
  "open_prs",
  "oldest_open_pr_days",
  "review_latency_days",
  "merged_count",
  "active_contributors",
]

/** A weekly series always has eight slots; a slot with no observation is null
 *  and must render as a gap, never as zero. */
export type Series = (number | null)[]

export type EvidenceSeverity = "red" | "amber" | "blue" | "teal"

export interface EvidenceItem {
  id: string | null
  type: EvidenceSeverity
  icon: string
  title: string
  metric: string | null
  unit: string
  current: number | null
  baseline: number | null
  window: string | null
  threshold: string | null
  /** Inspectable raw references. An item with none is dropped upstream: a
   *  warning without evidence is not shown at all. */
  sources: string[]
}

export interface Boundary {
  rootTeam: string
  subteams: string[]
  repos: string[]
  dataOwner: string
  effectiveSince: string
  effectiveUntil: string | null
  lifecycle: string
  version: string | null
}

export interface HistoryEntry {
  date: string
  action: string
  note: string
}

export interface AssessmentItem {
  title: string
  detail: string | null
  week: string | number | null
}

export interface AssessmentCitation {
  label: string | null
  reference: string
  url: string | null
}

export interface HealthAssessment {
  status: string | null
  statusClass: StatusClass | "neutral"
  score: number | null
  confidence: number | null
  expectedWeek: string | number | null
  explanation: string | null
  blockers: AssessmentItem[]
  weeklyTasks: AssessmentItem[]
  citations: AssessmentCitation[]
}

export interface SnapshotMeta {
  snapshotId: string | null
  snapshotWeekStart: string | null
  snapshotWeekEnd: string | null
  generatedAt: string | null
  ruleSetVersion: string | null
  dataCompletenessPct: number | null
  lastSyncAt: string | null
}

export interface Project {
  id: string
  name: string
  short: string
  team: string
  repo: string
  status: string
  statusClass: StatusClass
  signal: string
  signalDetail: string
  signalSource: string | null
  signalConfidence: number | null
  signalModel: string | null
  signalEvidenceTier: string | null
  lastActivity: string
  weeks: Series
  seriesBaselines: Partial<Record<MetricSeriesKey, [number | null, number | null]>>
  series: Partial<Record<MetricSeriesKey, Series>>
  /** Only keys the snapshot actually carried. An absent key is missing data. */
  metrics: Partial<Record<AggregateMetricKey, number>>
  description: string
  boundary: Boundary | null
  evidence: EvidenceItem[]
  history: HistoryEntry[]
  dataCompletenessPct: number | null
  lastSyncAt: string | null
  snapshotId: string | null
  healthAssessment: HealthAssessment | null
}

export interface PortfolioSnapshot extends SnapshotMeta {
  projects: Project[]
}

/** `GET /snapshots/latest` also reports which projects have no snapshot for
 *  the current week and whether the server can compute one on demand. */
export interface LatestSnapshotResult {
  snapshot: PortfolioSnapshot
  lazyWeekStart: string | null
  computable: boolean
  missingProjectIds: string[]
}

export interface PortfolioDelivery {
  open_prs: number | null
  oldest_open_pr_days: number | null
  branches_ahead: number | null
  open_issues: number | null
}

/* ---------------------------------------------------------------- progress */

export type Trajectory = "accelerating" | "steady" | "slowing" | "stalled" | "unknown"

export interface CheckpointItem {
  text: string
  severity?: "info" | "warning" | "critical" | null
  evidence?: string[]
}

/** A cumulative progress checkpoint. Not a weekly snapshot: it answers "where
 *  does this project stand as of this date", so it carries no metric series. */
export interface ProgressProject {
  id: string
  name: string
  team: string
  repo: string
  status: string
  statusClass: StatusClass
  checkpointId?: string | null
  headline?: string | null
  narrative?: string | null
  trajectory?: Trajectory
  workToDate?: string | null
  confidence?: number | null
  milestones?: CheckpointItem[]
  openConcerns?: CheckpointItem[]
  recommendations?: string[]
  dataGaps?: string[]
  weeksTotal?: number | null
  weeksDeepJudged?: number | null
  historyTruncated?: boolean
  isProvisional?: boolean
  generatedAt?: string | null
}

export interface ProgressAtResult {
  projects: ProgressProject[]
  missing_project_ids?: string[]
  computable?: boolean
}

/* --------------------------------------------------------------- analytics */

export interface AnalyticsRun {
  run_id?: string | null
  generated_at?: string | null
  history_scope?: string | null
  blame_status?: string | null
  warnings?: string[]
}

export interface AnalyticsTotals {
  roster_members?: number | null
  active_members?: number | null
  unmatched_identities?: number | null
  repositories?: number | null
  commits?: number | null
  merged_pull_requests?: number | null
  issues?: number | null
  blame_lines?: number | null
}

/** Every count here may legitimately be null: the collector marks a metric it
 *  could not gather as missing rather than zero. */
export interface AnalyticsMember {
  login: string
  name?: string | null
  email?: string | null
  organizations?: string[]
  repositories?: string[]
  roster_member?: boolean
  service_or_admin?: boolean
  has_activity?: boolean
  first_activity?: string | null
  last_activity?: string | null
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
  identity_aliases?: { candidate_identities?: string[] }[]
}

/* -------------------------------------------------------------- recruiting */

export type ReviewStatus = "pending" | "confirmed" | "adjusted" | "deferred"
export type EligibilityStatus = "eligible" | "excluded" | "needs_review"

export interface RecruitingRun {
  run_id: string
  generated_at?: string | null
  llm_used?: boolean
  signal_version?: string | null
  source_warnings?: string[]
  ranking_source?: string | null
  people_portal_source_system?: string | null
}

export interface RecruitingSummary {
  candidate_count: number
  underrated_count?: number | null
  reviewed_count: number
  pending_count: number
}

export interface RecruitingCandidate {
  member_login: string
  member_name: string
  provisional_rank?: number | null
  reviewer_rank?: number | null
  provisional_score?: number | null
  contribution_score?: number | null
  evidence_quality_score?: number | null
  review_status?: ReviewStatus
  /* Rubric components. Null means the input was never supplied -- People
     Portal evidence is absent -- not that the candidate scored zero on it. */
  ability_score?: number | null
  resume_score?: number | null
  interview_score?: number | null
  evidence_claim_count?: number | null
  resume_evidence_count?: number | null
  interview_evidence_count?: number | null
  signal_band?: string | null
  eligibility_status?: EligibilityStatus | null
  source_status?: string | null
  review_flags?: string[]
}

export interface RecruitingOverview {
  run?: RecruitingRun | null
  summary: RecruitingSummary
  candidates: RecruitingCandidate[]
}

export interface RecruitingReviewRecord {
  decision: string
  reviewer_user_id?: string | null
  created_at?: string | null
  note?: string | null
  member_login?: string
}

export interface RecruitingCandidateDetail extends RecruitingCandidate {
  run_id: string
  rationale?: string | null
  ability_score?: number | null
  resume_score?: number | null
  interview_score?: number | null
  source_status?: string | null
  member_stats?: Record<string, unknown>
  interview?: { score?: number | null; summary?: string | null; evidence?: string[] }
  resume?: { summary?: string | null; evidence?: string[] }
  context_excluded_from_score?: { prior_employers?: string[]; note?: string | null }
  eligibility?: { status?: EligibilityStatus | null }
  human_review?: { decision?: string | null; final_rank?: number | null; note?: string | null }
  evidence_refs?: { label?: string | null; source_type?: string; source_id?: string; source_field?: string }[]
  evidence_claims?: { claim: string; supporting_text: string; source_field: string }[]
  contradictions?: string[]
  duplicate_flags?: string[]
  review_flags?: string[]
  caveats?: string[]
  review_history?: RecruitingReviewRecord[]
  ranking?: {
    rubric_version?: string
    ranking_status?: string
    combined_rank?: number | null
    technical_execution_score?: number | null
    technical_leadership_score?: number | null
    club_contribution_score?: number | null
  } | null
}

export interface RecruitingAudit {
  audit?: {
    coverage?: {
      with_observable_stats?: number | null
      candidate_count?: number | null
      review_completion_pct?: number | null
    }
    calibration?: {
      reviewer_count?: number | null
      review_count?: number | null
      multi_reviewer_candidates?: number | null
      disagreement_candidates?: number | null
      agreement_rate_pct?: number | null
    }
    flags?: string[]
    recent_reviews?: RecruitingReviewRecord[]
  }
  run?: { run_id?: string }
}

/* ---------------------------------------------------------------- feedback */

export const FEEDBACK_REASONS = [
  { value: "risk_confirmed", label: "Risk confirmed", icon: "check-circle" },
  { value: "expected_cycle", label: "Expected cycle", icon: "calendar" },
  { value: "data_quality", label: "Data quality issue", icon: "triangle" },
  { value: "planned_pause", label: "Planned pause", icon: "pause" },
] as const

export type FeedbackReason = (typeof FEEDBACK_REASONS)[number]["value"]

export interface FeedbackPayload {
  snapshot_id: string
  project_id: string
  warning_id: string | null
  category: FeedbackReason
  note: string
}
