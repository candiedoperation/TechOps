/**
 * Vocabulary for the Gitea member analytics surfaces.
 *
 * The sort list is deliberately limited to observable counts: these are named
 * per-person contribution metrics -- descriptive activity indicators -- and
 * offering a derived ranking of Horizon's own here would turn them into a
 * score, which they are not.
 */

import type { AnalyticsMember } from "@/api/types"

/**
 * Numeric columns of the member table, in the order the published ranking
 * export (`member-analytics.md`) prints them, followed by the coverage
 * metrics that export omits.
 *
 * `sortable` marks the keys `MEMBER_SORT_FIELDS` accepts in `backend/api.py`.
 * A key absent from that set must stay unsortable: the API answers 422 for
 * anything else, so offering it here would be a dead control.
 */
export const MEMBER_COLUMNS = [
  { key: "commits", label: "Commits", sortable: true },
  { key: "additions", label: "Additions", sortable: true },
  { key: "deletions", label: "Deletions", sortable: true },
  { key: "unique_files", label: "Files", sortable: true },
  { key: "files_changed", label: "File changes", sortable: false },
  { key: "pulls_opened", label: "PRs", sortable: true },
  { key: "pulls_merged", label: "Merged", sortable: true },
  { key: "reviews_submitted", label: "Reviews", sortable: true },
  { key: "reviews_approved", label: "Approved", sortable: true },
  { key: "issues_opened", label: "Issues", sortable: true },
  { key: "active_days", label: "Active days", sortable: true },
  { key: "blame_lines", label: "Lines owned", sortable: true },
  { key: "blame_files", label: "Files owned", sortable: false },
] as const satisfies readonly {
  key: keyof AnalyticsMember
  label: string
  sortable: boolean
}[]

export type MemberColumn = (typeof MEMBER_COLUMNS)[number]

/** Every column the table renders, including the two non-numeric ones. */
export const MEMBER_TABLE_COLUMN_COUNT = MEMBER_COLUMNS.length + 2

export const MEMBER_SORTS = [
  ...MEMBER_COLUMNS.filter((column) => column.sortable).map((column) => ({
    key: column.key as string,
    label: column.label,
  })),
  { key: "name", label: "Name" },
]

export const MEMBER_SORT_KEYS: readonly string[] = MEMBER_SORTS.map((option) => option.key)

export function memberDisplayName(member: AnalyticsMember): string {
  return member.name || member.login || "Unknown"
}

/**
 * Read one numeric column off a member.
 *
 * Returns `null` rather than `0` for an absent metric so the cell renders as
 * "no data": a member the collector could not measure is not a member who
 * contributed nothing, and the two must not look alike.
 */
export function memberMetric(member: AnalyticsMember, key: MemberColumn["key"]): number | null {
  const value = member[key]
  return typeof value === "number" && Number.isFinite(value) ? value : null
}
