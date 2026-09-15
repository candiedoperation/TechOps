/**
 * API payload -> view model.
 *
 * This is a direct port of the normalization block at the top of the vanilla
 * `app.js`, and it keeps that code's central rule: a metric the snapshot did
 * not carry is *absent*, not zero. Every helper here either produces a real
 * observation or `null`/`undefined`, and nothing substitutes a default.
 */

import {
  AGGREGATE_METRIC_KEYS,
  METRIC_DEFINITIONS,
  type AggregateMetricKey,
  type AssessmentCitation,
  type AssessmentItem,
  type Boundary,
  type EvidenceItem,
  type EvidenceSeverity,
  type HealthAssessment,
  type HistoryEntry,
  type LatestSnapshotResult,
  type MetricSeriesKey,
  type PortfolioSnapshot,
  type Project,
  type RawRecord,
  type Series,
  type SnapshotMeta,
  type StatusClass,
} from "./types"

/* ------------------------------------------------------------- primitives */

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

export function isRecord(value: unknown): value is RawRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

export function record(value: unknown): RawRecord {
  return isRecord(value) ? value : {}
}

/** A number, or null. Empty strings and non-finite values are missing data. */
export function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null
  if (typeof value === "string" && !value.trim()) return null
  const parsed = typeof value === "number" ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

export function firstDefined<T>(...values: (T | null | undefined)[]): T | undefined {
  return values.find((value) => value !== undefined && value !== null) ?? undefined
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value
    if (typeof value === "number" && Number.isFinite(value)) return String(value)
  }
  return undefined
}

export function hasOwn(object: unknown, key: string): boolean {
  return isRecord(object) && Object.prototype.hasOwnProperty.call(object, key)
}

/** The last observed point in a series, skipping trailing gaps. */
export function lastValue(series: Series = []): number | null {
  for (let index = series.length - 1; index >= 0; index -= 1) {
    const value = series[index]
    if (value !== null && value !== undefined) return value
  }
  return null
}

export function metricValue(
  metrics: Partial<Record<AggregateMetricKey, number>>,
  key: AggregateMetricKey,
  fallback: number | null = null,
): number | null {
  return hasOwn(metrics, key) ? (metrics[key] as number) : fallback
}

/* ------------------------------------------------------------ series/metrics */

export function normalizeSeries(value: unknown): Series {
  const source = asArray(value).slice(0, 8)
  return Array.from({ length: 8 }, (_, index) => finiteNumber(source[index]))
}

export function normalizeMetricObject(value: unknown): Partial<Record<AggregateMetricKey, number>> {
  const source = record(value)
  const metrics: Partial<Record<AggregateMetricKey, number>> = {}
  for (const key of AGGREGATE_METRIC_KEYS) {
    if (!hasOwn(source, key)) continue
    const normalized = finiteNumber(source[key])
    /* A key present but unparseable stays absent: it is a failed measurement,
       which is missing data, not a zero. */
    if (normalized !== null) metrics[key] = normalized
  }
  return metrics
}

/* ------------------------------------------------------------- sub-objects */

export function normalizeBoundary(value: unknown): Boundary | null {
  if (!isRecord(value)) return null
  return {
    rootTeam: firstString(value.rootTeam, value.root_team, value.root) ?? "—",
    subteams: asArray(firstDefined(value.subteams, value.sub_teams)).filter(
      (item): item is string => typeof item === "string",
    ),
    repos: asArray(firstDefined(value.repos, value.repositories)).filter(
      (item): item is string => typeof item === "string",
    ),
    dataOwner: firstString(value.dataOwner, value.data_owner, value.owner) ?? "Unassigned",
    effectiveSince:
      firstString(value.effectiveSince, value.effective_since, value.effective_from, value.effective) ?? "—",
    effectiveUntil: firstString(value.effectiveUntil, value.effective_until, value.effective_to) ?? null,
    lifecycle: firstString(value.lifecycle) ?? "Active",
    version: firstString(value.version, value.boundary_version) ?? null,
  }
}

function evidenceReference(value: unknown, index: number): string {
  if (typeof value === "string" && value.trim()) return value.trim()
  if (!isRecord(value)) return ""
  const reference = firstString(
    value.reference_id,
    value.referenceId,
    value.source_id,
    value.sourceId,
    value.id,
    value.ref,
    value.uri,
    value.url,
    value.source,
  )
  return reference ? String(reference) : `evidence row ${index + 1}`
}

const EVIDENCE_SEVERITIES: EvidenceSeverity[] = ["red", "amber", "blue", "teal"]

/**
 * Warnings must be inspectable. An item whose source references cannot be
 * resolved is dropped entirely rather than shown as an unbacked assertion --
 * the same rule the API documents for evidence-linked warnings.
 */
export function normalizeEvidence(value: unknown): EvidenceItem[] {
  return asArray(value)
    .map((item): EvidenceItem | null => {
      if (!isRecord(item)) return null
      const sources = asArray(
        firstDefined(
          item.source_evidence,
          item.sourceEvidence,
          item.source_refs,
          item.source_evidence_refs,
          item.evidence_refs,
          item.evidenceReferences,
          item.sources,
        ),
      )
        .map(evidenceReference)
        .filter(Boolean)
      if (!sources.length) return null

      const metric = firstString(item.metric, item.metric_key) ?? null
      const rawType = firstString(item.type, item.severity) ?? "blue"
      const defaultIcon =
        metric === "openPRs" || metric === "open_prs"
          ? "pull"
          : metric === "contributors" || metric === "active_contributors"
            ? "users"
            : "activity"

      return {
        id: firstString(item.warning_id, item.warningId, item.id) ?? null,
        type: EVIDENCE_SEVERITIES.includes(rawType as EvidenceSeverity)
          ? (rawType as EvidenceSeverity)
          : "blue",
        icon: firstString(item.icon) ?? defaultIcon,
        title: firstString(item.title, item.signal_name, item.signalName) ?? "Signal evidence",
        metric,
        unit: firstString(item.unit) ?? "",
        current: finiteNumber(firstDefined(item.current, item.current_value)),
        baseline: finiteNumber(firstDefined(item.baseline, item.baseline_value)),
        window: firstString(item.window, item.time_window) ?? null,
        threshold: firstString(item.threshold, item.trigger_threshold) ?? null,
        sources,
      }
    })
    .filter((item): item is EvidenceItem => item !== null)
}

export function normalizeHistory(value: unknown): HistoryEntry[] {
  return asArray(value)
    .map((item): HistoryEntry | null => {
      if (!isRecord(item)) return null
      return {
        date: firstString(item.date, item.at, item.created_at) ?? "—",
        action: firstString(item.action, item.category) ?? "Review note",
        note: firstString(item.note, item.explanation, item.detail) ?? "",
      }
    })
    .filter((item): item is HistoryEntry => item !== null)
}

/* --------------------------------------------------------- health assessment */

const ASSESSMENT_STATUS_META: Record<string, { label: string; className: StatusClass | "neutral" }> = {
  risk: { label: "At risk", className: "risk" },
  at_risk: { label: "At risk", className: "risk" },
  watch: { label: "Watch", className: "watch" },
  okay: { label: "Okay", className: "clear" },
  ok: { label: "Okay", className: "clear" },
  clear: { label: "Okay", className: "clear" },
  healthy: { label: "Okay", className: "clear" },
  on_track: { label: "Okay", className: "clear" },
  blocked: { label: "Blocked", className: "risk" },
  insufficient_data: { label: "Insufficient data", className: "neutral" },
  planned_pause: { label: "Planned pause", className: "neutral" },
}

const ASSESSMENT_FIELD_PATTERN =
  /status|score|confidence|expected.?week|explanation|summary|blocker|task|recommend|citation|evidence/i

/** The CI agent's assessment has been nested under a handful of different
 *  keys over time; find the first candidate that actually looks like one. */
function assessmentSource(rawProject: unknown): RawRecord | null {
  const raw = record(rawProject)
  const profile = record(raw.profile)
  const projectProfile = record(raw.projectProfile ?? raw.project_profile)
  const projectAgent = record(raw.projectAgent ?? raw.project_agent)
  const agent = record(raw.agent)
  const candidates: unknown[] = [
    raw.healthAssessment,
    raw.health_assessment,
    raw.projectHealthAssessment,
    raw.project_health_assessment,
    profile.healthAssessment,
    profile.health_assessment,
    projectProfile.healthAssessment,
    projectProfile.health_assessment,
    projectAgent.healthAssessment,
    projectAgent.health_assessment,
    agent.healthAssessment,
    agent.health_assessment,
    raw.projectAgent,
    raw.project_agent,
    raw.agent,
  ]
  const match = candidates.find(
    (candidate) => isRecord(candidate) && Object.keys(candidate).some((key) => ASSESSMENT_FIELD_PATTERN.test(key)),
  )
  return isRecord(match) ? match : null
}

function normalizeAssessmentStatus(value: unknown): { label: string | null; className: StatusClass | "neutral" } {
  const raw = String(value ?? "").trim()
  if (!raw) return { label: null, className: "neutral" }
  const key = raw.toLowerCase().replaceAll("-", "_").replaceAll(" ", "_")
  return ASSESSMENT_STATUS_META[key] ?? { label: raw, className: "neutral" }
}

function normalizeAssessmentItems(value: unknown): AssessmentItem[] {
  return asArray(value)
    .map((item): AssessmentItem | null => {
      if (typeof item === "string" && item.trim()) return { title: item.trim(), detail: null, week: null }
      if (!isRecord(item)) return null
      const title = firstString(
        item.title,
        item.task,
        item.name,
        item.label,
        item.blocker,
        item.recommendation,
        item.text,
      )
      if (!title) return null
      const week = firstDefined(item.week, item.expected_week, item.expectedWeek)
      return {
        title: title.trim(),
        detail: firstString(item.detail, item.description, item.reason, item.explanation) ?? null,
        week: typeof week === "string" || typeof week === "number" ? week : null,
      }
    })
    .filter((item): item is AssessmentItem => item !== null)
}

function normalizeAssessmentCitations(value: unknown[]): AssessmentCitation[] {
  return value
    .map((item): AssessmentCitation | null => {
      if (typeof item === "string" && item.trim()) {
        return { label: item.trim(), reference: item.trim(), url: null }
      }
      if (!isRecord(item)) return null
      const sourceReference = [
        item.source_type,
        item.sourceType,
        item.source_id,
        item.sourceId,
        item.source_field,
        item.sourceField,
      ]
        .filter((part) => part !== undefined && part !== null && String(part).trim())
        .join(":")
      const reference = firstString(
        item.reference,
        item.reference_id,
        item.referenceId,
        sourceReference,
        item.source_id,
        item.sourceId,
        item.uri,
        item.url,
        item.ref,
        item.id,
      )
      if (!reference) return null
      return {
        label: firstString(item.label, item.title, item.source, item.name) ?? null,
        reference: reference.trim(),
        url: firstString(item.url, item.uri) ?? null,
      }
    })
    .filter((item): item is AssessmentCitation => item !== null)
}

export function normalizeHealthAssessment(rawProject: unknown): HealthAssessment | null {
  const source = assessmentSource(rawProject)
  if (!source) return null
  const status = normalizeAssessmentStatus(
    firstDefined(
      source.status,
      source.rag_status,
      source.ragStatus,
      source.assessment_status,
      source.assessmentStatus,
      source.health_status,
      source.healthStatus,
    ),
  )
  const score = finiteNumber(firstDefined(source.score, source.health_score, source.healthScore, source.rag_score, source.ragScore))
  const confidence = finiteNumber(firstDefined(source.confidence, source.confidence_score, source.confidenceScore))
  const expectedWeekRaw = firstDefined(
    source.expected_week,
    source.expectedWeek,
    source.expected_week_number,
    source.expectedWeekNumber,
    source.target_week,
    source.targetWeek,
  )
  const expectedWeek =
    typeof expectedWeekRaw === "string" || typeof expectedWeekRaw === "number" ? expectedWeekRaw : null
  const explanation = firstString(source.explanation, source.summary, source.rationale, source.reason) ?? null
  const blockers = normalizeAssessmentItems(
    firstDefined(source.blockers, source.blocking_items, source.blockingItems, source.risks) ?? [],
  )
  const weeklyTasks = normalizeAssessmentItems(
    firstDefined(
      source.recommended_weekly_tasks,
      source.recommendedWeeklyTasks,
      source.weekly_tasks,
      source.weeklyTasks,
      source.recommended_tasks,
      source.recommendedTasks,
      source.tasks,
    ) ?? [],
  )
  const citations = normalizeAssessmentCitations(
    [
      source.citations,
      source.evidence_references,
      source.evidenceReferences,
      source.evidence_refs,
      source.evidenceRefs,
      source.evidence_citations,
      source.spec_citations,
      source.sources,
    ].flatMap((value) => asArray(value)),
  )

  /* An assessment envelope with nothing inspectable in it is not an
     assessment; showing an empty card would imply a verdict was returned. */
  const hasInspectableFields = Boolean(
    status.label ||
      score !== null ||
      confidence !== null ||
      expectedWeek !== null ||
      explanation ||
      blockers.length ||
      weeklyTasks.length ||
      citations.length,
  )
  if (!hasInspectableFields) return null

  return {
    status: status.label,
    statusClass: status.className,
    score,
    confidence,
    expectedWeek,
    explanation,
    blockers,
    weeklyTasks,
    citations,
  }
}

/* ------------------------------------------------------------------ status */

export function normalizeStatus(value: unknown): [string, StatusClass] {
  const status = String(value ?? "")
    .toLowerCase()
    .replaceAll("-", "_")
    .replaceAll(" ", "_")
  if (status === "at_risk" || status === "risk") return ["At risk", "risk"]
  if (status === "watch") return ["Watch", "watch"]
  if (status === "clear") return ["Clear", "clear"]
  if (status === "planned_pause" || status === "pause" || status === "paused") return ["Planned pause", "pause"]
  return ["Insufficient data", "data"]
}

function looksPaused(raw: RawRecord, boundary: Boundary | null): boolean {
  const lifecycle = String(firstDefined(raw.lifecycle, boundary?.lifecycle) ?? "").toLowerCase()
  return (
    raw.planned_pause === true ||
    raw.plannedPause === true ||
    lifecycle === "paused" ||
    lifecycle === "planned pause" ||
    lifecycle === "planned_pause"
  )
}

export function formatLastActivity(days: unknown): string {
  const number = finiteNumber(days)
  if (number === null) return "—"
  if (number <= 0) return "Today"
  if (number === 1) return "Yesterday"
  return `${number} days ago`
}

function formatActivityDetail(metrics: Partial<Record<AggregateMetricKey, number>>): string {
  const activeDays = metrics.active_days
  const openPrs = metrics.open_prs
  if (activeDays !== undefined && openPrs !== undefined) return `${activeDays} active days · ${openPrs} open PRs`
  if (activeDays !== undefined) return `${activeDays} active days in the snapshot window`
  return "Snapshot metrics are available for review."
}

/* ----------------------------------------------------------------- project */

export function normalizeProject(rawProject: unknown, snapshotMeta: Partial<SnapshotMeta> = {}): Project {
  const raw = record(rawProject)
  const healthAssessment = normalizeHealthAssessment(raw)
  const metrics = normalizeMetricObject(firstDefined(raw.metrics, raw.metric_values) ?? {})
  const baselines = normalizeMetricObject(firstDefined(raw.baselines, raw.baseline_metrics) ?? {})
  const rawSeries = record(raw.series)
  const sourceWeeks = asArray(raw.weeks)

  const series: Partial<Record<MetricSeriesKey, Series>> = {
    activity: normalizeSeries(firstDefined(rawSeries.activity, rawSeries.active_days, raw.active_days_series)),
    openPRs: normalizeSeries(firstDefined(rawSeries.openPRs, rawSeries.open_prs)),
    reviewLatency: normalizeSeries(
      firstDefined(rawSeries.reviewLatency, rawSeries.review_latency_days, rawSeries.review_latency),
    ),
    contributors: normalizeSeries(firstDefined(rawSeries.contributors, rawSeries.active_contributors)),
  }

  /* Contributor counts are suppressed entirely below the aggregation floor.
     Without the aggregate the per-week series cannot be shown either -- a
     partial contributor series would read as a real, smaller team. */
  const contributorAggregateAvailable = hasOwn(metrics, "active_contributors")
  if (!contributorAggregateAvailable) series.contributors = normalizeSeries(null)

  if (!series.activity?.some((value) => value !== null) && sourceWeeks.length) {
    series.activity = normalizeSeries(
      sourceWeeks.map((value) => {
        const number = finiteNumber(value)
        return number === null ? null : number * 7
      }),
    )
  }

  const activitySource: unknown[] = series.activity?.some((value) => value !== null)
    ? (series.activity as unknown[])
    : sourceWeeks
  const weeks = normalizeSeries(
    activitySource.map((value) => {
      const number = finiteNumber(value)
      return number === null ? null : Math.min(1, number > 1 ? number / 7 : number)
    }),
  )

  const boundary = normalizeBoundary(raw.boundary)
  const evidence = normalizeEvidence(firstDefined(raw.evidence, raw.warnings) ?? [])
  const visibleEvidence = evidence.filter((item) => {
    const metric = String(item.metric ?? "").toLowerCase()
    return contributorAggregateAvailable || !["contributors", "active_contributors"].includes(metric)
  })

  let [status, statusClass] = normalizeStatus(
    firstDefined(raw.status, raw.attention_status, raw.statusClass, raw.status_class),
  )
  if (looksPaused(raw, boundary)) {
    status = "Planned pause"
    statusClass = "pause"
  }
  /* A risk or watch verdict with no inspectable evidence behind it is not
     shown as a warning. It falls back to insufficient data. */
  if ((statusClass === "risk" || statusClass === "watch") && !visibleEvidence.length) {
    status = "Insufficient data"
    statusClass = "data"
  }

  const aggregateMetrics = { ...metrics }
  if (metricValue(metrics, "active_contributors") === null) delete aggregateMetrics.active_contributors

  const hasTrustedMetricData =
    Object.keys(aggregateMetrics).length > 0 ||
    Boolean(series.activity?.some((value) => value !== null)) ||
    Boolean(series.openPRs?.some((value) => value !== null)) ||
    Boolean(series.reviewLatency?.some((value) => value !== null))
  /* "Clear" asserts something was measured and looked fine. With nothing
     measured it is insufficient data, not a clean bill of health. */
  if (statusClass === "clear" && !hasTrustedMetricData) {
    status = "Insufficient data"
    statusClass = "data"
  }

  const currentValues: Record<MetricSeriesKey, number | null> = {
    activity: metricValue(metrics, "active_days", lastValue(series.activity)),
    openPRs: metricValue(metrics, "open_prs", lastValue(series.openPRs)),
    reviewLatency: metricValue(metrics, "review_latency_days", lastValue(series.reviewLatency)),
    contributors: metricValue(metrics, "active_contributors", lastValue(series.contributors)),
  }

  const explicitBaselines = record(firstDefined(raw.seriesBaselines, raw.series_baselines) ?? {})
  const seriesBaselines: Partial<Record<MetricSeriesKey, [number | null, number | null]>> = {}
  for (const { key, metricKey } of METRIC_DEFINITIONS) {
    if (key === "contributors" && !contributorAggregateAvailable) {
      seriesBaselines[key] = [null, null]
      continue
    }
    const explicit = asArray(firstDefined(explicitBaselines[key], explicitBaselines[metricKey]) ?? [])
    seriesBaselines[key] = [
      metricValue(baselines, metricKey, finiteNumber(explicit[0])),
      currentValues[key] ?? finiteNumber(explicit[1]),
    ]
  }
  if (!contributorAggregateAvailable) {
    delete series.contributors
    delete seriesBaselines.contributors
  }

  const completeness = finiteNumber(firstDefined(raw.data_completeness_pct, snapshotMeta.dataCompletenessPct))

  const signal =
    statusClass === "data"
      ? "Trusted evidence is incomplete"
      : statusClass === "pause"
        ? "Inactivity is expected"
        : (firstString(raw.signal, raw.signal_name, visibleEvidence[0]?.title) ??
          (status === "Clear" ? "No current concern detected" : "Review current project signals"))

  const signalDetail =
    statusClass === "data"
      ? "The project remains out of the attention queue until data and evidence are available."
      : statusClass === "pause"
        ? "Planned pause is excluded from scoring."
        : (firstString(raw.signalDetail, raw.signal_detail) ?? formatActivityDetail(aggregateMetrics))

  const name = firstString(raw.name, raw.project_name, raw.id) ?? "Unnamed project"

  return {
    id: String(firstString(raw.project_id, raw.id) ?? "unknown-project"),
    name,
    short:
      firstString(raw.short) ??
      name
        .split(/\s+/)
        .map((part) => part[0])
        .join("")
        .slice(0, 2)
        .toUpperCase(),
    team: firstString(raw.team, raw.root_team, boundary?.rootTeam) ?? "Unassigned",
    repo: firstString(raw.repo, boundary?.repos?.[0]) ?? "—",
    status,
    statusClass,
    signal,
    signalDetail,
    signalSource: firstString(raw.signalSource, raw.signal_source) ?? null,
    signalConfidence: finiteNumber(firstDefined(raw.signalConfidence, raw.signal_confidence)),
    signalModel: firstString(raw.signalModel, raw.signal_model) ?? null,
    signalEvidenceTier: firstString(raw.signalEvidenceTier, raw.signal_evidence_tier) ?? null,
    lastActivity:
      firstString(raw.lastActivity, raw.last_activity) ?? formatLastActivity(aggregateMetrics.days_since_activity),
    weeks,
    seriesBaselines,
    series,
    metrics: aggregateMetrics,
    description: firstString(raw.description) ?? "",
    boundary,
    /* A paused or data-starved project shows no warnings at all: pauses
       short-circuit rule evaluation and are never emitted as risk. */
    evidence: statusClass === "pause" || statusClass === "data" ? [] : visibleEvidence,
    history: normalizeHistory(raw.history),
    dataCompletenessPct: completeness,
    lastSyncAt: firstString(raw.last_sync_at) ?? snapshotMeta.lastSyncAt ?? null,
    snapshotId: firstString(raw.snapshot_id) ?? snapshotMeta.snapshotId ?? null,
    healthAssessment,
  }
}

/* ---------------------------------------------------------------- snapshot */

export function snapshotEnvelope(raw: unknown): RawRecord {
  const outer = record(raw)
  if (isRecord(outer.snapshot)) return outer.snapshot
  if (isRecord(outer.data)) return outer.data
  return outer
}

export function normalizeSnapshotMeta(raw: unknown): SnapshotMeta {
  const envelope = snapshotEnvelope(raw)
  return {
    snapshotId: firstString(envelope.snapshot_id, envelope.snapshotId, envelope.id) ?? null,
    snapshotWeekStart: firstString(envelope.snapshot_week_start, envelope.week_start) ?? null,
    snapshotWeekEnd: firstString(envelope.snapshot_week_end, envelope.week_end) ?? null,
    generatedAt: firstString(envelope.generated_at) ?? null,
    ruleSetVersion: firstString(envelope.rule_set_version) ?? null,
    dataCompletenessPct: finiteNumber(envelope.data_completeness_pct),
    lastSyncAt: firstString(envelope.last_sync_at) ?? null,
  }
}

export function normalizeSnapshot(raw: unknown): PortfolioSnapshot {
  const envelope = snapshotEnvelope(raw)
  const meta = normalizeSnapshotMeta(raw)
  return { ...meta, projects: asArray(envelope.projects).map((project) => normalizeProject(project, meta)) }
}

export function normalizeLatestSnapshot(raw: unknown): LatestSnapshotResult {
  const outer = record(raw)
  return {
    snapshot: normalizeSnapshot(raw),
    lazyWeekStart: firstString(outer.lazy_week_start) ?? null,
    computable: Boolean(outer.computable),
    missingProjectIds: asArray(outer.missing_project_ids).filter(
      (value): value is string => typeof value === "string",
    ),
  }
}

/* --------------------------------------- per-project snapshot history shape */

function snapshotSourcePriority(snapshot: unknown): number {
  const outer = record(snapshot)
  const project = isRecord(outer.project) ? outer.project : outer
  const source = String(
    firstDefined(project.signalSource, project.signal_source, outer.rule_set_version) ?? "",
  ).toLowerCase()
  return source === "llm" || source.startsWith("llm-signal-") ? 1 : 0
}

/** Newest week first; within a week, an LLM-sourced row beats a rule-only one,
 *  then the later generation timestamp wins. */
export function compareSnapshotRows(left: unknown, right: unknown): number {
  const leftRecord = record(left)
  const rightRecord = record(right)
  const weekOrder = String(
    firstDefined(rightRecord.snapshot_week_end, rightRecord.week_end, rightRecord.generated_at) ?? "",
  ).localeCompare(
    String(firstDefined(leftRecord.snapshot_week_end, leftRecord.week_end, leftRecord.generated_at) ?? ""),
  )
  if (weekOrder !== 0) return weekOrder
  const sourceOrder = snapshotSourcePriority(right) - snapshotSourcePriority(left)
  if (sourceOrder !== 0) return sourceOrder
  return String(firstDefined(rightRecord.generated_at) ?? "").localeCompare(
    String(firstDefined(leftRecord.generated_at) ?? ""),
  )
}

/** `/projects/{id}/snapshots` has answered with several envelopes over time.
 *  Resolve any of them down to the one project record worth rendering. */
export function projectFromSnapshotResponse(raw: unknown, projectId: string): unknown {
  const withProfileAssessment = (project: unknown, envelope: unknown): unknown => {
    if (!isRecord(project) || !isRecord(envelope)) return project
    const agent = record(envelope.agent)
    const assessment = firstDefined(
      envelope.healthAssessment,
      envelope.health_assessment,
      envelope.projectHealthAssessment,
      envelope.project_health_assessment,
      agent.healthAssessment,
      agent.health_assessment,
    )
    return assessment && !project.healthAssessment && !project.health_assessment
      ? { ...project, healthAssessment: assessment }
      : project
  }

  if (isRecord(raw) && raw.project) return withProfileAssessment(raw.project, raw)
  if (isRecord(raw) && isRecord(raw.snapshot) && Array.isArray(raw.snapshot.projects)) {
    const projects = raw.snapshot.projects as unknown[]
    return projects.find((project) => record(project).id === projectId) ?? projects[0]
  }
  if (isRecord(raw) && Array.isArray(raw.projects)) {
    const projects = raw.projects as unknown[]
    return projects.find((project) => record(project).id === projectId) ?? projects[0]
  }
  if (isRecord(raw) && Array.isArray(raw.items)) return projectFromSnapshotResponse(raw.items, projectId)
  if (isRecord(raw) && Array.isArray(raw.snapshots)) {
    const sorted = (raw.snapshots as unknown[]).slice().sort(compareSnapshotRows)
    return projectFromSnapshotResponse(sorted[0], projectId)
  }
  if (Array.isArray(raw)) return raw.slice().sort(compareSnapshotRows)[0]
  return raw
}

export function snapshotMetaFromResponse(raw: unknown): SnapshotMeta {
  const outer = record(raw)
  const candidates = Array.isArray(raw) ? raw : asArray(firstDefined(outer.snapshots, outer.items) ?? [])
  const latest = candidates.length ? candidates.slice().sort(compareSnapshotRows)[0] : raw
  return normalizeSnapshotMeta(latest)
}
