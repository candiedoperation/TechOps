import { usePrefetchThrottle } from '../../api/prefetch'
import type { PointerEvent } from 'react'
import { memo, startTransition } from 'react'
import { ArrowUpRight, FolderKanban } from 'lucide-react'
import { Link, useSearchParams } from 'react-router-dom'
import { projectOperations, type ProjectSummary } from '../../api/contracts/projects'
import { usePublicProjectQuery, useProjectPrefetch } from '../../api/use-public-project-query'
import { Card } from '../../components/ui/Card'
import { QueryState } from '../../components/ui/QueryState'
import { EmptyState } from '../../components/ui/States'
import { ReadApiError } from '../../api/client'
import { loadProject } from '../../app/route-loaders'
import { Freshness } from './ProjectPublication'
import { readSelection } from './project-selection'
import './projects.css'

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

const ProjectCard = memo(function ProjectCard({
  project,
  season,
  run,
}: {
  project: ProjectSummary
  season: string
  run: string
}) {
  const prefetch = useProjectPrefetch()
  const selection = { season, run }
  const throttle = usePrefetchThrottle()
  const warm = (event?: PointerEvent) =>
    throttle(
      project.projectPk,
      () => {
        void loadProject()
        void prefetch(projectOperations.detail(project.projectPk, selection))
        void prefetch(projectOperations.timeline(project.projectPk, selection))
        void prefetch(projectOperations.history(project.projectPk, season))
      },
      event,
    )
  return (
    <Card title={project.friendlyName} icon={FolderKanban} className="project-card">
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
          search: new URLSearchParams(selection).toString(),
        }}
        aria-label={`View ${project.friendlyName}`}
        onFocus={() => warm()}
        onPointerEnter={warm}
        onPointerDown={warm}
      >
        View project <ArrowUpRight size={14} aria-hidden="true" />
      </Link>
    </Card>
  )
})

export function ProjectsPage() {
  const [search, setSearch] = useSearchParams()
  const selection = readSelection(search)
  const projects = usePublicProjectQuery(projectOperations.list(selection))
  return (
    <>
      <header className="page-intro">
        <div>
          <h1>All projects</h1>
          <p>Track published progress and delivery risks across the semester.</p>
        </div>
      </header>
      <form
        className="project-season"
        key={selection.season}
        onSubmit={(event) => {
          event.preventDefault()
          const data = new FormData(event.currentTarget)
          startTransition(() =>
            setSearch({ season: `${data.get('seasonType')}-${data.get('year')}` }),
          )
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
                  <ProjectCard
                    key={project.projectPk}
                    project={project}
                    season={selection.season}
                    run={meta.runId}
                  />
                ))}
              </div>
            </>
          )}
        </QueryState>
      )}
    </>
  )
}
