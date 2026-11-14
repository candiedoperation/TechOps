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
import { TrendChart } from '../../components/ui/TrendChart'
import { explainMissing } from '../../copy/missingReasons'
import { percent } from '../../format'
import { rankingStatus } from './display'
import { formatMetric } from './formatMetric'
import './rankings.css'

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

function MemberProfile({ document, season }: { document: MemberDocument; season: string }) {
  const { member, overall, explanation, buckets, history } = document
  const engineer = member.role === 'engineer'
  const ranked = overall.status === 'ranked'
  return (
    <div className="member-profile">
      <div className="page-intro">
        <div>
          <h1>{member.name}</h1>
          <p>
            {engineer ? 'Engineer' : 'Tech lead'} · {member.projectName}
          </p>
        </div>
      </div>
      <Card title="Overall ranking">
        {ranked && <ScoreBar value={overall.score} maximum={100} label="Overall score" />}
        {ranked && overall.rank !== null && (
          <p>
            {overall.rank} of {overall.rankedInGroup} {engineer ? 'engineers on' : 'tech leads in'}{' '}
            {overall.comparisonGroupLabel}
          </p>
        )}
        <p>Coverage {percent.format(overall.coverage)}</p>
        <span className="ranking-badge" title={rankingStatus[overall.status].reason}>
          {rankingStatus[overall.status].label}
        </span>
        {!ranked && <p>{rankingStatus[overall.status].reason}</p>}
      </Card>
      {explanation && (
        <Card
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
        <Card key={bucket.label} title={bucket.label}>
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
      <Card title="Semester trend">
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
      </Card>
      <button type="button" className="button button-secondary" disabled>
        Flag for calibration
      </button>
    </div>
  )
}

export function MemberPage() {
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
  const list = new URLSearchParams({ ...(season ? { season } : {}), run })
  return (
    <>
      <Link className="text-button" to={`/rankings?${list}`}>
        Back to rankings
      </Link>
      {season ? (
        <QueryState
          available={details.available}
          data={details.data}
          error={details.error}
          pending={details.isPending}
          onRefresh={() => void details.refetch()}
          isEmpty={(documents) => documents.length === 0}
        >
          {(documents) => {
            const selected =
              documents.find((doc) => doc.member.projectPk === projectPk) ?? documents[0]!
            return (
              <>
                {documents.length > 1 && (
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
                )}
                <MemberProfile document={selected} season={season} />
              </>
            )
          }}
        </QueryState>
      ) : (
        <p>Select a semester on the rankings page to open a member’s results.</p>
      )}
    </>
  )
}
