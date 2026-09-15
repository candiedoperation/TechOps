import { describe, expect, it } from "vitest"

import { normalizeEvidence, normalizeProject, normalizeSnapshot } from "./normalize"

/**
 * These cover the rules the product rests on: a metric that was never measured
 * stays absent, a warning without inspectable evidence is not a warning, and a
 * verdict that cannot be backed downgrades to "insufficient data".
 */

describe("missing versus zero", () => {
  it("keeps an observed zero and drops an absent metric", () => {
    const project = normalizeProject({
      project_id: "p1",
      name: "Alpha",
      status: "clear",
      metrics: { active_days: 0, open_prs: 4 },
    })
    expect(project.metrics.active_days).toBe(0)
    expect("review_latency_days" in project.metrics).toBe(false)
    expect(project.metrics.open_prs).toBe(4)
  })

  it("does not invent a zero for a metric the snapshot sent as null", () => {
    const project = normalizeProject({
      project_id: "p1",
      status: "clear",
      metrics: { active_days: null, open_prs: 2 },
    })
    expect("active_days" in project.metrics).toBe(false)
  })

  it("preserves gaps inside a weekly series instead of filling them", () => {
    const project = normalizeProject({
      project_id: "p1",
      status: "clear",
      metrics: { active_days: 3 },
      series: { activity: [1, null, 3, null, 5] },
    })
    expect(project.series.activity).toEqual([1, null, 3, null, 5, null, null, null])
  })

  it("suppresses the contributor series when the aggregate is below the floor", () => {
    const project = normalizeProject({
      project_id: "p1",
      status: "clear",
      metrics: { active_days: 2 },
      series: { contributors: [3, 3, 3] },
    })
    expect(project.series.contributors).toBeUndefined()
    expect(project.seriesBaselines.contributors).toBeUndefined()
  })
})

describe("evidence-linked warnings", () => {
  it("drops a warning that carries no inspectable source reference", () => {
    expect(normalizeEvidence([{ title: "Activity dropped", metric: "active_days" }])).toEqual([])
  })

  it("keeps a warning whose references resolve", () => {
    const evidence = normalizeEvidence([
      {
        warning_id: "w1",
        title: "Activity dropped",
        metric: "active_days",
        severity: "amber",
        source_evidence: [{ source_id: "commit:abc123" }, "pr:42"],
      },
    ])
    expect(evidence).toHaveLength(1)
    expect(evidence[0].id).toBe("w1")
    expect(evidence[0].type).toBe("amber")
    expect(evidence[0].sources).toEqual(["commit:abc123", "pr:42"])
  })

  it("falls back to a known severity rather than rendering an unknown one", () => {
    const evidence = normalizeEvidence([{ title: "x", severity: "chartreuse", sources: ["ref:1"] }])
    expect(evidence[0].type).toBe("blue")
  })
})

describe("status derivation", () => {
  it("downgrades an unbacked risk verdict to insufficient data", () => {
    const project = normalizeProject({
      project_id: "p1",
      status: "at_risk",
      metrics: { active_days: 1 },
      evidence: [{ title: "No sources", metric: "active_days" }],
    })
    expect(project.statusClass).toBe("data")
    expect(project.status).toBe("Insufficient data")
    expect(project.evidence).toEqual([])
  })

  it("keeps a risk verdict that has evidence behind it", () => {
    const project = normalizeProject({
      project_id: "p1",
      status: "at_risk",
      metrics: { active_days: 1 },
      evidence: [{ title: "Activity dropped", metric: "active_days", source_evidence: ["commit:abc"] }],
    })
    expect(project.statusClass).toBe("risk")
    expect(project.evidence).toHaveLength(1)
  })

  it("downgrades a clear verdict with nothing measured behind it", () => {
    const project = normalizeProject({ project_id: "p1", status: "clear" })
    expect(project.statusClass).toBe("data")
  })

  it("treats a planned pause as a pause and emits no warnings for it", () => {
    const project = normalizeProject({
      project_id: "p1",
      status: "at_risk",
      planned_pause: true,
      metrics: { active_days: 0 },
      evidence: [{ title: "Activity dropped", metric: "active_days", source_evidence: ["commit:abc"] }],
    })
    expect(project.statusClass).toBe("pause")
    expect(project.status).toBe("Planned pause")
    expect(project.evidence).toEqual([])
  })
})

describe("normalizeSnapshot", () => {
  it("carries the snapshot week and completeness onto each project", () => {
    const snapshot = normalizeSnapshot({
      snapshot: {
        snapshot_id: "s1",
        snapshot_week_start: "2026-09-07",
        snapshot_week_end: "2026-09-13",
        data_completeness_pct: 82,
        last_sync_at: "2026-09-13T06:00:00Z",
        projects: [{ project_id: "p1", status: "clear", metrics: { active_days: 3 } }],
      },
    })
    expect(snapshot.snapshotId).toBe("s1")
    expect(snapshot.snapshotWeekStart).toBe("2026-09-07")
    expect(snapshot.projects[0].snapshotId).toBe("s1")
    expect(snapshot.projects[0].dataCompletenessPct).toBe(82)
  })

  it("returns an empty portfolio rather than throwing on an empty envelope", () => {
    expect(normalizeSnapshot(null).projects).toEqual([])
  })
})
