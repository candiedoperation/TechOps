import { memo, useEffect, useRef, type CSSProperties } from 'react'
import { Check, Circle, CircleAlert, ListTodo } from 'lucide-react'
import { useLocation } from 'react-router-dom'
import type { SowTask, SowTimelineDocument } from '../../api/contracts/projects'
import { externalHttpUrl, taskAnchor } from '../../api/links'
import { Card } from '../../components/ui/Card'
import { whenVisible } from '../../components/ui/motion'
import { EmptyState } from '../../components/ui/States'
import { percent, shortDate } from '../../format'

const status = {
  done: { label: 'Done', icon: Check },
  in_progress: { label: 'In progress', icon: Circle },
  not_started: { label: 'Not started', icon: Circle },
  overdue: { label: 'Overdue', icon: CircleAlert },
}

const today = () => new Date()

const Task = memo(function Task({
  task,
  selected,
  index,
}: {
  task: SowTask
  selected: boolean
  index: number
}) {
  const { label, icon: Icon } = status[task.timelineStatus]
  const override = task.override
  const pending = task.pendingOverride
  return (
    <li
      id={taskAnchor(task.taskKey)}
      className={`sow-task sow-task-${task.timelineStatus}`}
      style={{ '--node-delay': `${Math.min(index, 11) * 34}ms` } as CSSProperties}
    >
      <span className="sow-status-icon">
        {task.timelineStatus === 'done' ? (
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path pathLength="1" d="m5 12 4 4L19 6" />
          </svg>
        ) : (
          <Icon size={16} aria-hidden="true" />
        )}
      </span>
      <details open={selected || undefined}>
        <summary>
          <strong>{task.title}</strong>
          <span className="sow-status">{label}</span>
          <span className="sow-facts">
            {task.dueDate ? (
              <time dateTime={task.dueDate}>{shortDate.format(new Date(task.dueDate))}</time>
            ) : (
              'No date'
            )}
            {' · '}
            {task.owners.length ? task.owners.join(', ') : 'Unassigned'}
          </span>
          {pending && <span className="sow-pending">Pending next run</span>}
        </summary>
        <div className="sow-task-details">
          <div>
            {task.description && <p>{task.description}</p>}
            {task.acceptanceCriteria.length > 0 && (
              <>
                <h3>Acceptance criteria</h3>
                <ul>
                  {task.acceptanceCriteria.map((criterion) => (
                    <li key={criterion}>{criterion}</li>
                  ))}
                </ul>
              </>
            )}
            {task.sourceRef && <p>Source {task.sourceRef}</p>}
            {task.matchedPrs.length > 0 && (
              <>
                <h3>Matched pull requests</h3>
                <ul>
                  {task.matchedPrs.map((pr) => {
                    const url = externalHttpUrl(pr.url)
                    return (
                      <li key={`${pr.url}:${pr.number}`}>
                        {url ? <a href={url}>PR #{pr.number}</a> : `PR #${pr.number}`} ·{' '}
                        {percent.format(pr.confidence)} confidence
                        <p>{pr.reason}</p>
                      </li>
                    )
                  })}
                </ul>
              </>
            )}
            {override && (
              <p>
                Applied override · {override.status.replaceAll('_', ' ')}
                {override.reason && ` · ${override.reason}`}
              </p>
            )}
            {pending && (
              <p>
                Pending next run · {pending.status.replaceAll('_', ' ')}
                {pending.reason && ` · ${pending.reason}`}
              </p>
            )}
          </div>
        </div>
      </details>
    </li>
  )
})

export function SowTimeline({
  document,
  projectPk,
  now = today,
}: {
  document: SowTimelineDocument | null
  projectPk: string
  now?: () => Date
}) {
  const { hash } = useLocation()
  const anchor = hash.slice(1)
  const rail = useRef<HTMLOListElement>(null)
  const markerRef = useRef<HTMLLIElement>(null)
  useEffect(() => {
    const list = rail.current
    if (!list) return
    return whenVisible(list, () => {
      list.dataset.motion = 'ready'
    })
  }, [document])
  useEffect(() => {
    const marker = markerRef.current
    if (!marker || !('IntersectionObserver' in window)) return
    const observer = new IntersectionObserver(([entry]) => {
      marker.dataset.onscreen = String(entry?.isIntersecting)
    })
    observer.observe(marker)
    return () => observer.disconnect()
  }, [document])
  useEffect(() => {
    if (anchor && document)
      window.document.getElementById(anchor)?.scrollIntoView?.({ block: 'nearest' })
  }, [anchor, document])
  if (!document) {
    const peoplePortal =
      externalHttpUrl(import.meta.env.VITE_HORIZON_PEOPLE_PORTAL_URL) ??
      'https://corp.appdevclub.com'
    const team = new URL(`/org/teams/${encodeURIComponent(projectPk)}`, peoplePortal)
    return (
      <Card title="SOW progress" icon={ListTodo} tone="green">
        <EmptyState
          title="No SOW yet"
          description="The project lead uploads the statement of work on the team page in People Portal."
          action={
            <a className="button button-secondary" href={team.href}>
              Open team in People Portal
            </a>
          }
        />
      </Card>
    )
  }
  const { progress, tasks } = document
  const todayKey = now().toISOString().slice(0, 10)
  const future = tasks.findIndex(
    (task) => task.dueDate !== null && task.dueDate.slice(0, 10) >= todayKey,
  )
  const lastDated = tasks.reduce((last, task, index) => (task.dueDate === null ? last : index), -1)
  const marker = future < 0 ? lastDated + 1 : future
  const todayMarker = (
    <li key="today" ref={markerRef} className="sow-today">
      <time dateTime={todayKey}>Today</time>
    </li>
  )
  return (
    <Card
      title="SOW progress"
      icon={ListTodo}
      tone="green"
      description={document.title ?? undefined}
    >
      <progress
        className="sow-overall"
        aria-label="SOW completion"
        value={progress.percentComplete}
        max={100}
      />
      <p>
        {progress.percentComplete}% complete · {progress.done} / {progress.total} done ·{' '}
        {progress.overdue} overdue
      </p>
      {tasks.length > 0 && (
        <ol ref={rail} className="sow-timeline" aria-label="SOW tasks">
          {tasks.flatMap((task, index) => {
            const id = taskAnchor(task.taskKey)
            const node = <Task key={id} index={index} task={task} selected={anchor === id} />
            return index === marker ? [todayMarker, node] : [node]
          })}
          {marker === tasks.length && todayMarker}
        </ol>
      )}
    </Card>
  )
}
