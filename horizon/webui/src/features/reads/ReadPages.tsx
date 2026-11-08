import { useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import type { HorizonReadContractRegistry } from '../../api/contracts/registry'
import type {
  ProvisionalComponentScore,
  ProvisionalPage,
} from '../../api/contracts/provisional/common'
import {
  useProvisionalHealthHistory,
  useProvisionalHealthPeriods,
  useProvisionalMemberProfile,
  useProvisionalMemberRankings,
  useProvisionalProjectDetails,
  useProvisionalProjectHealth,
  useProvisionalRankingHistory,
  useProvisionalRankingPeriods,
} from '../../api/contracts/provisional/hooks'
import { useHorizonReadClient } from '../../api/context'
import { Card } from '../../components/ui/Card'
import { DataTable, type TableColumn } from '../../components/ui/DataTable'
import { Pagination } from '../../components/ui/Pagination'
import { QueryState } from '../../components/ui/QueryState'
import { ScoreBar } from '../../components/ui/ScoreBar'

/** Shared API-backed presentation. A reviewed live registry can replace the demo registry. */
type RegistryProps = { registry: HorizonReadContractRegistry; scoreMaximum?: number }
function Heading({ title, description }: { title: string; description: string }) {
  const client = useHorizonReadClient()
  return (
    <div className="page-intro">
      <div>
        <p className="eyebrow">HORIZON WORKSPACE</p>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {client.accessMode === 'demo' && <span className="pill demo-label">DEMO DATA</span>}
    </div>
  )
}
function Controls({
  periods,
  periodId,
  onPeriod,
  search,
  onSearch,
  coverage,
  onCoverage,
}: {
  periods: readonly { id: string; label: string }[]
  periodId: string
  onPeriod: (value: string) => void
  search: string
  onSearch: (value: string) => void
  coverage: string
  onCoverage: (value: string) => void
}) {
  return (
    <div className="read-controls">
      <label>
        Period
        <select value={periodId} onChange={(event) => onPeriod(event.target.value)}>
          {periods.map((period) => (
            <option key={period.id} value={period.id}>
              {period.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Search
        <input
          type="search"
          value={search}
          onChange={(event) => onSearch(event.target.value)}
          placeholder="Filter by name"
        />
      </label>
      <label>
        Coverage
        <select value={coverage} onChange={(event) => onCoverage(event.target.value)}>
          <option value="">All coverage</option>
          {['complete', 'partial', 'missing'].map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </label>
    </div>
  )
}
interface PagedQuery<T> {
  data: { pages: ProvisionalPage<T>[] } | undefined
  available: boolean
  isPending: boolean
  isFetching: boolean
  error: Error | null
  hasNextPage: boolean
  refetch: () => unknown
  fetchNextPage: () => Promise<{ data?: { pages: ProvisionalPage<T>[] }; isError: boolean }>
}
function PagedResults<T>({
  query,
  caption,
  columns,
  rowKey,
}: {
  query: PagedQuery<T>
  caption: string
  columns: TableColumn<T>[]
  rowKey: (row: T) => string
}) {
  const [pageIndex, setPageIndex] = useState(0)
  const index = Math.min(pageIndex, Math.max(0, (query.data?.pages.length ?? 1) - 1))
  const page = query.data?.pages[index]
  return (
    <>
      <QueryState
        available={query.available}
        data={page}
        pending={query.isPending}
        error={query.error}
        freshness={page?.publication}
        refreshing={query.isFetching}
        onRefresh={() => {
          void query.refetch()
        }}
        isEmpty={(value) => value.items.length === 0}
      >
        {(value) => (
          <DataTable caption={caption} columns={columns} rows={value.items} rowKey={rowKey} />
        )}
      </QueryState>
      {page && !query.error && page.publication.state !== 'missing' && (
        <Pagination
          label={`${page.items.length} results on page ${index + 1}`}
          hasPrevious={index > 0}
          hasNext={index + 1 < (query.data?.pages.length ?? 0) || query.hasNextPage}
          pending={query.isFetching}
          onPrevious={() => setPageIndex(Math.max(0, index - 1))}
          onNext={() => {
            if (index + 1 < (query.data?.pages.length ?? 0)) {
              setPageIndex(index + 1)
              return
            }
            void query.fetchNextPage().then((result) => {
              if (!result.isError && (result.data?.pages.length ?? 0) > index + 1)
                setPageIndex(index + 1)
            })
          }}
        />
      )}
    </>
  )
}
export function ReadRankingsPage({ registry, scoreMaximum }: RegistryProps) {
  const periods = useProvisionalRankingPeriods(registry)
  const [selected, setSelected] = useState('')
  const [search, setSearch] = useState('')
  const [coverage, setCoverage] = useState('')
  const periodId = selected || periods.data?.periods[0]?.id || ''
  const query = useProvisionalMemberRankings(
    { periodId, pageSize: 3, filters: { q: search, coverage } },
    registry,
  )
  return (
    <>
      <Heading
        title="Member Rankings"
        description="Explore scores, coverage, and supporting evidence by semester."
      />
      <Card
        title="Rankings explorer"
        description="Score units and publication states come from the read response."
      >
        <Controls
          periods={periods.data?.periods ?? []}
          periodId={periodId}
          onPeriod={setSelected}
          search={search}
          onSearch={setSearch}
          coverage={coverage}
          onCoverage={setCoverage}
        />
        <PagedResults
          query={query}
          caption="Member rankings"
          rowKey={(row) => row.memberId}
          columns={[
            { id: 'position', heading: 'Rank', render: (row) => row.position ?? '—' },
            {
              id: 'member',
              heading: 'Member',
              render: (row) => (
                <Link
                  className="read-link"
                  to={`/rankings/members/${encodeURIComponent(row.memberId)}?periodId=${encodeURIComponent(periodId)}`}
                >
                  {row.displayName}
                </Link>
              ),
            },
            {
              id: 'score',
              heading: 'Score',
              render: (row) => (
                <>
                  {scoreMaximum === undefined ? (
                    (row.overallScore ?? 'Not available')
                  ) : (
                    <ScoreBar
                      value={row.overallScore}
                      maximum={scoreMaximum}
                      label={`${row.displayName} overall score`}
                    />
                  )}
                  <small className="cell-note">{row.scoreUnit}</small>
                </>
              ),
            },
            {
              id: 'coverage',
              heading: 'Coverage',
              render: (row) => <span className="pill pill-neutral">{row.coverage.state}</span>,
            },
          ]}
        />
      </Card>
    </>
  )
}
export function ReadProjectHealthPage({ registry }: RegistryProps) {
  const periods = useProvisionalHealthPeriods(registry)
  const [selected, setSelected] = useState('')
  const [search, setSearch] = useState('')
  const [coverage, setCoverage] = useState('')
  const periodId = selected || periods.data?.periods[0]?.id || ''
  const query = useProvisionalProjectHealth(
    { periodId, pageSize: 3, filters: { q: search, coverage } },
    registry,
  )
  return (
    <>
      <Heading
        title="Project Health"
        description="Follow project signals, completeness, and publication freshness."
      />
      <Card
        title="Project overview"
        description="Inspect each project to see component signals and reporting history."
      >
        <Controls
          periods={periods.data?.periods ?? []}
          periodId={periodId}
          onPeriod={setSelected}
          search={search}
          onSearch={setSearch}
          coverage={coverage}
          onCoverage={setCoverage}
        />
        <PagedResults
          query={query}
          caption="Project health"
          rowKey={(row) => row.projectId}
          columns={[
            {
              id: 'project',
              heading: 'Project',
              render: (row) => (
                <Link
                  className="read-link"
                  to={`/projects/${encodeURIComponent(row.projectId)}?periodId=${encodeURIComponent(periodId)}`}
                >
                  {row.name}
                </Link>
              ),
            },
            {
              id: 'health',
              heading: 'Health signal',
              render: (row) => row.healthLabel ?? 'Not available',
            },
            {
              id: 'coverage',
              heading: 'Evidence coverage',
              render: (row) => (
                <>
                  {row.coverage.state}
                  <small className="cell-note">
                    {row.coverage.available ?? '—'} / {row.coverage.expected ?? '—'} inputs
                  </small>
                </>
              ),
            },
          ]}
        />
      </Card>
    </>
  )
}
function Components({
  values,
  maximum,
}: {
  values: readonly ProvisionalComponentScore[]
  maximum?: number
}) {
  return (
    <div className="signal-grid">
      {values.map((component) => (
        <section key={component.key} className="signal-panel">
          <h3>{component.label}</h3>
          <p className="signal-value">
            {maximum === undefined ? (
              (component.value ?? 'Not available')
            ) : (
              <ScoreBar value={component.value} maximum={maximum} label={component.label} />
            )}{' '}
            <small>{component.unit}</small>
          </p>
          <p>Coverage: {component.coverage.state}</p>
          {component.coverage.gaps.length > 0 && (
            <ul>
              {component.coverage.gaps.map((gap) => (
                <li key={gap}>{gap}</li>
              ))}
            </ul>
          )}
          <h4>Evidence references</h4>
          <ul>
            {component.evidence.map((evidence) => (
              <li key={evidence.id}>
                {evidence.label}
                <small className="cell-note">{evidence.sourceType}</small>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}
export function ReadMemberDetailPage({ registry, scoreMaximum }: RegistryProps) {
  const params = useParams()
  const memberId = params.userPk ?? params.memberId ?? ''
  const [search, setSearch] = useSearchParams()
  const periods = useProvisionalRankingPeriods(registry)
  const periodId = search.get('periodId') || periods.data?.periods[0]?.id || ''
  const query = useProvisionalMemberProfile(memberId, periodId, registry)
  const history = useProvisionalRankingHistory(memberId, registry)
  return (
    <>
      <Heading
        title="Member profile"
        description="Component scores, evidence coverage, and semester history."
      />
      <Link className="read-link" to="/rankings">
        ← All member rankings
      </Link>
      <Card
        title={query.data?.data?.displayName ?? 'Member detail'}
        description="Follow the evidence behind each component."
      >
        <div className="read-controls">
          <label>
            Semester
            <select
              value={periodId}
              onChange={(event) => setSearch({ periodId: event.target.value })}
            >
              {periods.data?.periods.map((period) => (
                <option key={period.id} value={period.id}>
                  {period.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <QueryState
          available={query.available}
          data={query.data}
          pending={query.isPending}
          error={query.error}
          freshness={query.data?.publication}
          onRefresh={() => {
            void query.refetch()
          }}
          isEmpty={(value) => value.data === null}
        >
          {(value) =>
            value.data && <Components values={value.data.components} maximum={scoreMaximum} />
          }
        </QueryState>
      </Card>
      <Card
        title="Semester history"
        description="Historical values preserve the units and coverage of each publication."
      >
        <PagedResults
          query={history}
          caption="Member semester history"
          rowKey={(row) => row.periodId}
          columns={[
            {
              id: 'period',
              heading: 'Semester',
              render: (row) =>
                periods.data?.periods.find((period) => period.id === row.periodId)?.label ??
                row.periodId,
            },
            {
              id: 'score',
              heading: 'Score',
              render: (row) => (
                <>
                  {row.overallScore ?? 'Not available'}
                  <small className="cell-note">{row.scoreUnit}</small>
                </>
              ),
            },
            { id: 'coverage', heading: 'Coverage', render: (row) => row.coverage.state },
          ]}
        />
      </Card>
    </>
  )
}
export function ReadProjectDetailPage({ registry, scoreMaximum }: RegistryProps) {
  const params = useParams()
  const projectId = params.projectPk ?? params.projectId ?? ''
  const [search, setSearch] = useSearchParams()
  const periods = useProvisionalHealthPeriods(registry)
  const periodId = search.get('periodId') || periods.data?.periods[0]?.id || ''
  const query = useProvisionalProjectDetails(projectId, periodId, registry)
  const history = useProvisionalHealthHistory(projectId, registry)
  return (
    <>
      <Heading
        title="Project detail"
        description="Health signals, evidence references, and reporting trends."
      />
      <Link className="read-link" to="/projects">
        ← All project health
      </Link>
      <Card
        title={query.data?.data?.name ?? 'Project detail'}
        description="Inspect signals and their evidence before drawing conclusions."
      >
        <div className="read-controls">
          <label>
            Reporting period
            <select
              value={periodId}
              onChange={(event) => setSearch({ periodId: event.target.value })}
            >
              {periods.data?.periods.map((period) => (
                <option key={period.id} value={period.id}>
                  {period.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <QueryState
          available={query.available}
          data={query.data}
          pending={query.isPending}
          error={query.error}
          freshness={query.data?.publication}
          onRefresh={() => {
            void query.refetch()
          }}
          isEmpty={(value) => value.data === null}
        >
          {(value) =>
            value.data && <Components values={value.data.components} maximum={scoreMaximum} />
          }
        </QueryState>
      </Card>
      <Card title="Health history" description="Compare component values across reporting periods.">
        <PagedResults
          query={history}
          caption="Project health history"
          rowKey={(row) => row.periodId}
          columns={[
            {
              id: 'period',
              heading: 'Reporting period',
              render: (row) =>
                periods.data?.periods.find((period) => period.id === row.periodId)?.label ??
                row.periodId,
            },
            {
              id: 'signals',
              heading: 'Component trends',
              render: (row) =>
                row.components.map((component) => (
                  <span className="cell-note" key={component.key}>
                    {component.label}: {component.value ?? 'missing'}
                  </span>
                )),
            },
          ]}
        />
      </Card>
    </>
  )
}
export function ReadDashboardPage({ registry }: RegistryProps) {
  const semesters = useProvisionalRankingPeriods(registry)
  const periods = useProvisionalHealthPeriods(registry)
  const semester = semesters.data?.periods[0]?.id ?? ''
  const period = periods.data?.periods[0]?.id ?? ''
  const rankings = useProvisionalMemberRankings({ periodId: semester, pageSize: 3 }, registry)
  const health = useProvisionalProjectHealth({ periodId: period, pageSize: 3 }, registry)
  return (
    <>
      <Heading
        title="Your Horizon, at a glance."
        description="Explore the same query, transport, and state components used by feature pages."
      />
      <div className="dashboard-grid">
        <Card title="Member contributions" description={semesters.data?.periods[0]?.label}>
          <PagedResults
            query={rankings}
            caption="Dashboard rankings"
            rowKey={(row) => row.memberId}
            columns={[
              {
                id: 'name',
                heading: 'Member',
                render: (row) => (
                  <Link
                    className="read-link"
                    to={`/rankings/members/${encodeURIComponent(row.memberId)}?periodId=${encodeURIComponent(semester)}`}
                  >
                    {row.displayName}
                  </Link>
                ),
              },
              {
                id: 'score',
                heading: 'Score',
                render: (row) => row.overallScore ?? 'Not available',
              },
            ]}
          />
        </Card>
        <Card title="Project signals" description={periods.data?.periods[0]?.label}>
          <PagedResults
            query={health}
            caption="Dashboard project health"
            rowKey={(row) => row.projectId}
            columns={[
              {
                id: 'name',
                heading: 'Project',
                render: (row) => (
                  <Link
                    className="read-link"
                    to={`/projects/${encodeURIComponent(row.projectId)}?periodId=${encodeURIComponent(period)}`}
                  >
                    {row.name}
                  </Link>
                ),
              },
              {
                id: 'health',
                heading: 'Signal',
                render: (row) => row.healthLabel ?? 'Not available',
              },
            ]}
          />
        </Card>
      </div>
    </>
  )
}
