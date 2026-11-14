import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { renderReadPage } from '../../test/render-read-page'
import { ada, currentRun, finalRun } from '../../test/rankingFixtures'
import { RankingsPage } from './RankingsPage'

const rows = [
  {
    ...ada,
    userPk: 'member-d',
    name: 'Dora',
    status: 'insufficient_data',
    rankInGroup: null,
    overallScore: 55,
  },
  ada,
  { ...ada, userPk: 'member-c', name: 'Clara', status: 'group_too_small', rankInGroup: null },
  {
    ...ada,
    userPk: 'member-b',
    name: 'Finn',
    projectPk: 'atlas',
    projectName: 'Atlas',
    comparisonGroup: 'atlas-group',
    comparisonGroupLabel: 'Project Atlas',
  },
]

function rankings(url: URL) {
  if (url.pathname === '/api/semesters')
    return [
      { seasonType: 'FALL', seasonYear: 2026 },
      { seasonType: 'SPRING', seasonYear: 2026 },
    ]
  if (url.pathname.endsWith('/runs')) return [currentRun, finalRun]
  if (url.pathname !== '/api/v1/rankings') return undefined
  const project = url.searchParams.get('projectPk')
  const techLeads = url.searchParams.get('role') === 'tech_lead'
  const selectedRun = url.searchParams.get('run')
  const items = techLeads
    ? [ada, rows[3]].map((row) => ({ ...row, role: 'tech_lead' }))
    : rows.filter((row) => !project || row.projectPk === project)
  return {
    ...(selectedRun === 'final' || selectedRun === finalRun.rankingRunId ? finalRun : currentRun),
    items,
    page: 1,
    total: items.length,
    pageSize: 25,
    projects: [
      { projectPk: 'beacon', friendlyName: 'Beacon' },
      { projectPk: 'atlas', friendlyName: 'Atlas' },
    ],
  }
}

function renderRankings(path = '/rankings?season=FALL-2026') {
  return renderReadPage(
    path,
    <Routes>
      <Route path="/rankings" element={<RankingsPage />} />
      <Route path="/rankings/members/:userPk" element={<h1>Member detail</h1>} />
    </Routes>,
    rankings,
  )
}

describe('published rankings', () => {
  it('groups engineers and puts unranked rows after ranked rows without showing their scores', async () => {
    renderRankings()
    const beacon = await screen.findByRole('table', { name: 'Rankings · Project Beacon' })
    expect(screen.getByRole('heading', { name: 'Project Atlas' })).toBeInTheDocument()
    const [, first, second, third] = within(beacon).getAllByRole('row')
    expect(first).toHaveTextContent('Ada')
    expect(first).toHaveTextContent('80%')
    expect(within(first!).getByRole('meter', { name: /Code ownership/ })).toHaveAttribute(
      'value',
      '72',
    )
    expect(second).toHaveTextContent('Dora')
    expect(third).toHaveTextContent('Clara')
    expect(within(second!).queryByRole('meter')).not.toBeInTheDocument()
    expect(within(third!).queryByRole('meter')).not.toBeInTheDocument()
    expect(within(third!).getByText('Group too small')).toHaveAttribute(
      'title',
      'Too few members qualified for a comparison.',
    )
    expect(screen.getByText('Provisional')).toBeInTheDocument()
  })

  it('writes filters to the URL, refetches and uses one club-wide tech lead list', async () => {
    const user = userEvent.setup()
    const fetcher = renderRankings()
    await screen.findByRole('link', { name: 'Finn' })
    await user.selectOptions(screen.getByRole('combobox', { name: 'Project' }), 'atlas')
    expect(
      await screen.findByRole('table', { name: 'Rankings · Project Atlas' }),
    ).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Ada' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Location')).toHaveTextContent('projectPk=atlas')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Role' }), 'tech_lead')
    expect(await screen.findByRole('table', { name: 'Rankings · Tech leads' })).toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: 'Project' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Location')).not.toHaveTextContent('projectPk')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Semester' }), 'SPRING-2026')
    await waitFor(() =>
      expect(
        fetcher.mock.calls.some(([input]) => {
          const url = new URL(String(input))
          return (
            url.pathname === '/api/v1/rankings' &&
            url.searchParams.get('season') === 'SPRING-2026' &&
            url.searchParams.get('role') === 'tech_lead'
          )
        }),
      ).toBe(true),
    )
    expect(screen.getByLabelText('Location')).toHaveTextContent('season=SPRING-2026')
  })

  it('selects final or a dated run and navigates to the exact published member run on row click', async () => {
    const user = userEvent.setup()
    renderRankings()
    const selector = await screen.findByRole('combobox', { name: 'Run' })
    await screen.findByRole('option', { name: /Final ·/ })
    await user.selectOptions(selector, 'final')
    expect(await screen.findByText('Final', { exact: true })).toBeInTheDocument()
    expect(screen.getByLabelText('Location')).toHaveTextContent('run=final')
    await user.selectOptions(selector, currentRun.rankingRunId)
    const link = await screen.findByRole('link', { name: 'Ada' })
    expect(link).toHaveAttribute('href', expect.stringContaining(`run=${currentRun.rankingRunId}`))
    await user.click(within(link.closest('tr')!).getByText('Beacon'))
    expect(screen.getByRole('heading', { name: 'Member detail' })).toBeInTheDocument()
    expect(screen.getByLabelText('Location')).toHaveTextContent(
      `/rankings/members/member-a?season=FALL-2026&run=${currentRun.rankingRunId}`,
    )
  })
})
