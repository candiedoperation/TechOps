/**
 * Stale-while-revalidate envelope.
 *
 * A plain TTL makes exactly one unlucky request per expiry pay the full cold
 * cost, and under concurrency it is worse than one: every request arriving
 * during the rebuild misses too, and they all rebuild. Stamping the entry with
 * its build time lets a reader serve slightly stale data instantly and refresh
 * in the background, so the expensive path stops being on anyone's critical
 * path.
 *
 * Two bounds apply. The soft TTL is when a refresh is triggered; the hard TTL
 * is the Redis expiry, the absolute ceiling on staleness if every refresh
 * fails. Invalidation on write still deletes the key outright, so a real change
 * is never subject to either.
 */
export interface CacheEnvelope<T> {
    cachedAt: number;
    value: T;
}

export function wrapCacheValue<T>(value: T, now: number = Date.now()): CacheEnvelope<T> {
    return { cachedAt: now, value };
}

/** Guards against entries written before this format existed, or hand-edited. */
export function isCacheEnvelope<T>(candidate: unknown): candidate is CacheEnvelope<T> {
    return (
        typeof candidate === "object" &&
        candidate !== null &&
        typeof (candidate as CacheEnvelope<T>).cachedAt === "number" &&
        "value" in candidate
    );
}

/**
 * Whether the entry is past its soft TTL and should be refreshed. A future
 * `cachedAt` (clock skew between servers) counts as fresh rather than
 * triggering a refresh storm.
 */
export function isCacheStale(envelope: CacheEnvelope<unknown>, softTtlSeconds: number, now: number = Date.now()): boolean {
    return now - envelope.cachedAt > softTtlSeconds * 1000;
}
