const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createProjectCatalogEntry,
  projectCatalogIdentityIssues,
} = require("../../dist/models/ProjectCatalog.js");

const team = (users) => ({
  pk: "team-webdev-fa26",
  name: "WebDevFALL2026",
  parentPk: null,
  users,
  subteams: [],
  subteamPkList: [],
  friendlyName: "Web Dev",
  teamType: "PROJECT",
  seasonType: "FALL",
  seasonYear: 2026,
  teamStartDate: "2026-08-24",
  teamEndDate: "2026-12-20",
  description: "Full-stack project team",
  rootTeamSettings: {},
  bindlePermissions: {},
});

const user = (pk, username, name, role) => ({
  pk,
  username,
  name,
  email: `${username}@example.test`,
  active: true,
  attributes: { roles: { "team-webdev-fa26": role } },
});

test("project catalog uses stable team/repository identifiers and explicit lead roles", () => {
  const snapshot = {
    status: "verified",
    memberStatus: "verified",
    members: [{
      provider: "gitea",
      providerId: "700",
      username: "ada-git",
      email: " ADA@EXAMPLE.TEST ",
    }],
    repositories: [{
      id: 17,
      slug: "web-portal",
      fullName: "WebDevFALL2026/web-portal",
      archived: false,
    }],
  };
  const observedAt = new Date("2026-09-13T15:00:00.000Z");

  const entry = createProjectCatalogEntry(team([
    user("42", "ada", "Ada Lovelace", "Project Lead"),
    user("43", "grace", "Grace Hopper", "Engineer"),
  ]), snapshot, observedAt);

  assert.equal(entry.id, "team-webdev-fa26");
  assert.equal(entry.slug, "WebDevFALL2026");
  assert.deepEqual(entry.owningTeam, {
    id: "team-webdev-fa26",
    slug: "WebDevFALL2026",
    displayName: "Web Dev",
  });
  assert.deepEqual(entry.leads, [{
    id: "42",
    provider: "authentik",
    providerId: "42",
    username: "ada",
    name: "Ada Lovelace",
    email: "ada@example.test",
    role: "Project Lead",
    gitea: {
      provider: "gitea",
      providerId: "700",
      username: "ada-git",
      email: "ada@example.test",
    },
  }]);
  assert.equal(entry.gitea.organization, "WebDevFALL2026");
  assert.equal(entry.gitea.memberSnapshot, "verified");
  assert.deepEqual(entry.gitea.repositories, [{
    id: 17,
    slug: "web-portal",
    fullName: "WebDevFALL2026/web-portal",
    archived: false,
  }]);
  assert.equal(entry.sow, undefined);
  assert.equal(entry.revision.effectiveFrom, "2026-08-24");
  assert.equal(entry.revision.effectiveTo, "2026-12-20");
  assert.equal(entry.revision.observedAt, observedAt);
});

test("revision is stable across source ordering and unconfigured Gitea is explicit", () => {
  const first = createProjectCatalogEntry(team([
    user("43", "grace", "Grace Hopper", "Engineer"),
    user("42", "ada", "Ada Lovelace", "Owner"),
  ]), { status: "unconfigured", repositories: [], memberStatus: "unconfigured", members: [] }, new Date("2026-09-13T15:00:00.000Z"));
  const second = createProjectCatalogEntry(team([
    user("42", "ada", "Ada Lovelace", "Owner"),
    user("43", "grace", "Grace Hopper", "Engineer"),
  ]), { status: "unconfigured", repositories: [], memberStatus: "unconfigured", members: [] }, new Date("2026-09-13T16:00:00.000Z"));

  assert.equal(first.revision.value, second.revision.value);
  assert.equal(first.gitea.repositorySnapshot, "unconfigured");
  assert.deepEqual(first.gitea.repositories, []);
  assert.deepEqual(projectCatalogIdentityIssues([team([
    user("42", "ada", "Ada Lovelace", "Owner"),
    { ...user("43", "grace", "Grace Hopper", "Project Lead"), email: " " },
  ])]), [{
    code: "missing-email",
    provider: "authentik",
    projectIds: ["team-webdev-fa26"],
    personIds: ["43"],
  }]);
});

test("identity issues surface Gitea email collisions and missing identity fields", () => {
  const project = team([user("42", "ada", "Ada Lovelace", "Project Lead")]);
  const snapshot = {
    status: "verified",
    repositories: [],
    memberStatus: "verified",
    members: [
      { provider: "gitea", providerId: "700", username: "ada-git", email: "ada@example.test" },
      { provider: "gitea", providerId: "701", username: "other-git", email: " ADA@EXAMPLE.TEST " },
      { provider: "gitea", username: "missing-id", email: "missing-id@example.test" },
      { provider: "gitea", providerId: "702", username: "missing-email", email: " " },
    ],
  };

  const issues = projectCatalogIdentityIssues([project], new Map([[project.pk, snapshot]]));
  assert.deepEqual(issues, [
    {
      code: "duplicate-email",
      provider: "gitea",
      projectIds: ["team-webdev-fa26"],
      personIds: ["700", "701"],
      email: "ada@example.test",
    },
    {
      code: "missing-email",
      provider: "gitea",
      projectIds: ["team-webdev-fa26"],
      personIds: ["702"],
    },
    {
      code: "missing-provider-id",
      provider: "gitea",
      projectIds: ["team-webdev-fa26"],
      personIds: [],
      email: "missing-id@example.test",
    },
  ]);
});

test("project leads remain visible when an Authentik provider ID is missing", () => {
  const project = team([user("", "ada", "Ada Lovelace", "Project Lead")]);
  const entry = createProjectCatalogEntry(project, {
    status: "unconfigured",
    repositories: [],
    memberStatus: "unconfigured",
    members: [],
  });

  assert.deepEqual(entry.leads, [{
    provider: "authentik",
    username: "ada",
    name: "Ada Lovelace",
    email: "ada@example.test",
    role: "Project Lead",
  }]);
  assert.deepEqual(projectCatalogIdentityIssues([project]), [{
    code: "missing-provider-id",
    provider: "authentik",
    projectIds: ["team-webdev-fa26"],
    personIds: [],
  }]);
});

test("identity issues surface normalized-email collisions without overwriting either person", () => {
  const first = team([user("42", "ada", "Ada Lovelace", "Project Lead")]);
  const second = { ...team([user("99", "grace", "Grace Hopper", "Owner")]), pk: "team-data-fa26", name: "DataFALL2026" };
  second.users[0].email = " ADA@EXAMPLE.TEST ";
  second.users[0].attributes.roles = { "team-data-fa26": "Owner" };

  assert.deepEqual(projectCatalogIdentityIssues([first, second]), [{
    code: "duplicate-email",
    provider: "authentik",
    projectIds: ["team-data-fa26", "team-webdev-fa26"],
    personIds: ["42", "99"],
    email: "ada@example.test",
  }]);
});
