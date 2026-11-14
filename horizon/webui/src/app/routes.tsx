import { MemberRoute } from './MemberRoute'
import { lazy, type ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { ChartNoAxesCombined, LayoutDashboard, Settings2, UsersRound } from 'lucide-react'
import {
  PortfolioDashboard,
  PortfolioProjects,
  PortfolioInsights,
} from '../features/portfolio/PortfolioPages'
import { SignInPage } from '../features/auth/SignInPage'
import { SettingsPage } from '../features/settings/SettingsPage'
import { loadMember, loadProject, loadProjects, loadRankings } from './route-loaders'

const RankingsPage = lazy(() => loadRankings().then((module) => ({ default: module.RankingsPage })))
const ProjectPage = lazy(() => loadProject().then((module) => ({ default: module.ProjectPage })))
const ProjectsPage = lazy(() => loadProjects().then((module) => ({ default: module.ProjectsPage })))

export interface HorizonRoute {
  path: string
  title: string
  element: ReactNode
  preload?: () => Promise<unknown>
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

/** Ranking data routes require a verified executive session. */
export const horizonRoutes: readonly HorizonRoute[] = [
  {
    path: '/dashboard',
    title: 'Dashboard',
    element: <PortfolioDashboard />,
    navigation: { icon: LayoutDashboard, description: 'Your workspace overview' },
  },
  {
    path: '/rankings',
    preload: loadRankings,
    title: 'Member Rankings',
    element: <RankingsPage />,
    navigation: { icon: UsersRound, description: 'People & contributions', executiveOnly: true },
  },
  {
    path: '/projects',
    preload: loadProjects,
    title: 'Projects',
    element: <ProjectsPage />,
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
    preload: loadMember,
    title: 'Member profile',
    protected: true,
    executiveOnly: true,
    element: <MemberRoute />,
  },
  {
    path: '/projects/:projectPk',
    preload: loadProject,
    title: 'Project detail',
    element: <ProjectPage />,
  },
  { path: '/sign-in', title: 'Sign in', element: <SignInPage /> },
  {
    path: '/settings',
    title: 'Settings',
    element: <SettingsPage />,
    navigation: { icon: Settings2, description: 'Appearance & workspace', group: 'preferences' },
  },
]
