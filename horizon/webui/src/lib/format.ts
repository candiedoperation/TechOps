/**
 * Display formatting.
 *
 * Every function here has the same contract: a value that was never measured
 * comes back as the em dash, never as `0`, `0%` or an empty string that could
 * be mistaken for one. `MISSING` is the single spelling of "no data" in the
 * UI, so it is impossible for one surface to render missingness differently
 * from another.
 */

import { finiteNumber } from "@/api/normalize"

export const MISSING = "—"

/** Screen-reader text paired with `MISSING`, so the dash is not read as
 *  punctuation or skipped entirely. */
export const MISSING_LABEL = "No data"

export function formatDate(value: unknown, includeTime = false): string {
  if (!value) return "Unavailable"
  const date = new Date(String(value))
  if (Number.isNaN(date.getTime())) return String(value)
  return new Intl.DateTimeFormat(
    "en-US",
    includeTime
      ? { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }
      : { month: "short", day: "numeric", year: "numeric" },
  ).format(date)
}

export function formatPercent(value: unknown): string {
  const number = finiteNumber(value)
  return number === null ? MISSING : `${Math.round(number)}%`
}

/**
 * A count, thousands-separated. Deliberately distinguishes a real zero from a
 * missing measurement: `0` prints as "0", `null` prints as the dash.
 */
export function formatCount(value: unknown): string {
  if (value === null || value === undefined || value === "") return MISSING
  const number = Number(value)
  return Number.isFinite(number) ? number.toLocaleString() : MISSING
}

/** A metric with its unit, or the dash. */
export function formatMetric(value: unknown, unit = ""): string {
  const number = finiteNumber(value)
  if (number === null) return MISSING
  return `${Number(number.toFixed(2))}${unit}`
}

/** A 0-1 confidence as a percentage; a 0-100 score as itself. */
export function formatAssessmentNumber(value: unknown, asPercent = false): string {
  const number = finiteNumber(value)
  if (number === null) return MISSING
  if (asPercent && number >= 0 && number <= 1) return `${Math.round(number * 100)}%`
  return `${Number(number.toFixed(2))}${asPercent ? "%" : ""}`
}

/** Today, as the `YYYY-MM-DD` an `<input type="date">` and the API both use. */
export function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * Eight weekly axis labels ending at the snapshot week. Falls back to
 * "Week 1..8" when the snapshot carries no week start -- inventing dates for
 * an undated series would put a false timestamp on every point.
 */
export function weekLabels(snapshotWeekStart: string | null | undefined): string[] {
  const generic = Array.from({ length: 8 }, (_, index) => `Week ${index + 1}`)
  if (!snapshotWeekStart) return generic
  const end = new Date(snapshotWeekStart)
  if (Number.isNaN(end.getTime())) return generic
  return Array.from({ length: 8 }, (_, index) => {
    const date = new Date(end)
    date.setUTCDate(date.getUTCDate() - 7 * (7 - index))
    return date.toLocaleDateString("en-US", { month: "short", day: "2-digit", timeZone: "UTC" })
  })
}

/** A snapshot's week range, as one readable chip. */
export function formatWeekRange(start: string | null | undefined, end: string | null | undefined): string {
  if (!start && !end) return "Current snapshot"
  return `${formatDate(start)}${end ? ` – ${formatDate(end)}` : ""}`
}
