/**
 * getGroupsInfoByPks replaced a sequential getGroupInfo loop in the open-roles
 * build. That loop cost one Authentik round trip per recruiting team, plus one
 * more per subteam to populate members the endpoint never reads: about 65
 * serial requests at 13 teams. These tests pin the properties that make the
 * replacement safe to rely on, since the win is entirely in the request count.
 */
const assert = require("node:assert/strict");
const test = require("node:test");
const axios = require("axios");
const { AuthentikClient } = require("../../dist/clients/AuthentikClient/index.js");
const { AuthentikClientError, AuthentikClientErrorType } = require("../../dist/clients/AuthentikClient/models.js");

/** A group as Authentik's list and detail endpoints both shape it. */
function group(pk, children = []) {
  return {
    pk,
    name: `team-${pk}`,
    children: children.map((c) => c.pk),
    children_obj: children,
    parents: [],
    attributes: { friendlyName: `Team ${pk}`, description: "", seasonType: "Fall", seasonYear: 2026 },
    /* users_obj is deliberately absent: include_users=false omits it, which is
       exactly what used to crash the unguarded .map() in getGroupInfo. */
  };
}

/**
 * Replaces axios.request for one test, recording every call.
 * AuthentikClient calls axios.request at call time, so patching the singleton
 * is enough and nothing needs to be re-required.
 */
async function withAxios(handler, fn) {
  const calls = [];
  const original = axios.request;

  axios.request = async (config) => {
    calls.push(config);
    return handler(config, calls.length - 1);
  };

  try {
    return await fn(calls);
  } finally {
    axios.request = original;
  }
}

const isListCall = (c) => c.url === "/api/v3/core/groups/";
const isDetailCall = (c) => /^\/api\/v3\/core\/groups\/[^/]+\/$/.test(c.url);

test("resolves every team in a single request instead of one per team", async () => {
  const pks = Array.from({ length: 13 }, (_, i) => `t${i}`);

  await withAxios(
    async () => ({ data: { results: pks.map((pk) => group(pk)), pagination: { total_pages: 1 } } }),
    async (calls) => {
      const client = new AuthentikClient();
      const resolved = await client.getGroupsInfoByPks(pks, { includeUsers: false });

      assert.equal(resolved.size, 13, "every requested team must be resolved");
      assert.equal(calls.length, 1, `13 teams must cost 1 request, cost ${calls.length}`);
      assert.equal(calls.filter(isDetailCall).length, 0, "no per-team lookups should remain");
    }
  );
});

test("does not ask Authentik for members the open-roles page never reads", async () => {
  await withAxios(
    async () => ({ data: { results: [group("a")], pagination: { total_pages: 1 } } }),
    async (calls) => {
      const client = new AuthentikClient();
      await client.getGroupsInfoByPks(["a"], { includeUsers: false });

      assert.equal(calls[0].params.include_users, false, "member population is the bulk of the old cost");
      assert.equal(calls[0].params.include_children, true, "subteams are still required");
    }
  );
});

test("a group missing from the sweep is fetched individually rather than dropped", async () => {
  await withAxios(
    async (config) => {
      if (isListCall(config)) return { data: { results: [group("a")], pagination: { total_pages: 1 } } };
      return { data: group("b") };
    },
    async (calls) => {
      const client = new AuthentikClient();
      const resolved = await client.getGroupsInfoByPks(["a", "b"], { includeUsers: false });

      assert.deepEqual([...resolved.keys()].sort(), ["a", "b"]);
      assert.equal(calls.filter(isDetailCall).length, 1, "only the uncovered pk needs a lookup");
    }
  );
});

test("a failed sweep falls back to per-group lookups instead of failing the page", async () => {
  await withAxios(
    async (config) => {
      if (isListCall(config)) throw new Error("list endpoint unavailable");
      return { data: group(config.url.split("/")[4]) };
    },
    async (calls) => {
      const client = new AuthentikClient();
      const resolved = await client.getGroupsInfoByPks(["a", "b"], { includeUsers: false });

      assert.equal(resolved.size, 2, "the old behaviour is still available as a fallback");
      assert.equal(calls.filter(isDetailCall).length, 2);
    }
  );
});

/** The 404 Authentik itself returns; getGroupInfo only trusts this exact shape. */
function authentikNotFound() {
  return Object.assign(new Error("Request failed with status code 404"), {
    isAxiosError: true,
    response: { status: 404, headers: { "x-powered-by": "authentik" } },
  });
}

test("a group Authentik no longer has is omitted, not thrown", async () => {
  /* Callers delete their own rows for these. Throwing would fail the whole
     endpoint over one stale row, which is the COE this endpoint already has. */
  await withAxios(
    async (config) => {
      if (isListCall(config)) return { data: { results: [group("a")], pagination: { total_pages: 1 } } };
      throw authentikNotFound();
    },
    async () => {
      const client = new AuthentikClient();
      const resolved = await client.getGroupsInfoByPks(["a", "gone"], { includeUsers: false });

      assert.deepEqual([...resolved.keys()], ["a"]);
    }
  );
});

test("a real failure on a fallback lookup is surfaced, not swallowed as a missing group", async () => {
  /* Silently omitting these would make callers delete live rows: a directory
     outage would quietly wipe the recruiting roster. */
  await withAxios(
    async (config) => {
      if (isListCall(config)) return { data: { results: [], pagination: { total_pages: 1 } } };
      throw new Error("authentik is down");
    },
    async () => {
      const client = new AuthentikClient();

      /* getGroupInfo flattens any non-404 into GROUPINFO_REQUEST_FAILED. The
         property under test is that it still reaches the caller as an error
         rather than being folded into "this group no longer exists". */
      await assert.rejects(
        () => client.getGroupsInfoByPks(["a"], { includeUsers: false }),
        (e) => e instanceof AuthentikClientError &&
               e.code === AuthentikClientErrorType.GROUPINFO_REQUEST_FAILED
      );
    }
  );
});

test("follows pagination rather than truncating at the first page", async () => {
  await withAxios(
    async (config) => ({
      data: {
        results: [group(config.params.page === 1 ? "a" : "b")],
        pagination: { total_pages: 2 },
      },
    }),
    async (calls) => {
      const client = new AuthentikClient();
      const resolved = await client.getGroupsInfoByPks(["a", "b"], { includeUsers: false });

      assert.deepEqual([...resolved.keys()].sort(), ["a", "b"]);
      assert.equal(calls.filter(isDetailCall).length, 0, "pagination must not fall through to lookups");
    }
  );
});

test("an empty request touches Authentik not at all", async () => {
  await withAxios(
    async () => { throw new Error("should not be called"); },
    async (calls) => {
      const client = new AuthentikClient();
      assert.equal((await client.getGroupsInfoByPks([], {})).size, 0);
      assert.equal(calls.length, 0);
    }
  );
});

test("getGroupInfo survives a response with no users_obj", async () => {
  /* The guard that makes includeUsers:false usable at all. Without it the
     optimization turns every open-roles request into a TypeError. */
  await withAxios(
    async () => ({ data: group("a") }),
    async () => {
      const client = new AuthentikClient();
      const info = await client.getGroupInfo("a", { includeUsers: false, disableSubteamMemberPopulate: true });

      assert.deepEqual(info.users, [], "an omitted users_obj must read as no members");
    }
  );
});
