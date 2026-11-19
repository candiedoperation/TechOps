/**
 * Which teams confer organisation-wide administrative authority.
 *
 * The check used to be `team.name === "ExecutiveBoard"` written out in five
 * places across auth.ts and EventController. It is now a set, so these tests
 * pin down the contract and would catch a sixth site being added that forgets
 * it. TechOps briefly held authority too and was removed: it is recruited into,
 * so membership must not imply an org-wide override.
 */
const assert = require("node:assert/strict");
const test = require("node:test");
const {
  hasAdminAuthority,
  ADMIN_AUTHORITY_TEAMS,
  ADMIN_AUTHORITY_SUBTEAMS,
  ENABLED_SERVICE_TEAMS,
} = require("../../dist/config.js");

const team = (name, flagged = false) => ({ name, flaggedForDeletion: flagged });

/* getRootTeamsForUsername collapses a subteam to its parent, so a member of
   ExecutiveBoardMembers and a member of ExecutiveBoardAlumni both arrive with
   ExecutiveBoard as their root team. Only the second argument, the user's own
   groups, tells them apart. */
const rootOf = (group) =>
  group.startsWith("ExecutiveBoard") ? [team("ExecutiveBoard")]
  : group.startsWith("TechOps") ? [team("TechOps")]
  : [team(group)];
const authorityVia = (...groups) =>
  hasAdminAuthority(groups.flatMap(rootOf), groups);

test("ExecutiveBoard confers authority", () => {
  assert.equal(hasAdminAuthority([team("ExecutiveBoard")], ["ExecutiveBoardMembers"]), true);
});

test("TechOps confers no authority", () => {
  assert.equal(hasAdminAuthority([team("TechOps")], ["TechOpsMembers"]), false);
  assert.equal(authorityVia("TechOpsMembers"), false);
  assert.equal(authorityVia("TechOps"), false);
  assert.ok(!ADMIN_AUTHORITY_TEAMS.has("TechOps"));
  assert.ok(!ADMIN_AUTHORITY_SUBTEAMS.has("TechOpsMembers"));
});

test("an ordinary team confers nothing", () => {
  assert.equal(hasAdminAuthority([team("WebDevFALL2026")], []), false);
  assert.equal(hasAdminAuthority([team("MLBootcampFALL2026"), team("InfrastructureSPRING2026")], []), false);
});

test("authority is granted by membership of any one admin team", () => {
  assert.equal(
    hasAdminAuthority([team("WebDevFALL2026"), team("ExecutiveBoard")], ["WebDevFALL2026", "ExecutiveBoardMembers"]),
    true
  );
  assert.equal(
    hasAdminAuthority([team("TechOps"), team("ExecutiveBoard")], ["ExecutiveBoardMembers"]),
    true
  );
});

test("a team flagged for deletion confers nothing", () => {
  assert.equal(hasAdminAuthority([team("TechOps", true)], []), false);
  assert.equal(hasAdminAuthority([team("ExecutiveBoard", true)], []), false);
  /* One live admin team is still enough. */
  assert.equal(
    hasAdminAuthority([team("TechOps", true), team("ExecutiveBoard")], ["ExecutiveBoardMembers"]),
    true
  );
});

test("a subteam name as the ROOT team confers nothing", () => {
  /* Guards against a service subteam accidentally losing its parent: it would
     then arrive as its own root team, which must not be an admin root. */
  assert.equal(hasAdminAuthority([team("TechOpsMembers")], ["TechOpsMembers"]), false);
  assert.equal(hasAdminAuthority([team("ExecutiveBoardMembers")], ["ExecutiveBoardMembers"]), false);
});



test("an empty team list confers nothing", () => {
  assert.equal(hasAdminAuthority([], []), false);
});

test("name matching is exact, not a prefix", () => {
  assert.equal(authorityVia("TechOpsSomethingElse"), false);
  assert.equal(authorityVia("techops"), false);
  assert.equal(authorityVia("NotTechOps"), false);
});

test("every admin team is a real provisioned service team", () => {
  /* An admin team that validateServiceExistance never creates would silently
     grant nothing, because nobody could be a member of it. */
  for (const name of ADMIN_AUTHORITY_TEAMS) {
    assert.ok(ENABLED_SERVICE_TEAMS[name], `${name} must exist in ENABLED_SERVICE_TEAMS`);
  }
});

test("TechOps mirrors ExecutiveBoard's shape", () => {
  const exec = ENABLED_SERVICE_TEAMS.ExecutiveBoard;
  const ops = ENABLED_SERVICE_TEAMS.TechOps;
  assert.ok(ops, "TechOps must be a service team");
  assert.equal(ops.subteams.length, exec.subteams.length);
  assert.deepEqual(
    ops.subteams.map((s) => s.uniqueName),
    ["TechOpsMembers", "TechOpsAlumni"]
  );
});


/* ── the alumni case ──────────────────────────────────────────────────────
   These are the tests that matter. Before the subteam set existed, every one
   of the "no authority" cases below returned true, because the alumni group
   resolves to the same root team as the current members group. Any past
   executive kept the Bindle override on every team indefinitely. */

test("current executives hold authority", () => {
  assert.equal(authorityVia("ExecutiveBoardMembers"), true);
});

test("alumni do NOT hold authority, despite resolving to the same root team", () => {
  assert.equal(authorityVia("ExecutiveBoardAlumni"), false);
  assert.equal(authorityVia("TechOpsAlumni"), false);
});

test("an alumnus who is also a current member keeps authority", () => {
  assert.equal(authorityVia("ExecutiveBoardAlumni", "ExecutiveBoardMembers"), true);
});

test("direct membership of the root team itself still counts", () => {
  assert.equal(authorityVia("ExecutiveBoard"), true);
});

test("an ordinary team member holds nothing", () => {
  assert.equal(authorityVia("WebDevFALL2026"), false);
  assert.equal(authorityVia("WebDevBackendFALL2026"), false);
});

test("the right root with the wrong groups grants nothing", () => {
  /* Defends the second half of the check on its own. */
  assert.equal(hasAdminAuthority([team("ExecutiveBoard")], ["WebDevFALL2026"]), false);
  assert.equal(hasAdminAuthority([team("ExecutiveBoard")], []), false);
});

test("the right groups with a deleted root grant nothing", () => {
  /* And the first half. */
  assert.equal(
    hasAdminAuthority([team("ExecutiveBoard", true)], ["ExecutiveBoardMembers"]),
    false
  );
});

test("every admin subteam belongs to an admin root team", () => {
  const declared = new Set();
  for (const rootName of ADMIN_AUTHORITY_TEAMS) {
    for (const sub of ENABLED_SERVICE_TEAMS[rootName].subteams) declared.add(sub.uniqueName);
  }
  for (const sub of ADMIN_AUTHORITY_SUBTEAMS) {
    assert.ok(declared.has(sub), `${sub} must be a subteam of an admin team`);
  }
});
