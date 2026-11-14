/** Internal display model, not an assertion about an existing backend response schema.
 * A reviewed response parser must supply this metadata; cache age is not publication age.
 */
export interface PublicationFreshness {
  state: 'current' | 'stale' | 'provisional' | 'missing'
  publishedAt: string | null
}

/** Run age, not query-cache age. Exactly eight days is still current. */
export function isRunStale(asOf: string | null, now = Date.now()): boolean | null {
  if (!asOf) return null
  const timestamp = Date.parse(asOf)
  if (!Number.isFinite(timestamp)) return null
  return now - timestamp > 8 * 24 * 60 * 60 * 1000
}
