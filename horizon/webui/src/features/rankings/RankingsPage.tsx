import { LockKeyhole, UsersRound } from 'lucide-react'
import { ProtectedRoute } from '../../auth/ProtectedRoute'
import { Card } from '../../components/ui/Card'
import { DataTable, type TableColumn } from '../../components/ui/DataTable'
import { EmptyState } from '../../components/ui/States'

// Column labels are presentation only; no ranking response contract is assumed.
const columns: TableColumn<never>[] = ['Member', 'Overall score', 'Coverage', 'Last published'].map(
  (heading) => ({ id: heading, heading, render: () => null }),
)

export function RankingsPage() {
  return (
    <>
      <div className="page-intro">
        <div>
          <p className="eyebrow">PEOPLE & CONTRIBUTIONS</p>
          <h1>Member Rankings</h1>
          <p>Understand the signals behind each contribution, with evidence in context.</p>
        </div>
        <span className="page-icon">
          <UsersRound aria-hidden="true" />
        </span>
      </div>
      <div className="access-notice">
        <LockKeyhole size={19} aria-hidden="true" />
        <div>
          <strong>Member information is protected</strong>
          <p>Sign-in and access verification must be available before rankings can be loaded.</p>
        </div>
      </div>
      <Card
        title="Rankings explorer"
        description="Semester filters and member details will follow the available read API."
      >
        <div className="table-toolbar">
          <span>Published rankings</span>
          <label className="select-label">
            Semester
            <select disabled defaultValue="unavailable">
              <option value="unavailable">Awaiting published periods</option>
            </select>
          </label>
        </div>
        <DataTable<never>
          caption="Member rankings"
          columns={columns}
          rows={[]}
          rowKey={() => ''}
          emptyState={
            <ProtectedRoute executiveOnly>
              <EmptyState
                title="Ranking API not connected"
                description="Published rankings will be available once Horizon's authorized read API is ready."
                locked
              />
            </ProtectedRoute>
          }
        />
      </Card>
      <div className="principle-grid">
        <Card
          title="Evidence, not just a score"
          description="A score should be a starting point for understanding."
        >
          <p className="principle-copy">
            Future member pages will connect each signal to its source evidence, coverage, and
            reporting period.
          </p>
        </Card>
        <Card
          title="Coverage stays visible"
          description="Missing evidence is not a measure of contribution."
        >
          <p className="principle-copy">
            Unavailable or incomplete results will be identified clearly, without filling the gaps
            with assumed scores.
          </p>
        </Card>
      </div>
    </>
  )
}
