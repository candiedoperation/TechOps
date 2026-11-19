/**
 * mapWithConcurrency is what replaced the sequential Authentik loop in the
 * open-roles build, so its three guarantees are load-bearing: results stay in
 * input order, the ceiling is never exceeded, and one rejection cannot discard
 * the successful results around it.
 */
const assert = require("node:assert/strict");
const test = require("node:test");
const { mapWithConcurrency } = require("../../dist/utils/concurrency.js");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("results come back in input order, not completion order", async () => {
  const items = [40, 10, 30, 0, 20];

  /* Deliberately inverted: the last item finishes first. Indexing by
     completion would scramble teams against their Mongo rows. */
  const results = await mapWithConcurrency(items, 3, async (ms) => {
    await wait(ms);
    return ms;
  });

  assert.deepEqual(results.map((r) => r.value), items);
});

test("never runs more than the limit at once", async () => {
  let inFlight = 0;
  let peak = 0;

  await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
    peak = Math.max(peak, ++inFlight);
    await wait(5);
    inFlight--;
  });

  assert.equal(peak, 4, `expected at most 4 concurrent, saw ${peak}`);
});

test("a rejection is settled, not thrown, and does not lose its siblings", async () => {
  const results = await mapWithConcurrency([1, 2, 3], 2, async (n) => {
    if (n === 2) throw new Error("boom");
    return n * 10;
  });

  /* The caller decides what a failure means. For Authentik that is the
     difference between "this group is gone" and "the directory is down", so
     the rejection must arrive as data rather than unwinding the batch. */
  assert.deepEqual(results.map((r) => r.status), ["fulfilled", "rejected", "fulfilled"]);
  assert.equal(results[0].value, 10);
  assert.equal(results[2].value, 30);
  assert.equal(results[1].reason.message, "boom");
});

test("an empty list does no work and returns nothing", async () => {
  let called = 0;
  const results = await mapWithConcurrency([], 5, async () => { called++; });

  assert.deepEqual(results, []);
  assert.equal(called, 0);
});

test("a limit larger than the list, or below one, still runs every item exactly once", async () => {
  for (const limit of [999, 0, -1]) {
    const seen = [];
    const results = await mapWithConcurrency([1, 2, 3], limit, async (n) => { seen.push(n); return n; });

    assert.deepEqual(seen.sort(), [1, 2, 3], `limit ${limit} skipped or repeated an item`);
    assert.equal(results.length, 3);
  }
});
