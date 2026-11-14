import { array, boolean, date, nullable, number, object, oneOf, string } from './parse'

const statuses = ['ranked', 'unranked', 'insufficient_data', 'group_too_small'] as const

export function parseMember(value: unknown) {
  const member = object(value)
  return {
    userPk: string(member.userPk),
    name: string(member.name),
    role: oneOf(member.role, ['engineer', 'tech_lead']),
    projectPk: string(member.projectPk),
    projectName: string(member.projectName),
  }
}

function parseOverall(value: unknown) {
  const overall = object(value)
  return {
    score: nullable(number)(overall.score),
    rank: nullable(number)(overall.rank),
    rankedInGroup: number(overall.rankedInGroup),
    comparisonGroupLabel: string(overall.comparisonGroupLabel),
    coverage: number(overall.coverage),
    status: oneOf(overall.status, statuses),
  }
}

function parseEvidence(value: unknown) {
  const evidence = object(value)
  const type = oneOf(evidence.type, ['pr', 'sow_task'])
  return type === 'pr'
    ? { type, number: number(evidence.number), url: string(evidence.url) }
    : { type, taskKey: string(evidence.taskKey), projectPk: nullable(string)(evidence.projectPk) }
}

export type MemberEvidence = ReturnType<typeof parseEvidence>

function parseMetric(value: unknown) {
  const metric = object(value)
  return {
    label: string(metric.label),
    unit: nullable(string)(metric.unit),
    rawValue: nullable(number)(metric.rawValue),
    percentile: nullable(number)(metric.percentile),
    missingReason: nullable(string)(metric.missingReason),
    evidence: array(metric.evidence ?? [], parseEvidence),
  }
}

function parseBucket(value: unknown) {
  const bucket = object(value)
  return {
    label: string(bucket.label),
    weight: number(bucket.weight),
    score: nullable(number)(bucket.score),
    note: nullable(string)(bucket.note),
    metrics: array(bucket.metrics, parseMetric),
  }
}

function parseHistory(value: unknown) {
  const point = object(value)
  return {
    runId: string(point.runId),
    asOf: date(point.asOf),
    score: nullable(number)(point.score),
    rank: nullable(number)(point.rank),
  }
}

function parseExplanation(value: unknown) {
  const explanation = object(value)
  return {
    text: string(explanation.text),
    generated: boolean(explanation.generated),
    dataGaps: array(explanation.dataGaps, string),
  }
}

function parseDocument(value: unknown) {
  const doc = object(value)
  return {
    member: parseMember(doc.member),
    overall: parseOverall(doc.overall),
    explanation: nullable(parseExplanation)(doc.explanation),
    buckets: array(doc.buckets, parseBucket),
    history: array(doc.history, parseHistory),
  }
}

export type MemberDocument = ReturnType<typeof parseDocument>

// Existing T6.2 member rows lack the T4.5 document. Use their persisted fields
// until the Track 4 adapter can supply the document directly.
function parseLegacyRow(value: unknown, history: unknown): MemberDocument {
  const row = object(value)
  const ranking = object(row.ranking)
  const member = parseMember(ranking)
  const scores = array(ranking.buckets, object)
  const metrics = array(row.metrics, (value) => {
    const metric = object(value)
    return parseMetric({ ...metric, label: string(metric.metricKey).replaceAll('_', ' ') })
  })
  const explanation = array(row.explanations, object)[0]
  return {
    member,
    overall: parseOverall({
      ...ranking,
      score: ranking.overallScore,
      rank: ranking.rankInGroup,
      comparisonGroupLabel:
        ranking.comparisonGroupLabel ??
        (member.role === 'engineer' ? member.projectName : 'AppDev'),
    }),
    explanation: explanation
      ? parseExplanation({ ...explanation, generated: true, dataGaps: [] })
      : null,
    buckets: [
      ...scores.map((bucket) =>
        parseBucket({
          ...bucket,
          label: string(bucket.bucketKey).replaceAll('_', ' '),
          metrics: [],
        }),
      ),
      ...(metrics.length
        ? [{ label: 'Published metrics', weight: 0, score: null, note: null, metrics }]
        : []),
    ],
    history: array(history, object)
      .filter((point) => point.projectPk === member.projectPk && point.role === member.role)
      .map((point) =>
        parseHistory({
          ...point,
          runId: point.rankingRunId,
          score: point.overallScore,
          rank: point.rankInGroup,
        }),
      ),
  }
}

export function memberOperation(userPk: string, parameters: { season: string; run: string }) {
  return {
    path: `/api/v1/rankings/members/${encodeURIComponent(userPk)}?${new URLSearchParams(parameters)}`,
    parse: (value: unknown) => {
      const result = object(value)
      return array(result.items, (item) => {
        const row = object(item)
        return row.document ? parseDocument(row.document) : parseLegacyRow(row, result.history)
      })
    },
  }
}
