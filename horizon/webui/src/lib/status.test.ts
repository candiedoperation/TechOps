import { describe, expect, it } from "vitest"

import { normalizeProject } from "@/api/normalize"
import type { Project } from "@/api/types"
import { filterProjects, isAttentionProject, isProjectFilter } from "./status"
import { legacyHashRoute } from "./legacy-hash"

function project(raw: Record<string, unknown>): Project {
  return normalizeProject(raw)
}

const withEvidence = (metric = "active_days") => [
  { title: "Activity dropped", metric, source_evidence: ["commit:abc"] },
]

describe("attention queue membership", () => {
  it("includes a risk project whose warning has evidence", () => {
    expect(
      isAttentionProject(
        project({ project_id: "p1", status: "at_risk", metrics: { active_days: 1 }, evidence: withEvidence() }),
      ),
    ).toBe(true)
  })

  it("excludes a project whose warning lost its evidence", () => {
    expect(
      isAttentionProject(project({ project_id: "p1", status: "at_risk", metrics: { active_days: 1 } })),
    ).toBe(false)
  })

  it("excludes a paused project even when it looks inactive", () => {
    expect(
      isAttentionProject(
        project({
          project_id: "p1",
          status: "at_risk",
          planned_pause: true,
          metrics: { active_days: 0 },
          evidence: withEvidence(),
        }),
      ),
    ).toBe(false)
  })
})

describe("inventory filters", () => {
  const projects = [
    project({ project_id: "risk", status: "at_risk", metrics: { active_days: 1 }, evidence: withEvidence() }),
    project({ project_id: "clear", status: "clear", metrics: { active_days: 5 } }),
    project({ project_id: "data", status: "clear" }),
    project({ project_id: "paused", status: "clear", planned_pause: true, metrics: { active_days: 0 } }),
  ]

  it("passes everything through for the default filter", () => {
    expect(filterProjects(projects, "All projects")).toHaveLength(4)
  })

  it("excludes paused projects from Active projects", () => {
    expect(filterProjects(projects, "Active projects").map((p) => p.id)).toEqual(["risk", "clear", "data"])
  })

  it("matches Needs attention to the evidence-backed warnings only", () => {
    expect(filterProjects(projects, "Needs attention").map((p) => p.id)).toEqual(["risk"])
  })

  it("matches a status chip by its rendered label", () => {
    expect(filterProjects(projects, "Insufficient data").map((p) => p.id)).toEqual(["data"])
  })

  it("rejects a filter value that is not one of the chips", () => {
    expect(isProjectFilter("At risk")).toBe(true)
    expect(isProjectFilter("'; drop table")).toBe(false)
    expect(isProjectFilter(null)).toBe(false)
  })
})

describe("legacy hash bookmarks", () => {
  it("leaves a modern hash alone", () => {
    expect(legacyHashRoute("#/projects/p1?asOf=2026-01-05")).toBeNull()
    expect(legacyHashRoute("")).toBeNull()
  })

  it("upgrades a project bookmark", () => {
    expect(legacyHashRoute("#view=profile&project=p1")).toBe("#/projects/p1")
  })

  it("upgrades a plain view bookmark", () => {
    expect(legacyHashRoute("#view=insights")).toBe("#/insights")
  })

  it("sends anything unrecognized to Overview rather than a blank view", () => {
    expect(legacyHashRoute("#garbage")).toBe("#/overview")
  })
})
