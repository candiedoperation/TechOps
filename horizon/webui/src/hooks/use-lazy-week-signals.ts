/**
 * Viewport-gated weekly-signal compute.
 *
 * `GET /snapshots/latest` names the projects it has no snapshot for this week
 * and whether the server can compute one. Computing costs one LLM request per
 * project, so a row is computed only once it actually scrolls into view: a
 * cold database costs a request per project a reviewer looks at, not one per
 * project in the portfolio.
 *
 * The rules the vanilla implementation established, kept exactly:
 *  - only a `pending` row is observed; a row that is computing has a request
 *    in flight, an errored one waits for an explicit retry, and an
 *    `unavailable` one has no LLM configured to compute it with;
 *  - a failed row is *not* re-observed, so scrolling past it again cannot
 *    silently re-spend a request on a project that just failed;
 *  - a browser with no IntersectionObserver computes every pending row at
 *    once, because otherwise it would sit on placeholders forever.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"

import { requestJson } from "@/api/client"
import { normalizeProject } from "@/api/normalize"
import { queryKeys } from "@/api/queries"
import type { LatestSnapshotResult, Project } from "@/api/types"

/** Start slightly before the row is on screen so the result usually lands by
 *  the time the reviewer has scrolled to it. */
const LAZY_ROOT_MARGIN = "200px"

export type LazyRowState = "pending" | "computing" | "error" | "unavailable" | null

export interface LazyWeekSignals {
  /** `null` means the project has real data and renders normally. */
  rowState: (projectId: string) => LazyRowState
  errorFor: (projectId: string) => string | null
  /** Ref callback for a row element. Attaching it observes a pending row. */
  observeRow: (projectId: string) => (node: HTMLElement | null) => void
  retry: (projectId: string) => void
}

export function useLazyWeekSignals(latest: LatestSnapshotResult | undefined): LazyWeekSignals {
  const queryClient = useQueryClient()

  const missingFromServer = useMemo(
    () => new Set(latest?.missingProjectIds ?? []),
    [latest?.missingProjectIds],
  )
  const computable = Boolean(latest?.computable)
  const weekStart = latest?.lazyWeekStart ?? null

  const [computed, setComputed] = useState<Set<string>>(() => new Set())
  const [computing, setComputing] = useState<Set<string>>(() => new Set())
  const [errors, setErrors] = useState<Record<string, string>>({})

  /* A new snapshot response replaces the whole picture. */
  useEffect(() => {
    setComputed(new Set())
    setComputing(new Set())
    setErrors({})
  }, [latest])

  const inFlight = useRef<Set<string>>(new Set())

  const compute = useCallback(
    async (projectId: string) => {
      if (!computable || !weekStart) return
      if (!missingFromServer.has(projectId)) return
      if (inFlight.current.has(projectId)) return
      inFlight.current.add(projectId)
      setComputing((previous) => new Set(previous).add(projectId))
      setErrors((previous) => {
        if (!(projectId in previous)) return previous
        const next = { ...previous }
        delete next[projectId]
        return next
      })

      try {
        const raw = await requestJson<{ project?: unknown }>(
          `/projects/${encodeURIComponent(projectId)}/snapshots/at?date=${encodeURIComponent(weekStart)}`,
          { method: "POST" },
        )
        /* Write the computed row straight into the cached snapshot so every
           surface reading it -- the table, the profile it links to -- agrees. */
        queryClient.setQueryData<LatestSnapshotResult>(queryKeys.latestSnapshot, (current) => {
          if (!current) return current
          const updated: Project = normalizeProject(raw?.project, current.snapshot)
          return {
            ...current,
            snapshot: {
              ...current.snapshot,
              projects: current.snapshot.projects.map((project) =>
                project.id === projectId ? updated : project,
              ),
            },
          }
        })
        setComputed((previous) => new Set(previous).add(projectId))
      } catch (error) {
        setErrors((previous) => ({
          ...previous,
          [projectId]: error instanceof Error ? error.message : "Could not compute this week's signal.",
        }))
      } finally {
        inFlight.current.delete(projectId)
        setComputing((previous) => {
          const next = new Set(previous)
          next.delete(projectId)
          return next
        })
      }
    },
    [computable, missingFromServer, queryClient, weekStart],
  )

  const rowState = useCallback(
    (projectId: string): LazyRowState => {
      if (computing.has(projectId)) return "computing"
      if (errors[projectId]) return "error"
      if (!missingFromServer.has(projectId) || computed.has(projectId)) return null
      return computable ? "pending" : "unavailable"
    },
    [computable, computed, computing, errors, missingFromServer],
  )

  const observerRef = useRef<IntersectionObserver | null>(null)
  const observedIds = useRef<Map<Element, string>>(new Map())
  const computeRef = useRef(compute)
  computeRef.current = compute

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return
    const observed = observedIds.current
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          const projectId = observed.get(entry.target)
          observer.unobserve(entry.target)
          observed.delete(entry.target)
          if (projectId) void computeRef.current(projectId)
        }
      },
      { rootMargin: LAZY_ROOT_MARGIN },
    )
    observerRef.current = observer
    return () => {
      observer.disconnect()
      observerRef.current = null
      observed.clear()
    }
  }, [])

  const observeRow = useCallback(
    (projectId: string) => (node: HTMLElement | null) => {
      if (!node) return
      if (rowState(projectId) !== "pending") return
      if (typeof IntersectionObserver === "undefined") {
        /* No observer support: compute now rather than never. */
        void computeRef.current(projectId)
        return
      }
      const observer = observerRef.current
      if (!observer) return
      observedIds.current.set(node, projectId)
      observer.observe(node)
    },
    [rowState],
  )

  const retry = useCallback(
    (projectId: string) => {
      setErrors((previous) => {
        const next = { ...previous }
        delete next[projectId]
        return next
      })
      void compute(projectId)
    },
    [compute],
  )

  const errorFor = useCallback((projectId: string) => errors[projectId] ?? null, [errors])

  return { rowState, errorFor, observeRow, retry }
}
