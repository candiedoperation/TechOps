import { createClient } from "redis";

export class RedisClient {
    private static client: ReturnType<typeof createClient> | null = null;

    private static getRedisUrl(): string {
        const redisUrl = process.env.PEOPLEPORTAL_REDIS_URL;
        if (!redisUrl) {
            throw new Error("Redis URL is invalid");
        }

        return redisUrl;
    }

    private static getClient() {
        if (!this.client) {
            this.client = createClient({ url: this.getRedisUrl() });

             this.client.on("error", (err) => {
                 console.error("Redis client error:", err);
             });
        }

        return this.client;
    }

    public static async init() {
        const client = this.getClient();
        if (!client.isOpen) {
            await new Promise<void>((resolve, reject) => {
                const handleInitialError = (err: Error) => {
                    client.off("error", handleInitialError);
                    reject(err);
                };

                client.once("error", handleInitialError);
                client.connect().then(
                    () => {
                        client.off("error", handleInitialError);
                        resolve();
                    },
                    (err) => {
                        client.off("error", handleInitialError);
                        reject(err);
                    }
                );
            });
        }
    }

    public static async get<T>(key: string): Promise<T | null> {
        let value: string | null;

        try {
            value = await this.getClient().get(key);
        } catch (err) {
            console.error(`Failed to read Redis value for key "${key}":`, err);
            return null;
        }

        if (!value) {
            return null;
        }

        try {
            return JSON.parse(value) as T;
        } catch (err) {
            console.error(`Failed to parse Redis value for key "${key}":`, err);
            return null;
        }
    }

    public static async set(key: string, value: unknown, ttlSeconds?: number) {
        const serializedValue = JSON.stringify(value);

        try {
            if (ttlSeconds) {
                await this.getClient().set(key, serializedValue, { EX: ttlSeconds });
                return;
            }

            await this.getClient().set(key, serializedValue);
        } catch (err) {
            console.error(`Failed to write Redis value for key "${key}":`, err);
        }
    }

    public static async delete(key: string) {
        try {
            await this.getClient().del(key);
        } catch (err) {
            console.error(`Failed to delete Redis value for key "${key}":`, err);
        }
    }
}
