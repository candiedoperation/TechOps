import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { projectOperations, type SowTimelineDocument } from '../../api/contracts/projects'
import { renderReadPage } from '../../test/render-read-page'
import { ProjectPage } from './ProjectPages'
import { ProjectsPage } from './ProjectsListPage'
import { SowTimeline } from './SowTimeline'

const meta = {
  runId: '31c031ca-3965-452c-aa21-078da74808dc',
  asOf: '2026-11-09T00:00:00Z',
  stale: false,
}
const summary = {
  projectPk: 'beacon',
  friendlyName: 'Beacon',
  windowStart: '2026-08-01',
  windowEnd: '2026-12-01',
  hasSow: true,
  tasksTotal: 4,
  tasksDue: 2,
  tasksDone: 1,
  tasksPartial: 1,
  tasksOverdue: 1,
  percentComplete: 25,
  riskCounts: { review_delay: 2, blocked: 0 },
}
const tasks = [
  {
    taskKey: 'UI:1',
    title: 'Prepare the release',
    timelineStatus: 'done',
    dueDate: '2026-11-01',
    owners: [{ name: 'Ada' }],
    description: 'Publish the release guide.',
    acceptanceCriteria: ['Link the deployed guide.'],
    sourceRef: 'page 4',
    matchedPrs: [
      {
        number: 16,
        url: 'https://git.example.com/beacon/web/pulls/16',
        confidence: 0.85,
        reason: 'Includes the release guide.',
      },
    ],
    override: { status: 'done', reason: 'Verified manually' },
    pendingOverride: { status: 'in_progress', reason: 'Review requested' },
  },
  { taskKey: '2', title: 'Untimed task', timelineStatus: 'not_started', dueDate: null, owners: [] },
  {
    taskKey: '3',
    title: 'Finish handoff',
    timelineStatus: 'overdue',
    dueDate: '2026-11-05',
    owners: [],
  },
  {
    taskKey: '4',
    title: 'Start operations',
    timelineStatus: 'in_progress',
    dueDate: '2026-11-15',
    owners: [],
  },
  { taskKey: '5', title: 'No deadline', timelineStatus: 'not_started', dueDate: null, owners: [] },
]
const timeline = {
  sow: { title: 'Beacon SOW' },
  progress: { percentComplete: 25, done: 1, total: 4, overdue: 1 },
  tasks,
}
const detail = {
  metrics: [
    { week: '2026-11-01', prsMerged: 2, medianFirstReviewHours: 12, medianOpenPrAgeHours: 30 },
    { week: '2026-11-08', prsMerged: 4, medianFirstReviewHours: 6, medianOpenPrAgeHours: null },
  ],
  riskFlags: [{ label: 'Review delay', severity: 'high', description: 'Two reviews are overdue.' }],
  ownership: { active_owners: 3 },
  findings: [{ title: 'Activity increased', description: 'More PRs merged this week.' }],
}

function readTimeline(wire = timeline) {
  return projectOperations
    .timeline('beacon', { season: 'FALL-2026', run: 'current' })
    .parse({ meta, data: wire }).data
}

function showTimeline(document: SowTimelineDocument | null) {
  return render(
    <MemoryRouter>
      <SowTimeline
        document={document}
        projectPk="beacon"
        now={() => new Date('2026-11-10T12:00:00Z')}
      />
    </MemoryRouter>,
  )
}

describe('SOW timeline', () => {
  it('preserves task order and places Today between past and future deadlines', () => {
    showTimeline(readTimeline())
    const list = screen.getByRole('list', { name: 'SOW tasks' })
    expect(
      [...list.children].map(
        (item) => item.querySelector('strong')?.textContent ?? item.textContent,
      ),
    ).toEqual([
      'Prepare the release',
      'Untimed task',
      'Finish handoff',
      'Today',
      'Start operations',
      'No deadline',
    ])
    expect(screen.getByText('Done').closest('li')).toHaveClass('sow-task-done')
    expect(screen.getByText('In progress').closest('li')).toHaveClass('sow-task-in_progress')
    expect(screen.getByText('Overdue').closest('li')).toHaveClass('sow-task-overdue')
    expect(screen.getAllByText('Not started')[0]?.closest('li')).toHaveClass('sow-task-not_started')
    expect(screen.getAllByText('No date', { exact: false })).toHaveLength(2)
    expect(screen.getByRole('progressbar', { name: 'SOW completion' })).toHaveAttribute(
      'value',
      '25',
    )
  })

  it('puts Today after the last dated task when all deadlines have passed', () => {
    showTimeline(readTimeline({ ...timeline, tasks: [tasks[0]!, tasks[1]!] }))
    const list = screen.getByRole('list', { name: 'SOW tasks' })
    expect([...list.children].map((item) => item.className)).toEqual([
      'sow-task sow-task-done',
      'sow-today',
      'sow-task sow-task-not_started',
    ])
  })

  it('expands a task to show evidence and both override states', async () => {
    const user = userEvent.setup()
    showTimeline(readTimeline())
    const title = screen.getByText('Prepare the release')
    expect(title.closest('details')).not.toHaveAttribute('open')
    expect(screen.getByText('Pending next run', { exact: true })).toBeVisible()
    await user.click(title)
    expect(title.closest('details')).toHaveAttribute('open')
    expect(screen.getByText('Publish the release guide.')).toBeVisible()
    expect(screen.getByText('Link the deployed guide.')).toBeVisible()
    expect(screen.getByText('Source page 4')).toBeVisible()
    expect(screen.getByRole('link', { name: 'PR #16' })).toHaveAttribute(
      'href',
      'https://git.example.com/beacon/web/pulls/16',
    )
    expect(screen.getByText(/85% confidence/)).toBeVisible()
    expect(screen.getByText('Includes the release guide.')).toBeVisible()
    expect(screen.getByText('Applied override · done · Verified manually')).toBeVisible()
    expect(screen.getByText('Pending next run · in progress · Review requested')).toBeVisible()
  })

  it('links to the People Portal team when no SOW is published', () => {
    showTimeline(null)
    expect(screen.getByRole('heading', { name: 'No SOW yet' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open team in People Portal' })).toHaveAttribute(
      'href',
      'https://corp.appdevclub.com/org/teams/beacon',
    )
  })
})

describe('published project pages', () => {
  it('shows project cards, freshness, risk counts and pinned links', async () => {
    const fetcher = renderReadPage(
      '/projects?season=FALL-2026',
      <ProjectsPage />,
      () => ({
        meta,
        data: [summary, { ...summary, projectPk: 'atlas', friendlyName: 'Atlas', hasSow: false }],
      }),
      true,
    )
    expect(await screen.findByText('25% complete · 1 overdue')).toBeInTheDocument()
    expect(screen.getAllByText('review delay 2')).toHaveLength(2)
    expect(screen.getByText('No SOW yet')).toBeInTheDocument()
    expect(screen.getByText(/Updated/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'View Beacon' })).toHaveAttribute(
      'href',
      `/projects/beacon?season=FALL-2026&run=${meta.runId}`,
    )
    expect(fetcher).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({ credentials: 'omit' }),
    )
  })

  it('loads public detail and history, then pins the timeline and opens a linked task', async () => {
    const fetcher = renderReadPage(
      '/projects/beacon?season=FALL-2026#task-UI%3A1',
      <Routes>
        <Route path="/projects/:projectPk" element={<ProjectPage />} />
      </Routes>,
      (url) => {
        if (url.pathname.endsWith('/sow-timeline')) return { meta, data: timeline }
        if (url.pathname.endsWith('/history'))
          return [
            {
              runId: 'prior',
              asOf: '2026-11-01T00:00:00Z',
              percentComplete: 0,
              tasksOverdue: 0,
              riskCounts: {},
            },
            { ...meta, percentComplete: 25, tasksOverdue: 1, riskCounts: {} },
          ]
        return { meta, data: { summary, detail } }
      },
      true,
    )
    expect(await screen.findByRole('heading', { name: 'Beacon' })).toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: 'SOW progress' })).toBeInTheDocument()
    expect(screen.getByText('Prepare the release').closest('details')).toHaveAttribute('open')
    expect(screen.getByText('Two reviews are overdue.')).toBeInTheDocument()
    expect(screen.getByText('More PRs merged this week.')).toBeInTheDocument()
    expect(
      within(screen.getByRole('region', { name: 'Ownership' })).getByText('3'),
    ).toBeInTheDocument()
    const history = await screen.findByText('SOW completion by run')
    const [first, last] = history.closest('figure')!.querySelectorAll('circle')
    expect(first).toHaveAttribute('cy', '126')
    expect(last).toHaveAttribute('cy', '97.5')
    expect(
      screen.getByText('Median open PR age').closest('figure')?.querySelectorAll('circle'),
    ).toHaveLength(1)
    const calls = fetcher.mock.calls.map(([input]) => new URL(String(input)))
    expect(
      calls.find((url) => url.pathname.endsWith('/sow-timeline'))?.searchParams.get('run'),
    ).toBe(meta.runId)
  })
})
