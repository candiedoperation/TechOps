import { CountUp } from '../../components/ui/CountUp'
import {
  ArrowLeft,
  ChartNoAxesCombined,
  History,
  ListTodo,
  MessageSquareText,
  ShieldAlert,
  UsersRound,
} from 'lucide-react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { projectOperations } from '../../api/contracts/projects'
import { usePublicProjectQuery } from '../../api/use-public-project-query'
import { Card } from '../../components/ui/Card'
import { lazy, Suspense } from 'react'
import { Freshness } from './ProjectPublication'
import { readSelection } from './project-selection'
const TrendChart = lazy(() =>
  import('../../components/ui/TrendChart').then((module) => ({ default: module.TrendChart })),
)
import { QueryState } from '../../components/ui/QueryState'
import { EmptyState } from '../../components/ui/States'
import { ReadApiError } from '../../api/client'
import { shortDate } from '../../format'
import { SowTimeline } from './SowTimeline'
import './projects.css'

const series = [
  ['PRs merged per week', 'prsMerged', ''],
  ['Median time to first review', 'medianFirstReviewHours', ' h'],
  ['Median open PR age', 'medianOpenPrAgeHours', ' h'],
] as const

function ProjectPublication({
  projectPk,
  selection,
}: {
  projectPk: string
  selection: { season: string; run: string }
}) {
  const project = usePublicProjectQuery(projectOperations.detail(projectPk, selection))
  // Resolve current once through the detail endpoint before loading the matching timeline.
  const timeline = usePublicProjectQuery(
    projectOperations.timeline(projectPk, {
      ...selection,
      run: project.data?.meta.runId ?? selection.run,
    }),
    Boolean(project.data),
  )
  const history = usePublicProjectQuery(
    projectOperations.history(projectPk, selection.season),
    Boolean(project.data),
  )

  return (
    <>
      <Link className="portal-back text-button" to={`/projects?${new URLSearchParams(selection)}`}>
        <ArrowLeft size={15} aria-hidden="true" /> Back to projects
      </Link>
      {project.error instanceof ReadApiError && project.error.status === 404 ? (
        <EmptyState
          title="Project unavailable"
          description="No project was published for this selection."
        />
      ) : (
        <QueryState
          available
          data={project.data}
          pending={project.isPending}
          error={project.error}
          onRefresh={() => void project.refetch()}
          isEmpty={() => false}
        >
          {({ meta, data: { summary, detail } }) => (
            <>
              <header className="page-intro">
                <div>
                  <h1>{summary.friendlyName}</h1>
                  <Freshness meta={meta} />
                  <p>
                    {shortDate.format(new Date(summary.windowStart))} –{' '}
                    {shortDate.format(new Date(summary.windowEnd))}
                  </p>
                </div>
              </header>
              <div className="published-project-detail">
                <div className="project-main">
                  <Card title="Project progress" icon={ListTodo} tone="blue">
                    <dl className="project-totals">
                      {Object.entries({
                        Tasks: summary.tasksTotal,
                        Due: summary.tasksDue,
                        Done: summary.tasksDone,
                        Partial: summary.tasksPartial,
                        Overdue: summary.tasksOverdue,
                        Complete: summary.percentComplete,
                      }).map(([label, value]) => (
                        <div key={label}>
                          <dt>{label}</dt>
                          <dd>
                            <CountUp value={value} />
                            {label === 'Complete' && '%'}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </Card>
                  <Card title="Risk flags" icon={ShieldAlert} tone="amber">
                    {detail.riskFlags.length ? (
                      <ul>
                        {detail.riskFlags.map((risk) => (
                          <li key={risk.label}>
                            <strong>{risk.label}</strong> · {risk.severity}
                            {risk.description && <p>{risk.description}</p>}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p>No published risk flags.</p>
                    )}
                  </Card>
                  <Card title="Weekly engineering activity" icon={ChartNoAxesCombined} tone="blue">
                    <Suspense fallback={<div className="chart-placeholder" aria-hidden="true" />}>
                      {series.map(([title, key, unit]) => (
                        <TrendChart
                          key={key}
                          title={title}
                          unit={unit}
                          bars={key === 'prsMerged'}
                          points={detail.metrics.map((week) => ({
                            id: week.week,
                            at: week.week,
                            value: week[key],
                          }))}
                        />
                      ))}
                    </Suspense>
                  </Card>
                  <Card title="Ownership" icon={UsersRound} tone="green">
                    {Object.keys(detail.ownership).length ? (
                      <dl className="project-totals">
                        {Object.entries(detail.ownership).map(([key, value]) => (
                          <div key={key}>
                            <dt>{key.replaceAll('_', ' ')}</dt>
                            <dd>{value ?? 'Unavailable'}</dd>
                          </div>
                        ))}
                      </dl>
                    ) : (
                      <p>No published ownership metrics.</p>
                    )}
                  </Card>
                  <Card title="Findings" icon={MessageSquareText} tone="amber">
                    {detail.findings.length ? (
                      <ul>
                        {detail.findings.map((finding) => (
                          <li key={finding.title}>
                            <strong>{finding.title}</strong>
                            <p>{finding.description}</p>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p>No published findings.</p>
                    )}
                  </Card>
                  <Card title="Publication history" icon={History} tone="green">
                    <QueryState
                      available
                      data={history.data}
                      pending={history.isPending}
                      error={history.error}
                      onRefresh={() => void history.refetch()}
                      isEmpty={() => false}
                    >
                      {(points) => (
                        <Suspense
                          fallback={<div className="chart-placeholder" aria-hidden="true" />}
                        >
                          <TrendChart
                            title="SOW completion by run"
                            maximum={100}
                            unit="%"
                            points={points.map((point) => ({
                              id: point.runId,
                              at: point.asOf,
                              value: point.percentComplete,
                            }))}
                          />
                        </Suspense>
                      )}
                    </QueryState>
                  </Card>
                </div>
                <aside className="project-rail" aria-label="SOW timeline">
                  <QueryState
                    available
                    data={timeline.data}
                    pending={timeline.isPending}
                    error={timeline.error}
                    onRefresh={() => void timeline.refetch()}
                    isEmpty={() => false}
                  >
                    {({ data }) => <SowTimeline document={data} projectPk={projectPk} />}
                  </QueryState>
                </aside>
              </div>
            </>
          )}
        </QueryState>
      )}
    </>
  )
}

export function ProjectPage() {
  const { projectPk = '' } = useParams()
  const [search] = useSearchParams()
  return <ProjectPublication projectPk={projectPk} selection={readSelection(search)} />
}
