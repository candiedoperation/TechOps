import type { ProjectMeta } from '../../api/contracts/projects'
import { shortDate } from '../../format'

export function Freshness({ meta }: { meta: ProjectMeta }) {
  return (
    <p>
      {meta.stale ? 'Stale · Last updated' : 'Updated'}{' '}
      <time dateTime={meta.asOf}>{shortDate.format(new Date(meta.asOf))}</time>
    </p>
  )
}
