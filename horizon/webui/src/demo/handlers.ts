import { http, HttpResponse, passthrough } from 'msw'
import { DEMO_PREFIX, isDemoPath } from './policy'
import {
  components,
  coverage,
  fictionalMembers,
  fictionalProjects,
  healthPeriods,
  projects,
  publication,
  rankingPeriods,
  rankings,
  portfolioSnapshot,
} from './fixtures'
import { isDemoScenario } from './scenarios'

const headers = { 'x-horizon-demo': 'fictional', 'Cache-Control': 'no-store' }
function json(value: unknown, status = 200) {
  return new HttpResponse(JSON.stringify(value), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' },
  })
}
function page<T>(
  items: T[],
  cursor: string | null,
  limit: number,
  state: ReturnType<typeof publication>,
) {
  const offset = cursor?.match(/^fiction-offset-(\d+)$/)?.[1]
  const start = offset ? Number(offset) : 0
  return {
    items: items.slice(start, start + limit),
    page: { nextCursor: start + limit < items.length ? `fiction-offset-${start + limit}` : null },
    publication: state,
    capabilities: [],
  }
}
function pause(request: Request, milliseconds: number) {
  return new Promise<void>((resolve) => {
    if (request.signal.aborted) {
      resolve()
      return
    }
    const done = () => {
      clearTimeout(timer)
      request.signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, milliseconds)
    request.signal.addEventListener('abort', done, { once: true })
  })
}
export function createDemoHandlers(origin: string) {
  return [
    http.get(`${origin}${DEMO_PREFIX}*`, async ({ request }) => {
      const url = new URL(request.url)
      if (!isDemoPath(url)) return HttpResponse.error()
      const path = url.pathname.slice(DEMO_PREFIX.length)
      const periodId = url.searchParams.get('periodId') ?? ''
      const requested = url.searchParams.get('scenario')
      const scenario = isDemoScenario(requested) ? requested : 'success'
      const filters = [
        {
          key: 'coverage',
          label: 'Evidence coverage',
          options: ['complete', 'partial', 'missing'].map((value) => ({ value, label: value })),
        },
      ]
      // Keep selectors available while simulating failures of the actual data reads.
      if (path === 'ranking-periods')
        return json({ periods: rankingPeriods, availableFilters: filters })
      if (path === 'health-periods')
        return json({ periods: healthPeriods, availableFilters: filters })
      if (scenario === 'slow' || scenario === 'loading')
        await pause(request, scenario === 'slow' ? 1_500 : 30_000)
      if (scenario === 'error') return json({ message: 'Fictional server failure' }, 500)
      if (scenario === 'unauthorized' || scenario === 'forbidden')
        return json(
          { message: 'Simulated access denial; no real session was used.' },
          scenario === 'unauthorized' ? 401 : 403,
        )
      const metadata = publication(
        ['stale', 'provisional', 'missing'].includes(scenario)
          ? (scenario as 'stale' | 'provisional' | 'missing')
          : 'current',
      )
      const absent = scenario === 'empty' || scenario === 'missing'
      if (path === 'portfolio') {
        const snapshot = url.searchParams.get('snapshot') || healthPeriods[0]!.id
        if (!healthPeriods.some((period) => period.id === snapshot))
          return json({ message: 'Unknown fictional snapshot' }, 404)
        return json({
          ...portfolioSnapshot(snapshot),
          publication: metadata,
          ...(absent ? { projects: [], changes: [] } : {}),
        })
      }
      const limit = Math.min(5, Math.max(1, Number(url.searchParams.get('pageSize')) || 3))
      const cursor = url.searchParams.get('cursor')
      const search = (url.searchParams.get('q') ?? '').toLowerCase()
      const completeness = url.searchParams.get('coverage')
      if (path === 'rankings') {
        if (!rankingPeriods.some((item) => item.id === periodId))
          return json({ message: 'Unknown fictional semester' }, 400)
        const rows = absent
          ? []
          : rankings(periodId).filter(
              (item) =>
                item.displayName.toLowerCase().includes(search) &&
                (!completeness || item.coverage.state === completeness),
            )
        return json(page(rows, cursor, limit, metadata))
      }
      if (path === 'health') {
        if (!healthPeriods.some((item) => item.id === periodId))
          return json({ message: 'Unknown fictional reporting period' }, 400)
        const rows = absent
          ? []
          : projects(periodId).filter(
              (item) =>
                item.name.toLowerCase().includes(search) &&
                (!completeness || item.coverage.state === completeness),
            )
        return json(page(rows, cursor, limit, metadata))
      }
      const parts = path.split('/')
      if (parts[0] === 'members' && parts[1]) {
        const index = fictionalMembers.findIndex((member) => member.memberId === parts[1])
        if (index < 0) return json({ message: 'Unknown fictional member' }, 404)
        if (parts[2] === 'history')
          return json(
            page(
              absent
                ? []
                : rankingPeriods.map((period) => ({
                    periodId: period.id,
                    overallScore: rankings(period.id)[index]!.overallScore,
                    scoreUnit: 'illustrative points / 100',
                    coverage: coverage(index),
                  })),
              cursor,
              limit,
              metadata,
            ),
          )
        if (!rankingPeriods.some((item) => item.id === periodId))
          return json({ message: 'Unknown fictional semester' }, 400)
        return json({
          data: absent
            ? null
            : {
                ...fictionalMembers[index],
                periodId,
                components: components(
                  index,
                  rankingPeriods.findIndex((period) => period.id === periodId),
                ),
                coverage: coverage(index),
              },
          publication: metadata,
          capabilities: [],
        })
      }
      if (parts[0] === 'projects' && parts[1]) {
        const index = fictionalProjects.findIndex((project) => project.projectId === parts[1])
        if (index < 0) return json({ message: 'Unknown fictional project' }, 404)
        if (parts[2] === 'history')
          return json(
            page(
              absent
                ? []
                : healthPeriods.map((period, periodIndex) => ({
                    periodId: period.id,
                    components: components(index, periodIndex, true),
                  })),
              cursor,
              limit,
              metadata,
            ),
          )
        if (!healthPeriods.some((item) => item.id === periodId))
          return json({ message: 'Unknown fictional reporting period' }, 400)
        return json({
          data: absent
            ? null
            : {
                ...fictionalProjects[index],
                periodId,
                components: components(
                  index,
                  healthPeriods.findIndex((period) => period.id === periodId),
                  true,
                ),
                evidence: components(index, 0, true).flatMap((item) => item.evidence),
                coverage: coverage(index),
              },
          publication: metadata,
          capabilities: [],
        })
      }
      return json({ message: 'Unregistered demo read' }, 404)
    }),
    http.all('*', ({ request }) => {
      const url = new URL(request.url)
      // Only local browser assets may pass through. Programmatic/unhandled reads fail closed.
      if (
        url.origin === origin &&
        !url.pathname.startsWith('/api/') &&
        ['document', 'script', 'style', 'image', 'font'].includes(request.destination)
      )
        return passthrough()
      return HttpResponse.error()
    }),
  ]
}
