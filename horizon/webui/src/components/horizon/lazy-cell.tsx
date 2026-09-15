/**
 * The placeholder a table row shows while its weekly signal has not been
 * computed. The identity column stays, and only the data columns are replaced,
 * so the table's shape holds steady as rows fill in.
 */

import { Loader2Icon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { TableCell } from "@/components/ui/table"
import type { LazyRowState } from "@/hooks/use-lazy-week-signals"

export function LazyCell({
  state,
  colSpan,
  error,
  onRetry,
}: {
  state: Exclude<LazyRowState, null>
  colSpan: number
  error: string | null
  onRetry: () => void
}) {
  return (
    <TableCell colSpan={colSpan}>
      {state === "computing" ? (
        <span className="text-muted-foreground flex items-center gap-2 text-sm" aria-live="polite">
          <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
          Computing this week&rsquo;s signal…
        </span>
      ) : state === "error" ? (
        <Button
          variant="outline"
          size="sm"
          onClick={(event) => {
            event.stopPropagation()
            onRetry()
          }}
          title={error ?? undefined}
        >
          Could not compute — Retry
        </Button>
      ) : state === "unavailable" ? (
        <span className="text-muted-foreground font-mono text-xs">
          Unavailable — no signal service is configured to compute this week.
        </span>
      ) : (
        <span className="text-muted-foreground font-mono text-xs">Not computed</span>
      )}
    </TableCell>
  )
}
