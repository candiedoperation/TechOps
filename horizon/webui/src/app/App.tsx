import { useState, type ComponentType, type ReactNode } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { Link, Navigate, Route, Routes } from 'react-router-dom'
import { createHorizonQueryClient } from '../api/query-client'
import { MockSourceContext } from '../api/data-source'
import type { HorizonReadClient } from '../api/client'
import type { HorizonAuthAdapter } from '../auth/types'
import { HorizonReadProvider } from '../api/HorizonReadProvider'
import { AuthProvider } from '../auth/AuthProvider'
import { ProtectedRoute } from '../auth/ProtectedRoute'
import { AppLayout } from '../components/layout/AppLayout'
import { EmptyState } from '../components/ui/States'
import { AppErrorBoundary } from './AppErrorBoundary'
import { horizonRoutes, type HorizonRoute } from './routes'
import type { Appearance } from '../theme/appearance'
import { AppearanceProvider } from '../theme/AppearanceProvider'
import { PortfolioProvider } from '../features/portfolio/PortfolioProvider'

export interface AppExperience {
  ReadProvider: ComponentType<{ children: ReactNode }>
  routes: readonly HorizonRoute[]
  banner?: ReactNode
  PortfolioProvider?: ComponentType<{ children: ReactNode }>
}
const fixtureSession: HorizonAuthAdapter = {
  getState: async () => ({
    status: 'authenticated',
    session: {
      subject: 'horizon-fixture',
      displayName: 'Demo viewer',
      permissions: [],
      isExec: true,
    },
  }),
  signOut: async () => {},
  signIn: async () => {},
}

export function App({
  experience,
  mockSource,
  defaultAppearance,
}: {
  experience?: AppExperience
  mockSource?: HorizonReadClient | null
  defaultAppearance?: Appearance
} = {}) {
  const [queryClient] = useState(createHorizonQueryClient)
  const ReadProvider = experience?.ReadProvider ?? HorizonReadProvider
  const routes = experience?.routes ?? horizonRoutes
  const PortfolioBoundary = experience?.PortfolioProvider ?? PortfolioProvider
  return (
    <AppErrorBoundary>
      <AppearanceProvider defaultAppearance={defaultAppearance}>
        <QueryClientProvider client={queryClient}>
          <AuthProvider adapter={mockSource ? fixtureSession : undefined}>
            <MockSourceContext.Provider value={mockSource ?? null}>
              <ReadProvider>
                <PortfolioBoundary>
                  <Routes>
                    <Route
                      element={
                        <AppLayout
                          routes={routes}
                          banner={experience?.banner}
                          demoData={Boolean(mockSource)}
                        />
                      }
                    >
                      <Route index element={<Navigate to="/dashboard" replace />} />
                      {routes.map((route) => (
                        <Route
                          key={route.path}
                          path={route.path}
                          element={
                            route.protected ? (
                              <ProtectedRoute
                                permission={route.permission}
                                executiveOnly={route.executiveOnly}
                              >
                                {route.element}
                              </ProtectedRoute>
                            ) : (
                              route.element
                            )
                          }
                        />
                      ))}
                      <Route
                        path="*"
                        element={
                          <EmptyState
                            title="This page is beyond the horizon"
                            description="The page you are looking for does not exist in this workspace."
                            action={
                              <Link className="button button-primary" to="/dashboard">
                                Back to dashboard
                              </Link>
                            }
                          />
                        }
                      />
                    </Route>
                  </Routes>
                </PortfolioBoundary>
              </ReadProvider>
            </MockSourceContext.Provider>
          </AuthProvider>
        </QueryClientProvider>
      </AppearanceProvider>
    </AppErrorBoundary>
  )
}
