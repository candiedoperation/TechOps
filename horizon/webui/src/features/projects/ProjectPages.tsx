import { CountUp } from '../../components/ui/CountUp'
import { ArrowLeft, ArrowUpRight, ChartNoAxesCombined, FolderKanban, History, ListTodo, MessageSquareText, ShieldAlert, UsersRound } from 'lucide-react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import {
  projectOperations,
  type ProjectSummary,
  type ProjectMeta,
} from '../../api/contracts/projects'
import { usePublicProjectQuery } from '../../api/use-public-project-query'
import { Card } from '../../components/ui/Card'
import { TrendChart } from '../../components/ui/TrendChart'
import { QueryState } from '../../components/ui/QueryState'
import { EmptyState } from '../../components/ui/States'
import { ReadApiError } from '../../api/client'
import { shortDate } from '../../format'
import { SowTimeline } from './SowTimeline'
import './projects.css'

function readSelection(search: URLSearchParams) {
  const now = new Date()
  const season =
    search.get('season') ?? `${now.getUTCMonth() < 6 ? 'SPRING' : 'FALL'}-${now.getUTCFullYear()}`
  return { season, run: search.get('run') ?? 'current' }
}

function Freshness({ meta }: { meta: ProjectMeta }) {
  return (
    <p>
      {meta.stale ? 'Stale · Last updated' : 'Updated'}{' '}
      <time dateTime={meta.asOf}>{shortDate.format(new Date(meta.asOf))}</time>
    </p>
  )
}

function RiskBadges({ counts }: { counts: ProjectSummary['riskCounts'] }) {
  return (
    <ul className="project-badges" aria-label="Risks">
      {Object.entries(counts)
        .filter(([, count]) => count > 0)
        .map(([risk, count]) => (
          <li key={risk}>
            {risk.replaceAll('_', ' ')} {count}
          </li>
        ))}
    </ul>
  )
}

export function ProjectsPage() {
  const [search, setSearch] = useSearchParams()
  const selection = readSelection(search)
  const projects = usePublicProjectQuery(projectOperations.list(selection))
  return (
    <>
      <header className="page-intro">
        <div><h1>All projects</h1><p>Track published progress and delivery risks across the semester.</p></div>
      </header>
      <form
        className="project-season"
        key={selection.season}
        onSubmit={(event) => {
          event.preventDefault()
          const data = new FormData(event.currentTarget)
          setSearch({ season: `${data.get('seasonType')}-${data.get('year')}` })
        }}
      >
        <label className="select-label">
          Semester
          <select
            name="seasonType"
            defaultValue={selection.season.startsWith('SPRING') ? 'SPRING' : 'FALL'}
          >
            <option value="SPRING">Spring</option>
            <option value="FALL">Fall</option>
          </select>
        </label>
        <label className="select-label">
          Year
          <input
            name="year"
            type="number"
            min={2000}
            max={2200}
            required
            defaultValue={selection.season.split('-')[1]}
          />
        </label>
        <button type="submit" className="button button-secondary">
          Apply
        </button>
      </form>
      {projects.error instanceof ReadApiError && projects.error.status === 404 ? (
        <EmptyState
          title="No project publication"
          description="Choose a semester with published project progress."
        />
      ) : (
        <QueryState
          available
          data={projects.data}
          pending={projects.isPending}
          error={projects.error}
          onRefresh={() => void projects.refetch()}
          isEmpty={() => false}
        >
          {({ meta, data }) => (
            <>
              <Freshness meta={meta} />
              {data.length === 0 && (
                <EmptyState
                  title="No published projects"
                  description="No project summaries are available for this run."
                />
              )}
              <div className="published-project-list">
                {data.map((project) => (
                  <Card key={project.projectPk} title={project.friendlyName} icon={FolderKanban} className="project-card">
                    {project.hasSow ? (
                      <>
                        <p>
                          {project.percentComplete}% complete · {project.tasksOverdue} overdue
                        </p>
                        <progress
                          aria-label={`${project.friendlyName} completion`}
                          max={100}
                          value={project.percentComplete}
                        />
                      </>
                    ) : (
                      <p>No SOW yet</p>
                    )}
                    <RiskBadges counts={project.riskCounts} />
                    <Link
                      className="button button-secondary project-open"
                      to={{
                        pathname: `/projects/${encodeURIComponent(project.projectPk)}`,
                        search: new URLSearchParams({
                          season: selection.season,
                          run: meta.runId,
                        }).toString(),
                      }}
                      aria-label={`View ${project.friendlyName}`}
                    >
                      View project <ArrowUpRight size={14} aria-hidden="true" />
                    </Link>
                  </Card>
                ))}
              </div>
            </>
          )}
        </QueryState>
      )}
    </>
  )
}

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
                          <dd><CountUp value={value} />{label === 'Complete' && '%'}</dd>
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
