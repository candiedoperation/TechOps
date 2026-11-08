import { useContext, useState, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Card } from '../../components/ui/Card'
import { DataTable } from '../../components/ui/DataTable'
import { QueryState } from '../../components/ui/QueryState'
import { EmptyState } from '../../components/ui/States'
import type { PortfolioProject, PortfolioStatus } from '../../api/contracts/provisional/portfolio'
import { PortfolioContext, usePortfolio } from './context'

const labels = {
  all: 'All',
  attention: 'Needs Attention',
  clear: 'Clear',
  watch: 'Watch',
  risk: 'At Risk',
  insufficient: 'Insufficient Data',
}
type Filter = keyof typeof labels
const matches = (project: PortfolioProject, filter: string) =>
  filter === 'all' ||
  project.status === filter ||
  (filter === 'attention' && ['watch', 'risk'].includes(project.status))
const statuses: PortfolioStatus[] = ['clear', 'watch', 'risk', 'insufficient']
export function StatusBadge({ status }: { status: PortfolioStatus }) {
  return <span className={`portfolio-status status-${status}`}>{labels[status]}</span>
}

export function SnapshotControl() {
  const portfolio = useContext(PortfolioContext)
  const snapshots = portfolio?.query.data?.snapshots ?? []
  return (
    <label className="snapshot-control">
      View portfolio as of
      <select
        aria-label="Portfolio snapshot"
        disabled={!snapshots.length}
        value={portfolio?.snapshotId ?? ''}
        onChange={(event) => portfolio?.selectSnapshot(event.target.value)}
      >
        {snapshots.length ? (
          snapshots.map((snapshot) => (
            <option key={snapshot.id} value={snapshot.id}>
              {snapshot.label}
            </option>
          ))
        ) : (
          <option value="">Awaiting published snapshots</option>
        )}
      </select>
    </label>
  )
}
function Intro({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string
  title: string
  children: ReactNode
}) {
  return (
    <div className="portfolio-intro">
      <p className="eyebrow">{eyebrow}</p>
      <h1>{title}</h1>
      <p>{children}</p>
    </div>
  )
}
function PortfolioState({ children }: { children: ReactNode }) {
  const { query } = usePortfolio()
  return (
    <QueryState
      available={query.available}
      data={query.data}
      pending={query.isPending}
      error={query.error}
      freshness={query.data?.publication}
      refreshing={query.isFetching}
      onRefresh={() => {
        void query.refetch()
      }}
      isEmpty={(value) => !value.projects.length}
    >
      {() => children}
    </QueryState>
  )
}
function Filters({ value, onChange }: { value: string; onChange: (value: Filter) => void }) {
  return (
    <div className="filter-chips" role="group" aria-label="Project status filters">
      {(Object.keys(labels) as Filter[]).map((filter) => (
        <button
          key={filter}
          className="filter-chip"
          aria-pressed={value === filter}
          onClick={() => onChange(filter)}
        >
          {labels[filter]}
        </button>
      ))}
    </div>
  )
}

export function PortfolioDashboard() {
  const { query } = usePortfolio()
  const data = query.data?.publication.state === 'missing' ? undefined : query.data
  const projects = data?.projects ?? []
  const summary: { label: string; filter: Filter; count: number }[] = [
    { label: 'Active Projects', filter: 'all', count: projects.length },
    {
      label: 'Needs Attention',
      filter: 'attention',
      count: projects.filter((project) => matches(project, 'attention')).length,
    },
    {
      label: 'Clear',
      filter: 'clear',
      count: projects.filter((project) => project.status === 'clear').length,
    },
    {
      label: 'Insufficient Data',
      filter: 'insufficient',
      count: projects.filter((project) => project.status === 'insufficient').length,
    },
  ]
  const companies = [...new Set(projects.map((project) => project.companyId))]
  return (
    <>
      <Intro eyebrow="WEEKLY PORTFOLIO REVIEW" title="Your Horizon, at a glance.">
        A shared snapshot of project health, activity, and portfolio risk.
      </Intro>
      {!data && (
        <p className="portfolio-unavailable">
          No rankings, project scores, or evidence have been loaded.
        </p>
      )}
      <div className="portfolio-summary">
        {summary.map((item) => (
          <Link key={item.filter} to={`/projects?status=${item.filter}`} className="summary-tile">
            <span>{item.label}</span>
            <strong>{data ? item.count : '—'}</strong>
            <small>
              {data
                ? 'Across available companies · View projects →'
                : 'Awaiting authorized publications'}
            </small>
          </Link>
        ))}
      </div>
      <div className="portfolio-dashboard-grid">
        <Card
          title="Portfolio health"
          description="Companies grouped by published project status."
          action={
            <Link className="button button-secondary" to="/projects">
              View all projects →
            </Link>
          }
        >
          <PortfolioState>
            <div className="company-overview-grid">
              {companies.map((id) => {
                const group = projects.filter((project) => project.companyId === id)
                const first = group[0]!
                return (
                  <Link
                    key={id}
                    to={`/projects?company=${encodeURIComponent(id)}`}
                    className="company-overview"
                  >
                    <div>
                      <strong>{first.company}</strong>
                      <small>
                        {group.length} project{group.length === 1 ? '' : 's'}
                      </small>
                    </div>
                    <div className="filter-chips">
                      {[...new Set(group.map((project) => project.status))].map((status) => (
                        <StatusBadge key={status} status={status} />
                      ))}
                    </div>
                    <p>{first.summary}</p>
                  </Link>
                )
              })}
            </div>
          </PortfolioState>
        </Card>
        <div className="portfolio-side-stack">
          <Card
            title="Activity snapshot"
            description="Available read metrics, never inferred from a status."
          >
            <div className="activity-grid">
              {(
                [
                  ['Open PRs', 'openPrs'],
                  ['Oldest PR', 'oldestPrDays'],
                  ['Branches ahead', 'branchesAhead'],
                  ['Open issues', 'openIssues'],
                ] as const
              ).map(([label, key]) => {
                const values = projects.map((project) => project[key])
                const known = values.filter((value): value is number => value !== null)
                const available = data && known.length > 0
                const value = available
                  ? key === 'oldestPrDays'
                    ? Math.max(...known)
                    : known.reduce((a, b) => a + b, 0)
                  : null
                return (
                  <div key={key}>
                    <span>{label}</span>
                    <strong>
                      {value === null ? '—' : `${value}${key === 'oldestPrDays' ? 'd' : ''}`}
                    </strong>
                    {value !== null && (
                      <small>
                        {known.length} / {projects.length} projects reporting; known values only
                      </small>
                    )}
                  </div>
                )
              })}
            </div>
          </Card>
          <Card title="Status breakdown">
            <div className="status-breakdown">
              {statuses.map((status) => (
                <div key={status}>
                  <StatusBadge status={status} />
                  <strong>
                    {data ? projects.filter((project) => project.status === status).length : '—'}
                  </strong>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>
      <Card
        title="What Changed This Week"
        description="Published snapshot notes; not an automated assessment of real projects."
      >
        <div className="weekly-changes">
          {data?.changes.length ? (
            data.changes.map((change) => <p key={change}>{change}</p>)
          ) : (
            <p>Change summaries are unavailable until reviewed publications are connected.</p>
          )}
        </div>
      </Card>
    </>
  )
}

export function PortfolioProjects() {
  const { query, snapshotId, selectSnapshot } = usePortfolio()
  const [search, setSearch] = useState('')
  const [params, setParams] = useSearchParams()
  const requestedFilter = params.get('status') ?? 'all'
  const filter = Object.hasOwn(labels, requestedFilter) ? requestedFilter : 'all'
  const [selectedProject, setSelectedProject] = useState('')
  const [tab, setTab] = useState('Overview')
  const projects = query.data?.publication.state === 'missing' ? [] : (query.data?.projects ?? [])
  const visible = projects.filter(
    (project) =>
      matches(project, filter) &&
      `${project.company} ${project.name} ${project.semester}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  )
  const companies = [...new Set(visible.map((project) => project.companyId))]
  const selectedCompany = params.get('company')
  const group = visible.filter((project) => project.companyId === selectedCompany)
  const companyProjects = group.length
    ? group
    : visible.filter((project) => project.companyId === visible[0]?.companyId)
  const selected =
    companyProjects.find((project) => project.id === selectedProject) ?? companyProjects[0]
  return (
    <>
      <Intro eyebrow="PORTFOLIO INVENTORY" title="All projects">
        One company at a time, with project periods and evidence kept in context.
      </Intro>
      <div className="project-browser">
        <div>
          <div className="project-filter-panel">
            <Filters
              value={filter}
              onChange={(value) => {
                setParams({ status: value })
                setSelectedProject('')
              }}
            />
            <label className="portfolio-search">
              Search companies or projects
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Find a company or project"
              />
            </label>
          </div>
          <PortfolioState>
            <div className="company-list" role="group" aria-label="Company results">
              {companies.length ? (
                companies.map((id) => {
                  const rows = visible.filter((project) => project.companyId === id)
                  return (
                    <button
                      key={id}
                      className="company-list-card"
                      aria-pressed={selected?.companyId === id}
                      onClick={() => {
                        setParams({ status: filter, company: id })
                        setSelectedProject('')
                      }}
                    >
                      <strong>{rows[0]!.company}</strong>
                      <small>{rows.length} matching projects</small>
                      {rows.map((project) => (
                        <span className="company-project-line" key={project.id}>
                          <span>
                            {project.name}
                            <small>{project.semester}</small>
                          </span>
                          <StatusBadge status={project.status} />
                        </span>
                      ))}
                    </button>
                  )
                })
              ) : (
                <EmptyState description="No companies or projects match these filters." />
              )}
            </div>
          </PortfolioState>
        </div>
        <section className="project-detail-panel" aria-label="Selected project detail">
          {selected ? (
            <>
              <div className="selected-project-heading">
                <p className="eyebrow">SELECTED COMPANY</p>
                <h2>{selected.company}</h2>
                <div className="project-company-counts">
                  <span>{companyProjects.length} matching projects</span>
                  <StatusBadge status={selected.status} />
                </div>
                <div className="filter-chips">
                  {companyProjects.map((project) => (
                    <button
                      className="filter-chip"
                      key={project.id}
                      aria-pressed={selected.id === project.id}
                      onClick={() => setSelectedProject(project.id)}
                    >
                      {project.name} · {project.semester}
                    </button>
                  ))}
                </div>
              </div>
              <div className="detail-tabs" role="tablist" aria-label="Project detail tabs">
                {['Overview', 'Progress', 'Concerns', 'History'].map((value) => (
                  <button
                    id={`project-tab-${value}`}
                    key={value}
                    role="tab"
                    tabIndex={tab === value ? 0 : -1}
                    onKeyDown={(event) => {
                      const names = ['Overview', 'Progress', 'Concerns', 'History']
                      const index = names.indexOf(value)
                      const next =
                        event.key === 'ArrowRight'
                          ? (index + 1) % 4
                          : event.key === 'ArrowLeft'
                            ? (index + 3) % 4
                            : event.key === 'Home'
                              ? 0
                              : event.key === 'End'
                                ? 3
                                : -1
                      if (next < 0) return
                      event.preventDefault()
                      setTab(names[next]!)
                      document.getElementById(`project-tab-${names[next]}`)?.focus()
                    }}
                    aria-selected={tab === value}
                    aria-controls={`project-panel-${value}`}
                    onClick={() => setTab(value)}
                  >
                    {value}
                  </button>
                ))}
              </div>
              <div
                className="project-tab-panel"
                role="tabpanel"
                id={`project-panel-${tab}`}
                aria-labelledby={`project-tab-${tab}`}
              >
                <h3>{selected.name}</h3>
                {tab === 'Overview' && (
                  <>
                    <StatusBadge status={selected.status} />
                    <p>{selected.summary}</p>
                    <dl className="project-facts">
                      <div>
                        <dt>Open PRs</dt>
                        <dd>{selected.openPrs ?? 'Unavailable'}</dd>
                      </div>
                      <div>
                        <dt>Review latency</dt>
                        <dd>
                          {selected.reviewLatencyDays === null
                            ? 'Unavailable'
                            : `${selected.reviewLatencyDays} days`}
                        </dd>
                      </div>
                      <div>
                        <dt>Confidence</dt>
                        <dd>Unavailable</dd>
                      </div>
                    </dl>
                    <Link
                      className="read-link"
                      to={`/projects/${encodeURIComponent(selected.id)}?periodId=${encodeURIComponent(snapshotId)}`}
                    >
                      Inspect component evidence →
                    </Link>
                  </>
                )}
                {tab === 'Progress' && (
                  <>
                    <p>
                      Activity:{' '}
                      {selected.activityDays === null
                        ? 'Unavailable'
                        : `${selected.activityDays} days / week`}
                    </p>
                    <EmptyState
                      title="Milestone evidence unavailable"
                      description="Verified delivery, SOW milestones, and progress charts are deferred until their approved sources are available."
                    />
                  </>
                )}
                {tab === 'Concerns' &&
                  (selected.concerns.length ? (
                    <ul>
                      {selected.concerns.map((concern) => (
                        <li key={concern}>{concern}</li>
                      ))}
                    </ul>
                  ) : (
                    <p>
                      No concern evidence is included in this snapshot. This is not proof that a
                      project has no issues.
                    </p>
                  ))}
                {tab === 'History' && (
                  <>
                    <p>Choose an available snapshot to review that reporting period.</p>
                    <div className="history-snapshots">
                      {query.data?.snapshots.map((snapshot) => (
                        <button
                          key={snapshot.id}
                          className="filter-chip"
                          aria-pressed={snapshot.id === snapshotId}
                          onClick={() => selectSnapshot(snapshot.id)}
                        >
                          {snapshot.label}
                        </button>
                      ))}
                    </div>
                    <p className="portfolio-unavailable">
                      Historical trend analysis and publication comparison are deferred to T6.6.
                    </p>
                  </>
                )}
              </div>
            </>
          ) : (
            <EmptyState
              title="Select an available project"
              description="A project detail panel appears only when an authorized or explicitly fictional result is available and matches the filters."
            />
          )}
        </section>
      </div>
    </>
  )
}

export function PortfolioInsights() {
  const { query } = usePortfolio()
  const [metric, setMetric] = useState<'activityDays' | 'openPrs' | 'reviewLatencyDays'>(
    'activityDays',
  )
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const projects = query.data?.publication.state === 'missing' ? [] : (query.data?.projects ?? [])
  const rows = projects.filter(
    (project) =>
      matches(project, filter) &&
      `${project.company} ${project.name}`.toLowerCase().includes(search.toLowerCase()),
  )
  const metricLabels = {
    activityDays: 'Activity days / week',
    openPrs: 'Open PRs',
    reviewLatencyDays: 'Review latency (days)',
  }
  return (
    <>
      <Intro eyebrow="PORTFOLIO COMPARISON" title="Insights">
        Compare available activity and review signals without inferring unsupported health claims.
      </Intro>
      <Card
        title="Project comparison"
        description="Read metrics are shown as supplied. Missing values are not zero."
      >
        <div className="insights-toolbar">
          <div className="filter-chips" role="group" aria-label="Comparison metric">
            {(['activityDays', 'openPrs', 'reviewLatencyDays'] as const).map((key) => (
              <button
                className="filter-chip"
                key={key}
                aria-pressed={key === metric}
                onClick={() => setMetric(key)}
              >
                {metricLabels[key]}
              </button>
            ))}
          </div>
          <label className="portfolio-search">
            Search comparisons
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <label className="portfolio-search">
            Comparison status
            <select value={filter} onChange={(event) => setFilter(event.target.value as Filter)}>
              {(Object.keys(labels) as Filter[]).map((value) => (
                <option key={value} value={value}>
                  {labels[value]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <PortfolioState>
          <DataTable
            caption="Portfolio comparison"
            rows={rows}
            rowKey={(row) => row.id}
            columns={[
              { id: 'company', heading: 'Company', render: (row) => row.company },
              { id: 'project', heading: 'Project', render: (row) => row.name },
              {
                id: 'status',
                heading: 'Status',
                render: (row) => <StatusBadge status={row.status} />,
              },
              {
                id: 'metric',
                heading: metricLabels[metric],
                render: (row) => row[metric] ?? 'Unavailable',
              },
            ]}
            emptyState={<EmptyState description="No matching companies or projects." />}
          />
        </PortfolioState>
      </Card>
    </>
  )
}
