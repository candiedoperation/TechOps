/**
 * Attention-state vocabulary.
 *
 * The five states and the review language attached to them come straight from
 * the vanilla `statusMeta` table. Colour is named only as a token class here,
 * so no component has to know what "risk" looks like.
 */

import type { EvidenceSeverity, Project, StatusClass } from "@/api/types"

export interface StatusMeta {
  /** The standing description under the status pill on a profile. */
  copy: string
  /** The primary action a reviewer is offered for this state. */
  cta: string
}

export const STATUS_META: Record<StatusClass, StatusMeta> = {
  risk: { copy: "Review", cta: "Review" },
  watch: { copy: "Review", cta: "Review" },
  clear: { copy: "No concern", cta: "Confirm" },
  data: { copy: "Insufficient data", cta: "Flag" },
  pause: { copy: "Paused", cta: "Acknowledge" },
}

export function statusMetaFor(statusClass: StatusClass): StatusMeta {
  return STATUS_META[statusClass] ?? STATUS_META.data
}

/** Tailwind classes for a filled status chip. */
export const STATUS_PILL_CLASS: Record<StatusClass, string> = {
  risk: "bg-status-risk-surface text-status-risk border-status-risk/30",
  watch: "bg-status-watch-surface text-status-watch border-status-watch/30",
  clear: "bg-status-clear-surface text-status-clear border-status-clear/30",
  data: "bg-status-data-surface text-status-data border-status-data/30",
  pause: "bg-status-pause-surface text-status-pause border-status-pause/30",
}

/** Solid variant, for the monogram tile beside a project name. */
export const STATUS_SOLID_CLASS: Record<StatusClass, string> = {
  risk: "bg-status-risk text-status-risk-foreground",
  watch: "bg-status-watch text-status-watch-foreground",
  clear: "bg-status-clear text-status-clear-foreground",
  data: "bg-status-data text-status-data-foreground",
  pause: "bg-status-pause text-status-pause-foreground",
}

/** The CSS colour a chart line uses for a project, as a token reference. */
export const STATUS_STROKE_VAR: Record<StatusClass, string> = {
  risk: "var(--status-risk)",
  watch: "var(--status-watch)",
  clear: "var(--status-clear)",
  data: "var(--status-data)",
  pause: "var(--status-pause)",
}

/** Evidence markers carry their own severity, independent of the project's
 *  overall state: one amber signal does not make the project amber. */
export const EVIDENCE_MARKER_CLASS: Record<EvidenceSeverity, string> = {
  red: "bg-status-risk-surface text-status-risk",
  amber: "bg-status-watch-surface text-status-watch",
  blue: "bg-status-data-surface text-status-data",
  teal: "bg-status-clear-surface text-status-clear",
}

export const SEVERITY_LABELS: Record<string, string> = {
  info: "Info",
  warning: "Warning",
  critical: "Critical",
}

export const SEVERITY_CHIP_CLASS: Record<string, string> = {
  info: "bg-status-data-surface text-status-data",
  warning: "bg-status-watch-surface text-status-watch",
  critical: "bg-status-risk-surface text-status-risk",
}

/**
 * A project is in the attention queue only when its warning state is backed
 * by evidence. This is the same predicate the Overview counter uses, so the
 * "Need attention" tile can never disagree with the filtered list.
 */
export function isAttentionProject(project: Project): boolean {
  return (project.statusClass === "risk" || project.statusClass === "watch") && project.evidence.length > 0
}

export function isActiveProject(project: Project): boolean {
  return project.statusClass !== "pause"
}

/** The inventory filter chips, in the order they are offered. */
export const PROJECT_FILTERS = [
  "All projects",
  "Active projects",
  "Needs attention",
  "At risk",
  "Watch",
  "Clear",
  "Insufficient data",
  "Planned pause",
] as const

export type ProjectFilter = (typeof PROJECT_FILTERS)[number]

export function isProjectFilter(value: string | null | undefined): value is ProjectFilter {
  return Boolean(value) && (PROJECT_FILTERS as readonly string[]).includes(value as string)
}

export function filterProjects(projects: Project[], filter: ProjectFilter): Project[] {
  if (filter === "All projects") return projects
  if (filter === "Active projects") return projects.filter(isActiveProject)
  if (filter === "Needs attention") return projects.filter(isAttentionProject)
  return projects.filter((project) => project.status === filter)
}

export const TRAJECTORY_LABELS: Record<string, string> = {
  accelerating: "Accelerating",
  steady: "Steady",
  slowing: "Slowing",
  /* Retired verdict, kept so a checkpoint persisted before the change still
     renders a label rather than a blank chip. */
  stalled: "Slowing",
  unknown: "Unknown",
}

export const WORK_LEVEL_LABELS: Record<string, string> = {
  none: "None",
  trivial: "Trivial",
  minimal: "Minimal",
  moderate: "Moderate",
  substantial: "Substantial",
}
