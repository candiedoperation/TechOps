import {
  ArrowRight,
  ChartNoAxesCombined,
  Check,
  CircleDashed,
  FileSearch,
  Layers3,
  LockKeyhole,
  ShieldCheck,
  UsersRound,
} from 'lucide-react'
import { Link } from 'react-router-dom'
import { Card } from '../../components/ui/Card'
import { EmptyState } from '../../components/ui/States'

const connections = [
  { label: 'Frontend workspace', detail: 'Navigation and shared UI are ready', ready: true },
  { label: 'Horizon sign-in', detail: 'Awaiting authentication integration', ready: false },
  {
    label: 'Authorized read APIs',
    detail: 'Awaiting access policy and API contracts',
    ready: false,
  },
]

export function DashboardPage() {
  return (
    <>
      <div className="page-intro">
        <div>
          <p className="eyebrow">WORKSPACE OVERVIEW</p>
          <h1>Your Horizon, at a glance.</h1>
          <p>A clearer view of your people, projects, and the evidence behind them.</p>
        </div>
        <span className="pill pill-neutral">
          <CircleDashed size={14} aria-hidden="true" />
          Awaiting connection
        </span>
      </div>
      <section className="hero-panel" aria-label="Welcome to Horizon">
        <div className="hero-content">
          <span className="hero-kicker">
            <span className="live-dot" />
            APP DEV HORIZON
          </span>
          <h2>Good work deserves a clearer picture.</h2>
          <p>
            Understand contributions. Follow project health.
            <br className="desktop-break" /> Keep the evidence in view.
          </p>
          <Link to="/project-health" className="button button-white">
            Explore the workspace
            <ArrowRight size={16} aria-hidden="true" />
          </Link>
        </div>
      </section>
      <div className="summary-grid">
        {[
          { label: 'Member rankings', icon: UsersRound, note: 'Published member signals' },
          {
            label: 'Project health',
            icon: ChartNoAxesCombined,
            note: 'Evidence-led project insights',
          },
          { label: 'Latest publication', icon: Layers3, note: 'Reporting period and freshness' },
        ].map(({ label, icon: Icon, note }) => (
          <section className="summary-card" key={label} aria-label={label}>
            <span className="summary-icon">
              <Icon size={19} aria-hidden="true" />
            </span>
            <p className="summary-label">{label}</p>
            <span className="summary-value" aria-label="Not available">
              —
            </span>
            <p className="summary-note">{note}</p>
            <span className="summary-status">Not connected</span>
          </section>
        ))}
      </div>
      <div className="dashboard-grid">
        <Card title="Your workspace" description="Two perspectives. One shared source of truth.">
          <Link className="workspace-link" to="/rankings">
            <span className="feature-icon">
              <UsersRound size={21} aria-hidden="true" />
            </span>
            <span>
              <strong>Member Rankings</strong>
              <span>Explore contributions and supporting evidence.</span>
            </span>
            <ArrowRight size={18} aria-hidden="true" />
          </Link>
          <Link className="workspace-link" to="/project-health">
            <span className="feature-icon mint">
              <ChartNoAxesCombined size={21} aria-hidden="true" />
            </span>
            <span>
              <strong>Project Health</strong>
              <span>Follow progress, coverage, and project signals.</span>
            </span>
            <ArrowRight size={18} aria-hidden="true" />
          </Link>
          <div className="card-footnote">
            <ShieldCheck size={16} aria-hidden="true" />
            <span>Information appears only after access is verified.</span>
          </div>
        </Card>
        <Card
          title="Connection checklist"
          description="A transparent view of what is ready."
          className="connection-card"
        >
          <div id="connection" className="connection-list">
            {connections.map(({ label, detail, ready }) => (
              <div className="connection-item" key={label}>
                <span className={ready ? 'connection-check ready' : 'connection-check'}>
                  {ready ? (
                    <Check size={15} aria-hidden="true" />
                  ) : (
                    <CircleDashed size={16} aria-hidden="true" />
                  )}
                </span>
                <div>
                  <h3>{label}</h3>
                  <p>{detail}</p>
                </div>
                <span className={ready ? 'tiny-status ready' : 'tiny-status'}>
                  {ready ? 'Ready' : 'Pending'}
                </span>
              </div>
            ))}
          </div>
        </Card>
      </div>
      <Card
        title="Latest published insights"
        description="Current signals will appear here when they are available."
        action={
          <span className="pill pill-neutral">
            <LockKeyhole size={12} aria-hidden="true" />
            Protected
          </span>
        }
      >
        <EmptyState
          title="No published insights loaded"
          description="Horizon is ready for its data connection. No rankings, project scores, or evidence have been loaded."
          action={
            <span className="empty-caption">
              <FileSearch size={14} aria-hidden="true" />
              Awaiting an authorized data connection
            </span>
          }
        />
      </Card>
    </>
  )
}
