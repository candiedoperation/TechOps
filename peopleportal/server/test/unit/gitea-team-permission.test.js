/**
 * Bindle-to-Gitea team permission mapping. The pure helper covers precedence;
 * ensureTeamExists runs against a local mock Gitea HTTP server to prove that an
 * "admin" team is not reverted on sync and that create/downgrade send the
 * right permission.
 */
const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");

const {
    GiteaClient,
    computeGiteaTeamAccess,
} = require("../../dist/clients/GiteaClient/index.js");

test("no bindles yields read without repository creation", () => {
    assert.deepEqual(computeGiteaTeamAccess({}), {
        canCreateRespositories: false,
        permission: "read",
    });
});

test("any write-level bindle yields write", () => {
    for (const bindle of [
        "repo:brprotect-approvals",
        "repo:brprotect-merge",
        "repo:brprotect-override",
    ]) {
        const result = computeGiteaTeamAccess({ [bindle]: true });
        assert.equal(result.permission, "write", bindle);
        assert.equal(result.canCreateRespositories, false, bindle);
    }
});

test("repo:allowcreate yields write and creation", () => {
    assert.deepEqual(computeGiteaTeamAccess({ "repo:allowcreate": true }), {
        canCreateRespositories: true,
        permission: "write",
    });
});

test("repo:admin yields admin and implies repository creation", () => {
    assert.deepEqual(computeGiteaTeamAccess({ "repo:admin": true }), {
        canCreateRespositories: true,
        permission: "admin",
    });
});

test("admin takes precedence over every other bindle", () => {
    const result = computeGiteaTeamAccess({
        "repo:admin": true,
        "repo:allowcreate": true,
        "repo:brprotect-merge": true,
    });
    assert.equal(result.permission, "admin");
    assert.equal(result.canCreateRespositories, true);
});

test("false values are ignored", () => {
    assert.deepEqual(
        computeGiteaTeamAccess({
            "repo:admin": false,
            "repo:allowcreate": false,
            "repo:brprotect-approvals": false,
        }),
        { canCreateRespositories: false, permission: "read" },
    );
    assert.equal(
        computeGiteaTeamAccess({
            "repo:admin": false,
            "repo:brprotect-merge": true,
        }).permission,
        "write",
    );
});

test("owner is never produced", () => {
    const all = computeGiteaTeamAccess({
        "repo:admin": true,
        "repo:allowcreate": true,
        "repo:brprotect-approvals": true,
        "repo:brprotect-merge": true,
        "repo:brprotect-override": true,
    });
    assert.ok(["read", "write", "admin"].includes(all.permission));
});

test("repo:admin is exposed as a dangerous bindle definition", () => {
    const client = new GiteaClient();
    const def = client.getSupportedBindles()["repo:admin"];
    assert.equal(def.friendlyName, "Repository Administration");
    assert.ok(def.description.startsWith("Dangerous:"));
});

/* Mock Gitea: serves team search from `existing`, records every request. */
async function withMockGitea(existing, run) {
    const requests = [];
    const server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
            requests.push({
                method: req.method,
                url: req.url,
                body: body ? JSON.parse(body) : undefined,
            });
            res.setHeader("Content-Type", "application/json");
            if (req.method === "GET" && req.url.includes("/teams/search")) {
                res.end(
                    JSON.stringify({
                        ok: true,
                        data: existing ? [existing] : [],
                    }),
                );
            } else {
                res.statusCode = req.method === "POST" ? 201 : 200;
                res.end("{}");
            }
        });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const previous = process.env.PEOPLEPORTAL_GITEA_ENDPOINT;
    process.env.PEOPLEPORTAL_GITEA_ENDPOINT = `http://127.0.0.1:${server.address().port}`;
    try {
        await run(new GiteaClient(), requests);
    } finally {
        process.env.PEOPLEPORTAL_GITEA_ENDPOINT = previous;
        await new Promise((resolve) => server.close(resolve));
    }
}

const DESCRIPTION = "Permissions Group Replication for builders";
const baseReq = {
    grpSharedResourceId: "org1",
    teamSharedResourceId: "builders",
    description: DESCRIPTION,
    canCreateRespositories: true,
};
const existingTeam = (permission) => ({
    id: 42,
    name: "builders",
    description: DESCRIPTION,
    permission,
    can_create_org_repo: true,
});
const mutations = (requests) => requests.filter((r) => r.method !== "GET");

test("ensureTeamExists does not PATCH an admin team when admin is requested", async () => {
    await withMockGitea(existingTeam("admin"), async (client, requests) => {
        await client.ensureTeamExists({ ...baseReq, permission: "admin" });
        assert.deepEqual(mutations(requests), []);
    });
});

test("ensureTeamExists PATCHes an admin team down to write", async () => {
    await withMockGitea(existingTeam("admin"), async (client, requests) => {
        await client.ensureTeamExists({ ...baseReq, permission: "write" });
        const [patch, ...rest] = mutations(requests);
        assert.equal(rest.length, 0);
        assert.equal(patch.method, "PATCH");
        assert.equal(patch.url, "/api/v1/teams/42");
        assert.equal(patch.body.permission, "write");
    });
});

test("ensureTeamExists PATCHes a write team up to admin", async () => {
    await withMockGitea(existingTeam("write"), async (client, requests) => {
        await client.ensureTeamExists({ ...baseReq, permission: "admin" });
        const [patch] = mutations(requests);
        assert.equal(patch.method, "PATCH");
        assert.equal(patch.body.permission, "admin");
    });
});

test("ensureTeamExists POSTs permission admin when creating a team", async () => {
    await withMockGitea(null, async (client, requests) => {
        await client.ensureTeamExists({ ...baseReq, permission: "admin" });
        const [post, ...rest] = mutations(requests);
        assert.equal(rest.length, 0);
        assert.equal(post.method, "POST");
        assert.equal(post.url, "/api/v1/orgs/org1/teams");
        assert.equal(post.body.permission, "admin");
        assert.equal(post.body.can_create_org_repo, true);
    });
});
