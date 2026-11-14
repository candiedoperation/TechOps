import { useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../../auth/context'
import { memberPreviewKey, type MemberPreview } from '../../api/member-preview'
import { Award, ArrowLeft, BookOpen, ChartNoAxesCombined, CircleGauge } from 'lucide-react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import {
  memberOperation,
  type MemberDocument,
  type MemberEvidence,
} from '../../api/contracts/member'
import { externalHttpUrl, taskAnchor } from '../../api/links'
import { useHorizonReadQuery } from '../../api/use-horizon-query'
import { Card } from '../../components/ui/Card'
import { QueryState } from '../../components/ui/QueryState'
import { ScoreBar } from '../../components/ui/ScoreBar'
import { lazy, Suspense, type ReactNode } from 'react'
import { explainMissing } from '../../copy/missingReasons'
import { percent } from '../../format'
import { rankingStatus } from './display'
import { rubricV1 } from '../../rubric'
import { formatMetric } from './formatMetric'
import './rankings.css'

const TrendChart = lazy(() =>
  import('../../components/ui/TrendChart').then((module) => ({ default: module.TrendChart })),
)

function EvidenceLink({
  evidence,
  season,
  projectPk,
}: {
  evidence: MemberEvidence
  season: string
  projectPk: string
}) {
  if (evidence.type === 'pr') {
    const href = externalHttpUrl(evidence.url)
    return href ? <a href={href}>PR #{evidence.number}</a> : <span>PR #{evidence.number}</span>
  }
  const key = evidence.projectPk ?? projectPk
  return (
    <Link
      to={{
        pathname: `/projects/${encodeURIComponent(key)}`,
        search: new URLSearchParams({ season }).toString(),
        hash: taskAnchor(evidence.taskKey),
      }}
    >
      {evidence.taskKey}
    </Link>
  )
}

function MemberProfile({
  document,
  season,
  loading = false,
  projectSwitcher,
}: {
  document: MemberDocument
  season: string
  loading?: boolean
  projectSwitcher?: ReactNode
}) {
  const { member, overall, explanation, buckets, history } = document
  const engineer = member.role === 'engineer'
  const ranked = overall.status === 'ranked'
  return (
    <div className="member-profile">
      <div className="page-intro">
        <div>
          <h1 className="member-transition-name">{member.name}</h1>
          <p>
            {engineer ? 'Engineer' : 'Tech lead'} · {member.projectName}
          </p>
        </div>
      </div>
      <Card title="Overall ranking" icon={Award} tone="amber" className="member-overall">
        {ranked && (
          <div className="member-transition-score">
            <ScoreBar animate value={overall.score} maximum={100} label="Overall score" />
          </div>
        )}
        {ranked && overall.rank !== null && (
          <p>
            {overall.rank} of {overall.rankedInGroup} {engineer ? 'engineers on' : 'tech leads in'}{' '}
            {overall.comparisonGroupLabel}
          </p>
        )}
        <p>Coverage {percent.format(overall.coverage)}</p>
        <span
          className="ranking-badge"
          data-status={overall.status}
          title={rankingStatus[overall.status].reason}
        >
          {rankingStatus[overall.status].label}
        </span>
        {!ranked && <p>{rankingStatus[overall.status].reason}</p>}
      </Card>
      {projectSwitcher}
      {loading && (
        <div className="member-pending" role="status">
          Loading member evidence…
        </div>
      )}
      {explanation && (
        <Card
          icon={BookOpen}
          title={
            explanation.generated
              ? 'Generated explanation of the numbers below'
              : 'Summary (automatic)'
          }
        >
          <p>{explanation.text}</p>
          {explanation.dataGaps.length > 0 && (
            <>
              <h3>Data gaps</h3>
              <ul>
                {explanation.dataGaps.map((gap) => (
                  <li key={gap}>{explainMissing(gap)}</li>
                ))}
              </ul>
            </>
          )}
        </Card>
      )}
      {buckets.map((bucket) => (
        <Card key={bucket.label} title={bucket.label} icon={CircleGauge}>
          <div className="ranking-publication">
            {bucket.weight > 0 && <span>Weight {percent.format(bucket.weight)}</span>}
            {ranked && (
              <ScoreBar label={`${bucket.label} score`} value={bucket.score} maximum={100} />
            )}
          </div>
          {bucket.note && <p>{bucket.note}</p>}
          <dl className="member-metrics">
            {bucket.metrics.map((metric) => (
              <div key={metric.label}>
                <dt>{metric.label}</dt>
                <dd>
                  {metric.rawValue === null
                    ? 'Unavailable'
                    : formatMetric(metric.rawValue, metric.unit)}
                </dd>
                {metric.percentile !== null && <dd>Percentile {metric.percentile}</dd>}
                {metric.missingReason && <dd>{explainMissing(metric.missingReason)}</dd>}
                {metric.evidence.length > 0 && (
                  <dd>
                    <ul aria-label={`${metric.label} evidence`}>
                      {metric.evidence.map((evidence) => (
                        <li key={JSON.stringify(evidence)}>
                          <EvidenceLink
                            evidence={evidence}
                            season={season}
                            projectPk={member.projectPk}
                          />
                        </li>
                      ))}
                    </ul>
                  </dd>
                )}
              </div>
            ))}
          </dl>
        </Card>
      ))}
      {!loading && (
        <Card title="Semester trend" icon={ChartNoAxesCombined} tone="green">
          <Suspense fallback={<div className="chart-placeholder" aria-hidden="true" />}>
            <TrendChart
              title="Score by run"
              maximum={100}
              points={history.map((point) => ({
                id: point.runId,
                at: point.asOf,
                value: point.score,
              }))}
            />
            <TrendChart
              title="Rank by run"
              rank
              points={history.map((point) => ({
                id: point.runId,
                at: point.asOf,
                value: point.rank,
              }))}
            />
          </Suspense>
        </Card>
      )}
      <button type="button" className="button button-secondary" disabled>
        Flag for calibration
      </button>
    </div>
  )
}

function previewDocument(row: MemberPreview): MemberDocument {
  return {
    member: row,
    overall: {
      score: row.overallScore,
      rank: row.rankInGroup,
      rankedInGroup: row.rankedInGroup,
      comparisonGroupLabel: row.comparisonGroupLabel ?? row.projectName,
      coverage: row.coverage,
      status: row.status,
    },
    explanation: null,
    history: [],
    buckets: row.buckets.map((bucket) => ({
      label:
        bucket.label ?? rubricV1[row.role][bucket.key]?.label ?? bucket.key.replaceAll('_', ' '),
      score: bucket.score,
      weight: bucket.weight,
      note: null,
      metrics: [],
    })),
  }
}

export function MemberPage() {
  const queries = useQueryClient()
  const { state } = useAuth()
  const { userPk = '' } = useParams()
  const [search, setSearch] = useSearchParams()
  const season = search.get('season') ?? ''
  const run = search.get('run') ?? 'current'
  const projectPk = search.get('projectPk')
  const details = useHorizonReadQuery({
    feature: 'ranking-member',
    parameters: { userPk, season, run },
    operation: memberOperation(userPk, { season, run }),
    available: Boolean(season && userPk),
  })
  const preview =
    details.available &&
    details.isPending &&
    !details.error &&
    state.status === 'authenticated' &&
    state.session.isExec &&
    projectPk
      ? queries.getQueryData<MemberPreview>(
          memberPreviewKey(state.session.subject, userPk, season, run),
        )
      : undefined
  const seeded = preview && preview.projectPk === projectPk ? previewDocument(preview) : undefined
  const list = new URLSearchParams({ ...(season ? { season } : {}), run })
  return (
    <>
      <Link className="portal-back text-button" to={`/rankings?${list}`}>
        <ArrowLeft size={15} aria-hidden="true" /> Back to rankings
      </Link>
      {season ? (
        <QueryState
          available={details.available}
          data={details.data ?? (seeded ? [seeded] : undefined)}
          error={details.error}
          pending={details.isPending}
          onRefresh={() => void details.refetch()}
          isEmpty={(documents) => documents.length === 0}
        >
          {(documents) => {
            const selected =
              documents.find((doc) => doc.member.projectPk === projectPk) ?? documents[0]!
            return (
              <MemberProfile
                document={selected}
                loading={Boolean(seeded)}
                season={season}
                projectSwitcher={
                  documents.length > 1 && (
                    <label className="select-label member-project">
                      Project
                      <select
                        value={selected.member.projectPk}
                        onChange={(event) =>
                          setSearch({
                            season,
                            run,
                            projectPk: event.target.value,
                          })
                        }
                      >
                        {documents.map(({ member }) => (
                          <option key={member.projectPk} value={member.projectPk}>
                            {member.projectName}
                          </option>
                        ))}
                      </select>
                    </label>
                  )
                }
              />
            )
          }}
        </QueryState>
      ) : (
        <p>Select a semester on the rankings page to open a member’s results.</p>
      )}
    </>
  )
}
