const assert = require("node:assert/strict");
const test = require("node:test");

const {
  authenticateGiteaWebhook,
  isGiteaWebhookAuthorized,
} = require("../../dist/utils/gitea-webhook-auth.js");

const VALID_SECRET = "0123456789abcdef0123456789abcdef";

function requestWithAuthorization(authorization) {
  return {
    get(name) {
      assert.equal(name, "Authorization");
      return authorization;
    },
  };
}

test("accepts only the exact configured bearer credential", () => {
  process.env.PEOPLEPORTAL_GITEA_WEBHOOK_SECRET = VALID_SECRET;

  assert.equal(
    isGiteaWebhookAuthorized(requestWithAuthorization(`Bearer ${VALID_SECRET}`)),
    true
  );
  assert.equal(
    isGiteaWebhookAuthorized(requestWithAuthorization("Bearer incorrect")),
    false
  );
  assert.equal(
    isGiteaWebhookAuthorized(requestWithAuthorization(undefined)),
    false
  );
});

test("fails closed when the configured secret is absent or too short", () => {
  delete process.env.PEOPLEPORTAL_GITEA_WEBHOOK_SECRET;
  assert.equal(
    isGiteaWebhookAuthorized(requestWithAuthorization(`Bearer ${VALID_SECRET}`)),
    false
  );

  process.env.PEOPLEPORTAL_GITEA_WEBHOOK_SECRET = "too-short";
  assert.equal(
    isGiteaWebhookAuthorized(requestWithAuthorization("Bearer too-short")),
    false
  );
});

test("middleware rejects invalid credentials before dispatch", () => {
  process.env.PEOPLEPORTAL_GITEA_WEBHOOK_SECRET = VALID_SECRET;

  let nextCalled = false;
  const response = {
    statusCode: undefined,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    },
  };

  authenticateGiteaWebhook(
    requestWithAuthorization("Bearer incorrect"),
    response,
    () => {
      nextCalled = true;
    }
  );

  assert.equal(response.statusCode, 401);
  assert.equal(response.body, "Unauthorized");
  assert.equal(nextCalled, false);
});

test("middleware dispatches valid credentials", () => {
  process.env.PEOPLEPORTAL_GITEA_WEBHOOK_SECRET = VALID_SECRET;

  let nextCalled = false;
  authenticateGiteaWebhook(
    requestWithAuthorization(`Bearer ${VALID_SECRET}`),
    {},
    () => {
      nextCalled = true;
    }
  );

  assert.equal(nextCalled, true);
});
