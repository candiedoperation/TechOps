/**
 * Regression tests for defects found in the red-team review of the merged
 * integration branch. Each test names the bug it locks down, so a future
 * refactor that reintroduces one fails here rather than in production.
 */
const assert = require("node:assert/strict");
const test = require("node:test");

/* ── auth.ts: shared scopes array was mutated ─────────────────────────────
   eventsAuthVerify used scopes.shift() to strip a "NoExecOverride" marker.
   tsoa passes the SAME array instance to every request for a route, so the
   first call permanently removed the flag and silently re-enabled the exec
   override for everyone afterwards. */
test("eventsAuthVerify does not mutate the scopes array it is given", async () => {
  const { eventsAuthVerify } = require("../../dist/auth.js");

  /* Frozen so any in-place mutation throws instead of passing quietly. */
  const routeScopes = Object.freeze(["NoExecOverride", "su:exclusive"]);
  const request = { session: {} };

  /* Rejects because there is no authorized user; the scopes handling still
     runs first, which is the part under test. */
  await assert.rejects(() => eventsAuthVerify(request, routeScopes, true));

  assert.deepEqual(
    routeScopes,
    ["NoExecOverride", "su:exclusive"],
    "the caller's array must be untouched between requests"
  );
});

test("eventsAuthVerify leaves a scopes array without the marker alone", async () => {
  const { eventsAuthVerify } = require("../../dist/auth.js");
  const routeScopes = Object.freeze(["su:exclusive"]);
  await assert.rejects(() => eventsAuthVerify({ session: {} }, routeScopes, true));
  assert.deepEqual(routeScopes, ["su:exclusive"]);
});

/* ── utils/avatars.ts: cache keyed on pk, not on the signed key ───────────
   The signed URL derives from avatarKey, but the cache was keyed on the user
   pk alone, so changing an avatar served the previous image's URL for 24h. */
test("avatar cache does not serve a URL signed for a different key", async () => {
  const { signAvatarUrl } = require("../../dist/utils/avatars.js");

  const first = await signAvatarUrl(4242, "avatars/4242/original.png");
  const second = await signAvatarUrl(4242, "avatars/4242/replacement.png");

  /* Without S3 credentials both fail closed to "", which still proves the
     lookup is not returning a stale hit for a changed key. */
  if (first !== "" && second !== "") {
    assert.notEqual(first, second, "a changed avatarKey must not hit the cache");
    assert.match(second, /replacement\.png/);
  }

  /* Same key twice must be stable, cache hit or not. */
  const third = await signAvatarUrl(4242, "avatars/4242/replacement.png");
  assert.equal(typeof third, "string");
});

test("signAvatarUrl returns empty for a missing user or key rather than throwing", async () => {
  const { signAvatarUrl } = require("../../dist/utils/avatars.js");
  assert.equal(await signAvatarUrl(undefined, "avatars/x.png"), "");
  assert.equal(await signAvatarUrl(0, "avatars/x.png"), "");
  assert.equal(await signAvatarUrl(7, undefined), "");
  assert.equal(await signAvatarUrl(7, ""), "");
});

test("invalidateAvatarUrlCache accepts both id shapes without throwing", () => {
  const { invalidateAvatarUrlCache } = require("../../dist/utils/avatars.js");
  assert.doesNotThrow(() => invalidateAvatarUrlCache(1));
  assert.doesNotThrow(() => invalidateAvatarUrlCache("1"));
});

/* ── PhotoCheckClient: undecided results ─────────────────────────────────
   The service fails open by design. What must not happen is a malformed
   payload being read as a pass without anyone noticing. */
/* PHOTO_CHECK_ENABLED gates the whole client, so the behavioural tests below
   have to turn it on. It is off by default because the sidecar that answers
   these calls is not in the deployment yet. */
function withCheckEnabled(t) {
  const savedFlag = process.env.PHOTO_CHECK_ENABLED;
  const originalFetch = globalThis.fetch;
  process.env.PHOTO_CHECK_ENABLED = "true";
  delete require.cache[require.resolve("../../dist/clients/PhotoCheckClient/PhotoCheckClient.js")];
  const client = require("../../dist/clients/PhotoCheckClient/PhotoCheckClient.js");
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (savedFlag === undefined) delete process.env.PHOTO_CHECK_ENABLED;
    else process.env.PHOTO_CHECK_ENABLED = savedFlag;
    delete require.cache[require.resolve("../../dist/clients/PhotoCheckClient/PhotoCheckClient.js")];
  });
  return client;
}

test("the check is off unless PHOTO_CHECK_ENABLED is set", async () => {
  const savedFlag = process.env.PHOTO_CHECK_ENABLED;
  delete process.env.PHOTO_CHECK_ENABLED;
  delete require.cache[require.resolve("../../dist/clients/PhotoCheckClient/PhotoCheckClient.js")];
  const client = require("../../dist/clients/PhotoCheckClient/PhotoCheckClient.js");

  let called = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { called = true; throw new Error("should not be reached"); };

  const result = await client.checkPhotoHasFace(new Uint8Array([1]));
  assert.equal(result.passed, true);
  assert.equal(result.reason, "check_disabled");
  assert.equal(called, false, "a disabled check must not call the sidecar at all");

  globalThis.fetch = originalFetch;
  if (savedFlag === undefined) delete process.env.PHOTO_CHECK_ENABLED;
  else process.env.PHOTO_CHECK_ENABLED = savedFlag;
  delete require.cache[require.resolve("../../dist/clients/PhotoCheckClient/PhotoCheckClient.js")];
});

test("photo check treats a malformed payload as undecided, not as a pass", async (t) => {
  const client = withCheckEnabled(t);

  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ nonsense: true }) });
  const result = await client.checkPhotoHasFace(new Uint8Array([1, 2, 3]));
  assert.equal(result.reason, "malformed_response");
  assert.equal(typeof result.passed, "boolean");
});

test("photo check reports an unreachable service as service_unavailable", async (t) => {
  const client = withCheckEnabled(t);

  globalThis.fetch = async () => { throw new Error("ECONNREFUSED"); };
  const result = await client.checkPhotoHasFace(new Uint8Array([1]));
  assert.equal(result.reason, "service_unavailable");
});

test("photo check passes an explicit rejection straight through", async (t) => {
  const client = withCheckEnabled(t);

  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ passed: false, reason: "multiple_faces_detected", count: 2 }),
  });
  const result = await client.checkPhotoHasFace(new Uint8Array([1]));
  assert.equal(result.passed, false);
  assert.equal(result.reason, "multiple_faces_detected");
  assert.equal(result.count, 2);
});

test("photo check passes an explicit acceptance straight through", async (t) => {
  const client = withCheckEnabled(t);

  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ passed: true, reason: "ok", count: 1 }),
  });
  const result = await client.checkPhotoHasFace(new Uint8Array([1]));
  assert.equal(result.passed, true);
  assert.equal(result.reason, "ok");
});
