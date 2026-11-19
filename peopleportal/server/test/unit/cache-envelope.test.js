/**
 * The envelope is what lets the open-teams cache serve stale data while it
 * refreshes. Its failure modes are quiet ones: a mis-read entry does not throw,
 * it silently returns the wrong roster to applicants, so the type guard matters
 * as much as the staleness maths.
 */
const assert = require("node:assert/strict");
const test = require("node:test");
const {
  wrapCacheValue,
  isCacheEnvelope,
  isCacheStale,
} = require("../../dist/utils/cache-envelope.js");

test("a wrapped value round-trips through JSON, as Redis stores it", () => {
  const teams = [{ pk: "a", subteamInfo: {} }];
  const restored = JSON.parse(JSON.stringify(wrapCacheValue(teams, 1000)));

  assert.ok(isCacheEnvelope(restored));
  assert.deepEqual(restored.value, teams);
  assert.equal(restored.cachedAt, 1000);
});

test("an entry is fresh until the soft TTL and stale after it", () => {
  const envelope = wrapCacheValue([], 0);

  assert.equal(isCacheStale(envelope, 300, 299_000), false, "just inside the TTL is fresh");
  assert.equal(isCacheStale(envelope, 300, 300_000), false, "exactly at the TTL is not yet stale");
  assert.equal(isCacheStale(envelope, 300, 300_001), true, "one millisecond past is stale");
});

test("a cachedAt in the future counts as fresh rather than triggering a refresh storm", () => {
  /* Clock skew between instances must not make every reader think the entry
     is stale and start rebuilding. */
  const envelope = wrapCacheValue([], 10_000);
  assert.equal(isCacheStale(envelope, 300, 0), false);
});

test("anything that is not an envelope is rejected rather than read as one", () => {
  /* The bare-array format this replaced is the case that matters: reading it
     as an envelope would hand callers `undefined` and render an empty roster
     as though no team were recruiting. */
  assert.equal(isCacheEnvelope([{ pk: "a" }]), false, "the previous bare-array format");
  assert.equal(isCacheEnvelope(null), false);
  assert.equal(isCacheEnvelope(undefined), false);
  assert.equal(isCacheEnvelope("string"), false);
  assert.equal(isCacheEnvelope({ value: [] }), false, "missing cachedAt");
  assert.equal(isCacheEnvelope({ cachedAt: "no" , value: [] }), false, "cachedAt must be a number");
  assert.equal(isCacheEnvelope({ cachedAt: 1 }), false, "missing value");
});

test("an envelope holding null or an empty list is still a valid envelope", () => {
  /* "No teams are recruiting" is a real answer and must be cacheable. */
  assert.equal(isCacheEnvelope(wrapCacheValue([], 0)), true);
  assert.equal(isCacheEnvelope(wrapCacheValue(null, 0)), true);
});
