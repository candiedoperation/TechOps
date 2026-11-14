import { Suspense, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Link, NavLink, Outlet, useLocation, matchPath } from 'react-router-dom'
import {
  PanelLeft,
  ChevronRight,
  ChevronsUpDown,
  UserRound,
  Info,
  X,
  Monitor,
  Moon,
  Sun,
  LogOut,
  LockKeyhole,
} from 'lucide-react'
import portalLogo from '../../../../../peopleportal/webui/src/assets/logo.svg'
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
function SidebarBrand() {
  return (
    <Link className="portfolio-brand" to="/dashboard" aria-label="Horizon dashboard">
      <span className="portfolio-logo" aria-hidden="true">
        <img src={portalLogo} width={32} height={32} alt="" />
      </span>
      <span className="portal-brand-label">
        <strong>App Dev Club</strong>
        <span>Horizon</span>
      </span>
    </Link>
  )
}

function SidebarAccount({ signOut, onNavigate }: { signOut: () => void; onNavigate?: () => void }) {
  const { state } = useAuth()
  const session = state.status === 'authenticated' ? state.session : undefined
  const name = session?.displayName ?? 'Horizon account'
  const initials = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase()
  return (
    <details
      className="portal-account"
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !event.currentTarget.open) return
        event.stopPropagation()
        event.currentTarget.open = false
        event.currentTarget.querySelector('summary')?.focus()
      }}
    >
      <summary aria-label={`${name} account menu`}>
        <span className="portal-account-avatar" aria-hidden="true">
          {session ? initials : <UserRound size={17} />}
        </span>
        <span className="portal-account-label">
          <strong>{name}</strong>
          <span>{session ? (session.email ?? 'Horizon workspace') : 'Sign-in unavailable'}</span>
        </span>
        <ChevronsUpDown className="portal-account-chevron" size={16} aria-hidden="true" />
      </summary>
      <div className="portal-account-menu">
        <Link to="/settings" onClick={onNavigate}>
          Settings
        </Link>
        {session ? (
          <button
            type="button"
            onClick={(event) => {
              event.currentTarget.closest('details')?.removeAttribute('open')
              signOut()
            }}
          >
            <LogOut size={15} aria-hidden="true" /> Sign out
          </button>
        ) : (
          <Link to="/sign-in" onClick={onNavigate}>
            <LockKeyhole size={15} aria-hidden="true" /> Sign-in details
          </Link>
        )}
      </div>
    </details>
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
  const { signOut } = useAuth()
  const { appearance, resolved } = useAppearance()
  const AppearanceIcon = appearance === 'system' ? Monitor : resolved === 'dark' ? Moon : Sun
  const [logoutError, setLogoutError] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const [showPreview, setShowPreview] = useState(true)
  const exitAccount = () => {
    setLogoutError(false)
    void signOut().catch(() => setLogoutError(true))
  }
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
    <div
      className="portfolio-shell portal-shell"
      data-sidebar-collapsed={collapsed}
      data-workspace={location.pathname.startsWith('/projects/') ? 'project' : undefined}
    >
      <a href="#main-content" className="skip-link">
        Skip to content
      </a>
      <aside className="portal-sidebar" aria-label="Workspace sidebar">
        <SidebarBrand />
        <p className="portal-nav-label">Workspace</p>
        <Navigation routes={routes} />
        <SidebarAccount key={location.pathname} signOut={exitAccount} />
      </aside>
      <div className="portal-inset">
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
            {(banner ||
              ['/dashboard', '/insights', '/project-health'].includes(location.pathname)) && (
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
          <h2 className="sr-only">Horizon workspace</h2>
          <SidebarBrand />
          <p className="portal-nav-label">Workspace</p>
          <Navigation routes={routes} onNavigate={() => dialogRef.current?.close()} />
          <SidebarAccount
            key={location.pathname}
            signOut={exitAccount}
            onNavigate={() => dialogRef.current?.close()}
          />
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
      {(demoData || banner) && showPreview && (
        <aside className="portal-preview-notice" aria-label="Local preview">
          {banner ?? (
            <>
              <Info size={17} aria-hidden="true" />
              <div>
                <strong>Demo data</strong>
                <p>This preview uses fictional projects and members.</p>
              </div>
            </>
          )}
          <button
            className="icon-button"
            type="button"
            onClick={() => setShowPreview(false)}
            aria-label="Dismiss preview notice"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </aside>
      )}
    </div>
  )
}
