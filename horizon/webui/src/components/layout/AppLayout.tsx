import { Suspense, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Link, NavLink, Outlet, useLocation, matchPath } from 'react-router-dom'
import {
  PanelsTopLeft,
  PanelLeft,
  ChevronRight,
  X,
  Monitor,
  Moon,
  Sun,
  LogOut,
  LockKeyhole,
} from 'lucide-react'
import { horizonRoutes, type HorizonRoute } from '../../app/routes'
import { useAuth } from '../../auth/context'
import { useAppearance } from '../../theme/context'
import { SnapshotControl } from '../../features/portfolio/PortfolioPages'
import { LoadingState } from '../ui/States'
import { moveFrom } from '../ui/motion'
import './portal-shell.css'

function Navigation({
  routes,
  onNavigate,
}: {
  routes: readonly HorizonRoute[]
  onNavigate?: () => void
}) {
  const { state } = useAuth()
  const location = useLocation()
  const navigation = useRef<HTMLElement>(null)
  const previous = useRef<DOMRect>(null)
  useLayoutEffect(() => {
    const marker = navigation.current?.querySelector<HTMLElement>('.active .portal-nav-marker')
    if (!marker) return
    if (previous.current) moveFrom(marker, previous.current)
    previous.current = marker.getBoundingClientRect()
  }, [location.pathname])
  const order = ['/dashboard', '/projects', '/insights', '/rankings', '/settings']
  const visible = routes
    .filter(
      (route) =>
        route.navigation &&
        (!route.navigation.executiveOnly ||
          (state.status === 'authenticated' && state.session.isExec === true)),
    )
    .sort((a, b) => order.indexOf(a.path) - order.indexOf(b.path))
  return (
    <nav ref={navigation} aria-label="Primary navigation" className="portfolio-navigation">
      {visible.map((route) => (
        <NavLink
          key={route.path}
          to={route.path}
          onClick={onNavigate}
          onPointerEnter={() => void route.preload?.()}
          onFocus={() => void route.preload?.()}
          onPointerDown={() => void route.preload?.()}
          className={({ isActive }) => (isActive ? 'top-nav-link active' : 'top-nav-link')}
        >
          <i className="portal-nav-marker" aria-hidden="true" />
          {route.navigation && <route.navigation.icon size={16} aria-hidden="true" />}
          <span>{route.title}</span>
        </NavLink>
      ))}
    </nav>
  )
}
export function AppLayout({
  routes = horizonRoutes,
  banner,
  demoData = false,
}: {
  routes?: readonly HorizonRoute[]
  banner?: ReactNode
  demoData?: boolean
}) {
  const location = useLocation()
  const route = routes.find((item) => matchPath({ path: item.path, end: true }, location.pathname))
  const title = route?.title ?? 'Page not found'
  const dialogRef = useRef<HTMLDialogElement>(null)
  const mainRef = useRef<HTMLElement>(null)
  const { state, signOut } = useAuth()
  const { appearance, resolved } = useAppearance()
  const AppearanceIcon = appearance === 'system' ? Monitor : resolved === 'dark' ? Moon : Sun
  const [logoutError, setLogoutError] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  useEffect(() => {
    const sync = () => {
      document.documentElement.dataset.paused = String(document.hidden)
    }
    sync()
    document.addEventListener('visibilitychange', sync)
    return () => document.removeEventListener('visibilitychange', sync)
  }, [])
  useEffect(() => {
    document.title = title + ' · Horizon'
    mainRef.current?.focus({ preventScroll: true })
  }, [title])
  return (
    <div className="portfolio-shell portal-shell" data-sidebar-collapsed={collapsed}>
      <a href="#main-content" className="skip-link">
        Skip to content
      </a>
      <aside className="portal-sidebar">
        <Link className="portfolio-brand" to="/dashboard" aria-label="Horizon dashboard">
          <span className="portfolio-logo" aria-hidden="true">
            <PanelsTopLeft size={17} />
          </span>
          <span className="portal-brand-label">
            <strong>App Dev Club</strong>
            <span>Horizon</span>
          </span>
        </Link>
        <p className="portal-nav-label">Workspace</p>
        <Navigation routes={routes} />
      </aside>
      <div className="portal-inset">
        {banner}
        <header className="portal-toolbar">
          <button
            type="button"
            className="icon-button portal-sheet-trigger"
            aria-label="Open navigation"
            onClick={() => dialogRef.current?.showModal()}
          >
            <PanelLeft size={18} />
          </button>
          <button
            type="button"
            className="icon-button portal-sidebar-trigger"
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-expanded={!collapsed}
            onClick={() => setCollapsed((value) => !value)}
          >
            <PanelLeft size={18} />
          </button>
          <span className="portal-divider" aria-hidden="true" />
          <nav aria-label="Breadcrumb" className="portal-breadcrumb">
            <Link to="/dashboard">Horizon</Link>
            <ChevronRight size={13} aria-hidden="true" />
            <span aria-current="page">{title}</span>
          </nav>
          <div className="portfolio-header-actions">
            {demoData && <span className="portal-demo-badge">Demo data</span>}
            {['/dashboard', '/insights', '/project-health'].includes(location.pathname) && (
              <SnapshotControl />
            )}
            <Link
              to="/settings"
              className="icon-button"
              aria-label="Appearance settings"
              title={'Appearance: ' + appearance}
            >
              <AppearanceIcon size={18} />
            </Link>
            <span className="connection-indicator">
              <span />
              {demoData
                ? 'Local fixtures'
                : state.status === 'authenticated'
                  ? 'Session verified'
                  : 'Not connected'}
            </span>
            {state.status === 'authenticated' ? (
              <button
                className="button button-secondary compact"
                onClick={() => {
                  setLogoutError(false)
                  void signOut().catch(() => setLogoutError(true))
                }}
              >
                <LogOut size={14} />
                Sign out
              </button>
            ) : (
              <Link to="/sign-in" className="access-link" aria-label="Sign-in details">
                <LockKeyhole size={15} />
                <span>Sign-in details</span>
              </Link>
            )}
          </div>
        </header>
        <dialog
          ref={dialogRef}
          className="mobile-drawer"
          aria-label="Workspace navigation"
          onClick={(event) => {
            if (event.target === event.currentTarget) dialogRef.current?.close()
          }}
        >
          <button
            className="icon-button drawer-close"
            aria-label="Close navigation"
            onClick={() => dialogRef.current?.close()}
          >
            <X size={20} />
          </button>
          <h2>Horizon workspace</h2>
          <Navigation routes={routes} onNavigate={() => dialogRef.current?.close()} />
        </dialog>
        <main id="main-content" className="portfolio-main" ref={mainRef} tabIndex={-1}>
          {logoutError && <p role="alert">Sign-out could not be confirmed.</p>}
          <Suspense fallback={<LoadingState />}>
            <Outlet />
          </Suspense>
        </main>
        <footer className="portfolio-footer">
          <span>App Dev Horizon</span>
          <Link to="/sign-in">Access &amp; connection</Link>
        </footer>
      </div>
    </div>
  )
}
