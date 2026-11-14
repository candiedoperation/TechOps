import { ChartNoAxesCombined, LockKeyhole } from 'lucide-react'
import { ProtectedRoute } from '../../auth/ProtectedRoute'
import { Card } from '../../components/ui/Card'
import { DataTable, type TableColumn } from '../../components/ui/DataTable'
import { EmptyState } from '../../components/ui/States'

const columns: TableColumn<never>[] = [
  'Project',
  'Health',
  'Evidence coverage',
  'Reporting period',
].map((heading) => ({ id: heading, heading, render: () => null }))

export function ProjectHealthPage() {
  return (
    <>
      <div className="page-intro">
        <div>
          <p className="eyebrow">PROJECTS & PROGRESS</p>
          <h1>Project Health</h1>
          <p>See project signals in context, from delivery progress to the evidence behind it.</p>
        </div>
        <span className="page-icon mint">
          <ChartNoAxesCombined aria-hidden="true" />
        </span>
      </div>
      <div className="access-notice">
        <LockKeyhole size={19} aria-hidden="true" />
        <div>
          <strong>Project evidence is protected</strong>
          <p>Only authorized, published project results will appear in this workspace.</p>
        </div>
      </div>
      <Card
        title="Project overview"
        description="A shared view of project progress and signal freshness."
      >
        <div className="table-toolbar">
          <span>Published project health</span>
          <label className="select-label">
            Reporting period
            <select disabled defaultValue="unavailable">
              <option value="unavailable">Awaiting published periods</option>
            </select>
          </label>
        </div>
        <DataTable<never>
          caption="Project health"
          columns={columns}
          rows={[]}
          rowKey={() => ''}
          emptyState={
            <ProtectedRoute>
              <EmptyState
                title="Project health API not connected"
                description="Project signals will be available once Horizon's authorized read API is ready."
                locked
              />
            </ProtectedRoute>
          }
        />
      </Card>
      <div className="principle-grid">
        <Card
          title="A signal with a source"
          description="Follow each finding back to the supporting evidence."
        >
          <p className="principle-copy">
            Future project pages will connect health signals to SOW checkpoints, source references,
            and reporting history.
          </p>
        </Card>
        <Card
          title="Freshness is part of the picture"
          description="Current, stale, provisional, and missing are different states."
        >
          <p className="principle-copy">
            Publication timestamps and freshness will come from the API, so older evidence is never
            presented as a current result.
          </p>
        </Card>
      </div>
    </>
  )
}
