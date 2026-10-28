/**
 * Personal repositories are deleted only after the API confirms their owner,
 * identity, and creation time. Exercise each guard through the strict routes.
 */
const assert = require("node:assert/strict");
const test = require("node:test");
const express = require("express");
const request = require("supertest");
const { ValidateError } = require("tsoa");

const { RegisterRoutes } = require("../../dist/routes.js");
const giteaModule = require("../../dist/clients/GiteaClient/index.js");
const authentikModule = require("../../dist/clients/AuthentikClient/index.js");
const { HooksController } = require("../../dist/controllers/HooksController.js");

function buildApp() {
    const app = express();
    app.use(express.json());
    RegisterRoutes(app);
    app.use((err, _req, res, _next) => {
        if (err instanceof ValidateError) return res.status(422).json(err.fields);
        return res.status(500).end();
    });
    return app;
}

/* HooksController reads the client classes from these module exports when
   constructing each controller. Restore them even when an assertion fails. */
async function withFakeGitea({ isOrganization, apiRepository }, run) {
    const RealGiteaClient = giteaModule.GiteaClient;
    const RealAuthentikClient = authentikModule.AuthentikClient;
    const calls = { organizations: [], fetched: [], deleted: [], provisioned: [] };
    giteaModule.GiteaClient = class {
        async isOrganization(name) {
            calls.organizations.push(name);
            if (isOrganization instanceof Error) throw isOrganization;
            return isOrganization;
        }
        async getRepository(owner, repo) {
            calls.fetched.push(`${owner}/${repo}`);
            return apiRepository;
        }
        async deleteRepository(owner, repo) {
            calls.deleted.push(`${owner}/${repo}`);
        }
        async handleRepoProvisioning(req) {
            calls.provisioned.push(req);
        }
    };
    authentikModule.AuthentikClient = class {
        getGroupPkFromName = async () => "team-pk";
    };
    try {
        await run(calls);
    } finally {
        giteaModule.GiteaClient = RealGiteaClient;
        authentikModule.AuthentikClient = RealAuthentikClient;
    }
}

/* Include every required model field so tsoa's strict validation reaches the
   controller. Neither missing fields nor extra properties are accepted. */
function user(username) {
    return {
        id: 7,
        login: username,
        login_name: username,
        source_id: 0,
        full_name: username,
        email: `${username}@example.com`,
        avatar_url: "",
        html_url: `https://git.example.com/${username}`,
        language: "en-US",
        is_admin: false,
        last_login: "2026-01-01T00:00:00Z",
        created: "2026-01-01T00:00:00Z",
        restricted: false,
        active: true,
        prohibit_login: false,
        location: "",
        website: "",
        description: "",
        visibility: "public",
        followers_count: 0,
        following_count: 0,
        starred_repos_count: 0,
        username,
    };
}

function repository(owner = "ianc", overrides = {}) {
    const url = `https://git.example.com/${owner}/scratch`;
    const now = new Date().toISOString();
    return {
        owner: user(owner),
        name: "scratch",
        id: 42,
        full_name: `${owner}/scratch`,
        description: "",
        empty: true,
        private: false,
        fork: false,
        template: false,
        mirror: false,
        size: 0,
        language: "",
        languages_url: `${url}/languages`,
        html_url: url,
        url,
        link: url,
        ssh_url: `git@git.example.com:${owner}/scratch.git`,
        clone_url: `${url}.git`,
        original_url: "",
        website: "",
        stars_count: 0,
        forks_count: 0,
        watchers_count: 0,
        open_issues_count: 0,
        open_pr_counter: 0,
        release_counter: 0,
        default_branch: "main",
        archived: false,
        created_at: now,
        updated_at: now,
        archived_at: "",
        permissions: { admin: true, push: true, pull: true },
        has_issues: true,
        internal_tracker: {
            enable_time_tracker: true,
            allow_only_contributors_to_track_time: true,
            enable_issue_dependencies: true,
        },
        has_wiki: true,
        has_pull_requests: true,
        has_projects: true,
        projects_mode: "all",
        has_releases: true,
        has_packages: true,
        has_actions: true,
        ignore_whitespace_conflicts: false,
        allow_merge_commits: true,
        allow_rebase: true,
        allow_rebase_explicit: true,
        allow_squash_merge: true,
        allow_fast_forward_only_merge: false,
        allow_rebase_update: true,
        default_delete_branch_after_merge: false,
        default_merge_style: "merge",
        default_allow_maintainer_edit: false,
        avatar_url: "",
        internal: false,
        mirror_interval: "",
        object_format_name: "sha1",
        mirror_updated: "",
        topics: [],
        licenses: [],
        ...overrides,
    };
}

function createdEvent(owner = "ianc") {
    return {
        action: "created",
        repository: repository(owner),
        organization: user(owner),
        sender: user(owner),
    };
}

const post = (body) =>
    request(buildApp()).post("/api/webhook/git/repoevent").send(body);

test("a fresh personal repository is deleted once and never provisioned", () =>
    withFakeGitea(
        { isOrganization: false, apiRepository: repository() },
        async (calls) => {
            const response = await post(createdEvent());
            assert.equal(response.status, 200);
            assert.equal(response.body, "OK (Personal Repository Deleted)");
            assert.deepEqual(calls.organizations, ["ianc"]);
            assert.deepEqual(calls.fetched, ["ianc/scratch"]);
            assert.deepEqual(calls.deleted, ["ianc/scratch"]);
            assert.deepEqual(calls.provisioned, []);
        },
    ));

test("an organization repository is provisioned and never deleted", () => {
    const apiRepository = repository("TechOps");
    return withFakeGitea(
        { isOrganization: true, apiRepository },
        async (calls) => {
            const response = await post(createdEvent("TechOps"));
            assert.equal(response.status, 200);
            assert.deepEqual(calls.organizations, ["TechOps"]);
            assert.deepEqual(calls.deleted, []);
            assert.equal(calls.provisioned.length, 1);
            assert.deepEqual(calls.provisioned[0].repository, apiRepository);
        },
    );
});

test("no delete when the API repository id differs from the event", () =>
    withFakeGitea(
        { isOrganization: false, apiRepository: repository("ianc", { id: 99 }) },
        async (calls) => {
            const response = await post(createdEvent());
            assert.equal(response.status, 200);
            assert.equal(response.body, "OK (Actions Failed)");
            assert.deepEqual(calls.deleted, []);
            assert.deepEqual(calls.provisioned, []);
        },
    ));

test("no delete when the API repository owner differs from the event", () =>
    withFakeGitea(
        {
            isOrganization: false,
            apiRepository: repository("ianc", { owner: user("someone-else") }),
        },
        async (calls) => {
            const response = await post(createdEvent());
            assert.equal(response.status, 200);
            assert.equal(response.body, "OK (Actions Failed)");
            assert.deepEqual(calls.deleted, []);
            assert.deepEqual(calls.provisioned, []);
        },
    ));

test("no delete for a repository created before the deletion window", () => {
    const created_at = new Date(
        Date.now() - HooksController.PERSONAL_REPO_DELETE_WINDOW_MS - 60_000,
    ).toISOString();
    return withFakeGitea(
        { isOrganization: false, apiRepository: repository("ianc", { created_at }) },
        async (calls) => {
            const response = await post(createdEvent());
            assert.equal(response.status, 200);
            assert.equal(response.body, "OK (Actions Failed)");
            assert.deepEqual(calls.deleted, []);
            assert.deepEqual(calls.provisioned, []);
        },
    );
});

test("no delete when the API creation time cannot be parsed", () =>
    withFakeGitea(
        {
            isOrganization: false,
            apiRepository: repository("ianc", { created_at: "not a date" }),
        },
        async (calls) => {
            const response = await post(createdEvent());
            assert.equal(response.status, 200);
            assert.equal(response.body, "OK (Actions Failed)");
            assert.deepEqual(calls.deleted, []);
            assert.deepEqual(calls.provisioned, []);
        },
    ));

test("an organization lookup error prevents deletion and provisioning", () =>
    withFakeGitea(
        {
            isOrganization: new Error("Gitea unavailable"),
            apiRepository: repository(),
        },
        async (calls) => {
            const response = await post(createdEvent());
            assert.equal(response.status, 200);
            assert.equal(response.body, "OK (Actions Failed)");
            assert.deepEqual(calls.fetched, []);
            assert.deepEqual(calls.deleted, []);
            assert.deepEqual(calls.provisioned, []);
        },
    ));

test("non-created actions never delete or provision repositories", () =>
    withFakeGitea(
        { isOrganization: false, apiRepository: repository() },
        async (calls) => {
            for (const action of ["deleted", "archived"]) {
                const response = await post({ ...createdEvent(), action });
                assert.equal(response.status, 200);
                assert.equal(response.body, "OK");
            }
            assert.deepEqual(calls.organizations, []);
            assert.deepEqual(calls.fetched, []);
            assert.deepEqual(calls.deleted, []);
            assert.deepEqual(calls.provisioned, []);
        },
    ));
