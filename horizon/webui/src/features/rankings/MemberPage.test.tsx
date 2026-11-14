import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { ada, currentRun } from '../../test/rankingFixtures'
import { renderReadPage } from '../../test/render-read-page'
import { formatMetric } from './formatMetric'
import { MemberPage } from './MemberPage'

const reviewMissing = {
  label: 'Review turnaround',
  unit: 'hours',
  rawValue: null,
  percentile: null,
  missingReason: 'no_review_requests',
  evidence: [],
}
const document = {
  member: ada,
  overall: {
    score: 80,
    rank: 2,
    rankedInGroup: 5,
    comparisonGroupLabel: 'Project Beacon',
    coverage: 0.8,
    status: 'ranked',
  },
  explanation: {
    text: 'Ada completed the first delivery milestone.',
    generated: true,
    dataGaps: ['no_review_requests'],
  },
  buckets: [
    {
      label: 'Delivery',
      weight: 0.2,
      score: 71,
      note: 'Based on published task matches.',
      metrics: [
        {
          label: 'On-time completion',
          unit: 'ratio',
          rawValue: 0.75,
          percentile: 84,
          evidence: [
            { type: 'pr', number: 16, url: 'https://git.example.com/beacon/web/pulls/16' },
            { type: 'sow_task', taskKey: 'UI:1' },
          ],
        },
        reviewMissing,
      ],
    },
  ],
  history: [
    { runId: 'run-1', asOf: '2026-11-01T00:00:00Z', score: 72, rank: 3 },
    { runId: 'run-2', asOf: '2026-11-08T00:00:00Z', score: 80, rank: 2 },
  ],
}
const otherDocument = {
  ...document,
  member: { ...ada, projectPk: 'atlas', projectName: 'Atlas' },
  overall: {
    ...document.overall,
    comparisonGroupLabel: 'Project Atlas',
    status: 'insufficient_data',
    score: 68,
  },
  explanation: {
    text: 'Too few records for a score.',
    generated: false,
    dataGaps: ['no_peer_ratings'],
  },
  buckets: [{ label: 'Review', weight: 0.15, score: null, note: null, metrics: [reviewMissing] }],
}
const path = `/rankings/members/member-a?season=FALL-2026&run=${currentRun.rankingRunId}`

function show(url: string, wire: unknown) {
  return renderReadPage(
    url,
    <Routes>
      <Route path="/rankings/members/:userPk" element={<MemberPage />} />
    </Routes>,
    (request) => (request.pathname === '/api/v1/rankings/members/member-a' ? wire : undefined),
  )
}

describe('member ranking detail', () => {
  it('renders publication numbers, missing evidence, trend values and evidence links', async () => {
    const fetcher = show(path, { items: [{ document }] })
    expect(await screen.findByRole('heading', { name: 'Ada' })).toBeInTheDocument()
    expect(screen.getByText('2 of 5 engineers on Project Beacon')).toBeInTheDocument()
    expect(screen.getByText('Coverage 80%')).toBeInTheDocument()
    expect(screen.getByRole('meter', { name: 'Overall score' })).toHaveAttribute('value', '80')
    expect(
      screen.getByRole('heading', { name: 'Generated explanation of the numbers below' }),
    ).toBeInTheDocument()
    expect(screen.getAllByText('No review requests were available in this semester.')).toHaveLength(
      2,
    )
    expect(screen.getByText('75%')).toBeInTheDocument()
    expect(screen.getByText('Percentile 84')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'PR #16' })).toHaveAttribute(
      'href',
      'https://git.example.com/beacon/web/pulls/16',
    )
    expect(screen.getByRole('link', { name: 'UI:1' })).toHaveAttribute(
      'href',
      '/projects/beacon?season=FALL-2026#task-UI%3A1',
    )
    expect(screen.getByRole('button', { name: 'Flag for calibration' })).toBeDisabled()
    expect(
      (await screen.findByText('Score by run')).closest('figure')?.querySelectorAll('circle'),
    ).toHaveLength(2)
    expect(
      screen.getByText('Rank by run').closest('figure')?.querySelectorAll('circle'),
    ).toHaveLength(2)
    expect(String(fetcher.mock.calls[0]?.[0])).toContain(`run=${currentRun.rankingRunId}`)
  })

  it('switches between projects without refetching and shows reasons with withheld scores', async () => {
    const user = userEvent.setup()
    const fetcher = show(path, { items: [{ document }, { document: otherDocument }] })
    const select = await screen.findByRole('combobox', { name: 'Project' })
    await user.selectOptions(select, 'atlas')
    expect(screen.getByLabelText('Location')).toHaveTextContent('projectPk=atlas')
    expect(
      within(screen.getByRole('region', { name: 'Overall ranking' })).queryByRole('meter'),
    ).not.toBeInTheDocument()
    expect(
      screen.getByText('Too little evidence was available to publish a score.'),
    ).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Summary (automatic)' })).toBeInTheDocument()
    expect(screen.getByText('No eligible peer ratings were recorded.')).toBeInTheDocument()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('renders the persisted T6.2 rows when the full Track 4 document is absent', async () => {
    show(path, { items: [{ ranking: ada, metrics: [], explanations: [] }], history: [] })
    expect(await screen.findByRole('heading', { name: 'Ada' })).toBeInTheDocument()
    expect(screen.getByRole('meter', { name: 'Overall score' })).toHaveAttribute('value', '80')
  })

  it.each([
    [123, 'lines', '123 lines'],
    [8, 'files', '8 files'],
    [11, 'commits', '11 commits'],
    [2, 'PRs', '2 PRs'],
    [1.5, 'hours', '1.5 hours'],
    [0.75, 'ratio', '75%'],
    [2.6, 'rating_1_3', '2.6 / 3'],
    [3, 'semesters', '3 semesters'],
  ] as const)('formats %d %s', (value, unit, expected) => {
    expect(formatMetric(value, unit)).toBe(expected)
  })
})
