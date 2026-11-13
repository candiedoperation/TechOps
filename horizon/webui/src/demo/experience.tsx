import { useMemo, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { AppExperience } from '../app/App'
import { horizonRoutes } from '../app/routes'
import { ReadClientContext } from '../api/context'
import {
  ReadRankingsPage,
  ReadMemberDetailPage,
  ReadProjectDetailPage,
} from '../features/reads/ReadPages'
import { createDemoReadClient } from './client'
import { createDemoContracts } from './contracts'
import { DemoContext, useDemo } from './context'
import { demoScenarios, isDemoScenario, type DemoScenario } from './scenarios'
import { PortfolioProvider } from '../features/portfolio/PortfolioProvider'
import { PortfolioDashboard, PortfolioProjects } from '../features/portfolio/PortfolioPages'
import { parsePortfolio } from './parsers'
import { DEMO_PREFIX } from './policy'

export function DemoToolbar() {
  const { scenario, changeScenario } = useDemo()
  return (
    <aside className="demo-banner" aria-label="Fictional demo environment">
      <div>
        <strong>DEMO DATA</strong>
        <p>Entirely fictional · No live data · Authentik is not simulated</p>
      </div>
      <label>
        Response scenario
        <select
          value={scenario}
          onChange={(event) => {
            if (isDemoScenario(event.target.value)) changeScenario(event.target.value)
          }}
        >
          {demoScenarios.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </label>
    </aside>
  )
}
export function Dashboard() {
  return <PortfolioDashboard />
}
export function Rankings() {
  return <ReadRankingsPage registry={useDemo().registry} scoreMaximum={100} />
}
export function Projects() {
  return <PortfolioProjects />
}
export function DemoPortfolioProvider({ children }: { children: ReactNode }) {
  const { scenario } = useDemo()
  return (
    <PortfolioProvider
      operationForSnapshot={(snapshot) => ({
        path: `${DEMO_PREFIX}portfolio?${new URLSearchParams({ snapshot, scenario })}`,
        parse: parsePortfolio,
      })}
    >
      {children}
    </PortfolioProvider>
  )
}
export function Member() {
  return <ReadMemberDetailPage registry={useDemo().registry} scoreMaximum={100} />
}
export function Project() {
  return <ReadProjectDetailPage registry={useDemo().registry} scoreMaximum={100} />
}

/** This provider supplies fictional reads only. It never changes AuthProvider or ProtectedRoute. */
// Factory is created once at bootstrap; its provider identity must remain stable.
// eslint-disable-next-line react-refresh/only-export-components
export function createDemoExperience(ready: () => boolean): AppExperience {
  function DemoReadProvider({ children }: { children: ReactNode }) {
    const [scenario, setScenario] = useState<DemoScenario>('success')
    const queryClient = useQueryClient()
    const client = useMemo(
      () => createDemoReadClient({ origin: window.location.origin, scenario, ready }),
      [scenario],
    )
    const registry = useMemo(() => createDemoContracts(scenario), [scenario])
    return (
      <DemoContext.Provider
        value={{
          scenario,
          registry,
          changeScenario: (value) => {
            // Cancel delayed handlers and discard the preceding scenario's cached records.
            void queryClient.cancelQueries({ queryKey: ['horizon'] })
            queryClient.removeQueries({ queryKey: ['horizon'] })
            setScenario(value)
          },
        }}
      >
        <ReadClientContext.Provider value={client}>{children}</ReadClientContext.Provider>
      </DemoContext.Provider>
    )
  }
  return {
    ReadProvider: DemoReadProvider,
    PortfolioProvider: DemoPortfolioProvider,
    banner: <DemoToolbar />,
    routes: [
      ...horizonRoutes
        .filter(
          (route) => !['/rankings/members/:userPk', '/projects/:projectPk'].includes(route.path),
        )
        .map((route) => ({
          ...route,
          // Fictional preview navigation only; no verified identity or permission is created.
          navigation: route.navigation ? { ...route.navigation, executiveOnly: false } : undefined,
          element:
            route.path === '/dashboard' ? (
              <Dashboard />
            ) : route.path === '/rankings' ? (
              <Rankings />
            ) : ['/projects', '/project-health'].includes(route.path) ? (
              <Projects />
            ) : (
              route.element
            ),
        })),
      { path: '/rankings/members/:userPk', title: 'Member profile', element: <Member /> },
      { path: '/projects/:projectPk', title: 'Project detail', element: <Project /> },
      { path: '/rankings/:memberId', title: 'Member profile', element: <Member /> },
      { path: '/project-health/:projectId', title: 'Project detail', element: <Project /> },
    ],
  }
}
