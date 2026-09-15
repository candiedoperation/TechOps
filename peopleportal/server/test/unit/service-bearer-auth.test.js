const assert = require("node:assert/strict");
const test = require("node:test");

const { expressAuthentication } = require("../../dist/auth.js");

const requestFor = (authorization) => ({
  get: (name) => name.toLowerCase() === "authorization" ? authorization : undefined,
  session: {},
});

const withServiceToken = async (token, run) => {
  const previous = process.env.PEOPLEPORTAL_SERVICE_TOKEN;
  if (token === undefined) delete process.env.PEOPLEPORTAL_SERVICE_TOKEN;
  else process.env.PEOPLEPORTAL_SERVICE_TOKEN = token;
  try {
    await run();
  } finally {
    if (previous === undefined) delete process.env.PEOPLEPORTAL_SERVICE_TOKEN;
    else process.env.PEOPLEPORTAL_SERVICE_TOKEN = previous;
  }
};

test("the configured service bearer authenticates a service-secured route", async () => {
  await withServiceToken("horizon-service-token", async () => {
    const request = requestFor("Bearer horizon-service-token");
    assert.equal(await expressAuthentication(request, "service"), true);
  });
});

test("the service bearer establishes no session identity", async () => {
  await withServiceToken("horizon-service-token", async () => {
    const request = requestFor("Bearer horizon-service-token");
    await expressAuthentication(request, "service");

    /* A stateless job must not be promoted into a user session: doing so
       would hand a non-OIDC secret to OpenIdClient and mint a session record
       on every request. */
    assert.equal(request.session.accessToken, undefined);
    assert.equal(request.session.authorizedUser, undefined);
  });
});

test("the service bearer does not satisfy OIDC authentication", async () => {
  await withServiceToken("horizon-service-token", async () => {
    /* The bearer grants access to routes that opt in, never to the whole
       @Security("oidc") surface and never superuser authority. */
    await assert.rejects(
      expressAuthentication(requestFor("Bearer horizon-service-token"), "oidc"),
      /No Token Provided/,
    );
  });
});

test("an incorrect service bearer is rejected", async () => {
  await withServiceToken("horizon-service-token", async () => {
    await assert.rejects(
      expressAuthentication(requestFor("Bearer wrong-token"), "service"),
      /Invalid Service Token/,
    );
  });
});

test("a service bearer of a different length is rejected without throwing", async () => {
  await withServiceToken("horizon-service-token", async () => {
    await assert.rejects(
      expressAuthentication(requestFor("Bearer short"), "service"),
      /Invalid Service Token/,
    );
  });
});

test("a missing authorization header is rejected", async () => {
  await withServiceToken("horizon-service-token", async () => {
    await assert.rejects(
      expressAuthentication(requestFor(undefined), "service"),
      /No Service Token Provided/,
    );
  });
});

test("service authentication is refused when no token is configured", async () => {
  await withServiceToken(undefined, async () => {
    await assert.rejects(
      expressAuthentication(requestFor("Bearer anything"), "service"),
      /Service Authentication is Not Configured/,
    );
  });
});
