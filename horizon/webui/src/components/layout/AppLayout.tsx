import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, NavLink, Outlet, useLocation, matchPath } from 'react-router-dom'
import { Menu, X, Monitor, Moon, Sun, LogOut, LockKeyhole } from 'lucide-react'
import { horizonRoutes, type HorizonRoute } from '../../app/routes'
import { useAuth } from '../../auth/context'
import { useAppearance } from '../../theme/context'
import { SnapshotControl } from '../../features/portfolio/PortfolioPages'

function Navigation({
  routes,
  onNavigate,
}: {
  routes: readonly HorizonRoute[]
  onNavigate?: () => void
}) {
  const { state } = useAuth()
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
    <nav aria-label="Primary navigation" className="portfolio-navigation">
      {visible.map((route) => (
        <NavLink
          key={route.path}
          to={route.path}
          onClick={onNavigate}
          className={({ isActive }) => (isActive ? 'top-nav-link active' : 'top-nav-link')}
        >
          {route.title}
        </NavLink>
      ))}
    </nav>
  )
}
export function AppLayout({
  routes = horizonRoutes,
  banner,
}: {
  routes?: readonly HorizonRoute[]
  banner?: ReactNode
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
  useEffect(() => {
    document.title = title + ' · Horizon'
    mainRef.current?.focus({ preventScroll: true })
  }, [title])
  return (
    <div className="portfolio-shell">
      <a href="#main-content" className="skip-link">
        Skip to content
      </a>
      {banner}
      <header className="portfolio-header">
        <div className="portfolio-brand-nav">
          <button
            className="icon-button mobile-menu"
            aria-label="Open navigation"
            onClick={() => dialogRef.current?.showModal()}
          >
            <Menu size={21} />
          </button>
          <Link className="portfolio-brand" to="/dashboard" aria-label="Horizon dashboard">
            <span className="portfolio-logo" aria-hidden="true">
              H
            </span>
            <span>
              <strong>App Dev Horizon</strong>
              <small>INTELLIGENCE</small>
            </span>
          </Link>
          <div className="portfolio-topnav">
            <Navigation routes={routes} />
          </div>
        </div>
        <div className="portfolio-header-actions">
          <SnapshotControl />
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
            {state.status === 'authenticated' ? 'Session verified' : 'Not connected'}
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
            <Link to="/sign-in" className="access-link">
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
        <Outlet />
      </main>
      <footer className="portfolio-footer">
        <span>Horizon / A shared perspective.</span>
        <Link to="/sign-in">Access &amp; connection</Link>
      </footer>
    </div>
  )
}
