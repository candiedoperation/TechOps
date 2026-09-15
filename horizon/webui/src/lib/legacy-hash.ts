/**
 * Bookmarks that predate the path-style hash routes used `#view=X&project=Y`.
 *
 * The router only understands `#/...`, so a legacy link is translated once,
 * before the app mounts, and replaced in the address bar. An old link upgrades
 * itself on first use instead of landing on a blank view.
 */

const KNOWN_VIEWS = new Set([
  "overview",
  "projects",
  "insights",
  "members",
  "member",
  "recruiting",
  "profiles",
  "analytics",
])

/** Returns the modern hash for a legacy one, or null when there is nothing to
 *  translate (an already-modern hash, or an empty one). */
export function legacyHashRoute(rawHash: string): string | null {
  const hash = String(rawHash || "").replace(/^#/, "")
  if (!hash || hash.startsWith("/")) return null

  const params = new URLSearchParams(hash)
  const view = params.get("view")
  const projectId = params.get("project")

  if (projectId && (view === "profile" || !view || !KNOWN_VIEWS.has(view))) {
    return `#/projects/${encodeURIComponent(projectId)}`
  }
  if (view === "recruiting") return "#/recruiting"
  if (view === "member" || view === "members") return "#/members"
  if (view && KNOWN_VIEWS.has(view)) return `#/${view}`
  return "#/overview"
}

/** Rewrite the address bar in place. Called once, before the router mounts. */
export function normalizeLegacyHash(win: Window = window): void {
  const replacement = legacyHashRoute(win.location.hash)
  if (!replacement) return
  win.history.replaceState(null, "", `${win.location.pathname}${win.location.search}${replacement}`)
}
