import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { ChartNoAxesCombined, LayoutDashboard, Settings2, UsersRound } from 'lucide-react'
import { RankingsPage } from '../features/rankings/RankingsPage'
import {
  PortfolioDashboard,
  PortfolioProjects,
  PortfolioInsights,
} from '../features/portfolio/PortfolioPages'
import { SignInPage } from '../features/auth/SignInPage'
import { SettingsPage } from '../features/settings/SettingsPage'
import { EmptyState } from '../components/ui/States'

export interface HorizonRoute {
  path: string
  title: string
  element: ReactNode
  navigation?: {
    icon: LucideIcon
    description: string
    group?: 'preferences'
    executiveOnly?: boolean
  }
  /** Mark future data pages protected; the shell never implements feature permissions. */
  protected?: boolean
  permission?: string
  executiveOnly?: boolean
}

/** Public routes below are structural previews only. Protected data components remain gated. */
export const horizonRoutes: readonly HorizonRoute[] = [
  {
    path: '/dashboard',
    title: 'Dashboard',
    element: <PortfolioDashboard />,
    navigation: { icon: LayoutDashboard, description: 'Your workspace overview' },
  },
  {
    path: '/rankings',
    title: 'Member Rankings',
    element: <RankingsPage />,
    navigation: { icon: UsersRound, description: 'People & contributions', executiveOnly: true },
  },
  {
    path: '/projects',
    title: 'Projects',
    element: <PortfolioProjects />,
    navigation: { icon: ChartNoAxesCombined, description: 'Projects & progress' },
  },
  { path: '/project-health', title: 'Projects', element: <PortfolioProjects /> },
  {
    path: '/insights',
    title: 'Insights',
    element: <PortfolioInsights />,
    navigation: { icon: ChartNoAxesCombined, description: 'Portfolio comparison' },
  },
  {
    path: '/rankings/members/:userPk',
    title: 'Member profile',
    protected: true,
    executiveOnly: true,
    element: (
      <EmptyState
        title="Member detail pending"
        description="Authorized published member detail is not connected yet."
        locked
      />
    ),
  },
  {
    path: '/projects/:projectPk',
    title: 'Project detail',
    protected: true,
    element: (
      <EmptyState
        title="Project detail pending"
        description="Authorized project publications are not connected yet."
        locked
      />
    ),
  },
  { path: '/sign-in', title: 'Sign in', element: <SignInPage /> },
  {
    path: '/settings',
    title: 'Settings',
    element: <SettingsPage />,
    navigation: { icon: Settings2, description: 'Appearance & workspace', group: 'preferences' },
  },
]
