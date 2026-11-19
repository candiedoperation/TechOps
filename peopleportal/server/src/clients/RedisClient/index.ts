import { createClient } from "redis";
import log from "loglevel";

/**
 * Redis is a cache in front of Mongo and Authentik, never a system of record.
 * The governing rule is that a Redis outage is a cache miss and nothing more:
 * it must not fail a request, must not stall a request, and must not stop or
 * delay the server from booting. Every entry point below swallows its own
 * errors and reports a miss.
 */
export class RedisClient {
    private static readonly TAG = "RedisClient";

    /* Long enough to ride out a restart, short enough that a request never
       waits on a dead socket. Commands are raced against this too. */
    private static readonly CONNECT_TIMEOUT_MS = 5_000;
    private static readonly COMMAND_TIMEOUT_MS = 1_000;
    private static readonly MAX_RECONNECT_DELAY_MS = 30_000;
    private static readonly ERROR_LOG_INTERVAL_MS = 60_000;

    private static client: ReturnType<typeof createClient> | null = null;
    private static disabled = false;
    private static lastErrorLoggedAt = 0;

    /** A sustained outage must not flood the logs with one line per retry. */
    private static logErrorThrottled(message: string) {
        const now = Date.now();
        if (now - this.lastErrorLoggedAt < this.ERROR_LOG_INTERVAL_MS) return;

        this.lastErrorLoggedAt = now;
        log.error(this.TAG, message);
    }

    private static getClient() {
        if (this.disabled) return null;

        if (!this.client) {
            const redisUrl = process.env.PEOPLEPORTAL_REDIS_URL;
            if (!redisUrl) {
                /* Unconfigured is a deployment choice, not an error. Say so once
                   and stop trying, rather than throwing on every cache read. */
                log.warn(this.TAG, "PEOPLEPORTAL_REDIS_URL is unset; running without a cache.");
                this.disabled = true;
                return null;
            }

            this.client = createClient({
                url: redisUrl,

                /* Commands issued while disconnected must fail immediately. The
                   default queues them until reconnection, which would turn a
                   Redis outage into hung requests instead of cache misses. */
                disableOfflineQueue: true,

                socket: {
                    connectTimeout: this.CONNECT_TIMEOUT_MS,

                    /* Retry forever so the cache heals itself once Redis returns,
                       but on capped exponential backoff. The default strategy
                       reconnects in a tight loop, which is what made a downed
                       Redis hang startup and flood the log. */
                    reconnectStrategy: (retries: number) =>
                        Math.min(100 * 2 ** retries, this.MAX_RECONNECT_DELAY_MS),
                },
            });

            /* node-redis emits 'error' on the client. An unhandled 'error' event
               takes down the process, so this listener is mandatory, not
               cosmetic: a mid-flight Redis restart would otherwise kill us. */
            this.client.on("error", (e: unknown) => {
                this.logErrorThrottled(`Redis unavailable, serving uncached: ${e instanceof Error ? e.message : String(e)}`);
            });

            this.client.on("ready", () => log.info(this.TAG, "Cache connected."));
        }

        return this.client;
    }

    /** True only when a command can be issued right now. */
    private static ready(): boolean {
        return !!this.client?.isReady;
    }

    /** Runs a cache operation, degrading any failure or stall to `fallback`. */
    private static async attempt<T>(label: string, operation: () => Promise<T>, fallback: T): Promise<T> {
        if (!this.ready()) return fallback;

        try {
            /* isReady can go stale between the check and the call, so a command
               is raced against a timeout as well: no cache operation is ever
               allowed to become the slowest part of a request. */
            return await Promise.race([
                operation(),
                new Promise<T>((_, reject) =>
                    setTimeout(() => reject(new Error(`${label} timed out after ${this.COMMAND_TIMEOUT_MS}ms`)), this.COMMAND_TIMEOUT_MS)
                ),
            ]);
        } catch (e: unknown) {
            this.logErrorThrottled(`${label} failed, treating as a miss: ${e instanceof Error ? e.message : String(e)}`);
            return fallback;
        }
    }

    /**
     * Opens the connection without blocking boot. A failed or slow connect is
     * logged and abandoned; the reconnect strategy keeps working in the
     * background, so the cache comes online by itself once Redis is reachable.
     */
    public static async init() {
        const client = this.getClient();
        if (!client || client.isOpen) return;

        try {
            await Promise.race([
                client.connect(),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error("connect timed out")), this.CONNECT_TIMEOUT_MS)
                ),
            ]);
        } catch (e: unknown) {
            /* Deliberately not rethrown: startup() exits the process on a thrown
               error, and the server serves fine without a cache. */
            log.warn(this.TAG, `Cache unavailable at boot, continuing without it and retrying in the background: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    public static async get<T>(key: string): Promise<T | null> {
        return this.attempt(`get(${key})`, async () => {
            const value = await this.client!.get(key);
            return value ? (JSON.parse(value) as T) : null;
        }, null);
    }

    public static async set(key: string, value: unknown, ttlSeconds?: number) {
        await this.attempt(`set(${key})`, async () => {
            const serialized = JSON.stringify(value);
            if (ttlSeconds) await this.client!.set(key, serialized, { EX: ttlSeconds });
            else await this.client!.set(key, serialized);
        }, undefined);
    }

    public static async delete(key: string) {
        /* A failed invalidation serves stale data until the TTL expires, so
           every cached key must carry one. */
        await this.attempt(`delete(${key})`, async () => { await this.client!.del(key); }, undefined);
    }

    /** Lets tests and shutdown paths release the connection and start clean. */
    public static async disconnect() {
        if (this.client?.isOpen) await this.client.destroy();
        this.client = null;
        this.disabled = false;
        this.lastErrorLoggedAt = 0;
    }
}
