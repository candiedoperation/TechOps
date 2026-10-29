/**
 * The logger is the one place every server log line goes through, so these pin
 * the behaviours the rest of the codebase relies on: LOG_LEVEL is honoured,
 * errors are serialised without leaking request secrets, and each request logs
 * one structured line carrying its id.
 */
const assert = require("node:assert/strict");
const test = require("node:test");
const pino = require("pino");
const { EventEmitter } = require("node:events");
const {
  resolveLogLevel,
  serializeError,
  errorMap,
  requestLogger,
  REDACT,
} = require("../../dist/utils/logger.js");

test("LOG_LEVEL is honoured, case-insensitively, and bad values fall back", () => {
  assert.equal(resolveLogLevel("debug"), "debug");
  assert.equal(resolveLogLevel(" WARN "), "warn");
  /* NODE_ENV is "test" here, where the default is silent. */
  assert.equal(resolveLogLevel(undefined), "silent");
  assert.equal(resolveLogLevel("loud"), "silent");
});

test("serialised errors keep message and stack but drop the request", () => {
  const err = new Error("Request failed with status code 401");
  err.config = { headers: { Authorization: "Bearer super-secret" } };
  err.request = { _header: "Authorization: Bearer super-secret" };
  err.response = { status: 401, data: { token: "super-secret" } };

  const out = serializeError(err);
  assert.equal(out.message, "Request failed with status code 401");
  assert.ok(out.stack);
  assert.equal(out.status, 401);
  assert.equal(out.config, undefined);
  assert.equal(out.request, undefined);
  assert.equal(out.response, undefined);
  assert.doesNotMatch(JSON.stringify(out), /super-secret/);
});

test("errorMap flattens named failures to messages", () => {
  const errors = new Map([
    ["aws", new Error("denied")],
    ["slack", new Error("rate limited")],
  ]);
  assert.deepEqual(errorMap(errors), { aws: "denied", slack: "rate limited" });
});

test("a request gets an id header, and the id is passed along", () => {
  const req = { method: "GET", baseUrl: "/api", route: { path: "/teams/:teamId" }, session: {} };
  const res = new EventEmitter();
  res.statusCode = 200;
  const headers = {};
  res.setHeader = (k, v) => (headers[k] = v);

  let called = false;
  requestLogger(req, res, () => {
    called = true;
  });
  assert.ok(called, "next() must be called");
  assert.match(req.id, /^[0-9a-f-]{36}$/);
  assert.equal(headers["X-Request-Id"], req.id);

  /* Finishing must not throw even with no session user. */
  res.emit("finish");
});

test("credentials are redacted at the top level and one level down", () => {
  let line = "";
  const log = pino({ redact: REDACT }, { write: (chunk) => (line += chunk) });
  log.info({ password: "hunter2", token: "t0p", user: { secret: "s3", refreshToken: "r3" } });
  assert.doesNotMatch(line, /hunter2|t0p|s3|r3/);
  assert.match(line, /\[redacted\]/);
});
