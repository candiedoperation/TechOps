/**
 * Shared chrome for the Gitea member analytics surfaces: the identity badge,
 * the run provenance line, and the run's collection warnings.
 *
 * The warnings block is not decoration. A run with warnings is a run that is
 * *missing* data -- a repository with pull requests disabled returns 404 and
 * contributes no PR, review or approval rows -- so surfacing it is what stops
 * a partial run reading as a full one.
 */

import type { AnalyticsMember, AnalyticsRun } from "@/api/types"
import { Mono } from "@/components/horizon/primitives"
import { Badge } from "@/components/ui/badge"
import { formatDate } from "@/lib/format"

export function MemberBadge({ member }: { member: AnalyticsMember }) {
  if (member.service_or_admin) {
    return (
      <Badge variant="outline" className="bg-status-pause-surface text-status-pause" title="Service account">
        service
      </Badge>
    )
  }
  /* An unmatched identity may be a second identity for someone already listed
     above rather than another person, so it must not read as a member row. */
  if (member.roster_member === false) {
    return (
      <Badge variant="outline" className="bg-status-watch-surface text-status-watch" title="Unmatched identity">
        unmatched
      </Badge>
    )
  }
  return null
}

export function RunMeta({ run }: { run: AnalyticsRun | null | undefined }) {
  if (!run) return null
  const blame =
    run.blame_status === "disabled"
      ? "line ownership not collected"
      : `line ownership ${run.blame_status ?? "unknown"}`
  return (
    <Mono className="text-muted-foreground block">
      Run {run.run_id ?? "—"} · collected {formatDate(run.generated_at, true)}
      {run.history_scope ? ` · ${run.history_scope}` : ""} · {blame}
    </Mono>
  )
}

export function RunWarnings({ run }: { run: AnalyticsRun | null | undefined }) {
  const warnings = run?.warnings ?? []
  if (!warnings.length) return null
  return (
    <details className="rounded-lg border p-3 text-sm">
      <summary className="cursor-pointer font-medium">
        {warnings.length} warning{warnings.length === 1 ? "" : "s"} — part of this run is missing, not zero
      </summary>
      <ul className="mt-2 flex flex-col gap-1 pl-4">
        {warnings.map((warning, index) => (
          <li key={index} className="list-disc">
            <Mono>{warning}</Mono>
          </li>
        ))}
      </ul>
    </details>
  )
}
