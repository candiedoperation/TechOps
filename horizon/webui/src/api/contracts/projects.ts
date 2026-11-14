import { array, boolean, date, nullable, number, object, oneOf, string } from './parse'

const path = '/api/v1/projects'
type Selection = { season: string; run: string }

function parseCounts(value: unknown) {
  return Object.fromEntries(
    Object.entries(object(value)).map(([key, value]) => [key, number(value)]),
  )
}

function parseMeta(value: unknown) {
  const meta = object(value)
  return { runId: string(meta.runId), asOf: date(meta.asOf), stale: boolean(meta.stale) }
}

function publication<T>(parse: (value: unknown) => T) {
  return (value: unknown) => {
    const publication = object(value)
    return { meta: parseMeta(publication.meta), data: parse(publication.data) }
  }
}

function parseSummary(value: unknown) {
  const summary = object(value)
  return {
    projectPk: string(summary.projectPk),
    friendlyName: string(summary.friendlyName),
    windowStart: date(summary.windowStart),
    windowEnd: date(summary.windowEnd),
    hasSow: boolean(summary.hasSow),
    tasksTotal: number(summary.tasksTotal),
    tasksDue: number(summary.tasksDue),
    tasksDone: number(summary.tasksDone),
    tasksPartial: number(summary.tasksPartial),
    tasksOverdue: number(summary.tasksOverdue),
    percentComplete: number(summary.percentComplete),
    riskCounts: parseCounts(summary.riskCounts),
  }
}

export type ProjectSummary = ReturnType<typeof parseSummary>
export type ProjectMeta = ReturnType<typeof parseMeta>

function parseMetric(value: unknown) {
  const metric = object(value)
  return {
    week: date(metric.week),
    prsMerged: nullable(number)(metric.prsMerged),
    medianFirstReviewHours: nullable(number)(metric.medianFirstReviewHours),
    medianOpenPrAgeHours: nullable(number)(metric.medianOpenPrAgeHours),
  }
}

function parseRisk(value: unknown) {
  const risk = object(value)
  return {
    label: string(risk.label),
    severity: string(risk.severity),
    description: nullable(string)(risk.description),
  }
}

function parseFinding(value: unknown) {
  const finding = object(value)
  return { title: string(finding.title), description: string(finding.description) }
}

function parseDetail(value: unknown) {
  const result = object(value)
  const detail = object(result.detail)
  return {
    summary: parseSummary(result.summary),
    detail: {
      metrics: array(detail.metrics, parseMetric),
      riskFlags: array(detail.riskFlags, parseRisk),
      ownership: Object.fromEntries(
        Object.entries(object(detail.ownership)).map(([key, value]) => [
          key,
          nullable(number)(value),
        ]),
      ),
      findings: array(detail.findings, parseFinding),
    },
  }
}

function parseOverride(value: unknown) {
  const override = object(value)
  return {
    status: string(override.status),
    reason: nullable(string)(override.reason),
    setAt: nullable(date)(override.setAt),
  }
}

function parseTask(value: unknown) {
  const task = object(value)
  return {
    taskKey: string(task.taskKey),
    title: string(task.title),
    timelineStatus: oneOf(task.timelineStatus, ['done', 'in_progress', 'not_started', 'overdue']),
    dueDate: nullable(date)(task.dueDate),
    owners: array(task.owners, (owner) => string(object(owner).name)),
    description: nullable(string)(task.description),
    acceptanceCriteria: array(task.acceptanceCriteria ?? [], string),
    sourceRef: nullable(string)(task.sourceRef),
    matchedPrs: array(task.matchedPrs ?? [], (value) => {
      const pr = object(value)
      return {
        number: number(pr.number),
        url: nullable(string)(pr.url),
        confidence: number(pr.confidence),
        reason: string(pr.reason),
      }
    }),
    override: nullable(parseOverride)(task.override),
    pendingOverride: nullable(parseOverride)(task.pendingOverride),
  }
}

export type SowTask = ReturnType<typeof parseTask>

function parseTimeline(value: unknown) {
  const document = object(value)
  const sow = nullable(object)(document.sow)
  if (!sow) return null
  const progress = object(document.progress)
  return {
    title: nullable(string)(sow.title),
    progress: {
      percentComplete: number(progress.percentComplete),
      done: number(progress.done),
      total: number(progress.total),
      overdue: number(progress.overdue),
    },
    tasks: array(document.tasks, parseTask),
  }
}

export type SowTimelineDocument = NonNullable<ReturnType<typeof parseTimeline>>

function parseHistory(value: unknown) {
  const point = object(value)
  return {
    runId: string(point.runId),
    asOf: date(point.asOf),
    percentComplete: number(point.percentComplete),
    tasksOverdue: number(point.tasksOverdue),
    riskCounts: parseCounts(point.riskCounts),
  }
}

export const projectOperations = {
  list: (selection: Selection) => ({
    path: `${path}?${new URLSearchParams(selection)}`,
    parse: publication((value) => array(value, parseSummary)),
  }),
  detail: (projectPk: string, selection: Selection) => ({
    path: `${path}/${encodeURIComponent(projectPk)}?${new URLSearchParams(selection)}`,
    parse: publication(parseDetail),
  }),
  timeline: (projectPk: string, selection: Selection) => ({
    path: `${path}/${encodeURIComponent(projectPk)}/sow-timeline?${new URLSearchParams(selection)}`,
    parse: publication(parseTimeline),
  }),
  history: (projectPk: string, season: string) => ({
    path: `${path}/${encodeURIComponent(projectPk)}/history?${new URLSearchParams({ season })}`,
    parse: (value: unknown) => array(value, parseHistory),
  }),
}
