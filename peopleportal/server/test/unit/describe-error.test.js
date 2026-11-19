/**
 * describeUnknownError exists because `${e}` and e.toString() on a caught
 * `unknown` render a plain object as "[object Object]". Two archive/create
 * paths logged rejected API responses that way, erasing exactly the detail
 * someone reading the log needs.
 */
const assert = require("node:assert/strict");
const test = require("node:test");
const { describeUnknownError } = require("../../dist/utils/errors.js");

test("an Error is rendered as its message", () => {
  assert.equal(describeUnknownError(new Error("Gitea returned 502")), "Gitea returned 502");
  assert.equal(describeUnknownError(new TypeError("bad input")), "bad input");
});

test("a plain object is serialised rather than flattened to [object Object]", () => {
  const result = describeUnknownError({ status: 502, body: "upstream down" });
  assert.doesNotMatch(result, /\[object Object\]/);
  assert.match(result, /502/);
  assert.match(result, /upstream down/);
});

test("a thrown string comes back unchanged", () => {
  assert.equal(describeUnknownError("something broke"), "something broke");
});

test("null and undefined render as empty rather than the literal words", () => {
  assert.equal(describeUnknownError(null), "");
  assert.equal(describeUnknownError(undefined), "");
});

test("a circular object degrades gracefully instead of throwing", () => {
  const circular = { name: "loop" };
  circular.self = circular;
  assert.doesNotThrow(() => describeUnknownError(circular));
  assert.equal(typeof describeUnknownError(circular), "string");
});

test("a value JSON cannot represent still yields a string", () => {
  for (const value of [() => {}, Symbol("x"), 42n]) {
    const result = describeUnknownError(value);
    assert.equal(typeof result, "string");
    assert.ok(result.length > 0, `${String(value)} produced an empty description`);
  }
});

test("an object with a throwing toJSON does not take the caller down", () => {
  const hostile = { toJSON() { throw new Error("nope"); } };
  assert.doesNotThrow(() => describeUnknownError(hostile));
});
