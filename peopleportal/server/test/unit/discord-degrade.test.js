/**
 * DiscordClient must never be the reason the server fails to start.
 *
 * It is constructed at import time through ENABLED_SHARED_RESOURCES in
 * config.ts, so anything it throws happens before Express listens. Its two
 * variables are absent from the deployment's .env template, which makes a
 * missing one the likely case rather than the exceptional one: the constructor
 * threw "PEOPLEPORTAL_DISCORD_BOT_TOKEN is undefined" and took the process
 * with it.
 */
const assert = require("node:assert/strict");
const test = require("node:test");
const { DiscordClient } = require("../../dist/clients/DiscordClient/index.js");

/** Builds a client with the given env, restoring the real values after. */
function withEnv(vars, fn) {
  const saved = {
    PEOPLEPORTAL_DISCORD_BOT_TOKEN: process.env.PEOPLEPORTAL_DISCORD_BOT_TOKEN,
    PEOPLEPORTAL_DISCORD_SERVER_ID: process.env.PEOPLEPORTAL_DISCORD_SERVER_ID,
  };
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("constructing without either variable does not throw", () => {
  withEnv(
    { PEOPLEPORTAL_DISCORD_BOT_TOKEN: undefined, PEOPLEPORTAL_DISCORD_SERVER_ID: undefined },
    () => {
      let client;
      assert.doesNotThrow(() => { client = new DiscordClient(); });
      assert.equal(client.enabled, false);
      assert.equal(client.isReady, false);
    }
  );
});

test("either variable missing on its own is enough to disable it", () => {
  withEnv({ PEOPLEPORTAL_DISCORD_BOT_TOKEN: undefined, PEOPLEPORTAL_DISCORD_SERVER_ID: "123" }, () => {
    assert.equal(new DiscordClient().enabled, false);
  });
  withEnv({ PEOPLEPORTAL_DISCORD_BOT_TOKEN: "abc", PEOPLEPORTAL_DISCORD_SERVER_ID: undefined }, () => {
    assert.equal(new DiscordClient().enabled, false);
  });
});

test("a blank value counts as missing, not as configured", () => {
  withEnv({ PEOPLEPORTAL_DISCORD_BOT_TOKEN: "", PEOPLEPORTAL_DISCORD_SERVER_ID: "" }, () => {
    assert.equal(new DiscordClient().enabled, false);
  });
});

test("init resolves immediately when disabled, so the startup loop is not held up", async () => {
  await withEnv(
    { PEOPLEPORTAL_DISCORD_BOT_TOKEN: undefined, PEOPLEPORTAL_DISCORD_SERVER_ID: undefined },
    async () => {
      const client = new DiscordClient();
      const started = Date.now();
      await client.init();
      /* The enabled path waits up to 15s for the gateway. */
      assert.ok(Date.now() - started < 1000, "disabled init must not wait on a gateway");
    }
  );
});

test("waitForReady resolves rather than rejecting when disabled", async () => {
  await withEnv(
    { PEOPLEPORTAL_DISCORD_BOT_TOKEN: undefined, PEOPLEPORTAL_DISCORD_SERVER_ID: undefined },
    async () => {
      await assert.doesNotReject(() => new DiscordClient().waitForReady());
    }
  );
});

test("getChannelFromName answers undefined when disabled", async () => {
  await withEnv(
    { PEOPLEPORTAL_DISCORD_BOT_TOKEN: undefined, PEOPLEPORTAL_DISCORD_SERVER_ID: undefined },
    async () => {
      const client = new DiscordClient();
      /* Undefined is the "no such channel" answer both callers already handle,
         so a disabled integration is indistinguishable from a missing channel
         and needs no new branch at the call sites. */
      assert.equal(await client.getChannelFromName("announcements"), undefined);
    }
  );
});

test("the shared-resource contract still holds when disabled", () => {
  withEnv(
    { PEOPLEPORTAL_DISCORD_BOT_TOKEN: undefined, PEOPLEPORTAL_DISCORD_SERVER_ID: undefined },
    () => {
      const client = new DiscordClient();
      for (const method of ["init", "getResourceName", "getSupportedBindles", "handleOrgBindleSync", "archiveTeam"]) {
        assert.equal(typeof client[method], "function", `${method} must still exist`);
      }
      assert.equal(client.getResourceName(), "DiscordClient");
    }
  );
});

test("both variables present enables it", () => {
  withEnv(
    { PEOPLEPORTAL_DISCORD_BOT_TOKEN: "not-a-real-token", PEOPLEPORTAL_DISCORD_SERVER_ID: "000000000000000000" },
    () => {
      /* login() rejects on this token, but that is caught and must not throw
         out of the constructor either. */
      let client;
      assert.doesNotThrow(() => { client = new DiscordClient(); });
      assert.equal(client.enabled, true);
    }
  );
});
