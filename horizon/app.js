const icons = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  folder: '<path d="M3 6.5A2.5 2.5 0 0 1 5.5 4h4l2 2H18.5A2.5 2.5 0 0 1 21 8.5v7A2.5 2.5 0 0 1 18.5 18h-13A2.5 2.5 0 0 1 3 15.5Z"/>',
  database: '<ellipse cx="12" cy="5" rx="7" ry="3"/><path d="M5 5v7c0 1.7 3.1 3 7 3s7-1.3 7-3V5M5 12v7c0 1.7 3.1 3 7 3s7-1.3 7-3v-7"/>',
  calendar: '<rect x="3" y="4.5" width="18" height="17" rx="2"/><path d="M16 3v3M8 3v3M3 9h18M8 13h.01M12 13h.01M16 13h.01M8 17h.01M12 17h.01"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  'check-circle': '<circle cx="12" cy="12" r="9"/><path d="m8 12 2.7 2.7L16.5 9"/>',
  triangle: '<path d="m12 4 9 16H3Z"/><path d="M12 10v4M12 17h.01"/>',
  pause: '<rect x="5" y="4" width="14" height="16" rx="3"/><path d="M10 9v6M14 9v6"/>',
  message: '<path d="M20 11.5a7 7 0 0 1-7.2 7H8l-4 2 1.6-4A7.4 7.4 0 0 1 5 12c0-4.2 3.4-7.5 7.7-7.5S20 7.2 20 11.5Z"/><path d="M8 12h.01M12 12h.01M16 12h.01"/>',
  activity: '<path d="M3 12h4l2-6 4 12 2-6h6"/>',
  pull: '<path d="M6 3v18M6 7h8a3 3 0 0 1 3 3v1M18 8l2 3-2 3M6 17h8a3 3 0 0 0 3-3v-1"/>',
  users: '<path d="M16 20v-1.5a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4V20M9.5 10.5A3.5 3.5 0 1 0 9.5 3a3.5 3.5 0 0 0 0 7.5ZM17 11a3 3 0 1 0-1-5.8M21 20v-1.4a4 4 0 0 0-3-3.8"/>',
  sparkle: '<path d="m12 3 1.3 5.7L19 10l-5.7 1.3L12 17l-1.3-5.7L5 10l5.7-1.3ZM19 17l.5 2.5L22 20l-2.5.5L19 23l-.5-2.5L16 20l2.5-.5Z"/>',
  trend: '<path d="M4 17 10 11l4 4 6-7M15 8h5v5"/>',
};

function icon(name) {
  return `<svg class="icon-svg" viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.sparkle}</svg>`;
}

document.querySelectorAll('[data-icon]').forEach((element) => {
  element.innerHTML = icon(element.dataset.icon);
});

const API_BASE = window.PHI_API_BASE || 'http://127.0.0.1:8000';
const METRIC_DEFINITIONS = [
  { label: 'Activity', key: 'activity', metricKey: 'active_days', unit: 'd' },
  { label: 'Open PRs', key: 'openPRs', metricKey: 'open_prs', unit: '' },
  { label: 'Review latency', key: 'reviewLatency', metricKey: 'review_latency_days', unit: 'd' },
  { label: 'Active contributors', key: 'contributors', metricKey: 'active_contributors', unit: '' },
];
const AGGREGATE_METRIC_KEYS = [
  'active_days',
  'days_since_activity',
  'open_prs',
  'oldest_open_pr_days',
  'review_latency_days',
  'merged_count',
  'active_contributors',
];
const viewLabels = { overview: 'Overview', projects: 'Projects', insights: 'Insights', members: 'Members', member: 'Members', recruiting: 'Recruiting' };
// Gitea member analytics. These are named per-person contribution metrics --
// descriptive activity indicators, not a performance score -- so the sort
// list is kept to observable counts with no derived ranking of its own.
const MEMBER_SORTS = [
  { key: 'commits', label: 'Commits' },
  { key: 'blame_lines', label: 'Lines owned' },
  { key: 'additions', label: 'Additions' },
  { key: 'pulls_merged', label: 'Merged PRs' },
  { key: 'reviews_submitted', label: 'Reviews' },
  { key: 'issues_opened', label: 'Issues' },
  { key: 'active_days', label: 'Active days' },
  { key: 'name', label: 'Name' },
];
const MEMBER_SORT_KEYS = MEMBER_SORTS.map((option) => option.key);
// The inventory filter chips, hoisted out of renderProjects so the router can
// validate a `?filter=` value against the same list the UI offers.
const PROJECT_FILTERS = ['All projects', 'Active projects', 'Needs attention', 'At risk', 'Watch', 'Clear', 'Insufficient data', 'Planned pause'];
const statusMeta = {
  risk: { copy: 'Review', cta: 'Review' },
  watch: { copy: 'Review', cta: 'Review' },
  clear: { copy: 'No concern', cta: 'Confirm' },
  data: { copy: 'Insufficient data', cta: 'Flag' },
  pause: { copy: 'Paused', cta: 'Acknowledge' },
};

const state = {
  loading: true,
  error: null,
  snapshot: null,
  projects: [],
  projectSnapshots: {},
  projectSnapshotMeta: {},
  // Point-in-time project profiles, keyed `${projectId}@${YYYY-MM-DD}`, kept
  // apart from projectSnapshots above so a historical view never overwrites
  // (or gets served from) the live cache. Each entry is
  // { hasData: boolean, project: normalizedProject|null }.
  projectAsOf: {},
  delivery: null,
  // Projects-page cumulative-progress-as-of-date view.
  progressDate: null,
  progressLoading: false,
  progressError: null,
  progressComputable: false,
  progressResult: {}, // project_id -> { state: 'pending'|'done'|'error', data?, error? }
  // The date a *portfolio-wide* progress fan-out was last run for. Re-running
  // it costs one LLM request
  // per project, so Back/Forward must never trigger it for a date already
  // loaded. Deliberately left null by the single-project loader below, whose
  // result covers only one row of the list.
  progressLoadedDate: null,
  progressRunId: 0,
  // Viewport-gated lazy compute for the *live* dashboard (the Projects and
  // Insights tables). It fills in the current view for
  // projects GET /snapshots/latest had no snapshot for at all. Each id is
  // computed only once its row scrolls into view, so a cold database costs
  // one LLM request per project actually looked at rather than one per
  // project in the portfolio.
  lazyWeekStart: null,
  lazyComputable: false,
  lazyMissing: new Set(),
  lazyComputing: new Set(),
  lazyErrors: {},
  // Gitea member analytics, served by /analytics/*. Deliberately independent
  // of the portfolio snapshot above: it is a separate ingest with its own
  // run history, so this view stays usable when /snapshots/latest fails.
  membersRun: null,
  membersTotals: null,
  memberRows: [],
  membersLoading: false,
  membersError: null,
  // The filter signature memberRows were fetched for, so returning to the
  // view via Back/Forward re-renders from memory instead of refetching.
  membersLoadedKey: null,
  memberOrganizations: [],
  memberDetail: null,
  memberDetailLoading: false,
  memberDetailError: null,
  // Reviewer-gated recruiting signal pipeline. AI ranks remain provisional
  // until a human confirms, adjusts, or defers each candidate.
  recruitingOverview: null,
  recruitingCandidates: [],
  recruitingLoading: false,
  recruitingError: null,
  recruitingDetail: null,
  recruitingDetailLoading: false,
  recruitingDetailError: null,
  recruitingLoadedRunId: null,
  recruitingAudit: null,
  recruitingAuditLoading: false,
  recruitingAuditError: null,
};

let currentView = 'overview';
let selectedProjectId = null;
// The date the open profile is being viewed "as of". null means live data.
let selectedProjectAsOfDate = null;
// Which project's cumulative-progress checkpoint the 'progress' view is
// showing. Deliberately separate from selectedProjectId: that one drives the
// weekly-snapshot profile, and the two views answer different questions.
let selectedProgressProjectId = null;
let currentFilter = 'All projects';
// Which identity the 'member' detail view is showing, and the member-table
// controls. Kept module-level alongside currentFilter for the same reason:
// the router treats them as part of the addressable route state.
let selectedMemberLogin = null;
let memberSort = 'commits';
let memberOrgFilter = 'all';
let memberSearch = '';
let memberIncludeService = true;
let memberIncludeUnmatched = true;
let selectedRecruitingLogin = null;
let modalFeedback = '';
let feedbackWarningId = null;

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function finiteNumber(value) {
  if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) return null;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function hasOwn(object, key) {
  return Boolean(object && Object.prototype.hasOwnProperty.call(object, key));
}

function isAttentionProject(project) {
  return (project.statusClass === 'risk' || project.statusClass === 'watch') && project.evidence.length > 0;
}

function isActiveProject(project) {
  return project.statusClass !== 'pause';
}

function normalizeSeries(value) {
  const source = asArray(value).slice(0, 8);
  return Array.from({ length: 8 }, (_, index) => finiteNumber(source[index]));
}

function normalizeMetricObject(value) {
  const source = value && typeof value === 'object' ? value : {};
  return AGGREGATE_METRIC_KEYS.reduce((metrics, key) => {
    if (hasOwn(source, key)) {
      const normalized = finiteNumber(source[key]);
      if (normalized !== null) metrics[key] = normalized;
    }
    return metrics;
  }, {});
}

function normalizeBoundary(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    rootTeam: firstDefined(value.rootTeam, value.root_team, value.root, '—'),
    subteams: asArray(firstDefined(value.subteams, value.sub_teams)).filter((item) => typeof item === 'string'),
    repos: asArray(value.repos || value.repositories).filter((item) => typeof item === 'string'),
    dataOwner: firstDefined(value.dataOwner, value.data_owner, value.owner, 'Unassigned'),
    effectiveSince: firstDefined(value.effectiveSince, value.effective_since, value.effective_from, value.effective, '—'),
    effectiveUntil: firstDefined(value.effectiveUntil, value.effective_until, value.effective_to, null),
    lifecycle: firstDefined(value.lifecycle, 'Active'),
    version: firstDefined(value.version, value.boundary_version, null),
  };
}

function evidenceReference(value, index) {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (!value || typeof value !== 'object') return '';
  const reference = firstDefined(value.reference_id, value.referenceId, value.source_id, value.sourceId, value.id, value.ref, value.uri, value.url, value.source);
  return reference ? String(reference) : `evidence row ${index + 1}`;
}

function normalizeEvidence(value) {
  return asArray(value).map((item, index) => {
    if (!item || typeof item !== 'object') return null;
    const sources = asArray(firstDefined(item.source_evidence, item.sourceEvidence, item.source_refs, item.source_evidence_refs, item.evidence_refs, item.evidenceReferences, item.sources))
      .map((reference, referenceIndex) => evidenceReference(reference, referenceIndex))
      .filter(Boolean);
    if (!sources.length) return null;
    return {
      id: firstDefined(item.warning_id, item.warningId, item.id, null),
      type: firstDefined(item.type, item.severity, 'blue'),
      icon: firstDefined(item.icon, item.metric === 'openPRs' || item.metric === 'open_prs' ? 'pull' : item.metric === 'contributors' || item.metric === 'active_contributors' ? 'users' : 'activity'),
      title: firstDefined(item.title, item.signal_name, item.signalName, 'Signal evidence'),
      metric: firstDefined(item.metric, item.metric_key, null),
      unit: firstDefined(item.unit, ''),
      current: firstDefined(item.current, item.current_value, null),
      baseline: firstDefined(item.baseline, item.baseline_value, null),
      window: firstDefined(item.window, item.time_window, null),
      threshold: firstDefined(item.threshold, item.trigger_threshold, null),
      sources,
    };
  }).filter(Boolean).map((item) => ({ ...item, type: ['red', 'amber', 'blue', 'teal'].includes(item.type) ? item.type : 'blue' }));
}

function normalizeHistory(value) {
  return asArray(value).map((item) => {
    if (!item || typeof item !== 'object') return null;
    return {
      date: firstDefined(item.date, item.at, item.created_at, '—'),
      action: firstDefined(item.action, item.category, 'Review note'),
      note: firstDefined(item.note, item.explanation, item.detail, ''),
    };
  }).filter(Boolean);
}

const assessmentStatusMeta = {
  risk: { label: 'At risk', className: 'risk' },
  at_risk: { label: 'At risk', className: 'risk' },
  watch: { label: 'Watch', className: 'watch' },
  okay: { label: 'Okay', className: 'clear' },
  ok: { label: 'Okay', className: 'clear' },
  clear: { label: 'Okay', className: 'clear' },
  healthy: { label: 'Okay', className: 'clear' },
  on_track: { label: 'Okay', className: 'clear' },
  blocked: { label: 'Blocked', className: 'risk' },
  insufficient_data: { label: 'Insufficient data', className: 'neutral' },
  planned_pause: { label: 'Planned pause', className: 'neutral' },
};

function assessmentSource(rawProject) {
  const raw = rawProject && typeof rawProject === 'object' ? rawProject : {};
  const candidates = [
    raw.healthAssessment,
    raw.health_assessment,
    raw.projectHealthAssessment,
    raw.project_health_assessment,
    raw.profile?.healthAssessment,
    raw.profile?.health_assessment,
    raw.projectProfile?.healthAssessment,
    raw.project_profile?.health_assessment,
    raw.projectAgent?.healthAssessment,
    raw.project_agent?.health_assessment,
    raw.agent?.healthAssessment,
    raw.agent?.health_assessment,
    raw.projectAgent,
    raw.project_agent,
    raw.agent,
  ];
  return candidates.find((candidate) => candidate && typeof candidate === 'object' && !Array.isArray(candidate) && Object.keys(candidate).some((key) => /status|score|confidence|expected.?week|explanation|summary|blocker|task|recommend|citation|evidence/i.test(key))) || null;
}

function normalizeAssessmentStatus(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return { label: null, className: 'neutral' };
  const key = raw.toLowerCase().replaceAll('-', '_').replaceAll(' ', '_');
  return assessmentStatusMeta[key] || { label: raw, className: 'neutral' };
}

function normalizeAssessmentItems(value, kind) {
  return asArray(value).map((item) => {
    if (typeof item === 'string' && item.trim()) return { title: item.trim(), detail: null, week: null };
    if (!item || typeof item !== 'object') return null;
    const title = firstDefined(item.title, item.task, item.name, item.label, item.blocker, item.recommendation, item.text, null);
    if (!title || !String(title).trim()) return null;
    return {
      title: String(title).trim(),
      detail: firstDefined(item.detail, item.description, item.reason, item.explanation, null),
      week: firstDefined(item.week, item.expected_week, item.expectedWeek, null),
      kind,
    };
  }).filter(Boolean);
}

function normalizeAssessmentCitations(value) {
  return asArray(value).map((item) => {
    if (typeof item === 'string' && item.trim()) return { label: item.trim(), reference: item.trim(), url: null };
    if (!item || typeof item !== 'object') return null;
    const sourceReference = [item.source_type, item.sourceType, item.source_id, item.sourceId, item.source_field, item.sourceField].filter((part) => part !== undefined && part !== null && String(part).trim()).join(':');
    const reference = firstDefined(item.reference, item.reference_id, item.referenceId, sourceReference, item.source_id, item.sourceId, item.uri, item.url, item.ref, item.id, null);
    if (!reference || !String(reference).trim()) return null;
    return {
      label: firstDefined(item.label, item.title, item.source, item.name, null),
      reference: String(reference).trim(),
      url: firstDefined(item.url, item.uri, null),
    };
  }).filter(Boolean);
}

function normalizeHealthAssessment(rawProject) {
  const source = assessmentSource(rawProject);
  if (!source) return null;
  const status = normalizeAssessmentStatus(firstDefined(source.status, source.rag_status, source.ragStatus, source.assessment_status, source.assessmentStatus, source.health_status, source.healthStatus));
  const score = finiteNumber(firstDefined(source.score, source.health_score, source.healthScore, source.rag_score, source.ragScore));
  const confidence = finiteNumber(firstDefined(source.confidence, source.confidence_score, source.confidenceScore));
  const expectedWeek = firstDefined(source.expected_week, source.expectedWeek, source.expected_week_number, source.expectedWeekNumber, source.target_week, source.targetWeek, null);
  const explanation = firstDefined(source.explanation, source.summary, source.rationale, source.reason, null);
  const blockers = normalizeAssessmentItems(firstDefined(source.blockers, source.blocking_items, source.blockingItems, source.risks, []), 'blocker');
  const weeklyTasks = normalizeAssessmentItems(firstDefined(source.recommended_weekly_tasks, source.recommendedWeeklyTasks, source.weekly_tasks, source.weeklyTasks, source.recommended_tasks, source.recommendedTasks, source.tasks, []), 'task');
  const citationInputs = [source.citations, source.evidence_references, source.evidenceReferences, source.evidence_refs, source.evidenceRefs, source.evidence_citations, source.spec_citations, source.sources].flatMap((value) => asArray(value));
  const citations = normalizeAssessmentCitations(citationInputs);
  const hasInspectableFields = Boolean(status.label || score !== null || confidence !== null || expectedWeek !== null || explanation || blockers.length || weeklyTasks.length || citations.length);
  if (!hasInspectableFields) return null;
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
  };
}

function normalizeStatus(value) {
  const status = String(value || '').toLowerCase().replaceAll('-', '_').replaceAll(' ', '_');
  if (status === 'at_risk' || status === 'risk') return ['At risk', 'risk'];
  if (status === 'watch') return ['Watch', 'watch'];
  if (status === 'clear') return ['Clear', 'clear'];
  if (status === 'planned_pause' || status === 'pause' || status === 'paused') return ['Planned pause', 'pause'];
  return ['Insufficient data', 'data'];
}

function looksPaused(rawProject, boundary) {
  const lifecycle = String(firstDefined(rawProject.lifecycle, boundary?.lifecycle, '')).toLowerCase();
  return rawProject.planned_pause === true || rawProject.plannedPause === true || lifecycle === 'paused' || lifecycle === 'planned pause' || lifecycle === 'planned_pause';
}

function metricValue(metrics, key, fallback = null) {
  return hasOwn(metrics, key) ? metrics[key] : fallback;
}

function normalizeProject(rawProject, snapshotMeta = {}) {
  const raw = rawProject && typeof rawProject === 'object' ? rawProject : {};
  const healthAssessment = normalizeHealthAssessment(raw);
  const metrics = normalizeMetricObject(firstDefined(raw.metrics, raw.metric_values, {}));
  const baselines = normalizeMetricObject(firstDefined(raw.baselines, raw.baseline_metrics, {}));
  const rawSeries = raw.series && typeof raw.series === 'object' ? raw.series : {};
  const sourceWeeks = asArray(raw.weeks);
  const series = {
    activity: normalizeSeries(firstDefined(rawSeries.activity, rawSeries.active_days, raw.active_days_series)),
    openPRs: normalizeSeries(firstDefined(rawSeries.openPRs, rawSeries.open_prs)),
    reviewLatency: normalizeSeries(firstDefined(rawSeries.reviewLatency, rawSeries.review_latency_days, rawSeries.review_latency)),
    contributors: normalizeSeries(firstDefined(rawSeries.contributors, rawSeries.active_contributors)),
  };
  const contributorAggregateAvailable = hasOwn(metrics, 'active_contributors');
  if (!contributorAggregateAvailable) series.contributors = normalizeSeries(null);
  if (!series.activity.some((value) => value !== null) && sourceWeeks.length) {
    series.activity = normalizeSeries(sourceWeeks.map((value) => {
      const number = finiteNumber(value);
      return number === null ? null : number * 7;
    }));
  }
  const activitySource = series.activity.some((value) => value !== null) ? series.activity : sourceWeeks;
  const weeks = normalizeSeries(activitySource.map((value) => {
    const number = finiteNumber(value);
    return number === null ? null : Math.min(1, number > 1 ? number / 7 : number);
  }));
  const boundary = normalizeBoundary(raw.boundary);
  const sourceEvidence = firstDefined(raw.evidence, raw.warnings, []);
  const evidence = normalizeEvidence(sourceEvidence);
  const visibleEvidence = evidence.filter((item) => {
    const metric = String(item.metric || '').toLowerCase();
    return contributorAggregateAvailable || !['contributors', 'active_contributors'].includes(metric);
  });
  let [status, statusClass] = normalizeStatus(firstDefined(raw.status, raw.attention_status, raw.statusClass, raw.status_class));
  if (looksPaused(raw, boundary)) {
    status = 'Planned pause';
    statusClass = 'pause';
  }
  if ((statusClass === 'risk' || statusClass === 'watch') && !visibleEvidence.length) {
    status = 'Insufficient data';
    statusClass = 'data';
  }
  const aggregateMetrics = { ...metrics };
  const contributorCount = metricValue(metrics, 'active_contributors');
  if (contributorCount === null) delete aggregateMetrics.active_contributors;
  const hasTrustedMetricData = Object.keys(aggregateMetrics).length > 0 || series.activity.some((value) => value !== null) || series.openPRs.some((value) => value !== null) || series.reviewLatency.some((value) => value !== null);
  if (statusClass === 'clear' && !hasTrustedMetricData) {
    status = 'Insufficient data';
    statusClass = 'data';
  }
  const currentValues = {
    activity: metricValue(metrics, 'active_days', lastValue(series.activity)),
    openPRs: metricValue(metrics, 'open_prs', lastValue(series.openPRs)),
    reviewLatency: metricValue(metrics, 'review_latency_days', lastValue(series.reviewLatency)),
    contributors: metricValue(metrics, 'active_contributors', lastValue(series.contributors)),
  };
  const explicitBaselines = firstDefined(raw.seriesBaselines, raw.series_baselines, {});
  const seriesBaselines = Object.fromEntries(METRIC_DEFINITIONS.map(({ key, metricKey }) => {
    if (key === 'contributors' && !contributorAggregateAvailable) return [key, [null, null]];
    const explicit = asArray(firstDefined(explicitBaselines?.[key], explicitBaselines?.[metricKey]));
    const baseline = metricValue(baselines, metricKey, finiteNumber(explicit[0]));
    const current = currentValues[key] ?? finiteNumber(explicit[1]);
    return [key, [baseline, current]];
  }));
  if (!contributorAggregateAvailable) {
    delete series.contributors;
    delete seriesBaselines.contributors;
  }
  const completeness = finiteNumber(firstDefined(raw.data_completeness_pct, snapshotMeta.dataCompletenessPct));
  const signal = statusClass === 'data' ? 'Trusted evidence is incomplete' : statusClass === 'pause' ? 'Inactivity is expected' : firstDefined(raw.signal, raw.signal_name, visibleEvidence[0]?.title, status === 'Clear' ? 'No current concern detected' : 'Review current project signals');
  const signalDetail = statusClass === 'data' ? 'The project remains out of the attention queue until data and evidence are available.' : statusClass === 'pause' ? 'Planned pause is excluded from scoring.' : firstDefined(raw.signalDetail, raw.signal_detail, formatActivityDetail(aggregateMetrics));
  return {
    id: String(firstDefined(raw.project_id, raw.id, 'unknown-project')),
    name: firstDefined(raw.name, raw.project_name, raw.id, 'Unnamed project'),
    short: firstDefined(raw.short, String(firstDefined(raw.name, raw.id, 'P')).split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase()),
    team: firstDefined(raw.team, raw.root_team, boundary?.rootTeam, 'Unassigned'),
    repo: firstDefined(raw.repo, boundary?.repos?.[0], '—'),
    status,
    statusClass,
    signal,
    signalDetail,
    signalSource: firstDefined(raw.signalSource, raw.signal_source, null),
    signalConfidence: finiteNumber(firstDefined(raw.signalConfidence, raw.signal_confidence)),
    signalModel: firstDefined(raw.signalModel, raw.signal_model, null),
    signalEvidenceTier: firstDefined(raw.signalEvidenceTier, raw.signal_evidence_tier, null),
    lastActivity: firstDefined(raw.lastActivity, raw.last_activity, formatLastActivity(aggregateMetrics.days_since_activity)),
    trend: firstDefined(raw.trend, 'flat'),
    weeks,
    flagFrom: Number.isInteger(raw.flagFrom) ? raw.flagFrom : (statusClass === 'risk' || statusClass === 'watch' ? Math.max(0, weeks.length - 2) : 99),
    seriesBaselines,
    series,
    metrics: aggregateMetrics,
    description: firstDefined(raw.description, ''),
    boundary,
    evidence: statusClass === 'pause' || statusClass === 'data' ? [] : visibleEvidence,
    history: normalizeHistory(raw.history),
    dataCompletenessPct: completeness,
    lastSyncAt: firstDefined(raw.last_sync_at, snapshotMeta.lastSyncAt, null),
    snapshotId: firstDefined(raw.snapshot_id, snapshotMeta.snapshotId, null),
    healthAssessment,
  };
}

function lastValue(series = []) {
  for (let index = series.length - 1; index >= 0; index -= 1) {
    if (series[index] !== null && series[index] !== undefined) return series[index];
  }
  return null;
}

function formatLastActivity(days) {
  const number = finiteNumber(days);
  if (number === null) return '—';
  if (number <= 0) return 'Today';
  if (number === 1) return 'Yesterday';
  return `${number} days ago`;
}

function formatActivityDetail(metrics) {
  const activeDays = metrics.active_days;
  const openPrs = metrics.open_prs;
  if (activeDays !== undefined && openPrs !== undefined) return `${activeDays} active days · ${openPrs} open PRs`;
  if (activeDays !== undefined) return `${activeDays} active days in the snapshot window`;
  return 'Snapshot metrics are available for review.';
}

function snapshotEnvelope(raw) {
  if (raw && raw.snapshot && typeof raw.snapshot === 'object') return raw.snapshot;
  if (raw && raw.data && typeof raw.data === 'object' && !Array.isArray(raw.data)) return raw.data;
  return raw || {};
}

function normalizeSnapshot(raw) {
  const envelope = snapshotEnvelope(raw);
  const meta = {
    snapshotId: firstDefined(envelope.snapshot_id, envelope.snapshotId, envelope.id, raw?.snapshot_id, null),
    snapshotWeekStart: firstDefined(envelope.snapshot_week_start, envelope.week_start, null),
    snapshotWeekEnd: firstDefined(envelope.snapshot_week_end, envelope.week_end, null),
    generatedAt: firstDefined(envelope.generated_at, null),
    ruleSetVersion: firstDefined(envelope.rule_set_version, null),
    dataCompletenessPct: finiteNumber(envelope.data_completeness_pct),
    lastSyncAt: firstDefined(envelope.last_sync_at, null),
  };
  const rawProjects = asArray(envelope.projects);
  return { ...meta, projects: rawProjects.map((project) => normalizeProject(project, meta)) };
}

// Host integrations may supply an async API token through PHI_API_TOKEN.
async function authToken() {
  const source = window.PHI_API_TOKEN;
  const value = typeof source === 'function' ? await source() : source;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

async function authHeaders() {
  let token = null;
  try {
    token = await authToken();
  } catch (error) {
    throw new Error(error?.message || 'The API session token could not be obtained.');
  }
  const headers = token ? { Authorization: /^bearer\s/i.test(token) ? token : `Bearer ${token}` } : {};
  if (window.PHI_REVIEWER_ID) headers['X-Reviewer-Id'] = String(window.PHI_REVIEWER_ID);
  return headers;
}

async function requestJson(path, options = {}) {
  const headers = {
    Accept: 'application/json',
    ...(await authHeaders()),
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...(options.headers || {}),
  };
  const response = await fetch(`${API_BASE}${path}`, { credentials: 'omit', signal: AbortSignal.timeout(120000), ...options, headers });
  let payload = null;
  try { payload = await response.json(); } catch (error) { payload = null; }
  if (!response.ok) {
    const detail = payload && typeof payload === 'object' ? firstDefined(payload.detail, payload.message, payload.error) : null;
    const message = formatErrorDetail(detail);
    if (response.status === 401) {
      const reason = message || 'Authentication is required';
      throw new Error(`${/[.!?]$/.test(reason) ? reason : `${reason}.`} Configure an API token in the host integration.`);
    }
    if (response.status === 403) throw new Error(message || 'Your account does not have access to this data.');
    throw new Error(message || `Request failed (${response.status})`);
  }
  return payload;
}

// FastAPI returns a list of validation objects in `detail`; a plain string otherwise.
function formatErrorDetail(detail) {
  if (typeof detail === 'string') return detail.trim() || null;
  if (Array.isArray(detail)) {
    const messages = detail.map((item) => {
      if (typeof item === 'string') return item;
      if (!item || typeof item !== 'object') return '';
      const field = asArray(item.loc).filter((part) => part !== 'body').join('.');
      const message = String(firstDefined(item.msg, item.message, '') || '');
      return field && message ? `${field}: ${message}` : message;
    }).filter(Boolean);
    return messages.length ? messages.join('; ') : null;
  }
  if (detail && typeof detail === 'object') return formatErrorDetail(firstDefined(detail.msg, detail.message, detail.error));
  return null;
}

function formatDate(value, includeTime = false) {
  if (!value) return 'Unavailable';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('en-US', includeTime ? { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' } : { month: 'short', day: 'numeric', year: 'numeric' }).format(date);
}

function formatPercent(value) {
  const number = finiteNumber(value);
  return number === null ? '—' : `${Math.round(number)}%`;
}

// Cache key for one project's snapshot metadata: the plain project id for the
// live profile, id@date while that project is being viewed as of a past week.
function profileCacheKey(projectId) {
  return selectedProjectAsOfDate && projectId === selectedProjectId ? `${projectId}@${selectedProjectAsOfDate}` : projectId;
}

function snapshotMetaFor(project = null) {
  const cached = project ? state.projectSnapshotMeta[profileCacheKey(project.id)] : null;
  const snapshot = cached || (project && selectedProjectAsOfDate && project.id === selectedProjectId ? {} : state.snapshot || {});
  return {
    snapshotId: firstDefined(project?.snapshotId, snapshot.snapshotId, null),
    snapshotWeekStart: snapshot.snapshotWeekStart,
    snapshotWeekEnd: snapshot.snapshotWeekEnd,
    generatedAt: snapshot.generatedAt,
    ruleSetVersion: snapshot.ruleSetVersion,
    dataCompletenessPct: firstDefined(project?.dataCompletenessPct, snapshot.dataCompletenessPct, null),
    lastSyncAt: firstDefined(project?.lastSyncAt, snapshot.lastSyncAt, null),
  };
}

function snapshotMetaMarkup(project = null, compact = false) {
  const meta = snapshotMetaFor(project);
  const week = meta.snapshotWeekStart || meta.snapshotWeekEnd ? `${formatDate(meta.snapshotWeekStart)}${meta.snapshotWeekEnd ? ` – ${formatDate(meta.snapshotWeekEnd)}` : ''}` : 'Current snapshot';
  return `<div class="snapshot-meta ${compact ? 'compact' : ''}"><span>${escapeHtml(week)}</span><span>Data completeness ${escapeHtml(formatPercent(meta.dataCompletenessPct))}</span><span>Last sync ${escapeHtml(formatDate(meta.lastSyncAt, true))}</span></div>`;
}

function weekLabels(project = null) {
  const start = snapshotMetaFor(project).snapshotWeekStart;
  if (!start) return Array.from({ length: 8 }, (_, index) => `Week ${index + 1}`);
  const end = new Date(start);
  if (Number.isNaN(end.getTime())) return Array.from({ length: 8 }, (_, index) => `Week ${index + 1}`);
  return Array.from({ length: 8 }, (_, index) => {
    const date = new Date(end);
    date.setUTCDate(date.getUTCDate() - (7 * (7 - index)));
    return date.toLocaleDateString('en-US', { month: 'short', day: '2-digit', timeZone: 'UTC' });
  });
}

function statusColor(statusClass) {
  return { risk: 'var(--clay)', watch: 'var(--amber)', clear: 'var(--moss)', data: 'var(--plum)', pause: 'var(--slate)' }[statusClass] || 'var(--ink)';
}

function statusPill(project) {
  return `<span class="status-pill status-${escapeHtml(project.statusClass)}">${escapeHtml(project.status)}</span>`;
}

function monogram(project, className = '') {
  return `<div class="id-tag ${escapeHtml(project.statusClass)} ${className}">${escapeHtml(project.short)}</div>`;
}

function chartDomain(points, baseline = null) {
  const values = points.filter((value) => value !== null);
  if (!values.length) return null;
  const allValues = baseline !== null ? values.concat([baseline]) : values;
  const min = Math.min(...allValues);
  const max = Math.max(...allValues);
  const span = max - min || Math.max(1, max * 0.2);
  return { domainMin: min - span * 0.2, domainMax: max + span * 0.2 };
}

function formatChartTick(value, suffix = '', step = 1) {
  const precision = step >= 10 ? 0 : step >= 1 ? 1 : step >= 0.1 ? 2 : 3;
  const formatted = Number(value.toFixed(precision));
  return `${formatted}${suffix}`;
}

function chartYAxis(points, baseline, suffix = '', label = 'chart') {
  const domain = chartDomain(points, baseline);
  if (!domain) return '<div class="chart-y-axis chart-y-axis-empty" aria-hidden="true"></div>';
  const step = (domain.domainMax - domain.domainMin) / 4;
  const ticks = Array.from({ length: 5 }, (_, index) => domain.domainMax - (step * index));
  return `<div class="chart-y-axis" aria-label="${escapeHtml(label)} y-axis">${ticks.map((tick) => `<span>${escapeHtml(formatChartTick(tick, suffix, step))}</span>`).join('')}</div>`;
}

function sparkChart(points, { color = 'var(--ink)', baseline = null, width = 220, height = 56, suffix = '', area = true, labels = null, grid = false } = {}) {
  const domain = chartDomain(points, baseline);
  if (!domain) return `<div class="chart-empty" style="width:100%;height:${height}px">Insufficient data</div>`;
  const { domainMin, domainMax } = domain;
  const stepX = points.length > 1 ? width / (points.length - 1) : width;
  const y = (value) => height - 6 - ((value - domainMin) / (domainMax - domainMin)) * (height - 12);
  const segments = [];
  let current = [];
  points.forEach((value, index) => {
    if (value === null) { if (current.length) segments.push(current); current = []; }
    else current.push([index * stepX, y(value)]);
  });
  if (current.length) segments.push(current);
  const formatSegment = (segment) => segment.map(([x, yy]) => `${x.toFixed(1)} ${yy.toFixed(1)}`).join(' L ');
  const path = segments.map((segment) => `M${formatSegment(segment)}`).join(' ');
  const areaPath = segments.map((segment) => `M${formatSegment(segment)} L${segment.at(-1)[0].toFixed(1)} ${height} L${segment[0][0].toFixed(1)} ${height} Z`).join(' ');
  const last = segments.at(-1)?.at(-1);
  const chartLabels = labels || weekLabels();
  const gridLines = grid ? [0.25, 0.5, 0.75].map((fraction) => `<line class="chart-grid" x1="0" y1="${(height * fraction).toFixed(1)}" x2="${width}" y2="${(height * fraction).toFixed(1)}"/>`).join('') : '';
  const pointsMarkup = points.map((value, index) => {
    if (value === null) return '';
    const x = (index * stepX).toFixed(1);
    const yy = y(value).toFixed(1);
    const label = chartLabels[index] || `Week ${index + 1}`;
    return `<circle class="chart-point" cx="${x}" cy="${yy}" r="2.7" fill="${color}"/><circle class="chart-hit" cx="${x}" cy="${yy}" r="9" fill="transparent"><title>${escapeHtml(label)}: ${escapeHtml(value)}${escapeHtml(suffix)}</title></circle>`;
  }).join('');
  const baselineLine = baseline !== null ? `<line class="chart-baseline" x1="0" y1="${y(baseline).toFixed(1)}" x2="${width}" y2="${y(baseline).toFixed(1)}"/>` : '';
  return `<svg class="spark-chart" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" preserveAspectRatio="none" role="img" aria-label="8-week trend">${gridLines}${baselineLine}${area ? `<path class="spark-area" d="${areaPath}" fill="${color}" opacity="0.12"/>` : ''}<path class="spark-line" d="${path}" stroke="${color}" fill="none"/>${last ? `<circle class="spark-end" cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="3.5" fill="${color}"/>` : ''}${pointsMarkup}</svg>`;
}

function chartTimestampAxis(labels) {
  return `<div class="chart-axis-wrap"><div class="chart-axis" aria-label="Weekly chart timestamps">${labels.map((label, index) => `<span title="Week ${index + 1}: ${escapeHtml(label)}">${escapeHtml(label)}</span>`).join('')}</div><div class="chart-axis-note">Weekly timestamp · hover a point for its value</div></div>`;
}

function chartCaption(label, current, baseline, unit = '') {
  if (current === null || current === undefined) return `<div class="chart-caption"><span class="chart-caption-label">${escapeHtml(label)}</span><span class="chart-caption-value">—</span></div>`;
  const numericCurrent = finiteNumber(current);
  const numericBaseline = finiteNumber(baseline);
  if (numericCurrent === null) return `<div class="chart-caption"><span class="chart-caption-label">${escapeHtml(label)}</span><span class="chart-caption-value">—</span></div>`;
  const delta = numericBaseline === null ? null : numericCurrent - numericBaseline;
  const arrow = delta === null || Math.abs(delta) < 0.05 ? '' : delta > 0 ? '▲' : '▼';
  return `<div class="chart-caption"><span class="chart-caption-label">${escapeHtml(label)}</span><span class="chart-caption-value">${escapeHtml(numericCurrent)}${escapeHtml(unit)}${numericBaseline !== null ? ` <em>${arrow} vs ${escapeHtml(numericBaseline)}${escapeHtml(unit)} baseline</em>` : ''}</span></div>`;
}

function metricCharts(project) {
  const color = statusColor(project.statusClass);
  const definitions = METRIC_DEFINITIONS.filter(({ metricKey }) => metricKey !== 'active_contributors' || hasOwn(project.metrics, 'active_contributors'));
  return `<div class="metric-charts metric-count-${definitions.length}">${definitions.map(({ label, key, metricKey, unit }) => {
    const series = project.series[key];
    const baseline = project.seriesBaselines[key]?.[0] ?? null;
    const current = metricValue(project.metrics, metricKey, lastValue(series));
    const labels = weekLabels(project).slice(0, series.length);
    return `<article class="metric-chart-tile">${chartCaption(label, current, baseline, unit)}<div class="metric-chart-body"><div class="chart-plot-row">${chartYAxis(series, baseline, unit, label)}${sparkChart(series, { color, baseline, width: 520, height: 154, suffix: unit, labels, grid: true })}</div><div class="chart-axis-row"><span class="chart-axis-gutter" aria-hidden="true"></span>${chartTimestampAxis(labels)}</div></div></article>`;
  }).join('')}</div>`;
}

function aggregateMetricsSection(project) {
  const definitions = [
    ['Active days', 'active_days', 'd'],
    ['Days since activity', 'days_since_activity', 'd'],
    ['Open PRs', 'open_prs', ''],
    ['Oldest open PR', 'oldest_open_pr_days', 'd'],
    ['Review latency', 'review_latency_days', 'd'],
    ['Merged PRs', 'merged_count', ''],
  ];
  if (hasOwn(project.metrics, 'active_contributors')) definitions.push(['Active contributors (aggregate)', 'active_contributors', '']);
  return `<section class="panel code-insights"><div class="panel-header"><div><h2 class="panel-title">Project aggregates</h2></div><span class="eyebrow">${escapeHtml(snapshotMetaFor(project).ruleSetVersion || 'Current rules')}</span></div><div class="aggregate-metrics">${definitions.map(([label, key, unit]) => `<div class="aggregate-metric"><span class="chart-caption-label">${escapeHtml(label)}</span><strong>${project.metrics[key] === undefined ? '—' : `${escapeHtml(project.metrics[key])}${escapeHtml(unit)}`}</strong></div>`).join('')}</div></section>`;
}

function evidenceRow(project, item, size = '') {
  const metricDefinition = METRIC_DEFINITIONS.find(({ key, metricKey }) => key === item.metric || metricKey === item.metric);
  const metricKey = metricDefinition?.key || item.metric;
  const series = metricKey && project.series[metricKey] ? project.series[metricKey] : [];
  const metricName = metricDefinition?.metricKey;
  const baseline = finiteNumber(item.baseline) ?? (metricDefinition ? project.seriesBaselines[metricDefinition.key]?.[0] ?? null : null);
  const current = finiteNumber(item.current) ?? (metricDefinition ? metricValue(project.metrics, metricName, lastValue(series)) : null);
  const detail = [item.window ? `Window ${item.window}` : '', item.threshold ? `Trigger ${item.threshold}` : ''].filter(Boolean).join(' · ');
  if (metricDefinition && series.some((value) => value !== null)) {
    return `<div class="evidence-item ${size}"><span class="evidence-marker ${escapeHtml(item.type)}">${icon(item.icon)}</span><div class="evidence-copy"><div class="evidence-top"><strong>${escapeHtml(item.title)}</strong>${chartCaption('', current, baseline, metricDefinition.unit)}</div>${sparkChart(series, { color: statusColor(project.statusClass), baseline, width: size === 'lg' ? 420 : 220, height: size === 'lg' ? 56 : 36, suffix: metricDefinition.unit, labels: weekLabels(project), area: size === 'lg' })}${detail ? `<div class="evidence-note">${escapeHtml(detail)}</div>` : ''}</div></div>`;
  }
  return `<div class="evidence-item ${size}"><span class="evidence-marker ${escapeHtml(item.type)}">${icon(item.icon)}</span><div class="evidence-copy"><div class="evidence-top"><strong>${escapeHtml(item.title)}</strong>${metricDefinition ? chartCaption('', current, baseline, metricDefinition.unit) : `<span class="chart-caption-value">${current === null ? '—' : escapeHtml(current)}</span>`}</div>${detail ? `<div class="evidence-note">${escapeHtml(detail)}</div>` : ''}</div></div>`;
}

function evidenceList(project, size = '') {
  if (project.statusClass === 'data') return `<div class="evidence-item"><span class="evidence-marker blue">${icon('database')}</span><div class="evidence-copy"><strong>Insufficient data</strong></div></div>`;
  if (project.statusClass === 'pause') return `<div class="evidence-item"><span class="evidence-marker blue">${icon('pause')}</span><div class="evidence-copy"><strong>Paused</strong></div></div>`;
  if (!project.evidence.length) return `<div class="evidence-item"><span class="evidence-marker teal">${icon('check-circle')}</span><div class="evidence-copy"><strong>No concern detected</strong></div></div>`;
  return project.evidence.map((item) => evidenceRow(project, item, size)).join('');
}

function assessmentNumber(value, asPercent = false) {
  const number = finiteNumber(value);
  if (number === null) return '—';
  if (asPercent && number >= 0 && number <= 1) return `${Math.round(number * 100)}%`;
  return `${Number(number.toFixed(2))}${asPercent ? '%' : ''}`;
}

function assessmentCitation(item) {
  const label = item.label && item.label !== item.reference ? `${item.label} · ` : '';
  const reference = `${label}${item.reference}`;
  const safeUrl = typeof item.url === 'string' && /^https?:\/\//i.test(item.url) ? item.url : null;
  return safeUrl
    ? `<li><a href="${escapeHtml(safeUrl)}" target="_blank" rel="noreferrer">${escapeHtml(reference)}</a></li>`
    : `<li>${escapeHtml(reference)}</li>`;
}

function assessmentItems(items, emptyCopy) {
  if (!items.length) return `<p class="assessment-empty">${escapeHtml(emptyCopy)}</p>`;
  return `<ul class="assessment-list">${items.map((item) => `<li><strong>${escapeHtml(item.title)}</strong>${item.week !== null && item.week !== undefined ? `<span class="assessment-week">Week ${escapeHtml(item.week)}</span>` : ''}${item.detail ? `<span>${escapeHtml(item.detail)}</span>` : ''}</li>`).join('')}</ul>`;
}

function weeklyProgressCard(project) {
  const statusClass = ['risk', 'watch', 'clear'].includes(project.statusClass) ? project.statusClass : 'neutral';
  return `<section class="panel ci-assessment"><div class="panel-header"><div><span class="eyebrow">Progress</span><h2 class="panel-title">${escapeHtml(project.signal)}</h2></div><span class="assessment-badge ${statusClass}">${escapeHtml(project.status)}</span></div></section>`;
}

function healthAssessmentCard(project) {
  const assessment = project.healthAssessment;
  if (!assessment) {
    return weeklyProgressCard(project);
  }
  const statusClass = ['risk', 'watch', 'clear'].includes(assessment.statusClass) ? assessment.statusClass : 'neutral';
  const statusLabel = assessment.status || 'Assessment returned';
  const metrics = `<div class="assessment-metrics"><div><span>Score</span><strong>${escapeHtml(assessmentNumber(assessment.score))}</strong></div><div><span>Confidence</span><strong>${escapeHtml(assessmentNumber(assessment.confidence, true))}</strong></div><div><span>Expected week</span><strong>${assessment.expectedWeek === null || assessment.expectedWeek === undefined ? '—' : `Week ${escapeHtml(assessment.expectedWeek)}`}</strong></div></div>`;
  const citations = assessment.citations.length ? `<div class="assessment-block"><h3>References</h3><ul class="assessment-citations">${assessment.citations.map(assessmentCitation).join('')}</ul></div>` : '';
  return `<section class="panel ci-assessment"><div class="panel-header"><div><span class="eyebrow">Project health</span><h2 class="panel-title">${escapeHtml(statusLabel)}</h2></div><span class="assessment-badge ${statusClass}">${escapeHtml(statusLabel)}</span></div>${metrics}${assessment.explanation ? `<div class="assessment-explanation">${escapeHtml(assessment.explanation)}</div>` : ''}<div class="assessment-columns"><div class="assessment-block"><h3>Blockers</h3>${assessmentItems(assessment.blockers, 'None')}</div><div class="assessment-block"><h3>Weekly tasks</h3>${assessmentItems(assessment.weeklyTasks, 'None')}</div></div>${citations}</section>`;
}

function projectSignalCard(project) {
  const sourceLabel = project.signalSource === 'llm' ? 'LLM project signal' : 'Weekly project signal';
  const confidence = project.signalConfidence === null || project.signalConfidence === undefined
    ? ''
    : `<span class="eyebrow">${escapeHtml(`${Math.round(project.signalConfidence * 100)}% confidence`)}</span>`;
  const provenance = [
    project.signalEvidenceTier ? `Evidence ${project.signalEvidenceTier}` : '',
    project.signalModel ? `Model ${project.signalModel}` : '',
  ].filter(Boolean).join(' · ');
  return `<section class="panel ci-assessment project-signal-card"><div class="panel-header"><div><span class="eyebrow">${escapeHtml(sourceLabel)}</span><h2 class="panel-title">${escapeHtml(project.signal || 'Signal unavailable')}</h2></div>${confidence || statusPill(project)}</div>${project.signalDetail ? `<div class="assessment-explanation">${escapeHtml(project.signalDetail)}</div>` : ''}${provenance ? `<div class="snapshot-meta compact"><span>${escapeHtml(provenance)}</span></div>` : ''}</section>`;
}

// Overview's date picker is a jump-off, not a mode: choosing a date navigates
// to the inventory page's cumulative progress view. It deliberately shows no
// current value or "Back to live" affordance because Overview is always live.
function overviewProgressControlMarkup() {
  const today = new Date().toISOString().slice(0, 10);
  return `<div class="calendar-control"><label for="calendar-date-input">${icon('calendar')}<span>View progress as of</span></label><input type="date" id="calendar-date-input" max="${today}" value="" /></div>`;
}

function renderOverview() {
  const projects = state.projects;
  const attention = projects.filter(isAttentionProject);
  const clear = projects.filter((project) => project.statusClass === 'clear');
  const insufficient = projects.filter((project) => project.statusClass === 'data');
  const active = projects.filter(isActiveProject);
  return `<div class="page-heading"><div><span class="eyebrow">Overview</span><h1>Good morning</h1></div><div class="heading-actions"><div class="date-chip">${icon('calendar')} ${escapeHtml(snapshotMetaFor().snapshotWeekStart ? `${formatDate(snapshotMetaFor().snapshotWeekStart)}${snapshotMetaFor().snapshotWeekEnd ? ` – ${formatDate(snapshotMetaFor().snapshotWeekEnd)}` : ''}` : 'Current snapshot')}</div>${overviewProgressControlMarkup()}</div></div>
    ${statGridMarkup(active, attention, clear, insufficient)}`;
}

// A stat card that is not a filter: the delivery figures describe the whole
// portfolio and have no corresponding project filter to switch to, so they
// render as plain tiles rather than buttons.
function deliveryCardMarkup(accent, label, iconName, value, foot) {
  const shown = value === null || value === undefined ? '—' : value;
  return `<div class="stat-card ${accent}"><span class="stat-label"><span>${escapeHtml(label)}</span><span class="stat-icon">${icon(iconName)}</span></span><span class="stat-value">${escapeHtml(String(shown))}</span><span class="stat-foot">${escapeHtml(foot)}</span></div>`;
}

// Second row of the stat grid: what the portfolio has in flight, as opposed to
// the status counts above. Contributor count is deliberately NOT shown: the
// identity_map table is empty, so /portfolio/delivery can only count distinct
// author strings -- display names and usernames for the same person both
// count -- and a headline figure of 'people' built from that would be wrong. Everything here comes from the Gitea sync via
// /portfolio/delivery; a null renders as "--" so "not synced yet" never
// masquerades as a real zero.
function deliveryGridMarkup() {
  const d = state.delivery;
  const oldest = d && typeof d.oldest_open_pr_days === 'number' ? `${Math.round(d.oldest_open_pr_days)}d` : null;
  return [
    deliveryCardMarkup('total', 'Open PRs', 'pull', d ? d.open_prs : null, 'Open'),
    deliveryCardMarkup('attention', 'Oldest open PR', 'calendar', oldest, 'Oldest'),
    deliveryCardMarkup('data', 'Branches ahead', 'activity', d ? d.branches_ahead : null, 'Ahead'),
    deliveryCardMarkup('clear', 'Open issues', 'message', d ? d.open_issues : null, 'Open'),
  ].join('');
}

// The stat cards are Overview's whole body now that the per-project week-signal
// list has moved to the inventory page, so they always render. They used to be
// suppressed whenever that list was open.
function statGridMarkup(active, attention, clear, insufficient) {
  return `<div class="stat-grid"><button class="stat-card total dashboard-filter" data-dashboard-filter="Active projects" type="button"><span class="stat-label"><span>Active projects</span><span class="stat-icon">${icon('folder')}</span></span><span class="stat-value">${active.length}</span><span class="stat-foot">Current</span></button><button class="stat-card attention dashboard-filter" data-dashboard-filter="Needs attention" type="button"><span class="stat-label"><span>Need attention</span><span class="stat-icon">${icon('triangle')}</span></span><span class="stat-value">${attention.length}</span><span class="stat-foot">Review</span></button><button class="stat-card clear dashboard-filter" data-dashboard-filter="Clear" type="button"><span class="stat-label"><span>Clear</span><span class="stat-icon">${icon('check-circle')}</span></span><span class="stat-value">${clear.length}</span><span class="stat-foot">Server status</span></button><button class="stat-card data dashboard-filter" data-dashboard-filter="Insufficient data" type="button"><span class="stat-label"><span>Insufficient data</span><span class="stat-icon">${icon('database')}</span></span><span class="stat-value">${insufficient.length}</span><span class="stat-foot">Suppressed</span></button>${deliveryGridMarkup()}</div>`;
}

function renderProjects() {
  const filters = PROJECT_FILTERS;
  const filtered = currentFilter === 'All projects'
    ? state.projects
    : currentFilter === 'Active projects'
      ? state.projects.filter(isActiveProject)
      : currentFilter === 'Needs attention'
        ? state.projects.filter(isAttentionProject)
        : state.projects.filter((project) => project.status === currentFilter);
  return `<div class="page-heading"><div><span class="eyebrow">Portfolio inventory</span><h1>All projects</h1></div><div class="heading-actions">${progressControlMarkup()}</div></div>
    ${progressPanelMarkup()}
    <section class="panel"><div class="panel-header"><div><h2 class="panel-title">Project inventory</h2></div><div class="filter-row">${filters.map((filter) => `<button class="filter-button ${currentFilter === filter ? 'active' : ''}" data-filter="${escapeHtml(filter)}">${escapeHtml(filter)}</button>`).join('')}</div></div><div class="table-scroll"><table class="projects-table"><thead><tr><th>Project</th><th>Status</th><th>Signal</th><th>Active</th><th>Coverage</th></tr></thead><tbody>${filtered.length ? filtered.map((project) => {
      const identityCell = `<td><div class="table-project">${monogram(project, 'sm')}<div><strong>${escapeHtml(project.name)}</strong><span>${escapeHtml(project.team)} · ${escapeHtml(project.repo)}</span></div></div></td>`;
      // A project with no snapshot keeps its identity cell and replaces the
      // four data columns with the lazy placeholder, so the table's shape
      // holds steady as rows fill in.
      if (lazyRowState(project.id)) return `<tr class="project-row lazy-row" data-project-id="${escapeHtml(project.id)}"${lazyRowAttrs(project.id)}>${identityCell}${lazyCellMarkup(project.id, 4)}</tr>`;
      return `<tr class="project-row" data-project-id="${escapeHtml(project.id)}">${identityCell}<td>${statusPill(project)}</td><td>${escapeHtml(project.signal)}</td><td><span class="freshness">${escapeHtml(project.lastActivity)}</span></td><td><span class="freshness">${escapeHtml(formatPercent(project.dataCompletenessPct))}</span></td></tr>`;
    }).join('') : '<tr><td colspan="5"><div class="history-empty">No projects</div></td></tr>'}</tbody></table></div></section>`;
}

function insightsProjectCell(project) {
  return `<div class="insights-project-cell">${monogram(project, 'sm')}<div class="insights-project-copy"><div><strong>${escapeHtml(project.name)}</strong><span>${escapeHtml(project.team)}</span></div>${statusPill(project)}</div></div>`;
}

function renderInsights() {
  const showContributorColumn = state.projects.some((project) => hasOwn(project.metrics, 'active_contributors'));
  const contributorHeader = showContributorColumn ? '<th>Active contributors <span>aggregate only</span></th>' : '';
  const contributorCell = (project) => showContributorColumn ? `<td>${hasOwn(project.metrics, 'active_contributors') ? chartCaption('', project.metrics.active_contributors, project.seriesBaselines.contributors?.[0]) : '<div class="chart-caption"><span class="chart-caption-label"></span><span class="chart-caption-value">—</span></div>'}</td>` : '';
  return `<div class="page-heading"><div><span class="eyebrow">Last 8 weeks</span><h1>Insights</h1>${snapshotMetaMarkup()}</div></div><section class="panel"><div class="table-scroll"><table class="insights-table"><thead><tr><th>Project</th><th>Activity <span>days/wk</span></th><th>Open PRs</th><th>Review latency</th>${contributorHeader}</tr></thead><tbody>${state.projects.length ? state.projects.map((project) => {
      if (lazyRowState(project.id)) return `<tr class="insights-row lazy-row" data-project-id="${escapeHtml(project.id)}"${lazyRowAttrs(project.id)}><td>${insightsProjectCell(project)}</td>${lazyCellMarkup(project.id, showContributorColumn ? 4 : 3)}</tr>`;
      return `<tr class="insights-row" data-project-id="${escapeHtml(project.id)}"><td>${insightsProjectCell(project)}</td><td>${chartCaption('', metricValue(project.metrics, 'active_days', lastValue(project.series.activity)), project.seriesBaselines.activity?.[0])}</td><td>${chartCaption('', metricValue(project.metrics, 'open_prs', lastValue(project.series.openPRs)), project.seriesBaselines.openPRs?.[0])}</td><td>${chartCaption('', metricValue(project.metrics, 'review_latency_days', lastValue(project.series.reviewLatency)), project.seriesBaselines.reviewLatency?.[0], 'd')}</td>${contributorCell(project)}</tr>`;
    }).join('') : `<tr><td colspan="${showContributorColumn ? 5 : 4}"><div class="history-empty">No project metrics returned.</div></td></tr>`}</tbody></table></div></section>`;
}

// Banner shown on a historical profile so it cannot be mistaken for live data.
function asOfBannerMarkup() {
  if (!selectedProjectAsOfDate) return '';
  return `<div class="as-of-banner"><div class="date-chip">${icon('calendar')} As of ${escapeHtml(formatDate(selectedProjectAsOfDate))}</div><span>Historical snapshot</span><button class="text-button" id="profile-live">Back to live ×</button></div>`;
}

function profileBackLinkMarkup() {
  const label = 'Back to inventory';
  return `<button class="text-button back-link" id="profile-back"><span>←</span> ${escapeHtml(label)}</button>`;
}

// A project can have no persisted snapshot for the selected week. Say so
// plainly -- falling back to the live profile here would silently reintroduce
// exactly the present-data-under-a-past-date confusion this view fixes.
// ---------------------------------------------------------------------
// Members. Named per-person contribution metrics from the Gitea analytics
// collector. Every surface here repeats the same framing the collector's own
// report carries: these are descriptive activity indicators, not a score.
// ---------------------------------------------------------------------

const MEMBER_DISCLAIMER = 'Gitea activity';

function memberDisplayName(member) {
  return member?.name || member?.login || 'Unknown';
}

function memberBadgeMarkup(member) {
  if (member.service_or_admin) return '<span class="member-badge service" title="Service account">service</span>';
  // An unmatched identity may be a second identity for someone already listed
  // above rather than another person, so it must not read as a member row.
  if (member.roster_member === false) return '<span class="member-badge unmatched" title="Unmatched identity">unmatched</span>';
  return '';
}

function memberRunMetaMarkup() {
  const run = state.membersRun;
  if (!run) return '';
  const scope = run.history_scope ? ` · ${escapeHtml(run.history_scope)}` : '';
  const blame = run.blame_status === 'disabled'
    ? ' · line ownership not collected'
    : ` · line ownership ${escapeHtml(run.blame_status || 'unknown')}`;
  return `<div class="snapshot-meta"><span class="mono">Run ${escapeHtml(run.run_id || '—')} · collected ${escapeHtml(formatDate(run.generated_at, true))}${scope}${blame}</span></div>`;
}

// A run with warnings is a run that is missing data -- for example a
// repository with pull requests disabled contributes no PR, review or
// approval rows. Surfacing it here stops a partial run reading as a full one.
function memberWarningsMarkup() {
  const warnings = asArray(state.membersRun?.warnings);
  if (!warnings.length) return '';
  return `<details class="member-warnings"><summary class="member-warnings-title">${warnings.length} warning${warnings.length === 1 ? '' : 's'}</summary><ul>${warnings.map((warning) => `<li><span class="mono">${escapeHtml(warning)}</span></li>`).join('')}</ul></details>`;
}

function memberStatGridMarkup() {
  const totals = state.membersTotals;
  if (!totals) return '';
  const cards = [
    ['Roster members', totals.roster_members],
    ['Active members', totals.active_members],
    ['Unmatched identities', totals.unmatched_identities],
    ['Repositories', totals.repositories],
    ['Commits', totals.commits],
    ['Merged PRs', totals.merged_pull_requests],
    ['Issues', totals.issues],
    ['Lines owned', totals.blame_lines],
  ];
  return `<section class="stat-grid">${cards.map(([label, value]) => `<div class="stat-card plain"><span class="stat-label">${escapeHtml(label)}</span><span class="stat-value">${escapeHtml(formatCount(value))}</span></div>`).join('')}</section>`;
}

function formatCount(value) {
  if (value === null || value === undefined || value === '') return '—';
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString() : '—';
}

function memberControlsMarkup() {
  const organizations = state.memberOrganizations;
  return `<section class="panel member-controls">
    <label class="member-field"><span>Find a member</span><input id="member-search" type="search" placeholder="Name, login, or email" value="${escapeHtml(memberSearch)}" autocomplete="off"></label>
    <label class="member-field"><span>Organization</span><select id="member-org"><option value="all">All organizations</option>${organizations.map((name) => `<option value="${escapeHtml(name)}"${name === memberOrgFilter ? ' selected' : ''}>${escapeHtml(name)}</option>`).join('')}</select></label>
    <label class="member-field"><span>Sort by</span><select id="member-sort">${MEMBER_SORTS.map((option) => `<option value="${option.key}"${option.key === memberSort ? ' selected' : ''}>${escapeHtml(option.label)}</option>`).join('')}</select></label>
    <div class="member-toggles">
      <label><input type="checkbox" id="member-include-unmatched"${memberIncludeUnmatched ? ' checked' : ''}> Unmatched identities</label>
      <label><input type="checkbox" id="member-include-service"${memberIncludeService ? ' checked' : ''}> Service accounts</label>
    </div>
  </section>`;
}

function memberRowMarkup(member) {
  const organizations = asArray(member.organizations).join(', ') || '—';
  return `<tr class="member-row" data-member-login="${escapeHtml(member.login)}" tabindex="0" role="button" aria-label="View ${escapeHtml(memberDisplayName(member))}">
    <td><div class="member-name-line"><span class="member-name">${escapeHtml(memberDisplayName(member))}</span>${memberBadgeMarkup(member)}</div><span class="mono member-login">${escapeHtml(member.login)}</span></td>
    <td>${escapeHtml(organizations)}</td>
    <td class="num">${escapeHtml(formatCount(member.commits))}</td>
    <td class="num pos">${escapeHtml(formatCount(member.additions))}</td>
    <td class="num">${escapeHtml(formatCount(member.deletions))}</td>
    <td class="num">${escapeHtml(formatCount(member.pulls_opened))}</td>
    <td class="num">${escapeHtml(formatCount(member.pulls_merged))}</td>
    <td class="num">${escapeHtml(formatCount(member.reviews_submitted))}</td>
    <td class="num">${escapeHtml(formatCount(member.issues_opened))}</td>
    <td class="num">${escapeHtml(formatCount(member.active_days))}</td>
    <td class="num">${escapeHtml(formatCount(member.blame_lines))}</td>
  </tr>`;
}

function renderMembers() {
  const heading = `<div class="page-heading"><div><span class="eyebrow">${escapeHtml(MEMBER_DISCLAIMER)}</span><h1>Members</h1>${memberRunMetaMarkup()}</div></div>`;
  if (state.membersLoading) return `${heading}${loadingPanel()}`;
  if (state.membersError) return `${heading}${errorPanel(state.membersError.message || 'Unavailable', 'retry-members')}`;
  if (!state.membersRun) {
    return `${heading}<div class="empty-view"><div class="empty-view-inner"><div class="empty-view-icon">${icon('users')}</div><h2>No analytics data</h2></div></div>`;
  }
  const rows = state.memberRows;
  return `${heading}${memberWarningsMarkup()}${memberStatGridMarkup()}${memberControlsMarkup()}
    <section class="panel"><div class="panel-header"><div><h2 class="panel-title">Contribution</h2></div></div>
    <div class="table-scroll"><table class="insights-table member-table"><thead><tr><th>Member</th><th>Organizations</th><th>Commits</th><th>Additions</th><th>Deletions</th><th>PRs</th><th>Merged</th><th>Reviews</th><th>Issues</th><th>Active days</th><th>Lines owned</th></tr></thead>
    <tbody>${rows.length ? rows.map(memberRowMarkup).join('') : `<tr><td colspan="11"><div class="history-empty">No matches</div></td></tr>`}</tbody></table></div></section>`;
}

function memberDetailStat(label, value) {
  return `<div class="stat-card plain"><span class="stat-label">${escapeHtml(label)}</span><span class="stat-value">${escapeHtml(formatCount(value))}</span></div>`;
}

function renderMemberDetail() {
  const back = `<button class="text-button back-link" id="member-back"><span>←</span> Back to members</button>`;
  if (state.memberDetailLoading) return `${back}${loadingPanel()}`;
  if (state.memberDetailError) return `${back}${errorPanel(state.memberDetailError.message || 'Unavailable', 'retry-member-detail')}`;
  const member = state.memberDetail;
  if (!member) return `${back}${errorPanel('Identity not found.', 'retry-member-detail')}`;

  const organizations = asArray(member.organizations);
  const repositories = asArray(member.repositories);
  const window = member.first_activity
    ? `${formatDate(member.first_activity)} – ${formatDate(member.last_activity || member.first_activity)}`
    : 'No activity';
  // Say *why* the window is empty. A member whose organizations hold no
  // repositories had nothing to contribute to, which is a different fact from
  // having had the opportunity and not taken it.
  const emptyReason = member.has_activity ? '' : '<p class="member-empty-reason">No activity in collected scope.</p>';

  return `${back}
  <div class="page-heading"><div><span class="eyebrow">Member</span><h1>${escapeHtml(memberDisplayName(member))} ${memberBadgeMarkup(member)}</h1><p class="mono">${escapeHtml(member.login)}${member.email ? ` · ${escapeHtml(member.email)}` : ''}</p>${memberRunMetaMarkup()}</div></div>
  <section class="stat-grid">
    ${memberDetailStat('Commits', member.commits)}${memberDetailStat('Additions', member.additions)}${memberDetailStat('Deletions', member.deletions)}${memberDetailStat('Files touched', member.unique_files)}
    ${memberDetailStat('PRs opened', member.pulls_opened)}${memberDetailStat('PRs merged', member.pulls_merged)}${memberDetailStat('Reviews', member.reviews_submitted)}${memberDetailStat('Approvals', member.reviews_approved)}
    ${memberDetailStat('Issues opened', member.issues_opened)}${memberDetailStat('Active days', member.active_days)}${memberDetailStat('Lines owned', member.blame_lines)}${memberDetailStat('Files owned', member.blame_files)}
  </section>
  <section class="panel"><div class="panel-header"><div><h2 class="panel-title">Context</h2></div></div>
    <div class="member-context">
      <div><span class="stat-label">Organizations</span><p>${organizations.length ? escapeHtml(organizations.join(', ')) : '—'}</p></div>
      <div><span class="stat-label">Repositories touched</span><p>${repositories.length ? escapeHtml(repositories.join(', ')) : '—'}</p></div>
      <div><span class="stat-label">Activity window</span><p>${escapeHtml(window)}</p>${emptyReason}</div>
    </div>
  </section>`;
}

// ---------------------------------------------------------------------
// Recruiting. This is a reviewer workspace, not an automated hiring
// decision. The list is an AI-assisted provisional ordering; every candidate
// exposes the underlying source evidence and a human decision control.
// ---------------------------------------------------------------------

const RECRUITING_DISCLAIMER = 'Discovery evidence · Human review required';

function recruitingReviewMarkup(status) {
  const meta = {
    pending: ['Pending human review', 'pending'],
    confirmed: ['Confirmed', 'confirmed'],
    adjusted: ['Rank adjusted', 'adjusted'],
    deferred: ['Deferred', 'deferred'],
  }[status] || ['Pending human review', 'pending'];
  return `<span class="review-status ${meta[1]}">${escapeHtml(meta[0])}</span>`;
}

function recruitingEligibilityMarkup(status) {
  const meta = {
    eligible: ['Outreach eligible', 'eligible'],
    excluded: ['Outreach excluded', 'excluded'],
    needs_review: ['Eligibility needs review', 'needs_review'],
  }[status] || ['Eligibility needs review', 'needs_review'];
  return `<span class="review-status ${meta[1]}">${escapeHtml(meta[0])}</span>`;
}

function recruitingScore(value) {
  const number = finiteNumber(value);
  return number === null ? '—' : Math.round(number);
}

function recruitingScoreBar(label, value, accent = '') {
  const number = finiteNumber(value);
  const width = number === null ? 0 : Math.max(0, Math.min(100, number));
  return `<div class="recruiting-score-row"><div><span>${escapeHtml(label)}</span><strong>${number === null ? '—' : `${Math.round(number)}/100`}</strong></div><div class="recruiting-score-track"><span class="${escapeHtml(accent)}" style="width:${width}%"></span></div></div>`;
}

function recruitingSummaryMarkup() {
  const summary = state.recruitingOverview?.summary || {};
  const cards = [
    ['Review queue', summary.candidate_count, 'total', 'Candidates'],
    ['Evidence signals', summary.underrated_count, 'attention', 'Signals'],
    ['Human reviewed', `${summary.reviewed_count || 0}/${summary.candidate_count || 0}`, 'clear', 'Decisions'],
    ['Needs review', summary.pending_count, 'data', 'Pending'],
  ];
  return `<section class="stat-grid recruiting-summary-grid">${cards.map(([label, value, accent, foot]) => `<div class="stat-card ${accent}"><span class="stat-label">${escapeHtml(label)}</span><span class="stat-value">${escapeHtml(String(value ?? '—'))}</span><span class="stat-foot">${escapeHtml(foot)}</span></div>`).join('')}</section>`;
}

function recruitingWarningsMarkup() {
  const warnings = asArray(state.recruitingOverview?.run?.source_warnings);
  if (!warnings.length) return '';
  return `<details class="member-warnings recruiting-warnings"><summary class="member-warnings-title">${warnings.length} warnings</summary><ul>${warnings.map((warning) => `<li><span class="mono">${escapeHtml(warning)}</span></li>`).join('')}</ul></details>`;
}

function recruitingAuditMarkup() {
  if (state.recruitingAuditLoading) return '<section class="panel recruiting-audit-panel"><div class="panel-header"><div><h2 class="panel-title">Evidence audit</h2></div></div></section>';
  if (state.recruitingAuditError) return `<section class="panel recruiting-audit-panel"><div class="panel-header"><div><h2 class="panel-title">Evidence audit</h2><p class="panel-subtitle">${escapeHtml(state.recruitingAuditError.message || 'Unavailable')}</p></div><button class="secondary-button" id="retry-recruiting-audit">Retry</button></div></section>`;
  const audit = state.recruitingAudit?.audit;
  if (!audit) return '';
  const coverage = audit.coverage || {};
  const calibration = audit.calibration || {};
  const flags = asArray(audit.flags);
  const recentReviews = asArray(audit.recent_reviews);
  const multiReviewer = Number(calibration.multi_reviewer_candidates || 0);
  const disagreements = Number(calibration.disagreement_candidates || 0);
  const calibrationLabel = disagreements ? 'Needs calibration' : multiReviewer ? 'Calibrating' : 'Not started';
  const calibrationClass = disagreements ? 'watch' : multiReviewer ? 'clear' : 'data';
  const recentMarkup = recentReviews.length
    ? `<ul class="recruiting-audit-list">${recentReviews.slice(0, 5).map((review) => `<li><div><strong>${escapeHtml(review.member_login)}</strong><span>${escapeHtml(review.decision)}${review.reviewer_user_id ? ` · ${escapeHtml(review.reviewer_user_id)}` : ''}</span></div><small>${escapeHtml(formatDate(review.created_at, true))}</small></li>`).join('')}</ul>`
    : '<p class="recruiting-empty-copy">No reviews yet.</p>';
  return `<section class="panel recruiting-audit-panel">
    <div class="panel-header"><div><span class="eyebrow">Governance</span><h2 class="panel-title">Evidence audit</h2></div><span class="review-status ${calibrationClass}">${escapeHtml(calibrationLabel)}</span></div>
    <div class="recruiting-audit-grid">
      <div><span class="stat-label">Coverage</span><strong>${escapeHtml(`${formatCount(coverage.with_observable_stats || 0)}/${formatCount(coverage.candidate_count || 0)}`)}</strong><small>With stats</small></div>
      <div><span class="stat-label">Review completion</span><strong>${escapeHtml(`${Math.round(Number(coverage.review_completion_pct || 0))}%`)}</strong><small>Reviewed</small></div>
      <div><span class="stat-label">Reviewers</span><strong>${escapeHtml(formatCount(calibration.reviewer_count || 0))}</strong><small>${escapeHtml(`${formatCount(calibration.review_count || 0)} records`)}</small></div>
      <div><span class="stat-label">Agreement sample</span><strong>${calibration.agreement_rate_pct === null || calibration.agreement_rate_pct === undefined ? '—' : `${Math.round(Number(calibration.agreement_rate_pct))}%`}</strong><small>${escapeHtml(`${formatCount(multiReviewer)} with 2+ reviews`)}</small></div>
    </div>
    <div class="recruiting-audit-columns"><div><h3>Review flags</h3>${flags.length ? `<ul class="recruiting-audit-flags">${flags.map((flag) => `<li>${escapeHtml(flag)}</li>`).join('')}</ul>` : '<p class="recruiting-empty-copy">No coverage or calibration flags for this run.</p>'}</div><div><h3>Recent reviewer activity</h3>${recentMarkup}</div></div>
  </section>`;
}

function recruitingCandidateRow(candidate) {
  const selected = candidate.member_login === selectedRecruitingLogin ? ' selected' : '';
  const rank = candidate.reviewer_rank || candidate.provisional_rank || '—';
  return `<tr class="recruiting-candidate-row${selected}" data-recruiting-login="${escapeHtml(candidate.member_login)}" tabindex="0" role="button" aria-label="Review ${escapeHtml(candidate.member_name)}">
    <td class="recruiting-rank"><strong>#${escapeHtml(rank)}</strong><span>Provisional ${escapeHtml(candidate.provisional_rank ?? '—')}</span></td>
    <td><div class="recruiting-name"><strong>${escapeHtml(candidate.member_name)}</strong><span class="mono">${escapeHtml(candidate.member_login)}</span></div></td>
    <td class="num recruiting-score-cell"><strong>${escapeHtml(recruitingScore(candidate.provisional_score))}</strong><span>/100</span></td>
    <td class="num">${escapeHtml(recruitingScore(candidate.contribution_score))}</td>
    <td class="num">${escapeHtml(recruitingScore(candidate.evidence_quality_score))}</td>
  </tr>`;
}

function recruitingMetricTile(label, value) {
  return `<div class="recruiting-metric-tile"><span>${escapeHtml(label)}</span><strong>${escapeHtml(formatCount(value))}</strong></div>`;
}

function recruitingEvidenceList(items, emptyCopy) {
  const values = asArray(items);
  return values.length ? `<ul class="recruiting-evidence-list">${values.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : `<p class="recruiting-empty-copy">${escapeHtml(emptyCopy)}</p>`;
}

function recruitingEvidenceClaimsMarkup(claims) {
  const values = asArray(claims);
  if (!values.length) return '';
  return `<section class="recruiting-claims"><div class="recruiting-section-heading"><h3>Source claims</h3></div><ul>${values.map((claim) => `<li><strong>${escapeHtml(claim.claim)}</strong><span>${escapeHtml(claim.supporting_text)}</span><code>${escapeHtml(claim.source_field)}</code></li>`).join('')}</ul></section>`;
}

function recruitingReviewFlagsMarkup(detail) {
  const groups = [
    ['Contradictions', detail.contradictions],
    ['Duplicate flags', detail.duplicate_flags],
    ['Review flags', detail.review_flags],
    ['Evidence caveats', detail.caveats],
  ].flatMap(([label, items]) => asArray(items).map((item) => `${label}: ${item}`));
  return groups.length
    ? `<section class="recruiting-claims"><div class="recruiting-section-heading"><h3>Review flags</h3></div><ul>${groups.map((item) => `<li><span>${escapeHtml(item)}</span></li>`).join('')}</ul></section>`
    : '';
}

function recruitingReviewHistoryMarkup(history) {
  const values = asArray(history);
  if (!values.length) return '';
  return `<section class="recruiting-review-history"><div class="recruiting-section-heading"><h3>Review history</h3></div><ul>${values.map((review) => `<li><div><strong>${escapeHtml(review.decision)}</strong><span>${escapeHtml(review.reviewer_user_id || 'reviewer')}</span></div><small>${escapeHtml(formatDate(review.created_at, true))}</small>${review.note ? `<p>${escapeHtml(review.note)}</p>` : ''}</li>`).join('')}</ul></section>`;
}

function recruitingDetailMarkup() {
  const detail = state.recruitingDetail;
  if (!selectedRecruitingLogin) return `<section class="panel recruiting-detail-panel"><div class="empty-view"><div class="empty-view-inner"><div class="empty-view-icon">${icon('users')}</div><h2>Select a candidate</h2></div></div></section>`;
  if (state.recruitingDetailLoading) return `<section class="panel recruiting-detail-panel">${loadingPanel()}</section>`;
  if (state.recruitingDetailError) return `<section class="panel recruiting-detail-panel">${errorPanel(state.recruitingDetailError.message || 'Unavailable', 'retry-recruiting-detail')}</section>`;
  if (!detail) return `<section class="panel recruiting-detail-panel"><div class="empty-view"><div class="empty-view-inner"><div class="empty-view-icon">${icon('users')}</div><h2>Select a candidate</h2></div></div></section>`;
  const stats = detail.member_stats || {};
  const interview = detail.interview || {};
  const resume = detail.resume || {};
  const context = detail.context_excluded_from_score || {};
  const eligibility = detail.eligibility || {};
  const human = detail.human_review || {};
  const refs = asArray(detail.evidence_refs);
  const sharedRanking = detail.ranking || null;
  const hasPeoplePortalEvidence = detail.source_status === 'complete' || resume.summary || asArray(resume.evidence).length || interview.summary || asArray(interview.evidence).length;
  const selectedDecision = human.decision || '';
  const selectedEligibility = eligibility.status || '';
  return `<section class="panel recruiting-detail-panel">
    <div class="panel-header recruiting-detail-header"><div><span class="eyebrow">Candidate</span><h2 class="panel-title">${escapeHtml(detail.member_name)}</h2><p class="panel-subtitle mono">${escapeHtml(detail.member_login)} · Discovery order ${escapeHtml(detail.provisional_rank ?? '—')}</p></div><div class="recruiting-detail-badges">${recruitingReviewMarkup(detail.review_status)}${recruitingEligibilityMarkup(eligibility.status)}</div></div>
    <div class="recruiting-detail-score"><div><span class="eyebrow">Signal</span><strong>${escapeHtml(recruitingScore(detail.provisional_score))}<small>/100</small></strong></div><p>${escapeHtml(detail.rationale)}</p></div>
    <div class="recruiting-score-grid">${sharedRanking ? `${recruitingScoreBar('Technical execution', sharedRanking.technical_execution_score === null || sharedRanking.technical_execution_score === undefined ? null : Number(sharedRanking.technical_execution_score) * 20, 'teal')}${recruitingScoreBar('Technical leadership', sharedRanking.technical_leadership_score === null || sharedRanking.technical_leadership_score === undefined ? null : Number(sharedRanking.technical_leadership_score) * 20, 'plum')}${recruitingScoreBar('Club contribution', sharedRanking.club_contribution_score === null || sharedRanking.club_contribution_score === undefined ? null : Number(sharedRanking.club_contribution_score) * 20, 'blue')}` : `${recruitingScoreBar('Club contribution', detail.contribution_score, 'blue')}${recruitingScoreBar('Reviewed ability evidence', detail.ability_score, 'teal')}${hasPeoplePortalEvidence ? `${recruitingScoreBar('Resume evidence', detail.resume_score, 'teal')}${recruitingScoreBar('Interview evidence', detail.interview_score, 'plum')}` : ''}`}${recruitingScoreBar('Evidence quality', detail.evidence_quality_score, 'amber')}</div>
    ${sharedRanking ? `<div class="recruiting-context"><div><span class="eyebrow">Shared ranking artifact</span><p>${escapeHtml(`${sharedRanking.rubric_version} · ${sharedRanking.ranking_status} · exact combined rank ${sharedRanking.combined_rank ?? 'unranked'}`)}</p></div><p>People Portal and Gitea evidence were joined upstream; this screen displays the imported pipeline scores.</p></div>` : ''}
    ${recruitingEvidenceClaimsMarkup(detail.evidence_claims)}
    ${recruitingReviewFlagsMarkup(detail)}
    <div class="recruiting-source-grid">
      <div class="recruiting-source-card"><div class="recruiting-source-heading"><span class="source-kicker gitea">Gitea</span><h3>Contribution</h3></div><div class="recruiting-metric-grid">${recruitingMetricTile('Commits', stats.commits)}${recruitingMetricTile('Merged PR contributions', stats.pulls_merged_contributed_to)}${recruitingMetricTile('Authored PRs merged', stats.pulls_merged)}${recruitingMetricTile('Reviews', stats.reviews_submitted)}${recruitingMetricTile('Active days', stats.active_days)}${recruitingMetricTile('Issues', stats.issues_opened)}${recruitingMetricTile('Repositories', asArray(stats.repositories).length)}</div></div>
      ${hasPeoplePortalEvidence ? `<div class="recruiting-source-card"><div class="recruiting-source-heading"><span class="source-kicker people">People Portal</span><h3>Interview</h3><strong class="recruiting-interview-score">${interview.score === null || interview.score === undefined ? '—' : `${escapeHtml(interview.score)}/5`}</strong></div><p class="recruiting-source-copy">${escapeHtml(interview.summary || 'No summary.')}</p>${recruitingEvidenceList(interview.evidence, 'No evidence.')}</div><div class="recruiting-source-card"><div class="recruiting-source-heading"><span class="source-kicker people">People Portal</span><h3>Resume</h3></div><p class="recruiting-source-copy">${escapeHtml(resume.summary || 'No summary.')}</p>${recruitingEvidenceList(resume.evidence, 'No evidence.')}</div>` : `<div class="recruiting-source-card recruiting-source-card-muted"><div class="recruiting-source-heading"><span class="source-kicker people">Optional</span><h3>People Portal</h3></div><p class="recruiting-source-copy">No data.</p></div>`}
    </div>
    <div class="recruiting-review-box"><div><span class="eyebrow">Human review</span><h3>Review evidence</h3><p>Eligibility is separate from ability. Select eligible only after checking the employment evidence and outreach fit.</p></div><div class="recruiting-review-form"><label>Decision<select id="recruiting-decision"><option value=""${selectedDecision ? '' : ' selected'}>Choose</option><option value="confirm"${selectedDecision === 'confirm' ? ' selected' : ''}>Confirm evidence order</option><option value="adjust"${selectedDecision === 'adjust' ? ' selected' : ''}>Adjust</option><option value="defer"${selectedDecision === 'defer' ? ' selected' : ''}>Defer</option></select></label><label>Eligibility<select id="recruiting-eligibility"><option value=""${selectedEligibility ? '' : ' selected'}>Choose</option><option value="eligible"${selectedEligibility === 'eligible' ? ' selected' : ''}>Eligible</option><option value="needs_review"${selectedEligibility === 'needs_review' ? ' selected' : ''}>Needs review</option><option value="excluded"${selectedEligibility === 'excluded' ? ' selected' : ''}>Excluded</option></select></label><label>Reviewed discovery order <input id="recruiting-final-rank" type="number" min="1" value="${human.final_rank || detail.provisional_rank || ''}" /></label><label class="recruiting-note-field">Reviewer note <textarea id="recruiting-review-note" rows="3" placeholder="Note required for adjust/defer">${escapeHtml(human.note || '')}</textarea></label><button class="primary-button" id="save-recruiting-review"${selectedDecision ? '' : ' disabled'}>Save <span>→</span></button></div></div>
    ${recruitingReviewHistoryMarkup(detail.review_history)}
    <div class="recruiting-context"><div><span class="eyebrow">Context · not scored</span><p>${asArray(context.prior_employers).length ? escapeHtml(context.prior_employers.join(', ')) : 'None'}</p></div><p>${escapeHtml(context.note || 'Employer and school prestige excluded.')}</p></div>
    <div class="recruiting-references"><span class="eyebrow">References</span>${refs.length ? `<ul>${refs.map((ref) => `<li><span>${escapeHtml(ref.label || ref.source_type)}</span><code>${escapeHtml(`${ref.source_id} · ${ref.source_field}`)}</code></li>`).join('')}</ul>` : '<p class="recruiting-empty-copy">None</p>'}</div>
  </section>`;
}

function renderRecruiting() {
  const overview = state.recruitingOverview;
  const heading = `<div class="page-heading"><div><span class="eyebrow">${escapeHtml(RECRUITING_DISCLAIMER)}</span><h1>Recruiting</h1>${overview?.run ? `<div class="snapshot-meta"><span class="mono">Run ${escapeHtml(overview.run.run_id)} · ${escapeHtml(formatDate(overview.run.generated_at, true))}</span><span>${overview.run.llm_used ? 'LLM organizer' : 'Deterministic'}</span><span>${escapeHtml(overview.run.signal_version || 'recruiting-v2')}</span></div>` : ''}</div><div class="heading-actions"><button class="secondary-button" id="refresh-recruiting">Refresh</button><button class="secondary-button" id="run-recruiting-analysis">Run analysis <span>↻</span></button></div></div>`;
  if (state.recruitingLoading) return `${heading}${loadingPanel()}`;
  if (state.recruitingError) return `${heading}${errorPanel(state.recruitingError.message || 'Unavailable', 'retry-recruiting')}`;
  if (!overview) return `${heading}<section class="panel"><div class="empty-view"><div class="empty-view-inner"><div class="empty-view-icon">${icon('sparkle')}</div><h2>No recruiting run</h2></div></div></section>`;
  const candidates = asArray(overview.candidates);
  return `${heading}${recruitingWarningsMarkup()}<div class="recruiting-policy-banner"><span class="insight-banner-icon">${icon('check-circle')}</span><div><strong>Evidence first</strong><span>Human review required. Horizon makes no employment decisions.</span></div></div>${recruitingSummaryMarkup()}${recruitingAuditMarkup()}<div class="recruiting-steps"><div class="active"><span>01</span><strong>Source</strong><small>${overview.run?.ranking_source ? 'People Portal + Gitea' : overview.run?.people_portal_source_system ? 'People Portal API + Gitea' : 'Gitea'}</small></div><div class="active"><span>02</span><strong>Evidence</strong><small>${overview.run?.ranking_source ? 'Imported ranking artifact' : overview.run?.people_portal_source_system ? 'People Portal API evidence' : 'Stats + source evidence'}</small></div><div class="active"><span>03</span><strong>Review</strong><small>${escapeHtml(`${overview.summary.reviewed_count}/${overview.summary.candidate_count} verified`)}</small></div></div><div class="recruiting-layout"><section class="panel recruiting-list-panel"><div class="panel-header"><div><h2 class="panel-title">Evidence review queue</h2><p class="panel-subtitle">Review before deciding.</p></div><span class="eyebrow">${escapeHtml(`${candidates.length} candidates`)}</span></div><div class="table-scroll"><table class="insights-table recruiting-table"><thead><tr><th>Discovery order</th><th>Candidate</th><th>Signal</th><th>Club contribution</th><th>Stats quality</th></tr></thead><tbody>${candidates.length ? candidates.map(recruitingCandidateRow).join('') : '<tr><td colspan="5"><div class="history-empty">No candidates</div></td></tr>'}</tbody></table></div><div class="table-footer"><span>Provisional</span><span class="mono">${escapeHtml(`${overview.summary.pending_count} pending`)}</span></div></section>${recruitingDetailMarkup()}</div>`;
}

function renderAsOfEmptyProfile() {
  const listed = state.projects.find((project) => project.id === selectedProjectId);
  const name = listed ? listed.name : 'This project';
  return `<div class="page-heading"><div>${profileBackLinkMarkup()}<div class="profile-title-row">${listed ? monogram({ ...listed, statusClass: '' }, 'lg') : ''}<div><h1>${escapeHtml(name)}</h1><p>${escapeHtml(listed ? `${listed.team} · ${listed.repo}` : 'No snapshot')}</p></div></div></div></div>${asOfBannerMarkup()}<section class="panel"><div class="empty-view"><div class="empty-view-inner"><div class="empty-view-icon">${icon('database')}</div><h2>No snapshot</h2></div></div></section>`;
}

function renderProjectProfile(project) {
  const meta = statusMeta[project.statusClass] || statusMeta.data;
  return `<div class="page-heading"><div>${profileBackLinkMarkup()}<div class="profile-title-row">${monogram(project, 'lg')}<div><h1>${escapeHtml(project.name)}</h1><p>${escapeHtml(project.team)} · ${escapeHtml(project.repo)}</p>${snapshotMetaMarkup(project, true)}</div>${statusPill(project)}</div></div></div>${asOfBannerMarkup()}<div class="detail-status wide ${escapeHtml(project.statusClass)}"><strong>${escapeHtml(project.status)}</strong><span>${escapeHtml(meta.copy)}</span></div>${projectSignalCard(project)}${healthAssessmentCard(project)}${metricCharts(project)}${aggregateMetricsSection(project)}<div class="profile-grid"><section class="panel"><div class="panel-header"><div><h2 class="panel-title">Evidence</h2></div><span class="eyebrow">${escapeHtml(formatPercent(project.dataCompletenessPct))} complete</span></div><div class="evidence-section wide">${evidenceList(project, 'lg')}</div><div class="detail-actions"><button class="secondary-button" id="add-context">Add context</button><button class="primary-button" id="confirm-review">${escapeHtml(meta.cta)} <span>→</span></button></div></section></div>`;
}

function loadingPanel(message = '') {
  return `<div class="empty-view"><div class="empty-view-inner"><div class="empty-view-icon">${icon('database')}</div><h2>Loading</h2>${message ? `<p>${escapeHtml(message)}</p>` : ''}</div></div>`;
}

function errorPanel(message, retryId = 'retry-latest') {
  return `<div class="empty-view"><div class="empty-view-inner"><div class="empty-view-icon">${icon('triangle')}</div><h2>Unavailable</h2><p>${escapeHtml(message)}</p><button class="primary-button" id="${retryId}" style="margin-top:18px;">Retry</button></div></div>`;
}

function renderLoading() {
  return `<div class="page-heading"><div><span class="eyebrow">Overview</span><h1>Loading</h1></div></div>${loadingPanel()}`;
}

function renderGlobalError() {
  return `<div class="page-heading"><div><span class="eyebrow">Overview</span><h1>Unavailable</h1></div></div>${errorPanel(state.error?.message || 'Snapshot unavailable.')}`;
}

// `preserveScroll` is for renders that are a data update rather than a
// navigation -- a lazy row filling in must not yank the page back to the top,
// which would also change which rows are on screen and so which ones the
// observer decides to compute next.
function render(preserveScroll = false) {
  const scrollY = preserveScroll ? window.scrollY : 0;
  const appView = document.getElementById('app-view');
  // The member views read from /analytics/* and carry their own loading and
  // error states, so they render before the portfolio-snapshot guards below:
  // a failing /snapshots/latest must not take this page down with it.
  const isIndependentView = currentView === 'members' || currentView === 'member' || currentView === 'recruiting';
  if (currentView === 'members') appView.innerHTML = renderMembers();
  else if (currentView === 'member') appView.innerHTML = renderMemberDetail();
  else if (currentView === 'recruiting') appView.innerHTML = renderRecruiting();
  else if (state.loading) appView.innerHTML = renderLoading();
  else if (state.error) appView.innerHTML = renderGlobalError();
  else if (currentView === 'overview') appView.innerHTML = renderOverview();
  else if (currentView === 'projects') appView.innerHTML = renderProjects();
  else if (currentView === 'insights') appView.innerHTML = renderInsights();
  else if (currentView === 'progress') appView.innerHTML = renderProgressDetail();
  else if (currentView === 'profile') {
    const project = selectedProject();
    const asOfEntry = selectedProjectAsOfDate ? state.projectAsOf[`${selectedProjectId}@${selectedProjectAsOfDate}`] : null;
    appView.innerHTML = state.profileLoading
      ? loadingPanel()
      : state.profileError ? errorPanel(state.profileError, 'retry-profile')
        : asOfEntry && !asOfEntry.hasData ? renderAsOfEmptyProfile()
          : !project ? errorPanel('Project unavailable.')
            : renderProjectProfile(project);
  }
  // Lets CSS target a single view without inspecting its contents. Overview
  // uses it to fill the viewport and centre its stat row vertically, which
  // must not happen on the content-driven views.
  appView.dataset.view = (!isIndependentView && (state.loading || state.error)) ? 'loading' : currentView;
  const navActiveView = (currentView === 'profile' || currentView === 'progress') ? 'projects'
      : currentView === 'member' ? 'members'
      : currentView;
  document.querySelectorAll('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.view === navActiveView));
  updateChrome();
  bindViewEvents();
  bindLazyCompute();
  window.scrollTo(0, scrollY);
}

function selectedProject() {
  // A profile opened as of a past date resolves only from the point-in-time
  // cache; it must never fall back to the live snapshot or the live list.
  if (selectedProjectAsOfDate) return state.projectAsOf[`${selectedProjectId}@${selectedProjectAsOfDate}`]?.project || null;
  return state.projectSnapshots[selectedProjectId] || state.projects.find((project) => project.id === selectedProjectId) || null;
}

function updateChrome() {
  const count = document.querySelector('.nav-count');
  if (count) count.textContent = String(state.projects.filter((project) => project.statusClass === 'risk' || project.statusClass === 'watch').length);
}

function showToast(message, isError = false) {
  const toast = document.getElementById('toast');
  document.getElementById('toast-message').textContent = message;
  toast.classList.toggle('error', isError);
  toast.classList.add('show');
  window.clearTimeout(showToast.timeout);
  showToast.timeout = window.setTimeout(() => toast.classList.remove('show'), 3000);
}

async function loadLatestSnapshot() {
  state.loading = true;
  state.error = null;
  render();
  try {
    const raw = await requestJson('/snapshots/latest');
    state.snapshot = normalizeSnapshot(raw);
    state.projects = state.snapshot.projects;
    state.lazyWeekStart = firstDefined(raw?.lazy_week_start, null);
    state.lazyComputable = Boolean(raw?.computable);
    state.lazyMissing = new Set(asArray(raw?.missing_project_ids));
    state.lazyComputing = new Set();
    state.lazyErrors = {};
    state.loading = false;
    if (!selectedProjectId && state.projects[0]) selectedProjectId = state.projects[0].id;
    render();
  } catch (error) {
    state.loading = false;
    state.error = error;
    render();
  }
}

// ---------------------------------------------------------------------
// Gitea member analytics loaders. The summary call carries the run metadata
// (including its collection warnings) and the organization list that fills
// the filter, so it is fetched alongside the member rows rather than lazily.
// ---------------------------------------------------------------------

function memberQueryKey() {
  return JSON.stringify([memberOrgFilter, memberSearch, memberSort, memberIncludeService, memberIncludeUnmatched]);
}

async function loadMemberAnalytics() {
  const key = memberQueryKey();
  // Already have exactly this result -- Back/Forward must not refetch it.
  if (state.membersLoadedKey === key && !state.membersError) return;
  state.membersLoading = true;
  state.membersError = null;
  render();
  const query = new URLSearchParams({ sort: memberSort, limit: '1000' });
  if (memberOrgFilter !== 'all') query.set('organization', memberOrgFilter);
  if (memberSearch.trim()) query.set('search', memberSearch.trim());
  if (!memberIncludeService) query.set('include_service', 'false');
  if (!memberIncludeUnmatched) query.set('include_unmatched', 'false');
  try {
    const [summary, members] = await Promise.all([
      requestJson('/analytics/summary'),
      requestJson(`/analytics/members?${query.toString()}`),
    ]);
    state.membersRun = summary?.run || members?.run || null;
    state.membersTotals = summary?.totals || null;
    state.memberRows = asArray(members?.members);
    // The organization list comes from the run, not from the filtered rows,
    // so filtering to one org can never empty the filter that produced it.
    const organizations = await requestJson('/analytics/organizations');
    state.memberOrganizations = asArray(organizations?.organizations).map((row) => row.organization).filter(Boolean);
    state.membersLoadedKey = key;
    state.membersLoading = false;
    render();
  } catch (error) {
    state.membersLoading = false;
    state.membersError = error;
    render();
  }
}

async function loadMemberDetail(login) {
  state.memberDetailLoading = true;
  state.memberDetailError = null;
  state.memberDetail = null;
  render();
  try {
    const payload = await requestJson(`/analytics/members/${encodeURIComponent(login)}`);
    state.memberDetail = payload?.member || null;
    state.membersRun = payload?.run || state.membersRun;
    state.memberDetailLoading = false;
    render();
  } catch (error) {
    state.memberDetailLoading = false;
    state.memberDetailError = error;
    render();
  }
}

// ---------------------------------------------------------------------
// Recruiting loaders and reviewer actions.
// ---------------------------------------------------------------------

async function loadRecruitingOverview() {
  if (state.recruitingOverview && state.recruitingLoadedRunId && !state.recruitingError && Date.now() - (state.recruitingFetchedAt || 0) < 30000) {
    if (!state.recruitingAudit || state.recruitingAudit.run?.run_id !== state.recruitingLoadedRunId) loadRecruitingAudit(state.recruitingLoadedRunId);
    if (selectedRecruitingLogin && state.recruitingDetail?.member_login !== selectedRecruitingLogin) loadRecruitingDetail(selectedRecruitingLogin);
    return;
  }
  state.recruitingLoading = true;
  state.recruitingError = null;
  render();
  try {
    const overview = await requestJson('/recruiting/overview');
    state.recruitingOverview = overview;
    state.recruitingFetchedAt = Date.now();
    state.recruitingCandidates = asArray(overview?.candidates);
    state.recruitingLoadedRunId = overview?.run?.run_id || null;
    state.recruitingLoading = false;
    render();
    if (state.recruitingLoadedRunId) loadRecruitingAudit(state.recruitingLoadedRunId);
    if (selectedRecruitingLogin) loadRecruitingDetail(selectedRecruitingLogin);
  } catch (error) {
    state.recruitingLoading = false;
    state.recruitingError = error;
    render();
  }
}

async function loadRecruitingAudit(runId) {
  if (!runId) return;
  state.recruitingAuditLoading = true;
  state.recruitingAuditError = null;
  render(true);
  try {
    const payload = await requestJson(`/recruiting/audit?run_id=${encodeURIComponent(runId)}`);
    if (state.recruitingOverview?.run?.run_id === runId) state.recruitingAudit = payload;
    state.recruitingAuditLoading = false;
    render(true);
  } catch (error) {
    state.recruitingAuditLoading = false;
    state.recruitingAuditError = error;
    render(true);
  }
}

let recruitingDetailRequest = 0;
async function loadRecruitingDetail(login) {
  if (!login) return;
  const requestId = ++recruitingDetailRequest;
  const runId = state.recruitingOverview?.run?.run_id;
  state.recruitingDetailLoading = true;
  state.recruitingDetailError = null;
  state.recruitingDetail = null;
  render(true);
  try {
    const query = runId ? `?run_id=${encodeURIComponent(runId)}` : '';
    const payload = await requestJson(`/recruiting/candidates/${encodeURIComponent(login)}${query}`);
    if (requestId !== recruitingDetailRequest || selectedRecruitingLogin !== login || state.recruitingOverview?.run?.run_id !== runId) return;
    state.recruitingDetail = payload?.candidate || null;
  } catch (error) {
    if (requestId !== recruitingDetailRequest || selectedRecruitingLogin !== login) return;
    state.recruitingDetailError = error;
  } finally {
    if (requestId === recruitingDetailRequest) {
      state.recruitingDetailLoading = false;
      render(true);
    }
  }
}

async function runRecruitingAnalysis() {
  const button = document.getElementById('run-recruiting-analysis');
  if (button) button.disabled = true;
  state.recruitingLoading = true;
  state.recruitingError = null;
  render();
  try {
    await requestJson('/recruiting/run', { method: 'POST' });
    state.recruitingOverview = null;
    state.recruitingCandidates = [];
    state.recruitingDetail = null;
    state.recruitingAudit = null;
    state.recruitingAuditError = null;
    state.recruitingLoadedRunId = null;
    await loadRecruitingOverview();
    showToast('New provisional recruiting signal generated');
  } catch (error) {
    state.recruitingLoading = false;
    state.recruitingError = error;
    render();
    showToast(error.message || 'Recruiting analysis could not be generated.', true);
  } finally {
    if (button) button.disabled = false;
  }
}

async function saveRecruitingReview() {
  const detail = state.recruitingDetail;
  const overview = state.recruitingOverview;
  if (!detail || !overview?.run?.run_id || detail.member_login !== selectedRecruitingLogin || detail.run_id !== overview.run.run_id) return;
  const decision = document.getElementById('recruiting-decision')?.value || '';
  const eligibilityDecision = document.getElementById('recruiting-eligibility')?.value || '';
  const rankValue = document.getElementById('recruiting-final-rank')?.value || '';
  const note = document.getElementById('recruiting-review-note')?.value.trim() || '';
  if (!decision) {
    showToast('Choose a human review decision first.', true);
    return;
  }
  if (decision === 'adjust' && (!rankValue || !Number.isInteger(Number(rankValue)) || Number(rankValue) < 1 || Number(rankValue) > overview.summary.candidate_count)) {
    showToast('Enter a final rank when adjusting the signal.', true);
    return;
  }
  if ((decision === 'adjust' || decision === 'defer' || eligibilityDecision) && !note) {
    showToast('Add a note for ordering or eligibility decisions.', true);
    return;
  }
  const button = document.getElementById('save-recruiting-review');
  if (button) button.disabled = true;
  try {
    const payload = await requestJson('/recruiting/reviews', {
      method: 'POST',
      body: JSON.stringify({
        run_id: overview.run.run_id,
        member_login: detail.member_login,
        decision,
        eligibility_decision: eligibilityDecision || null,
        final_rank: decision === 'adjust' ? Number(rankValue) : decision === 'confirm' ? detail.provisional_rank : null,
        note,
      }),
    });
    state.recruitingDetail = payload?.candidate || state.recruitingDetail;
    state.recruitingLoadedRunId = null;
    await loadRecruitingOverview();
    await loadRecruitingDetail(detail.member_login);
    showToast('Human review recorded');
  } catch (error) {
    showToast(error.message || 'Human review could not be recorded.', true);
  } finally {
    if (button) button.disabled = false;
  }
}

// Portfolio-wide delivery facts for the Overview stat row. Cache-only on the
// server, so it is cheap and never blocks the page: a failure leaves the extra
// cards showing "--" rather than surfacing an error over the status counts.
async function loadPortfolioDelivery() {
  try {
    state.delivery = await requestJson('/portfolio/delivery');
  } catch {
    state.delivery = null;
  }
  render();
}

// ---------------------------------------------------------------------
// Viewport-gated lazy compute for live dashboard tables. Rows without a
// snapshot are observed and computed only once they are on screen.
// ---------------------------------------------------------------------

// Start the request slightly before the row is actually visible, so the
// result usually lands by the time the reviewer has scrolled to it.
const LAZY_ROOT_MARGIN = '200px';
let lazyObserver = null;

function lazyComputeFor(projectId) {
  if (!projectId) return;
  computeLatestProjectSnapshot(projectId);
}

function bindLazyCompute() {
  const rows = document.querySelectorAll('[data-lazy-project]');
  if (!('IntersectionObserver' in window)) {
    // Without observer support, compute every pending row immediately. That
    // costs more requests than the lazy path, but a browser that cannot
    // observe would otherwise sit on placeholder rows forever.
    rows.forEach((node) => lazyComputeFor(node.dataset.lazyProject));
    return;
  }
  // render() replaces the view's whole innerHTML, so every observed node is
  // destroyed on each paint; the observer is rebuilt here rather than once
  // at boot. The observed set only ever shrinks -- a row that starts
  // computing loses its data-lazy-project attribute -- so this cannot loop.
  if (lazyObserver) lazyObserver.disconnect();
  lazyObserver = new IntersectionObserver((entries, observer) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      observer.unobserve(entry.target);
      lazyComputeFor(entry.target.dataset.lazyProject);
    });
  }, { rootMargin: LAZY_ROOT_MARGIN });
  rows.forEach((node) => lazyObserver.observe(node));
}

async function computeLatestProjectSnapshot(projectId) {
  if (!state.lazyComputable || !state.lazyWeekStart) return;
  if (!state.lazyMissing.has(projectId) || state.lazyComputing.has(projectId)) return;
  state.lazyComputing.add(projectId);
  delete state.lazyErrors[projectId];
  render(true);
  try {
    const raw = await requestJson(`/projects/${encodeURIComponent(projectId)}/snapshots/at?date=${encodeURIComponent(state.lazyWeekStart)}`, { method: 'POST' });
    const updated = normalizeProject(raw?.project, state.snapshot || {});
    state.projects = state.projects.map((project) => (project.id === projectId ? updated : project));
    // state.snapshot.projects is what selectedProject() falls back to, so it
    // has to track the list rather than keep serving the pre-compute row.
    if (state.snapshot) state.snapshot.projects = state.projects;
    state.lazyMissing.delete(projectId);
  } catch (error) {
    // Left in lazyMissing so the row keeps its placeholder and offers a
    // retry -- but it is no longer observed, so scrolling past it again
    // cannot silently re-spend an LLM request on a project that just failed.
    state.lazyErrors[projectId] = error;
  } finally {
    state.lazyComputing.delete(projectId);
    render(true);
  }
}

// Row state for a project the live dashboard has no snapshot for. null means
// the project has real data and renders normally.
function lazyRowState(projectId) {
  if (state.lazyComputing.has(projectId)) return 'computing';
  if (state.lazyErrors[projectId]) return 'error';
  if (!state.lazyMissing.has(projectId)) return null;
  return state.lazyComputable ? 'pending' : 'unavailable';
}

// Only a 'pending' row is observed. A computing row has a request in flight,
// an errored one waits for an explicit retry, and an unavailable one has no
// LLM configured to compute it with.
function lazyRowAttrs(projectId) {
  return lazyRowState(projectId) === 'pending'
    ? ` data-lazy-project="${escapeHtml(projectId)}"`
    : '';
}

function lazyCellMarkup(projectId, colspan) {
  const status = lazyRowState(projectId);
  const body = status === 'computing'
    ? '<span class="lazy-note"><span class="spinner"></span>Computing this week’s signal…</span>'
    : status === 'error'
      ? `<button class="lazy-retry" data-project-id="${escapeHtml(projectId)}">Retry</button>`
      : status === 'unavailable'
        ? '<span class="lazy-note mono">Unavailable</span>'
        : '<span class="lazy-note mono">Not computed</span>';
  return `<td colspan="${colspan}">${body}</td>`;
}

// ---------------------------------------------------------------------
// Projects-page cumulative-progress-as-of-date view. Picking a date
// automatically computes every project's progress (bounded client-side
// concurrency, one request per project) -- no per-project button.
// ---------------------------------------------------------------------

const PROGRESS_FAN_OUT_CONCURRENCY = 3;

async function loadProgressAt(dateStr) {
  const runId = ++state.progressRunId;
  state.progressDate = dateStr;
  state.progressResult = {};
  state.progressLoading = true;
  state.progressError = null;
  render();

  let raw;
  try {
    raw = await requestJson(`/progress/at?date=${encodeURIComponent(dateStr)}`);
  } catch (error) {
    if (runId !== state.progressRunId) return;
    state.progressLoading = false;
    state.progressLoadedDate = null; // leave it refetchable when the route is revisited
    state.progressError = error;
    render();
    return;
  }
  if (runId !== state.progressRunId) return;

  const missing = new Set(asArray(raw?.missing_project_ids));
  const results = {};
  asArray(raw?.projects).forEach((project) => {
    if (!missing.has(project.id)) results[project.id] = { state: 'done', data: project };
  });
  missing.forEach((id) => { results[id] = { state: 'pending' }; });
  state.progressResult = results;
  state.progressLoading = false;
  state.progressLoadedDate = dateStr;
  state.progressComputable = Boolean(raw?.computable);
  render();

  const queue = Array.from(missing);
  const worker = async () => {
    while (queue.length) {
      const projectId = queue.shift();
      await computeProjectProgress(projectId, dateStr, runId);
    }
  };
  await Promise.all(Array.from({ length: PROGRESS_FAN_OUT_CONCURRENCY }, worker));
}

async function computeProjectProgress(projectId, dateStr, runId) {
  try {
    const raw = await requestJson(`/projects/${encodeURIComponent(projectId)}/progress/at?date=${encodeURIComponent(dateStr)}`, { method: 'POST' });
    if (runId !== state.progressRunId) return; // a newer date pick superseded this request
    state.progressResult[projectId] = { state: 'done', data: raw?.project };
    render(true);
  } catch (error) {
    if (runId !== state.progressRunId) return;
    state.progressResult[projectId] = { state: 'error', error };
    render(true);
  }
}

// Cold-load path for #/projects/:id/progress?asOf=... -- a deep link, a
// refresh, or Back onto a detail view whose checkpoint is no longer in memory.
// It reads the same cache-only GET the list view does, but computes at most
// the ONE project the URL names; running the portfolio fan-out here would
// spend an LLM request per project to render a single-project screen.
async function loadProgressForProject(projectId, dateStr) {
  const runId = ++state.progressRunId;
  state.progressDate = dateStr;
  state.progressResult = { [projectId]: { state: 'pending' } };
  state.progressLoading = false;
  state.progressError = null;
  render();

  let raw;
  try {
    raw = await requestJson(`/progress/at?date=${encodeURIComponent(dateStr)}`);
  } catch (error) {
    if (runId !== state.progressRunId) return;
    state.progressResult[projectId] = { state: 'error', error };
    render();
    return;
  }
  if (runId !== state.progressRunId) return;

  state.progressComputable = Boolean(raw?.computable);
  const missing = new Set(asArray(raw?.missing_project_ids));
  const cached = asArray(raw?.projects).find((project) => project.id === projectId);
  if (cached && !missing.has(projectId)) {
    state.progressResult[projectId] = { state: 'done', data: cached };
    render();
    return;
  }
  await computeProjectProgress(projectId, dateStr, runId);
}

function retryProjectProgress(projectId) {
  if (!state.progressDate) return;
  const runId = state.progressRunId;
  state.progressResult[projectId] = { state: 'pending' };
  render(true);
  computeProjectProgress(projectId, state.progressDate, runId);
}

// A route change (#/projects?asOf=... -> #/projects) lets the router own the
// state and orphan any in-flight fan-out via setProgressDate.
function clearProgress() {
  goto({ view: 'projects', filter: currentFilter, asOf: null });
}

function progressControlMarkup() {
  const today = new Date().toISOString().slice(0, 10);
  return `<div class="calendar-control"><label for="progress-date-input">${icon('calendar')}<span>View progress as of</span></label><input type="date" id="progress-date-input" max="${today}" value="${escapeHtml(state.progressDate || '')}" />${state.progressDate ? '<button class="text-button" id="progress-clear">Back to live ×</button>' : ''}</div>`;
}

// 'stalled' is retired; kept here only so a checkpoint persisted before the
// change still renders a label rather than a blank chip.
const TRAJECTORY_LABELS = { accelerating: 'Accelerating', steady: 'Steady', slowing: 'Slowing', stalled: 'Slowing', unknown: '' };

function progressRowMarkup(projectId) {
  const entry = state.progressResult[projectId];
  const meta = state.projects.find((project) => project.id === projectId) || { id: projectId, name: projectId, team: '', repo: '' };
  if (!entry || entry.state === 'pending') {
    return `<div class="queue-item">${monogram(meta)}<div class="queue-main"><div class="queue-name-line"><span class="queue-name">${escapeHtml(meta.name)}</span></div><div class="queue-meta">${escapeHtml(meta.team)} · ${escapeHtml(meta.repo)}</div></div><span class="queue-action compute-pending"><span class="spinner"></span> Computing progress…</span></div>`;
  }
  if (entry.state === 'error') {
    return `<div class="queue-item">${monogram(meta)}<div class="queue-main"><div class="queue-name-line"><span class="queue-name">${escapeHtml(meta.name)}</span></div><div class="queue-meta">${escapeHtml(meta.team)} · ${escapeHtml(meta.repo)}</div></div><button class="queue-action progress-retry" data-project-id="${escapeHtml(projectId)}">Could not compute — Retry</button></div>`;
  }
  const project = entry.data || {};
  const fidelity = project.weeksTotal ? `${project.weeksDeepJudged} of ${project.weeksTotal} weeks reviewed in depth` : '';
  // One signal per row: the attention status pill alone. Trajectory used to ride
  // beside it as a second chip, which read as two competing verdicts on the same
  // project; it now shows only in the checkpoint detail, where it is labelled and
  // sits beside Work to date and Confidence.
  return `<div class="queue-item">${monogram(project)}<div class="queue-main"><div class="queue-name-line"><span class="queue-name">${escapeHtml(project.name)}</span><span class="status-pill status-${escapeHtml(project.statusClass)}">${escapeHtml(project.status)}</span></div><div class="queue-meta">${escapeHtml(project.team)} · ${escapeHtml(project.repo)}</div></div><div class="queue-signal"><strong>${escapeHtml(project.headline || '')}</strong>${fidelity ? `<span class="mono">${escapeHtml(fidelity)}</span>` : ''}</div><button class="queue-action view-progress" data-project-id="${escapeHtml(projectId)}">View progress</button></div>`;
}

function progressPanelMarkup() {
  if (!state.progressDate) return '';
  if (state.progressLoading) return `<section class="panel calendar-panel">${loadingPanel()}</section>`;
  if (state.progressError) return `<section class="panel calendar-panel">${errorPanel(state.progressError.message || 'Unavailable', 'retry-progress')}</section>`;
  const ids = Object.keys(state.progressResult);
  return `<section class="panel calendar-panel"><div class="panel-header"><div><h2 class="panel-title">Portfolio progress as of ${escapeHtml(formatDate(state.progressDate))}</h2></div></div><div class="queue-list">${ids.length ? ids.map(progressRowMarkup).join('') : '<div class="history-empty" style="padding:20px;">No projects</div>'}</div></section>`;
}

// ---------------------------------------------------------------------
// Cumulative-checkpoint detail view (the drill-down from a progress row).
//
// Deliberately NOT the weekly-snapshot profile: a checkpoint answers
// "where does this project stand, cumulatively, as of this date", so it
// renders the checkpoint's own fields (trajectory, work to date,
// milestones, open concerns) and never a single week's metrics/series.
// Needs no fetch -- GET /progress/at and POST /projects/{id}/progress/at
// already return the whole checkpoint, which the row cached in
// state.progressResult.
// ---------------------------------------------------------------------

const WORK_LEVEL_LABELS = { none: 'None', trivial: 'Trivial', minimal: 'Minimal', moderate: 'Moderate', substantial: 'Substantial' };
const SEVERITY_LABELS = { info: 'Info', warning: 'Warning', critical: 'Critical' };

function openProgressDetail(projectId) {
  goto({ view: 'progress', projectId, asOf: state.progressDate });
}

function progressBackLinkMarkup() {
  const label = state.progressDate ? `Back to portfolio progress as of ${formatDate(state.progressDate)}` : 'Back to inventory';
  return `<button class="text-button back-link" id="progress-back"><span>←</span> ${escapeHtml(label)}</button>`;
}

function progressBannerMarkup() {
  return `<div class="as-of-banner"><div class="date-chip">${icon('calendar')} As of ${escapeHtml(formatDate(state.progressDate))}</div><span>Cumulative</span></div>`;
}

function checkpointRefs(refs) {
  const list = asArray(refs).filter((ref) => typeof ref === 'string' && ref.trim());
  if (!list.length) return '';
  return `<ul class="checkpoint-refs">${list.map((ref) => `<li>${escapeHtml(ref)}</li>`).join('')}</ul>`;
}

function checkpointItems(items, emptyCopy) {
  const list = asArray(items);
  if (!list.length) return `<p class="assessment-empty">${escapeHtml(emptyCopy)}</p>`;
  return `<ul class="assessment-list">${list.map((item) => {
    const severity = typeof item?.severity === 'string' ? item.severity : null;
    const chip = severity ? `<span class="severity-chip severity-${escapeHtml(severity)}">${escapeHtml(SEVERITY_LABELS[severity] || severity)}</span>` : '';
    return `<li><strong>${escapeHtml(item?.text || '')}</strong>${chip}${checkpointRefs(item?.evidence)}</li>`;
  }).join('')}</ul>`;
}

function checkpointNotes(items, emptyCopy) {
  const list = asArray(items).filter((item) => typeof item === 'string' && item.trim());
  if (!list.length) return `<p class="assessment-empty">${escapeHtml(emptyCopy)}</p>`;
  return `<ul class="assessment-list">${list.map((item) => `<li><strong>${escapeHtml(item)}</strong></li>`).join('')}</ul>`;
}

function progressDetailShell(name, body) {
  return `<div class="page-heading"><div>${progressBackLinkMarkup()}<div class="profile-title-row"><div><h1>${escapeHtml(name)}</h1></div></div></div></div>${progressBannerMarkup()}<section class="panel">${body}</section>`;
}

function renderProgressEmptyDetail(name, reason) {
  return progressDetailShell(name, `<div class="empty-view"><div class="empty-view-inner"><div class="empty-view-icon">${icon('database')}</div><h2>${escapeHtml(reason)}</h2></div></div>`);
}

function renderProgressDetail() {
  const projectId = selectedProgressProjectId;
  const entry = projectId ? state.progressResult[projectId] : null;
  const listed = state.projects.find((project) => project.id === projectId);
  const fallbackName = listed ? listed.name : (projectId || 'This project');
  // Reached on a deep link or a refresh: the checkpoint isn't in memory yet
  // and loadProgressForProject is fetching (or computing) it. state.progressLoading
  // covers the frame between the route being applied and that fetch starting.
  if (state.progressLoading || (entry && entry.state === 'pending')) {
    return progressDetailShell(fallbackName, loadingPanel());
  }
  if (entry && entry.state === 'error') {
    return progressDetailShell(fallbackName, errorPanel(entry.error?.message || 'Unavailable', 'retry-progress-detail'));
  }
  if (!entry || entry.state !== 'done' || !entry.data) {
    return renderProgressEmptyDetail(fallbackName, 'No progress data.');
  }
  const project = entry.data;
  // A checkpoint the server had nothing to build from: say so rather than
  // dressing an empty synthesis up as a verdict.
  if (!project.checkpointId) {
    return renderProgressEmptyDetail(project.name || fallbackName, 'No progress data.');
  }

  const trajectoryLabel = TRAJECTORY_LABELS[project.trajectory] || 'Unknown';
  const workLabel = WORK_LEVEL_LABELS[project.workToDate] || '—';
  const confidence = finiteNumber(project.confidence);
  const fidelityBits = [];
  if (project.weeksTotal) {
    const shallow = project.weeksTotal - project.weeksDeepJudged;
    fidelityBits.push(`${project.weeksDeepJudged} of ${project.weeksTotal} weeks reviewed in depth${shallow > 0 ? `; the other ${shallow} counted from commit metadata only` : ''}`);
  }
  if (project.historyTruncated) fidelityBits.push('history was truncated, so older activity may be missing');
  if (project.isProvisional) fidelityBits.push('provisional — this date falls in the current, in-progress week');
  if (project.generatedAt) fidelityBits.push(`synthesized ${formatDate(project.generatedAt, true)}`);
  const fidelity = fidelityBits.length ? `<p class="assessment-empty-body">${escapeHtml(fidelityBits.join(' · '))}</p>` : '';

  const header = `<div class="page-heading"><div>${progressBackLinkMarkup()}<div class="profile-title-row">${monogram(project, 'lg')}<div><h1>${escapeHtml(project.name)}</h1><p>${escapeHtml(project.team)} · ${escapeHtml(project.repo)}</p></div>${statusPill(project)}</div></div></div>`;
  // Everything here was previously said two or three times over: the status as
  // both the header pill and a full-width standing band, the trajectory as both
  // a header chip and a metric cell, and "as of <date>, cumulative not weekly"
  // in the back link, the banner AND the panel subtitle. Each now appears once,
  // in whichever spot carries it best — nothing was dropped from the page.
  // The narrative stands alone, directly under the as-of banner: it is the one
  // thing a reader wants first, so it gets its own tile rather than being
  // buried mid-panel between the metrics row and the milestone columns.
  const summaryTile = project.narrative
    ? `<section class="panel progress-summary"><span class="eyebrow">Summary</span><p>${escapeHtml(project.narrative)}</p></section>`
    : '';
  const summary = `<section class="panel ci-assessment"><div class="panel-header"><div><span class="eyebrow">Cumulative progress</span><h2 class="panel-title">${escapeHtml(project.headline || 'Cumulative progress')}</h2></div></div><div class="assessment-metrics"><div><span>Trajectory</span><strong class="trajectory-value trajectory-${escapeHtml(project.trajectory || 'unknown')}">${escapeHtml(trajectoryLabel)}</strong></div><div><span>Work to date</span><strong>${escapeHtml(workLabel)}</strong></div><div><span>Confidence</span><strong>${confidence === null ? '—' : `${Math.round(confidence * 100)}%`}</strong></div></div><div class="assessment-columns"><div class="assessment-block"><h3>Milestones to date</h3>${checkpointItems(project.milestones, 'No grounded milestones were recorded up to this date.')}</div><div class="assessment-block"><h3>Open concerns</h3>${checkpointItems(project.openConcerns, 'No open concerns were recorded up to this date.')}</div></div><div class="assessment-columns"><div class="assessment-block"><h3>Recommendations</h3>${checkpointNotes(project.recommendations, 'No recommendations were returned.')}</div><div class="assessment-block"><h3>Data gaps</h3>${checkpointNotes(project.dataGaps, 'No data gaps were reported.')}</div></div>${fidelity}</section>`;
  return `${header}${progressBannerMarkup()}${summaryTile}${summary}`;
}

function projectFromSnapshotResponse(raw, projectId) {
  const withProfileAssessment = (project, envelope) => {
    if (!project || typeof project !== 'object' || !envelope || typeof envelope !== 'object') return project;
    const assessment = firstDefined(envelope.healthAssessment, envelope.health_assessment, envelope.projectHealthAssessment, envelope.project_health_assessment, envelope.agent?.healthAssessment, envelope.agent?.health_assessment, null);
    return assessment && !project.healthAssessment && !project.health_assessment ? { ...project, healthAssessment: assessment } : project;
  };
  if (raw && raw.project) return withProfileAssessment(raw.project, raw);
  if (raw && raw.snapshot && Array.isArray(raw.snapshot.projects)) return raw.snapshot.projects.find((project) => project.id === projectId) || raw.snapshot.projects[0];
  if (raw && Array.isArray(raw.projects)) return raw.projects.find((project) => project.id === projectId) || raw.projects[0];
  if (raw && Array.isArray(raw.items)) return projectFromSnapshotResponse(raw.items, projectId);
  if (raw && Array.isArray(raw.snapshots)) {
    const sorted = raw.snapshots.slice().sort(compareSnapshotRows);
    return projectFromSnapshotResponse(sorted[0], projectId);
  }
  if (Array.isArray(raw)) {
    const sorted = raw.slice().sort(compareSnapshotRows);
    return sorted[0];
  }
  return raw;
}

function snapshotSourcePriority(snapshot) {
  const project = snapshot?.project && typeof snapshot.project === 'object' ? snapshot.project : snapshot;
  const source = String(firstDefined(project?.signalSource, project?.signal_source, snapshot?.rule_set_version, '')).toLowerCase();
  return source === 'llm' || source.startsWith('llm-signal-') ? 1 : 0;
}

function compareSnapshotRows(left, right) {
  const weekOrder = String(firstDefined(right.snapshot_week_end, right.week_end, right.generated_at, '')).localeCompare(String(firstDefined(left.snapshot_week_end, left.week_end, left.generated_at, '')));
  if (weekOrder !== 0) return weekOrder;
  const sourceOrder = snapshotSourcePriority(right) - snapshotSourcePriority(left);
  if (sourceOrder !== 0) return sourceOrder;
  return String(firstDefined(right.generated_at, '')).localeCompare(String(firstDefined(left.generated_at, '')));
}

function snapshotMetaFromResponse(raw) {
  const candidates = Array.isArray(raw) ? raw : asArray(raw?.snapshots || raw?.items);
  const latest = candidates.length ? candidates.slice().sort(compareSnapshotRows)[0] : raw;
  const envelope = snapshotEnvelope(latest);
  return { snapshotId: firstDefined(envelope.snapshot_id, envelope.snapshotId, envelope.id, null), snapshotWeekStart: firstDefined(envelope.snapshot_week_start, envelope.week_start, null), snapshotWeekEnd: firstDefined(envelope.snapshot_week_end, envelope.week_end, null), generatedAt: firstDefined(envelope.generated_at, null), ruleSetVersion: firstDefined(envelope.rule_set_version, null), dataCompletenessPct: finiteNumber(envelope.data_completeness_pct), lastSyncAt: firstDefined(envelope.last_sync_at, null) };
}

async function loadProjectSnapshots(projectId) {
  state.profileLoading = true;
  state.profileError = null;
  render();
  try {
    const raw = await requestJson(`/projects/${encodeURIComponent(projectId)}/snapshots`);
    const baseMeta = snapshotMetaFor();
    const responseMeta = snapshotMetaFromResponse(raw);
    const meta = Object.fromEntries(Object.keys(baseMeta).map((key) => [key, firstDefined(responseMeta[key], baseMeta[key])]));
    const rawProject = projectFromSnapshotResponse(raw, projectId);
    if (!rawProject || typeof rawProject !== 'object') throw new Error('No snapshot was returned for this project.');
    state.projectSnapshotMeta[projectId] = meta;
    const baseProject = state.projects.find((project) => project.id === projectId) || {};
    state.projectSnapshots[projectId] = normalizeProject({ ...baseProject, ...rawProject }, meta);
    state.profileLoading = false;
    render();
  } catch (error) {
    state.profileLoading = false;
    state.profileError = error.message || 'Project snapshots could not be loaded.';
    render();
  }
}

// Point-in-time sibling of loadProjectSnapshots. The cache-only endpoint
// serves the same _project_response shape the live endpoint does, so the same
// normalizeProject/renderProjectProfile path renders it unchanged.
async function loadProjectSnapshotAsOf(projectId, dateStr) {
  state.profileLoading = true;
  state.profileError = null;
  render();
  const key = `${projectId}@${dateStr}`;
  try {
    const raw = await requestJson(`/projects/${encodeURIComponent(projectId)}/snapshots/at?date=${encodeURIComponent(dateStr)}`);
    const meta = snapshotMetaFromResponse(raw);
    state.projectSnapshotMeta[key] = meta;
    // Deliberately no merge with the live project record: filling gaps from
    // today's data is what made the historical view misleading before.
    state.projectAsOf[key] = raw?.has_data
      ? { hasData: true, project: normalizeProject(raw.project, meta) }
      : { hasData: false, project: null };
    state.profileLoading = false;
    render();
  } catch (error) {
    state.profileLoading = false;
    state.profileError = error.message || `The snapshot as of ${formatDate(dateStr)} could not be loaded.`;
    render();
  }
}

// Opens a profile, live or as of a captured date, from wherever it was clicked.
function openProject(projectId, asOfDate = null) {
  goto({ view: 'profile', projectId, asOf: asOfDate });
}

function reloadProfile() {
  if (!selectedProjectId) return;
  if (selectedProjectAsOfDate) return loadProjectSnapshotAsOf(selectedProjectId, selectedProjectAsOfDate);
  return loadProjectSnapshots(selectedProjectId);
}

// =====================================================================
// Router
//
// Route table (hash routes, see buildHash/parseRoute below):
//
//   #/overview                                  overview, live portfolio
//   #/overview?asOf=YYYY-MM-DD                  redirects to project progress
//   #/insights                                  insights
//   #/projects                                  project inventory
//   #/projects?filter=At%20risk                 inventory, filter chip applied
//   #/projects?asOf=YYYY-MM-DD                  inventory, cumulative-progress calendar open
//   #/projects/:projectId                       project profile, live
//   #/projects/:projectId?asOf=YYYY-MM-DD       project profile, historical week
//   #/projects/:projectId/progress?asOf=DATE    cumulative-progress detail
//
// HASH routes, not pushState paths: the frontend is served by
// `python -m http.server` locally and as plain static files on Vercel, and
// neither rewrites unknown paths to index.html -- a path route would hard-404
// on refresh and on every deep link. history.pushState is still used to
// *write* the hash-bearing URL so Back/Forward get real history entries.
//
// A route object is the single source of truth for what is on screen:
//   { view, projectId, asOf, filter }
// applyRouteState() derives every module-level variable from it, which is what
// makes Back restore not just the view but the project, date and filter too.
// =====================================================================

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function withQuery(path, query) {
  // URLSearchParams encodes spaces as '+', which round-trips fine but reads
  // badly in a shared link; %20 is friendlier and parses identically.
  const search = query.toString().replace(/\+/g, '%20');
  return search ? `${path}?${search}` : path;
}

function buildHash(route) {
  const query = new URLSearchParams();
  if (route.asOf) query.set('asOf', route.asOf);
  if (route.view === 'insights') return '#/insights';
  if (route.view === 'recruiting') {
    if (route.candidate) query.set('candidate', route.candidate);
    return withQuery('#/recruiting', query);
  }
  if (route.view === 'members') {
    // 'commits' and 'all' are the defaults, so they stay out of the URL.
    if (route.sort && route.sort !== 'commits') query.set('sort', route.sort);
    if (route.organization && route.organization !== 'all') query.set('org', route.organization);
    return withQuery('#/members', query);
  }
  if (route.view === 'member' && route.login) return `#/members/${encodeURIComponent(route.login)}`;
  if (route.view === 'projects') {
    // 'All projects' is the default, so it stays out of the URL.
    if (route.filter && route.filter !== 'All projects') query.set('filter', route.filter);
    return withQuery('#/projects', query);
  }
  if (route.view === 'profile' && route.projectId) return withQuery(`#/projects/${encodeURIComponent(route.projectId)}`, query);
  if (route.view === 'progress' && route.projectId) return withQuery(`#/projects/${encodeURIComponent(route.projectId)}/progress`, query);
  // Overview, and the fallback for any half-built route (e.g. a profile with
  // no project id) that has no addressable form of its own. Overview carries no
  // query of its own now that its as-of date redirects to the inventory.
  return '#/overview';
}

// Bookmarks predating the path-style routes used `#view=X&project=Y`. Map them
// onto the equivalent new route; parseRoute's caller replaces the URL with the
// modern form on arrival, so an old link upgrades itself on first use.
function legacyRoute(hash) {
  const params = new URLSearchParams(hash);
  const view = params.get('view');
  const projectId = params.get('project');
  if (projectId && (view === 'profile' || !viewLabels[view])) return { view: 'profile', projectId };
  if (viewLabels[view]) return { view };
  return null;
}

// Returns a route object, or null for anything unrecognized (the caller falls
// back to overview rather than rendering a blank view).
function parseRoute(rawHash) {
  const hash = String(rawHash || '').replace(/^#/, '');
  if (!hash || hash === '/') return { view: 'overview' };
  if (!hash.startsWith('/')) return legacyRoute(hash);

  const [pathPart, queryPart] = hash.split('?');
  const query = new URLSearchParams(queryPart || '');
  const rawAsOf = query.get('asOf');
  // A malformed date is dropped rather than honoured: every consumer of it
  // feeds it straight into an API query string.
  const asOf = rawAsOf && ISO_DATE_PATTERN.test(rawAsOf) ? rawAsOf : null;
  let segments;
  try {
    segments = pathPart.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    return null; // malformed percent-encoding
  }

  // Overview no longer renders a per-project week-signal list, so it has no
  // dated form: an as-of date is a request to see the portfolio at a date,
  // which now lives entirely on the inventory page. Old #/overview?asOf links
  // land there instead of on a page that would ignore their date.
  if (segments.length === 1 && segments[0] === 'overview') {
    return asOf ? { view: 'projects', filter: 'All projects', asOf } : { view: 'overview' };
  }
  if (segments.length === 1 && segments[0] === 'insights') return { view: 'insights' };
  if (segments.length === 1 && segments[0] === 'recruiting') return { view: 'recruiting', candidate: query.get('candidate') || null };
  if (segments[0] === 'members') {
    if (segments.length === 1) {
      const sort = query.get('sort');
      return {
        view: 'members',
        sort: MEMBER_SORT_KEYS.includes(sort) ? sort : 'commits',
        organization: query.get('org') || 'all',
      };
    }
    // A login can contain '/' only through encoding, which decodeURIComponent
    // above has already undone, so rejoin whatever the split produced.
    if (segments.length >= 2) return { view: 'member', login: segments.slice(1).join('/') };
  }
  if (segments[0] !== 'projects') return null;
  if (segments.length === 1) {
    const filter = query.get('filter');
    return { view: 'projects', filter: PROJECT_FILTERS.includes(filter) ? filter : 'All projects', asOf };
  }
  if (segments.length === 2) return { view: 'profile', projectId: segments[1], asOf };
  if (segments.length === 3 && segments[2] === 'progress') {
    // A cumulative checkpoint only exists relative to a date, so a progress
    // link without a usable one isn't addressable -- send it to the inventory,
    // where the date can be picked, rather than to an undated empty view.
    return asOf ? { view: 'progress', projectId: segments[1], asOf } : { view: 'projects' };
  }
  return null;
}

// The inverse of applyRouteState: what the current module state says the URL
// should be. buildHash reads from here rather than from the route object passed
// to goto(), so the URL reflects what was actually applied (normalized filter,
// dropped as-of date, and so on).
function routeFromState() {
  if (currentView === 'profile') return { view: 'profile', projectId: selectedProjectId, asOf: selectedProjectAsOfDate };
  if (currentView === 'progress') return { view: 'progress', projectId: selectedProgressProjectId, asOf: state.progressDate };
  if (currentView === 'projects') return { view: 'projects', filter: currentFilter, asOf: state.progressDate };
  if (currentView === 'overview') return { view: 'overview' };
  if (currentView === 'members') return { view: 'members', sort: memberSort, organization: memberOrgFilter };
  if (currentView === 'member') return { view: 'member', login: selectedMemberLogin };
  if (currentView === 'recruiting') return { view: 'recruiting', candidate: selectedRecruitingLogin };
  return { view: currentView };
}

function setProgressDate(dateStr) {
  if (state.progressDate === dateStr) return;
  state.progressRunId += 1; // orphan any in-flight fan-out requests
  state.progressDate = dateStr;
  state.progressResult = {};
  state.progressLoadedDate = null;
  state.progressError = null;
  state.progressLoading = Boolean(dateStr);
}

function applyRouteState(route) {
  currentView = route.view;
  // On an inventory route the URL is authoritative: no `?filter=` means the
  // default, so a link to plain #/projects can't inherit a filter left over
  // from wherever the user was before. Other views carry the current filter
  // through untouched so it survives a round trip to a profile and back.
  if (route.view === 'projects') currentFilter = route.filter || 'All projects';
  else if (route.filter) currentFilter = route.filter;
  if (route.view === 'profile') selectedProjectId = route.projectId;
  // Leaving the profile ends the as-of drill-down; the next profile opened is
  // live unless it too is opened from a historical row.
  selectedProjectAsOfDate = route.view === 'profile' ? (route.asOf || null) : null;
  selectedProgressProjectId = route.view === 'progress' ? route.projectId : null;
  // The members table's sort and organization live in the URL, so a link to
  // plain #/members resets them to the defaults rather than inheriting
  // whatever the previous visit left behind.
  if (route.view === 'members') {
    memberSort = MEMBER_SORT_KEYS.includes(route.sort) ? route.sort : 'commits';
    memberOrgFilter = route.organization || 'all';
  }
  selectedMemberLogin = route.view === 'member' ? route.login : null;
  selectedRecruitingLogin = route.view === 'recruiting' ? (route.candidate || null) : null;

  if (route.view === 'projects' || route.view === 'progress') setProgressDate(route.asOf || null);

  if (route.view === 'profile') {
    state.profileLoading = true;
    state.profileError = null;
  }
}

// Fires whatever fetches the route needs. Safe to call for a route whose data
// is already in memory -- each branch checks first -- which is what keeps
// Back/Forward from re-requesting (and, for progress, re-computing) snapshots
// the app already holds.
function startRouteLoads(route) {
  // The member views have their own data source, so they load regardless of
  // the portfolio snapshot's state -- checked before the guard below.
  if (route.view === 'members') {
    loadMemberAnalytics();
    return;
  }
  if (route.view === 'member') {
    if (route.login) loadMemberDetail(route.login);
    return;
  }
  if (route.view === 'recruiting') {
    loadRecruitingOverview();
    return;
  }
  // Nothing else can resolve before the portfolio snapshot lands; the
  // bootstrap at the bottom of this file re-runs this once it has.
  if (state.loading || state.error) return;
  if (route.view === 'profile') {
    if (selectedProjectId) reloadProfile();
    return;
  }
  if (route.view === 'progress') {
    const entry = selectedProgressProjectId ? state.progressResult[selectedProgressProjectId] : null;
    if (selectedProgressProjectId && state.progressDate && (!entry || entry.state !== 'done')) {
      loadProgressForProject(selectedProgressProjectId, state.progressDate);
    }
    return;
  }
  // Overview needs no fetch of its own: the stat cards count state.projects,
  // which loadLatestSnapshot already populated.
  if (route.view === 'overview') return;
  if (route.view === 'projects') {
    if (state.progressDate && state.progressLoadedDate !== state.progressDate) loadProgressAt(state.progressDate);
  }
}

// Members-view controls. The search box re-queries the server rather than
// filtering in place, so it is debounced; the selects and checkboxes fire
// immediately. Sort and organization go through the router because they are
// part of the addressable route; the rest are local view state.
let memberSearchTimer = null;

function bindMemberEvents() {
  const search = document.getElementById('member-search');
  if (search) {
    search.addEventListener('input', (event) => {
      const value = event.target.value;
      clearTimeout(memberSearchTimer);
      memberSearchTimer = setTimeout(() => {
        memberSearch = value;
        state.membersLoadedKey = null;
        loadMemberAnalytics();
      }, 250);
    });
  }
  document.getElementById('member-org')?.addEventListener('change', (event) => {
    goto({ view: 'members', sort: memberSort, organization: event.target.value });
  });
  document.getElementById('member-sort')?.addEventListener('change', (event) => {
    goto({ view: 'members', sort: event.target.value, organization: memberOrgFilter });
  });
  document.getElementById('member-include-service')?.addEventListener('change', (event) => {
    memberIncludeService = event.target.checked;
    state.membersLoadedKey = null;
    loadMemberAnalytics();
  });
  document.getElementById('member-include-unmatched')?.addEventListener('change', (event) => {
    memberIncludeUnmatched = event.target.checked;
    state.membersLoadedKey = null;
    loadMemberAnalytics();
  });
  document.getElementById('retry-members')?.addEventListener('click', () => {
    state.membersLoadedKey = null;
    loadMemberAnalytics();
  });
  document.getElementById('member-back')?.addEventListener('click', () => {
    goto({ view: 'members', sort: memberSort, organization: memberOrgFilter });
  });
  document.getElementById('retry-member-detail')?.addEventListener('click', () => {
    if (selectedMemberLogin) loadMemberDetail(selectedMemberLogin);
  });
  document.querySelectorAll('.member-row').forEach((row) => {
    const open = () => goto({ view: 'member', login: row.dataset.memberLogin });
    row.addEventListener('click', open);
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        open();
      }
    });
  });
}

function bindRecruitingEvents() {
  document.getElementById('refresh-recruiting')?.addEventListener('click', () => { state.recruitingLoadedRunId = null; loadRecruitingOverview(); });
  document.getElementById('run-recruiting-analysis')?.addEventListener('click', runRecruitingAnalysis);
  document.getElementById('retry-recruiting-audit')?.addEventListener('click', () => {
    loadRecruitingAudit(state.recruitingOverview?.run?.run_id);
  });
  document.getElementById('retry-recruiting')?.addEventListener('click', () => {
    state.recruitingLoadedRunId = null;
    loadRecruitingOverview();
  });
  document.getElementById('retry-recruiting-detail')?.addEventListener('click', () => {
    if (selectedRecruitingLogin) loadRecruitingDetail(selectedRecruitingLogin);
  });
  document.querySelectorAll('.recruiting-candidate-row').forEach((row) => {
    const open = () => goto({ view: 'recruiting', candidate: row.dataset.recruitingLogin });
    row.addEventListener('click', open);
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        open();
      }
    });
  });
  const decision = document.getElementById('recruiting-decision');
  const save = document.getElementById('save-recruiting-review');
  decision?.addEventListener('change', () => {
    if (save) save.disabled = !decision.value;
  });
  save?.addEventListener('click', saveRecruitingReview);
}

// The last hash the app itself wrote or applied. pushState/replaceState do not
// fire popstate or hashchange, so a URL write can never re-enter the router on
// its own; this is the belt-and-braces guard for the one path that does fire
// events for a URL we may have just produced (a hash edited in the address bar
// of an already-loaded page).
let lastAppliedHash = null;

function writeUrl(replace) {
  const hash = buildHash(routeFromState());
  if (hash !== location.hash) {
    // Keep pathname and search intact -- only the fragment is ours.
    const url = `${location.pathname}${location.search}${hash}`;
    if (replace) history.replaceState(null, '', url);
    else history.pushState(null, '', url);
  }
  lastAppliedHash = location.hash;
}

// The one way to change what is on screen: update state from the route, write
// the URL, render, then start the route's fetches.
function goto(route, { replace = false } = {}) {
  applyRouteState(route);
  writeUrl(replace);
  render();
  startRouteLoads(route);
}

// Back/Forward, and a hash pasted into the address bar of a loaded page.
function applyLocationRoute() {
  if (location.hash === lastAppliedHash) return;
  const route = parseRoute(location.hash);
  // Unknown or malformed routes fall back to Overview, and replace the bad
  // history entry so Back doesn't walk straight back into it.
  goto(route || { view: 'overview' }, { replace: true });
}

window.addEventListener('popstate', applyLocationRoute);
window.addEventListener('hashchange', applyLocationRoute);

// Sidebar / brand navigation. Nav clicks keep the as-of date the destination
// page already had -- the stickiness the pre-router view switcher had -- while
// the route object stays the single source of truth for what gets rendered.
function navigate(view) {
  const asOf = view === 'projects' ? state.progressDate : null;
  if (view === 'members') return goto({ view, sort: memberSort, organization: memberOrgFilter });
  if (view === 'recruiting') return goto({ view, candidate: null });
  goto({ view, asOf, filter: currentFilter });
}

function openFeedback(project = selectedProject(), warningId = null) {
  if (!project) return;
  modalFeedback = '';
  feedbackWarningId = warningId || project.evidence[0]?.id || null;
  document.getElementById('feedback-project-name').textContent = `Add context to the ${project.name} warning. Your note will be attached to this immutable snapshot.`;
  document.getElementById('feedback-note').value = '';
  document.querySelectorAll('.feedback-options button').forEach((button) => button.classList.remove('selected'));
  document.getElementById('modal-backdrop').hidden = false;
}

function closeFeedback() {
  document.getElementById('modal-backdrop').hidden = true;
}

async function saveFeedback() {
  const project = selectedProject();
  if (!project) return;
  const saveButton = document.getElementById('modal-save');
  const note = document.getElementById('feedback-note').value.trim();
  // The API requires a category; posting without one only produces a 422.
  if (!modalFeedback) {
    showToast('Choose a review category before saving.', true);
    return;
  }
  const snapshotId = snapshotMetaFor(project).snapshotId;
  if (!snapshotId) {
    showToast('This project has no snapshot to attach review context to.', true);
    return;
  }
  const payload = { snapshot_id: snapshotId, project_id: project.id, warning_id: feedbackWarningId, category: modalFeedback, note };
  saveButton.disabled = true;
  try {
    await requestJson('/feedback', { method: 'POST', body: JSON.stringify(payload) });
    closeFeedback();
    showToast('Review context recorded');
    // The note is stored server-side; refetch so the review history reflects it.
    await reloadProfile();
  } catch (error) {
    showToast(error.message || 'Review context could not be recorded.', true);
  } finally {
    saveButton.disabled = false;
  }
}

function bindViewEvents() {
  bindMemberEvents();
  bindRecruitingEvents();
  // Picking a date on Overview navigates to the inventory page's as-of view --
  // Overview itself no longer renders a per-project list for a date, so the
  // portfolio-at-a-date question is answered in exactly one place.
  document.getElementById('calendar-date-input')?.addEventListener('change', (event) => {
    if (event.target.value) goto({ view: 'projects', filter: 'All projects', asOf: event.target.value });
  });
  // Retry is the one lazy action still driven by a click; everything else
  // fires from the observer. Clearing the recorded error first is what puts
  // the row back into the 'pending' state the compute function requires.
  document.querySelectorAll('.lazy-retry').forEach((button) => button.addEventListener('click', (event) => {
    event.stopPropagation();
    const projectId = button.dataset.projectId;
    delete state.lazyErrors[projectId];
    computeLatestProjectSnapshot(projectId);
  }));
  document.getElementById('progress-date-input')?.addEventListener('change', (event) => {
    if (event.target.value) goto({ view: 'projects', filter: currentFilter, asOf: event.target.value });
  });
  document.getElementById('progress-clear')?.addEventListener('click', clearProgress);
  document.getElementById('retry-progress')?.addEventListener('click', () => { if (state.progressDate) loadProgressAt(state.progressDate); });
  document.getElementById('retry-progress-detail')?.addEventListener('click', () => {
    if (selectedProgressProjectId && state.progressDate) loadProgressForProject(selectedProgressProjectId, state.progressDate);
  });
  document.querySelectorAll('.progress-retry').forEach((button) => button.addEventListener('click', (event) => {
    event.stopPropagation();
    retryProjectProgress(button.dataset.projectId);
  }));
  document.querySelectorAll('.view-progress').forEach((button) => button.addEventListener('click', (event) => {
    event.stopPropagation();
    openProgressDetail(button.dataset.projectId);
  }));
  document.getElementById('progress-back')?.addEventListener('click', () => navigate('projects'));
  document.querySelectorAll('.view-project').forEach((button) => button.addEventListener('click', (event) => {
    event.stopPropagation();
    openProject(button.dataset.projectId);
  }));
  document.querySelectorAll('.insights-row, .project-row').forEach((row) => row.addEventListener('click', () => {
    openProject(row.dataset.projectId);
  }));
  document.getElementById('profile-back')?.addEventListener('click', () => {
    navigate('projects');
  });
  document.getElementById('profile-live')?.addEventListener('click', () => openProject(selectedProjectId, null));
  document.querySelectorAll('[data-dashboard-filter]').forEach((button) => button.addEventListener('click', () => {
    goto({ view: 'projects', filter: button.dataset.dashboardFilter, asOf: state.progressDate });
  }));
  document.querySelectorAll('[data-filter]').forEach((button) => button.addEventListener('click', (event) => {
    event.stopPropagation();
    goto({ view: 'projects', filter: button.dataset.filter, asOf: state.progressDate });
  }));
  document.getElementById('add-context')?.addEventListener('click', () => openFeedback());
  document.getElementById('confirm-review')?.addEventListener('click', () => openFeedback());
  document.getElementById('retry-latest')?.addEventListener('click', loadLatestSnapshot);
  document.getElementById('retry-profile')?.addEventListener('click', () => reloadProfile());
}

document.querySelectorAll('.nav-item[data-view]').forEach((item) => item.addEventListener('click', () => navigate(item.dataset.view)));
document.querySelector('.brand-lockup')?.addEventListener('click', () => navigate('overview'));
document.querySelectorAll('.feedback-options button').forEach((button) => button.addEventListener('click', () => {
  modalFeedback = button.dataset.feedback;
  document.querySelectorAll('.feedback-options button').forEach((option) => option.classList.toggle('selected', option === button));
}));
document.getElementById('modal-close').addEventListener('click', closeFeedback);
document.getElementById('modal-cancel').addEventListener('click', closeFeedback);
document.getElementById('modal-backdrop').addEventListener('click', (event) => { if (event.target.id === 'modal-backdrop') closeFeedback(); });
document.getElementById('modal-save').addEventListener('click', saveFeedback);
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeFeedback(); });

// Cold load. Resolve the route before the first fetch so the deep-linked view
// is what renders while the portfolio snapshot is loading, and normalize the
// URL with replaceState -- a legacy `#view=...` link, a bare '#', or garbage
// all become their canonical route without leaving a junk history entry.
const bootRoute = parseRoute(location.hash) || { view: 'overview' };
applyRouteState(bootRoute);
writeUrl(true);

loadLatestSnapshot().then(() => {
  // Members and Recruiting are independent source surfaces, so they still
  // boot if the portfolio snapshot is temporarily unavailable.
  if (state.error && !['members', 'member', 'recruiting'].includes(currentView)) return;
  // Fired after the status counts land so the page paints immediately; the
  // delivery cards fill in on the follow-up render.
  if (!state.error) loadPortfolioDelivery();
  // startRouteLoads is a deliberate no-op while state.loading is true, so the
  // route's own fetches -- the profile, its as-of snapshot, or progress --
  // start here, once the snapshot they layer on top of has landed.
  startRouteLoads(routeFromState());
});
