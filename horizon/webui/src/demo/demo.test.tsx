import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { setupServer } from 'msw/node'
import { App } from '../app/App'
import { createDemoExperience } from './experience'
import { createDemoHandlers } from './handlers'
import { createDemoReadClient } from './client'
import { createDemoContracts } from './contracts'
import { demoAllowed, isDemoPath } from './policy'
import { rankingPeriods, healthPeriods } from './fixtures'
import type { DemoScenario } from './scenarios'

const origin = window.location.origin
const server = setupServer(...createDemoHandlers(origin))
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
beforeEach(() => vi.stubEnv('VITE_HORIZON_DEMO', 'true'))
afterEach(() => {
  server.resetHandlers()
  vi.unstubAllEnvs()
})
afterAll(() => server.close())
const client = (scenario: DemoScenario = 'success') =>
  createDemoReadClient({ origin, ready: () => true, scenario })
const operation = (scenario: DemoScenario = 'success') =>
  createDemoContracts(scenario).rankings!({ periodId: rankingPeriods[0]!.id, pageSize: 3 })

describe('demo isolation', () => {
  it.each([
    [false, true, 'true', 'localhost'],
    [true, false, 'true', 'localhost'],
    [true, true, undefined, 'localhost'],
    [true, true, 'false', 'localhost'],
    [true, true, 'true', 'horizon.example.org'],
  ])('fails closed for build=%s development=%s setting=%s host=%s', (build, dev, setting, host) => {
    expect(demoAllowed(build as boolean, dev as boolean, setting, host as string)).toBe(false)
  })
  it('requires explicit loopback development and never marks contracts approved', () => {
    expect(demoAllowed(true, true, 'true', '127.0.0.1')).toBe(true)
    expect(createDemoContracts('success').reviewStatus).toBe('demo')
    expect(isDemoPath(new URL('https://production.example/__horizon_demo__/rankings'))).toBe(false)
  })
  it.each([
    '/api/rankings',
    'https://production.example/api/rankings',
    '//production.example/api/rankings',
    '/__horizon_demo__/../api/rankings',
    '/__horizon_demo__/%2e%2e/api/rankings',
    '/__horizon_demo__/%2fapi',
  ])('rejects %s before sending any request', async (path) => {
    const fetcher = vi.fn()
    const isolated = createDemoReadClient({
      origin,
      scenario: 'success',
      ready: () => true,
      fetcher,
    })
    await expect(isolated.get({ path, parse: (value) => value })).rejects.toMatchObject({
      kind: 'unavailable',
    })
    expect(fetcher).not.toHaveBeenCalled()
  })
  it.each([
    { buildAllowsDemo: false },
    { development: false },
    { setting: 'false' },
    { ready: () => false },
  ])('does not fetch when the production or startup gate is closed (%j)', async (options) => {
    const fetcher = vi.fn()
    const isolated = createDemoReadClient({
      origin,
      scenario: 'success',
      ready: () => true,
      fetcher,
      ...options,
    })
    await expect(isolated.get(operation())).rejects.toMatchObject({ kind: 'unavailable' })
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('uses only the reserved local namespace, omits credentials, and refuses unmarked responses', async () => {
    const fetcher = vi.fn(fetch)
    const isolated = createDemoReadClient({
      origin,
      scenario: 'success',
      ready: () => true,
      fetcher,
    })
    await isolated.get(operation())
    expect(fetcher).toHaveBeenCalledOnce()
    const [url, options] = fetcher.mock.calls[0]!
    expect(new URL(String(url)).origin).toBe(origin)
    expect(new URL(String(url)).pathname).toMatch(/^\/__horizon_demo__\//)
    expect(options).toMatchObject({ credentials: 'omit', redirect: 'error', cache: 'no-store' })
    const unmarked = createDemoReadClient({
      origin,
      scenario: 'success',
      ready: () => true,
      fetcher: vi.fn().mockResolvedValue(Response.json({ real: 'must not render' })),
    })
    await expect(unmarked.get(operation())).rejects.toMatchObject({ kind: 'unavailable' })
  })
  it('MSW blocks unregistered local and remote API requests instead of passing through', async () => {
    await expect(fetch(`${origin}/api/protected`)).rejects.toThrow()
    await expect(fetch('https://production.example/api/protected')).rejects.toThrow()
  })
})

describe('fictional read responses through MSW and the shared HTTP transport', () => {
  it('paginates, filters, and changes semesters deterministically', async () => {
    const api = client()
    const contracts = createDemoContracts('success')
    const first = await api.get(operation())
    expect(first.items.map((item) => item.displayName)).toEqual([
      'Mira Solen',
      'Theo Marlow',
      'Iris Fenwick',
    ])
    const next = await api.get(
      contracts.rankings!({
        periodId: rankingPeriods[0]!.id,
        cursor: first.page.nextCursor,
        pageSize: 3,
      }),
    )
    expect(next.items[0]!.displayName).toBe('Rowan Vale')
    const filtered = await api.get(
      contracts.rankings!({
        periodId: rankingPeriods[1]!.id,
        filters: { q: 'Mira', coverage: 'complete' },
      }),
    )
    expect(filtered.items).toHaveLength(1)
    expect(filtered.items[0]!.overallScore).not.toBe(first.items[0]!.overallScore)
  })
  it('provides member components, fictional evidence, and three-semester history', async () => {
    const api = client()
    const contracts = createDemoContracts('success')
    const detail = await api.get(contracts.member!('fiction-member-1', rankingPeriods[0]!.id))
    expect(detail.data!.components).toHaveLength(3)
    expect(detail.data!.components[0]!.evidence[0]).toMatchObject({
      href: null,
      sourceType: 'fictional fixture',
    })
    const history = await api.get(contracts.rankingHistory!('fiction-member-1', null))
    expect(history.items).toHaveLength(3)
    expect(new Set(history.items.map((item) => item.overallScore)).size).toBe(3)
  })
  it('provides project signals, completeness, detail and paginated four-period trends', async () => {
    const api = client()
    const contracts = createDemoContracts('success')
    const list = await api.get(
      contracts.projectHealth!({
        periodId: healthPeriods[0]!.id,
        filters: { coverage: 'partial' },
      }),
    )
    expect(list.items[0]!.name).toBe('Copper Kite')
    const detail = await api.get(contracts.project!('fiction-project-3', healthPeriods[0]!.id))
    expect(detail.data!.coverage.state).toBe('partial')
    expect(detail.data!.evidence.length).toBeGreaterThan(0)
    const history = await api.get(contracts.healthHistory!('fiction-project-3', null))
    const next = await api.get(
      contracts.healthHistory!('fiction-project-3', history.page.nextCursor),
    )
    expect(history.items.length + next.items.length).toBe(4)
    expect(next.items[0]!.components[0]!.value).not.toBe(history.items[0]!.components[0]!.value)
  })
  it.each(['empty', 'stale', 'provisional', 'missing'] as const)(
    'supports %s publication/results',
    async (scenario) => {
      const result = await client(scenario).get(operation(scenario))
      expect(result.publication.state).toBe(scenario === 'empty' ? 'current' : scenario)
      expect(result.items.length).toBe(['empty', 'missing'].includes(scenario) ? 0 : 3)
    },
  )
  it.each([
    ['error', 'http', 500],
    ['unauthorized', 'unauthorized', 401],
    ['forbidden', 'forbidden', 403],
  ] as const)('returns safe %s failures', async (scenario, kind, status) => {
    await expect(client(scenario).get(operation(scenario))).rejects.toMatchObject({ kind, status })
  })
  it('keeps slow reads pending before returning normal data', async () => {
    let settled = false
    const pending = client('slow')
      .get(operation('slow'))
      .then((value) => {
        settled = true
        return value
      })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(settled).toBe(false)
    expect((await pending).items).toHaveLength(3)
  })
})

function renderDemo(path = '/rankings') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App experience={createDemoExperience(() => true)} />
    </MemoryRouter>,
  )
}
describe('demo pages use React Query without authenticating', () => {
  it('labels records, navigates pagination, filters, and opens component/history detail', async () => {
    const user = userEvent.setup()
    renderDemo()
    expect(await screen.findByRole('link', { name: 'Mira Solen' })).toBeInTheDocument()
    expect(screen.getAllByText('DEMO DATA').length).toBeGreaterThan(1)
    await user.click(screen.getByRole('button', { name: 'Next' }))
    expect(await screen.findByRole('link', { name: 'Rowan Vale' })).toBeInTheDocument()
    await user.type(screen.getByRole('searchbox', { name: 'Search' }), 'Mira')
    await user.click(await screen.findByRole('link', { name: 'Mira Solen' }))
    expect(
      await screen.findByRole('heading', { name: 'Engineering contribution' }),
    ).toBeInTheDocument()
    expect(
      await screen.findByRole('table', { name: 'Member semester history' }),
    ).toBeInTheDocument()
  })
  it.each([
    ['empty', 'No results match this view.'],
    ['unauthorized', 'Session expired'],
    ['forbidden', 'Access restricted'],
    ['stale', 'This information may be out of date.'],
    ['provisional', 'Provisional result — not a final published assessment.'],
    ['missing', 'No published result'],
  ] as const)(
    'switches to %s without retaining the previous scenario records',
    async (scenario, text) => {
      const user = userEvent.setup()
      renderDemo()
      await screen.findByRole('link', { name: 'Mira Solen' })
      await user.selectOptions(
        screen.getByRole('combobox', { name: 'Response scenario' }),
        scenario,
      )
      expect(await screen.findByText(text, { exact: false })).toBeInTheDocument()
      if (['empty', 'unauthorized', 'forbidden', 'missing'].includes(scenario))
        expect(screen.queryByRole('link', { name: 'Mira Solen' })).not.toBeInTheDocument()
    },
  )
  it('shows loading and cancels delayed reads when switching back', async () => {
    const user = userEvent.setup()
    renderDemo()
    await screen.findByRole('link', { name: 'Mira Solen' })
    await user.selectOptions(screen.getByRole('combobox', { name: 'Response scenario' }), 'loading')
    expect(await screen.findByText('Loading Horizon data')).toBeInTheDocument()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Response scenario' }), 'success')
    expect(await screen.findByRole('link', { name: 'Mira Solen' })).toBeInTheDocument()
  })
  it('keeps Authentik unavailable and sends no requests from sign-in', async () => {
    const requests = vi.fn()
    server.events.on('request:start', requests)
    renderDemo('/sign-in')
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Continue with Authentik' })).toBeDisabled(),
    )
    expect(screen.getByText(/Your People Portal session is not used/)).toBeInTheDocument()
    expect(requests).not.toHaveBeenCalled()
    server.events.removeListener('request:start', requests)
  })
  it('keeps registered protected routes locked even while demo reads work', async () => {
    const experience = createDemoExperience(() => true)
    experience.routes = [
      ...experience.routes,
      { path: '/private', title: 'Private', protected: true, element: <p>Must never mount</p> },
    ]
    render(
      <MemoryRouter initialEntries={['/private']}>
        <App experience={experience} />
      </MemoryRouter>,
    )
    expect(await screen.findByText('Protected workspace unavailable')).toBeInTheDocument()
    expect(screen.queryByText('Must never mount')).not.toBeInTheDocument()
  })
  it('renders server failures after the shared retry policy finishes', async () => {
    const user = userEvent.setup()
    renderDemo()
    await screen.findByRole('link', { name: 'Mira Solen' })
    await user.selectOptions(screen.getByRole('combobox', { name: 'Response scenario' }), 'error')
    expect(
      await screen.findByText('Unable to load information', {}, { timeout: 4500 }),
    ).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Mira Solen' })).not.toBeInTheDocument()
  })
  it('opens project detail and historical trends from the dashboard', async () => {
    const user = userEvent.setup()
    renderDemo('/dashboard')
    await user.click(await screen.findByRole('link', { name: /Fable Works/ }))
    await user.click(screen.getByRole('link', { name: 'Inspect component evidence →' }))
    expect(await screen.findByRole('heading', { name: 'Delivery progress' })).toBeInTheDocument()
    expect(await screen.findByRole('table', { name: 'Project health history' })).toBeInTheDocument()
    await user.click(screen.getByRole('link', { name: '← All project health' }))
    expect(await screen.findByRole('heading', { name: 'All projects' })).toBeInTheDocument()
  })
})

describe('Yash reference portfolio interactions', () => {
  it('shows snapshot-backed summary cards and links into project filters', async () => {
    const user = userEvent.setup()
    renderDemo('/dashboard')
    await screen.findByRole('link', { name: /Fable Works/ })
    expect(screen.getByRole('link', { name: /Active Projects/ })).toHaveTextContent('5')
    await user.click(screen.getByRole('link', { name: /Needs Attention/ }))
    expect(await screen.findByRole('heading', { name: 'All projects' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Needs Attention' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })
  it('filters grouped companies and clears selection when there are no matches', async () => {
    const user = userEvent.setup()
    renderDemo('/projects')
    await screen.findByRole('group', { name: 'Company results' })
    await user.click(screen.getByRole('button', { name: 'At Risk' }))
    await waitFor(() =>
      expect(
        within(screen.getByRole('group', { name: 'Company results' })).getAllByRole('button'),
      ).toHaveLength(1),
    )
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Copper Kite')
    await user.type(
      screen.getByRole('searchbox', { name: 'Search companies or projects' }),
      'not-a-fictional-company',
    )
    expect(
      await screen.findByText('No companies or projects match these filters.'),
    ).toBeInTheDocument()
    expect(screen.getByText('Select an available project')).toBeInTheDocument()
    expect(screen.queryByRole('tabpanel')).not.toBeInTheDocument()
  })
  it('supports selected project tabs, keyboard navigation, and real snapshot changes', async () => {
    const user = userEvent.setup()
    renderDemo('/projects')
    await screen.findByRole('group', { name: 'Company results' })
    await user.click(screen.getByRole('tab', { name: 'Overview' }))
    await user.keyboard('{End}')
    expect(screen.getByRole('tab', { name: 'History' })).toHaveAttribute('aria-selected', 'true')
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Portfolio snapshot' }),
      healthPeriods[1]!.id,
    )
    await waitFor(() =>
      expect(screen.getByRole('tabpanel')).toHaveTextContent('Historical trend analysis'),
    )
    await user.click(screen.getByRole('tab', { name: 'Overview' }))
    expect(screen.getByRole('link', { name: 'Inspect component evidence →' })).toHaveAttribute(
      'href',
      `/projects/fiction-project-1?periodId=${healthPeriods[1]!.id}`,
    )
    await user.click(screen.getByRole('tab', { name: 'Progress' }))
    expect(screen.getByText('Milestone evidence unavailable')).toBeInTheDocument()
  })
  it('switches Insights metrics and supports status/search filtering', async () => {
    const user = userEvent.setup()
    renderDemo('/insights')
    await screen.findByRole('table', { name: 'Portfolio comparison' })
    await user.click(screen.getByRole('button', { name: 'Review latency (days)' }))
    expect(screen.getByRole('columnheader', { name: 'Review latency (days)' })).toBeInTheDocument()
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Comparison status' }),
      'insufficient',
    )
    expect(screen.getByRole('table')).toHaveTextContent('Meadow Lab')
    expect(screen.getByRole('table')).toHaveTextContent('Unavailable')
    await user.type(screen.getByRole('searchbox', { name: 'Search comparisons' }), 'absent')
    expect(screen.getByText('No matching companies or projects.')).toBeInTheDocument()
  })
  it('does not retain portfolio records after a fictional 403', async () => {
    const user = userEvent.setup()
    renderDemo('/projects')
    await screen.findByRole('group', { name: 'Company results' })
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Response scenario' }),
      'forbidden',
    )
    expect(await screen.findByText('Access restricted')).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Company results' })).not.toBeInTheDocument()
    expect(screen.queryByRole('tabpanel')).not.toBeInTheDocument()
  })
})
