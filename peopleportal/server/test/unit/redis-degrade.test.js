/**
 * Redis is a cache, so losing it must cost latency and nothing else.
 *
 * Two failure modes are covered, both of which the original implementation got
 * wrong. Unconfigured threw on every call, since the URL getter raised instead
 * of reporting a miss. Unreachable was worse: node-redis reconnects forever by
 * default, so `connect()` never settled and `await RedisClient.init()` inside
 * startup() hung boot before Mongo was ever reached, with no listener and no
 * error. Both must now degrade to a plain cache miss.
 */
const assert = require("node:assert/strict");
const test = require("node:test");
const { RedisClient } = require("../../dist/clients/RedisClient/index.js");

/* Nothing listens here; .env.test points at a real port, so it is overridden. */
const UNREACHABLE_URL = "redis://127.0.0.1:6399";

/** Runs with the given Redis URL, restoring env and client state afterwards. */
async function withRedisUrl(url, fn) {
  const saved = process.env.PEOPLEPORTAL_REDIS_URL;
  if (url === undefined) delete process.env.PEOPLEPORTAL_REDIS_URL;
  else process.env.PEOPLEPORTAL_REDIS_URL = url;

  try {
    return await fn();
  } finally {
    await RedisClient.disconnect();
    if (saved === undefined) delete process.env.PEOPLEPORTAL_REDIS_URL;
    else process.env.PEOPLEPORTAL_REDIS_URL = saved;
  }
}

test("an unset URL disables the cache instead of throwing", async () => {
  await withRedisUrl(undefined, async () => {
    await RedisClient.init();
    assert.equal(await RedisClient.get("k"), null);
    await RedisClient.set("k", { a: 1 }, 60);
    await RedisClient.delete("k");
  });
});

test("init() settles rather than hanging boot when Redis is unreachable", async () => {
  await withRedisUrl(UNREACHABLE_URL, async () => {
    const startedAt = Date.now();
    await RedisClient.init();

    /* The bug this guards: an unbounded reconnect loop never settles, so
       startup() never proceeds to Mongo. Any bounded value passes. */
    assert.ok(Date.now() - startedAt < 15_000, "init() must give up and let boot continue");
  });
});

test("reads and writes against an unreachable Redis are fast misses, not errors", async () => {
  await withRedisUrl(UNREACHABLE_URL, async () => {
    await RedisClient.init();

    const startedAt = Date.now();
    assert.equal(await RedisClient.get("ats:openteams"), null);
    await RedisClient.set("ats:openteams", [{ pk: 1 }], 60);
    await RedisClient.delete("ats:openteams");

    /* disableOfflineQueue is what makes this instant. Without it the commands
       queue until reconnection and the request hangs instead of missing. */
    assert.ok(Date.now() - startedAt < 5_000, "cache operations must not stall a request");
  });
});

test("a cache miss is indistinguishable from a stored null", async () => {
  await withRedisUrl(UNREACHABLE_URL, async () => {
    await RedisClient.init();
    /* Callers branch on `if (cached)`, so a miss must be falsy, never a throw
       and never an empty array that would masquerade as "no open teams". */
    assert.equal(await RedisClient.get("anything"), null);
  });
});
