const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");

/* environment.ts reads NODE_ENV at import time, so each case re-imports it
   with a fresh module registry rather than mutating a cached singleton. */
function loadEnvironment(nodeEnv) {
  const modulePath = require.resolve("../../dist/config/environment.js");
  delete require.cache[modulePath];
  const previous = process.env.NODE_ENV;
  /* Assigning undefined to process.env stores the string "undefined". */
  if (nodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = nodeEnv;
  try {
    return require(modulePath);
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
}

test("defaults to development when NODE_ENV is unset", () => {
  const env = loadEnvironment(undefined);
  assert.equal(env.ENVIRONMENT, "development");
  assert.equal(env.isDevelopment, true);
  assert.equal(env.isProduction, false);
});

test("recognises each valid environment exactly once", () => {
  for (const name of ["development", "test", "production"]) {
    const env = loadEnvironment(name);
    assert.equal(env.ENVIRONMENT, name);
    const flags = [env.isDevelopment, env.isTest, env.isProduction].filter(Boolean);
    assert.equal(flags.length, 1, `${name} should set exactly one flag`);
  }
});

test("rejects an unknown NODE_ENV instead of silently defaulting", () => {
  assert.throws(() => loadEnvironment("staging"), /NODE_ENV must be one of/);
});

test("envFlag only treats an explicit 'true' as enabled", () => {
  const env = loadEnvironment("test");
  const cases = [
    ["true", true], ["TRUE", true], ["  true  ", true],
    ["false", false], ["1", false], ["yes", false], ["", false],
  ];
  for (const [raw, expected] of cases) {
    process.env.__FLAG_UNDER_TEST = raw;
    assert.equal(env.envFlag("__FLAG_UNDER_TEST"), expected, `for ${JSON.stringify(raw)}`);
  }
  delete process.env.__FLAG_UNDER_TEST;
  assert.equal(env.envFlag("__FLAG_UNDER_TEST"), false);
  assert.equal(env.envFlag("__FLAG_UNDER_TEST", true), true, "fallback is honoured");
});

test("envInt falls back rather than yielding NaN", () => {
  const env = loadEnvironment("test");
  process.env.__INT_UNDER_TEST = "8080";
  assert.equal(env.envInt("__INT_UNDER_TEST", 3000), 8080);
  process.env.__INT_UNDER_TEST = "not-a-number";
  assert.equal(env.envInt("__INT_UNDER_TEST", 3000), 3000);
  process.env.__INT_UNDER_TEST = "";
  assert.equal(env.envInt("__INT_UNDER_TEST", 3000), 3000);
  delete process.env.__INT_UNDER_TEST;
  assert.equal(env.envInt("__INT_UNDER_TEST", 3000), 3000);
});

test("envRequired treats blank as missing", () => {
  const env = loadEnvironment("test");
  process.env.__REQ_UNDER_TEST = "   ";
  assert.throws(() => env.envRequired("__REQ_UNDER_TEST"), /is not set/);
  process.env.__REQ_UNDER_TEST = "value";
  assert.equal(env.envRequired("__REQ_UNDER_TEST"), "value");
  delete process.env.__REQ_UNDER_TEST;
});

test("required-variable check is a no-op outside production", () => {
  for (const name of ["development", "test"]) {
    const env = loadEnvironment(name);
    assert.doesNotThrow(() => env.assertRequiredEnvironment());
  }
});

test("production refuses to start with a required variable missing", () => {
  const env = loadEnvironment("production");
  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("PEOPLEPORTAL_")) delete process.env[key];
  }
  assert.throws(() => env.assertRequiredEnvironment(), /Missing required environment variables/);
  Object.assign(process.env, saved);
});

test("production refuses to start with TLS verification disabled", () => {
  const env = loadEnvironment("production");
  const saved = { ...process.env };
  for (const key of [
    "PEOPLEPORTAL_BASE_URL", "PEOPLEPORTAL_MONGO_URL", "PEOPLEPORTAL_TOKEN_SECRET",
    "PEOPLEPORTAL_OIDC_DSCVURL", "PEOPLEPORTAL_OIDC_CLIENTID", "PEOPLEPORTAL_OIDC_CLIENTSECRET",
    "PEOPLEPORTAL_AUTHENTIK_ENDPOINT", "PEOPLEPORTAL_AUTHENTIK_TOKEN",
  ]) process.env[key] = "set";
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  assert.throws(() => env.assertRequiredEnvironment(), /NODE_TLS_REJECT_UNAUTHORIZED/);
  process.env = saved;
});
