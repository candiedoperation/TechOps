/**
 * Runs an async mapper over a list with a ceiling on how many run at once.
 *
 * Sequential `for ... await` loops over network calls are the usual cause of an
 * endpoint that degrades linearly with the size of the club. Promise.all fixes
 * the latency but replaces it with an unbounded burst at whatever upstream is
 * being called. This sits in between.
 *
 * Results are returned in input order and settled, never thrown, so one failed
 * item cannot discard the successful ones: callers decide what a rejection
 * means, which for Authentik is the difference between "this group is gone,
 * clean it up" and "the directory is down, abort".
 */
export async function mapWithConcurrency<T, R>(
    items: readonly T[],
    limit: number,
    mapper: (item: T, index: number) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
    if (items.length === 0) return [];

    const effectiveLimit = Math.max(1, Math.min(limit, items.length));
    const results = new Array<PromiseSettledResult<R>>(items.length);
    let nextIndex = 0;

    /* Each worker pulls the next index until the list is exhausted, so a slow
       item delays only its own worker rather than a whole batch. */
    const worker = async () => {
        while (true) {
            const index = nextIndex++;
            if (index >= items.length) return;

            try {
                results[index] = { status: "fulfilled", value: await mapper(items[index]!, index) };
            } catch (reason: unknown) {
                results[index] = { status: "rejected", reason };
            }
        }
    };

    await Promise.all(Array.from({ length: effectiveLimit }, worker));
    return results;
}
