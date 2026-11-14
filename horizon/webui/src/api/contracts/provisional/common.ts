/** DRAFT DISCUSSION TYPES ONLY. No existing Horizon endpoint returns these contracts.
 * Review field names, units, nullability, IDs, and authorization with T6.2/T6.3 owners.
 */
export interface ProvisionalPublicationMetadata {
  state: 'current' | 'stale' | 'provisional' | 'missing'
  publishedAt: string | null
  sourceAsOf: string | null
  publicationId: string | null
  runId: string | null
}

export interface ProvisionalCoverage {
  state: 'complete' | 'partial' | 'missing'
  available: number | null
  expected: number | null
  gaps: readonly string[]
}

export interface ProvisionalEvidenceReference {
  id: string
  label: string
  sourceType: string
  /** Returned only if the viewer is permitted to follow this evidence link. */
  href: string | null
}

export interface ProvisionalComponentScore {
  key: string
  label: string
  value: number | null
  /** Backend-defined unit/range; never assume 0–100 or infer missing scores as zero. */
  unit: string | null
  coverage: ProvisionalCoverage
  evidence: readonly ProvisionalEvidenceReference[]
}

export interface ProvisionalPage<T> {
  items: readonly T[]
  page: { nextCursor: string | null }
  publication: ProvisionalPublicationMetadata
  /** Backend-supplied capabilities are UI hints, never proof of authorization. */
  capabilities: readonly string[]
}

export interface ProvisionalResult<T> {
  data: T | null
  publication: ProvisionalPublicationMetadata
  capabilities: readonly string[]
}

export interface ProvisionalPeriod {
  id: string
  label: string
}

export interface ProvisionalFilter {
  key: string
  label: string
  options: readonly { value: string; label: string }[]
}

export interface ProvisionalReadOptions {
  periodId: string
  cursor?: string | null
  pageSize?: number
  /** Populate only from the filters advertised by the approved API. */
  filters?: Readonly<Record<string, string>>
}
