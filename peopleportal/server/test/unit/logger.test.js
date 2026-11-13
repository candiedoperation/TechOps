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

/* An axios-shaped failure: the request config and response both carry secrets. */
function axiosError(message) {
  const err = new Error(message);
  err.config = { headers: { Authorization: "Bearer nested-bearer" } };
  err.request = { _header: "Authorization: Bearer nested-bearer" };
  err.response = {
    status: 401,
    headers: { "set-cookie": ["sid=nested-cookie; HttpOnly"] },
    data: { token: "nested-token" },
  };
  err.headers = { "set-cookie": ["sid=nested-cookie; HttpOnly"] };
  return err;
}

test("errors inside an AggregateError are stripped of the request too", () => {
  const out = serializeError(
    new AggregateError([axiosError("first failed"), new Error("second failed")], "all failed"),
  );
  assert.equal(out.message, "all failed");
  assert.equal(out.aggregateErrors.length, 2);
  assert.equal(out.aggregateErrors[0].message, "first failed");
  assert.equal(out.aggregateErrors[0].status, 401);
  assert.equal(out.aggregateErrors[0].config, undefined);
  assert.doesNotMatch(JSON.stringify(out), /nested-bearer|nested-cookie|nested-token/);
});

test("errors attached as .original, .inner or .cause are stripped too", () => {
  const err = new Error("An HTTP protocol error occurred");
  err.code = "slack_webapi_request_error";
  err.original = axiosError("Request failed with status code 401");
  err.inner = new Error("wrapped", { cause: axiosError("deeper") });
  err.inner.inner = axiosError("deepest");
  err.cause = axiosError("cause");

  const out = serializeError(err);
  assert.equal(out.code, "slack_webapi_request_error");
  assert.equal(out.original.message, "Request failed with status code 401");
  assert.equal(out.inner.inner.message, "deepest");
  assert.match(out.message, /cause/);
  assert.doesNotMatch(JSON.stringify(out), /nested-bearer|nested-cookie|nested-token/);

  /* The caller's error object is left as it was. */
  assert.ok(err.original.config);
});

test("a plain-object cause or errors list cannot smuggle the request in", () => {
  const err = new Error("outer");
  err.cause = { config: { headers: { Authorization: "Bearer nested-bearer" } } };
  const agg = new AggregateError([], "agg");
  Object.defineProperty(agg, "errors", {
    value: [axiosError("listed")],
    enumerable: true,
  });

  assert.doesNotMatch(
    JSON.stringify([serializeError(err), serializeError(agg)]),
    /nested-bearer|nested-cookie|nested-token/,
  );
});

test("circular error references do not loop", () => {
  const a = new Error("a");
  const b = new Error("b");
  a.inner = b;
  b.inner = a;
  const out = serializeError(a);
  assert.equal(out.inner.message, "b");
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

/* Runs one request through requestLogger and reports how it was logged. */
function logRequest(req) {
  const { logger } = require("../../dist/utils/logger.js");
  const res = new EventEmitter();
  res.statusCode = 200;
  res.setHeader = () => {};
  const seen = [];
  const saved = { info: logger.info, debug: logger.debug };
  logger.info = (fields) => seen.push(["info", fields]);
  logger.debug = (fields) => seen.push(["debug", fields]);
  try {
    requestLogger({ session: {}, method: "GET", baseUrl: "", ...req }, res, () => {});
    res.emit("finish");
  } finally {
    Object.assign(logger, saved);
  }
  assert.equal(seen.length, 1);
  return { level: seen[0][0], route: seen[0][1].route };
}

test("API requests log at info with their route pattern", () => {
  assert.deepEqual(
    logRequest({ originalUrl: "/api/teams/abc?x=1", route: { path: "/api/teams/:teamId" } }),
    { level: "info", route: "/api/teams/:teamId" },
  );
  assert.deepEqual(logRequest({ originalUrl: "/api/nope" }), {
    level: "info",
    route: "(unmatched)",
  });
});

test("UI pages and static assets log at debug", () => {
  assert.deepEqual(
    logRequest({ originalUrl: "/onboard/step/2", route: { path: ["/onboard", "/onboard/*splat"] } }),
    { level: "debug", route: "/onboard" },
  );
  assert.deepEqual(
    logRequest({ originalUrl: "/apply", route: { path: ["/apply", "/apply/*splat"] } }),
    { level: "debug", route: "/apply" },
  );
  assert.deepEqual(logRequest({ originalUrl: "/teams/abc", route: { path: "*splat" } }), {
    level: "debug",
    route: "*splat",
  });
  assert.deepEqual(logRequest({ originalUrl: "/assets/index.js" }), {
    level: "debug",
    route: "(static)",
  });
});

test("credentials are redacted at the top level and one level down", () => {
  let line = "";
  const log = pino({ redact: REDACT }, { write: (chunk) => (line += chunk) });
  log.info({ password: "hunter2", token: "t0p", user: { secret: "s3", refreshToken: "r3" } });
  assert.doesNotMatch(line, /hunter2|t0p|s3|r3/);
  assert.match(line, /\[redacted\]/);
});

test("request bodies attached to errors never reach the log", () => {
  const err = new SyntaxError("Unexpected end of JSON input");
  err.status = 400;
  err.body = '{"username":"probe","password":"hunter2"';
  err.rawBody = Buffer.from(err.body);
  err.data = { auth: { token: "hunter2" } };

  const out = serializeError(err);
  assert.equal(out.message, "Unexpected end of JSON input");
  assert.equal(out.status, 400);
  assert.doesNotMatch(JSON.stringify(out), /hunter2/);
});

test("a caller-supplied x-request-id is used, but only when it is a plain token", () => {
  const run = (headers) => {
    const req = { method: "GET", baseUrl: "/api", headers, session: {} };
    const res = new EventEmitter();
    res.statusCode = 200;
    const sent = {};
    res.setHeader = (k, v) => (sent[k] = v);
    requestLogger(req, res, () => {});
    assert.equal(sent["X-Request-Id"], req.id);
    return req.id;
  };

  assert.equal(run({ "x-request-id": "test-123" }), "test-123");
  assert.match(run({}), /^[0-9a-f-]{36}$/);
  assert.match(run({ "x-request-id": "bad id\nwith newline" }), /^[0-9a-f-]{36}$/);
  assert.match(run({ "x-request-id": "x".repeat(65) }), /^[0-9a-f-]{36}$/);
});
