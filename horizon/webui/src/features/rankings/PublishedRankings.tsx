import { ListOrdered } from 'lucide-react'
import { useLayoutEffect, useRef } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../../auth/context'
import { useHorizonReadClient } from '../../api/context'
import { memberOperation } from '../../api/contracts/member'
import { loadMember } from '../../app/route-loaders'
import { rankingOperations, type RankingRow } from '../../api/contracts/rankings'
import { horizonQueryKeys, useHorizonReadQuery } from '../../api/use-horizon-query'
import { Card } from '../../components/ui/Card'
import { QueryState } from '../../components/ui/QueryState'
import { DataTable, type TableColumn } from '../../components/ui/DataTable'
import { Pagination } from '../../components/ui/Pagination'
import { motionAllowed, moveFrom } from '../../components/ui/motion'
import { ScoreBar } from '../../components/ui/ScoreBar'
import { rubricV1 } from '../../rubric'
import { percent, shortDate } from '../../format'
import { rankingStatus } from './display'
import './rankings.css'

function groupedRows(rows: RankingRow[], engineers: boolean) {
  const groups = new Map<string, { label: string; rows: RankingRow[] }>()
  for (const row of rows) {
    const key = engineers ? row.comparisonGroup : ''
    const label = engineers ? (row.comparisonGroupLabel ?? row.projectName) : 'Tech leads'
    if (!groups.has(key)) groups.set(key, { label, rows: [] })
    groups.get(key)?.rows.push(row)
  }
  return groups
}

function memberUrl(row: RankingRow, season: string, run: string) {
  return {
    pathname: `/rankings/members/${encodeURIComponent(row.userPk)}`,
    search: new URLSearchParams({ season, run, projectPk: row.projectPk }).toString(),
  }
}

function selectTransition(row: HTMLElement | null) {
  if (!row || !motionAllowed() || !document.startViewTransition) return
  row
    .querySelector<HTMLElement>('[data-transition-name]')
    ?.style.setProperty('view-transition-name', 'member-name')
  row
    .querySelector<HTMLElement>('[data-transition-score]')
    ?.style.setProperty('view-transition-name', 'member-score')
}

function columns(
  season: string,
  runId: string,
  rubricVersion: string,
  prefetch: (row: RankingRow, run: string) => Promise<void>,
): TableColumn<RankingRow>[] {
  return [
    {
      id: 'rank',
      heading: 'Rank',
      render: (row) => (row.status === 'ranked' ? (row.rankInGroup ?? '—') : '—'),
    },
    {
      id: 'name',
      heading: 'Name',
      render: (row) => (
        <Link
          to={memberUrl(row, season, runId)}
          viewTransition={motionAllowed()}
          onClick={(event) => {
            if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey)
              selectTransition(event.currentTarget.closest('tr'))
          }}
          onPointerEnter={() => void prefetch(row, runId)}
          onPointerDown={() => void prefetch(row, runId)}
          onFocus={() => void prefetch(row, runId)}
          data-transition-name
        >
          {row.name}
        </Link>
      ),
    },
    { id: 'project', heading: 'Project', render: (row) => row.projectName },
    {
      id: 'role',
      heading: 'Role',
      render: (row) => (row.role === 'engineer' ? 'Engineer' : 'Tech lead'),
    },
    {
      id: 'score',
      heading: 'Overall score',
      render: (row) =>
        row.status === 'ranked' ? (
          <div data-transition-score>
            <ScoreBar value={row.overallScore} maximum={100} label={`${row.name} overall score`} />
          </div>
        ) : (
          '—'
        ),
    },
    { id: 'coverage', heading: 'Coverage', render: (row) => percent.format(row.coverage) },
    {
      id: 'status',
      heading: 'Status',
      render: ({ status }) => (
        <span className="ranking-badge" data-status={status} title={rankingStatus[status].reason}>
          {rankingStatus[status].label}
        </span>
      ),
    },
    {
      id: 'buckets',
      heading: 'Buckets',
      render: (row) =>
        row.status === 'ranked' && (
          <div className="bucket-bars">
            {row.buckets.map((bucket) => {
              const rubric = rubricVersion === 'v1' ? rubricV1[row.role][bucket.key] : undefined
              const label = bucket.label ?? rubric?.label ?? bucket.key.replaceAll('_', ' ')
              const weight = rubric?.weight ?? percent.format(bucket.weight)
              const wording = `${label}: ${bucket.score ?? 'No score'} · Weight ${typeof weight === 'number' ? `${weight}%` : weight}`
              return (
                <span key={bucket.key} title={wording}>
                  {bucket.score === null ? (
                    <span aria-label={wording}>—</span>
                  ) : (
                    <meter aria-label={wording} min={0} max={100} value={bucket.score} />
                  )}
                </span>
              )
            })}
          </div>
        ),
    },
  ]
}

export function PublishedRankings() {
  const navigate = useNavigate()
  const queries = useQueryClient()
  const client = useHorizonReadClient()
  const { state } = useAuth()
  const tables = useRef<HTMLDivElement>(null)
  const previous = useRef(new Map<string, DOMRect>())
  const [search, setSearch] = useSearchParams()
  const semesters = useHorizonReadQuery({
    feature: 'ranking-semesters',
    operation: rankingOperations.semesters,
  })
  const season = search.get('season') ?? semesters.data?.[0] ?? ''
  const role = search.get('role') === 'tech_lead' ? 'tech_lead' : 'engineer'
  const projectPk = role === 'engineer' ? (search.get('projectPk') ?? '') : ''
  const run = search.get('run') ?? 'current'
  const page = search.get('page') ?? '1'
  const runs = useHorizonReadQuery({
    feature: 'ranking-runs',
    parameters: { season },
    operation: rankingOperations.runs(season),
    available: Boolean(season),
  })
  const filters = { season, run, role, page, ...(projectPk ? { projectPk } : {}) }
  const rankings = useHorizonReadQuery({
    feature: 'published-rankings',
    parameters: filters,
    operation: rankingOperations.list(filters),
    available: Boolean(season),
  })

  function prefetch(row: RankingRow, run: string) {
    if (state.status !== 'authenticated' || !client.isAvailable()) return Promise.resolve()
    const parameters = { userPk: row.userPk, season, run }
    return Promise.all([
      loadMember(),
      queries.prefetchQuery({
        queryKey: horizonQueryKeys.read(state.session.subject, 'ranking-member', parameters),
        queryFn: ({ signal }) => client.get(memberOperation(row.userPk, { season, run }), signal),
      }),
    ]).then(() => {})
  }

  useLayoutEffect(() => {
    if (!rankings.data || !motionAllowed()) return
    const rows = tables.current?.querySelectorAll<HTMLElement>('[data-row-key]')
    if (!rows || rows.length > 50) return
    for (const row of rows) {
      const prior = previous.current.get(row.dataset.rowKey ?? '')
      if (prior) {
        row.style.animation = 'none'
        moveFrom(row, prior)
      }
    }
    previous.current.clear()
  }, [rankings.data])

  function update(changes: Record<string, string>) {
    const next = new URLSearchParams({ season, role, run, projectPk, ...changes })
    if (!next.get('projectPk')) next.delete('projectPk')
    previous.current.clear()
    const rows = tables.current?.querySelectorAll<HTMLElement>('[data-row-key]')
    if (motionAllowed() && rows && rows.length <= 50) {
      for (const row of rows)
        previous.current.set(row.dataset.rowKey ?? '', row.getBoundingClientRect())
    }
    setSearch(next)
  }

  const semesterOptions = [...new Set([...(semesters.data ?? []), ...(season ? [season] : [])])]
  const final = runs.data?.find((entry) => entry.isFinal)
  const knownRun =
    ['current', 'latest'].includes(run) ||
    (run === 'final' && final) ||
    runs.data?.some((entry) => entry.runId === run)
  const projects = rankings.data?.projects ?? []
  return (
    <Card title="Rankings explorer" icon={ListOrdered}>
      <div className="filter-bar ranking-filters">
        <label className="select-label">
          Semester
          <select
            value={season}
            onChange={(event) =>
              update({ season: event.target.value, run: 'current', projectPk: '' })
            }
          >
            {!season && <option value="">Select a semester</option>}
            {semesterOptions.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <label className="select-label">
          Role
          <select
            value={role}
            onChange={(event) => update({ role: event.target.value, projectPk: '' })}
          >
            <option value="engineer">Engineer</option>
            <option value="tech_lead">Tech lead</option>
          </select>
        </label>
        {role === 'engineer' && (
          <label className="select-label">
            Project
            <select
              value={projectPk}
              onChange={(event) => update({ projectPk: event.target.value })}
            >
              <option value="">All projects</option>
              {projectPk && !projects.some((project) => project.projectPk === projectPk) && (
                <option value={projectPk}>{projectPk}</option>
              )}
              {projects.map((project) => (
                <option key={project.projectPk} value={project.projectPk}>
                  {project.friendlyName}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="select-label">
          Run
          <select value={run} onChange={(event) => update({ run: event.target.value })}>
            <option value="current">Current</option>
            {run === 'latest' && <option value="latest">Current</option>}
            {final && (
              <option value="final">Final · {shortDate.format(new Date(final.asOf))}</option>
            )}
            {runs.data?.map((entry) => (
              <option key={entry.runId} value={entry.runId}>
                {shortDate.format(new Date(entry.asOf))}
                {entry.isFinal ? ' · Final run' : ''}
              </option>
            ))}
            {!knownRun && <option value={run}>{run}</option>}
          </select>
        </label>
      </div>
      {(semesters.isError || runs.isError) && (
        <p role="status">Some filter options could not be loaded.</p>
      )}
      <QueryState
        available={rankings.available || (!season && semesters.available)}
        data={rankings.data}
        pending={rankings.fetchStatus === 'fetching' || semesters.fetchStatus === 'fetching'}
        error={rankings.error ?? (!season ? semesters.error : null)}
        onRefresh={() => {
          if (season) void rankings.refetch()
          else void semesters.refetch()
        }}
        isEmpty={() => false}
      >
        {({ meta, items, page, pageSize, total }) => (
          <div ref={tables}>
            <p className="ranking-publication">
              <span>
                {meta.stale ? 'Stale' : 'Updated'} ·{' '}
                <time dateTime={meta.asOf}>{shortDate.format(new Date(meta.asOf))}</time>
              </span>
              <span>Rubric {meta.rubricVersion}</span>
              <span className="ranking-badge">{meta.isFinal ? 'Final' : 'Provisional'}</span>
            </p>
            {items.length === 0 && <p>No members match these filters.</p>}
            {[...groupedRows(items, role === 'engineer')].map(([key, group]) => (
              <section key={key} className="ranking-group">
                {key && <h3>{group.label}</h3>}
                <DataTable
                  caption={`Rankings · ${group.label}`}
                  columns={columns(season, meta.runId, meta.rubricVersion, prefetch)}
                  rows={[
                    ...group.rows.filter((row) => row.status === 'ranked'),
                    ...group.rows.filter((row) => row.status !== 'ranked'),
                  ]}
                  motion
                  rowKey={(row) => JSON.stringify([row.userPk, row.projectPk, row.role])}
                  rowClassName={(row) => (row.status !== 'ranked' ? 'unranked-row' : 'ranking-row')}
                  onRowClick={(row) => {
                    const key = JSON.stringify([row.userPk, row.projectPk, row.role])
                    const element = [
                      ...(tables.current?.querySelectorAll<HTMLElement>('[data-row-key]') ?? []),
                    ].find((element) => element.dataset.rowKey === key)
                    const animate = motionAllowed() && Boolean(document.startViewTransition)
                    const open = () => {
                      selectTransition(element ?? null)
                      void navigate(memberUrl(row, season, meta.runId), { viewTransition: animate })
                    }
                    if (animate) void prefetch(row, meta.runId).then(open, open)
                    else open()
                  }}
                />
              </section>
            ))}
            {(total > pageSize || page > 1) && (
              <Pagination
                hasPrevious={page > 1}
                hasNext={page * pageSize < total}
                label={`Page ${page}`}
                onPrevious={() => update({ page: String(page - 1) })}
                onNext={() => update({ page: String(page + 1) })}
              />
            )}
          </div>
        )}
      </QueryState>
    </Card>
  )
}
