/**
 * Cumulative progress for a chosen date.
 *
 * `GET /progress/at` is cache-only and names the projects it had no checkpoint
 * for. Those are computed with `POST /projects/{id}/progress/at`, one request
 * each, so the fan-out is bounded to three at a time rather than firing a
 * request per project simultaneously.
 *
 * A newer date pick invalidates the run: results from a superseded fan-out are
 * discarded rather than rendered under the new date.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { useQuery } from "@tanstack/react-query"

import { requestJson } from "@/api/client"
import { progressAtQuery } from "@/api/queries"
import { record } from "@/api/normalize"
import type { ProgressProject } from "@/api/types"

const FAN_OUT_CONCURRENCY = 3

/** Narrow a seeded map to one project, keeping a `pending` placeholder when
 *  that project was not in the response at all. */
function pickOne(
  entries: Record<string, ProgressEntry>,
  projectId: string,
): Record<string, ProgressEntry> {
  return { [projectId]: entries[projectId] ?? { state: "pending" } }
}

export type ProgressEntry =
  | { state: "pending" }
  | { state: "done"; data: ProgressProject }
  | { state: "error"; error: string }

export interface ProgressAtState {
  /** Project id -> checkpoint state. Empty when no date is selected. */
  entries: Record<string, ProgressEntry>
  isLoading: boolean
  error: unknown
  refetch: () => void
  retryProject: (projectId: string) => void
}

/**
 * @param onlyProjectId when given, the fan-out computes at most that one
 *   project. The checkpoint detail screen passes it so a deep link cannot
 *   spend an LLM request per project to render a single-project view.
 */
export function useProgressAt(
  date: string | null,
  enabled: boolean,
  onlyProjectId?: string,
): ProgressAtState {
  const listing = useQuery({ ...progressAtQuery(date ?? ""), enabled: enabled && Boolean(date) })

  const [entries, setEntries] = useState<Record<string, ProgressEntry>>({})
  const runId = useRef(0)

  const computeOne = useCallback(async (projectId: string, dateStr: string, run: number) => {
    try {
      const raw = record(
        await requestJson<unknown>(
          `/projects/${encodeURIComponent(projectId)}/progress/at?date=${encodeURIComponent(dateStr)}`,
          { method: "POST" },
        ),
      )
      if (run !== runId.current) return
      setEntries((previous) => ({
        ...previous,
        [projectId]: { state: "done", data: raw.project as ProgressProject },
      }))
    } catch (error) {
      if (run !== runId.current) return
      setEntries((previous) => ({
        ...previous,
        [projectId]: {
          state: "error",
          error: error instanceof Error ? error.message : "Could not compute progress.",
        },
      }))
    }
  }, [])

  useEffect(() => {
    runId.current += 1
    const run = runId.current

    if (!date || !listing.data) {
      setEntries({})
      return
    }

    const missing = new Set(listing.data.missing_project_ids ?? [])
    const seeded: Record<string, ProgressEntry> = {}
    for (const project of listing.data.projects) {
      if (!missing.has(project.id)) seeded[project.id] = { state: "done", data: project }
    }
    for (const id of missing) seeded[id] = { state: "pending" }
    setEntries(onlyProjectId ? pickOne(seeded, onlyProjectId) : seeded)

    if (!listing.data.computable || missing.size === 0) return

    const queue = onlyProjectId
      ? missing.has(onlyProjectId)
        ? [onlyProjectId]
        : []
      : Array.from(missing)
    if (queue.length === 0) return
    const worker = async () => {
      while (queue.length) {
        const projectId = queue.shift()
        if (!projectId) return
        if (run !== runId.current) return
        await computeOne(projectId, date, run)
      }
    }
    void Promise.all(Array.from({ length: FAN_OUT_CONCURRENCY }, worker))
  }, [computeOne, date, listing.data, onlyProjectId])

  const retryProject = useCallback(
    (projectId: string) => {
      if (!date) return
      setEntries((previous) => ({ ...previous, [projectId]: { state: "pending" } }))
      void computeOne(projectId, date, runId.current)
    },
    [computeOne, date],
  )

  return {
    entries,
    isLoading: listing.isPending && Boolean(date),
    error: listing.error,
    refetch: () => void listing.refetch(),
    retryProject,
  }
}
