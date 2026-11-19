/**
 * getEffectivePermissionSet is the core of the bindle authorization layer:
 * every @Security("bindles", [...]) route resolves through it. It answers one
 * question — which permissions does this user hold on this team — by union-ing
 * the enabled bindles of every subteam the user belongs to.
 */
const assert = require("node:assert/strict");
const test = require("node:test");
const { BindleController } = require("../../dist/controllers/BindleController.js");
const { PeoplePortalClient } = require("../../dist/clients/PeoplePortalClient/index.js");

const CLIENT = PeoplePortalClient.TAG;

const subteam = (name, bindles) => ({
  name,
  pk: `pk-${name}`,
  attributes: bindles === undefined ? {} : { bindlePermissions: { [CLIENT]: bindles } },
});

const team = (subteams) => ({ name: "webdev-fa26", pk: "team-1", subteams });

test("grants the bindles of a subteam the user belongs to", () => {
  const permissions = BindleController.getEffectivePermissionSet(
    team([subteam("webdev-leads", { "corp:hiringaccess": true, "corp:membermgmt": true })]),
    ["webdev-leads"]
  );
  assert.ok(permissions.has("corp:hiringaccess"));
  assert.ok(permissions.has("corp:membermgmt"));
  assert.equal(permissions.size, 2);
});

test("grants nothing for a subteam the user does not belong to", () => {
  const permissions = BindleController.getEffectivePermissionSet(
    team([subteam("webdev-leads", { "corp:hiringaccess": true })]),
    ["some-other-team"]
  );
  assert.equal(permissions.size, 0);
});

test("ignores bindles explicitly disabled", () => {
  const permissions = BindleController.getEffectivePermissionSet(
    team([subteam("webdev-leads", { "corp:hiringaccess": false, "corp:membermgmt": true })]),
    ["webdev-leads"]
  );
  assert.equal(permissions.has("corp:hiringaccess"), false, "false must not grant");
  assert.ok(permissions.has("corp:membermgmt"));
});

test("unions permissions across every subteam the user belongs to", () => {
  const permissions = BindleController.getEffectivePermissionSet(
    team([
      subteam("webdev-leads", { "corp:hiringaccess": true }),
      subteam("webdev-eng", { "corp:meetingsmgmt": true }),
      subteam("webdev-design", { "corp:reviewaccess": true }),
    ]),
    ["webdev-leads", "webdev-eng"]
  );
  assert.deepEqual(
    [...permissions].sort(),
    ["corp:hiringaccess", "corp:meetingsmgmt"],
    "only the two subteams the user is in should contribute"
  );
});

test("a grant in one subteam is not cancelled by a denial in another", () => {
  /* Union semantics: holding the bindle anywhere on the team grants it. Worth
     pinning down, because the opposite (deny wins) is an equally defensible
     design and silently switching would widen or narrow every route at once. */
  const permissions = BindleController.getEffectivePermissionSet(
    team([
      subteam("webdev-leads", { "corp:hiringaccess": true }),
      subteam("webdev-eng", { "corp:hiringaccess": false }),
    ]),
    ["webdev-leads", "webdev-eng"]
  );
  assert.ok(permissions.has("corp:hiringaccess"));
});

test("tolerates teams and subteams with no bindle data", () => {
  assert.equal(BindleController.getEffectivePermissionSet(team([]), ["x"]).size, 0);
  assert.equal(BindleController.getEffectivePermissionSet(team(undefined), ["x"]).size, 0);
  assert.equal(
    BindleController.getEffectivePermissionSet(team([subteam("webdev-leads", undefined)]), ["webdev-leads"]).size,
    0
  );
});

test("tolerates a user in no groups at all", () => {
  const t = team([subteam("webdev-leads", { "corp:hiringaccess": true })]);
  assert.equal(BindleController.getEffectivePermissionSet(t, []).size, 0);
});

test("ignores bindles belonging to a different client", () => {
  const permissions = BindleController.getEffectivePermissionSet(
    team([{
      name: "webdev-leads",
      pk: "pk-1",
      attributes: { bindlePermissions: { SomeOtherClient: { "repo:allowcreate": true } } },
    }]),
    ["webdev-leads"]
  );
  assert.equal(permissions.size, 0, "only this client's bindles are in scope");
});

test("membership is matched on exact subteam name, not a prefix", () => {
  const permissions = BindleController.getEffectivePermissionSet(
    team([subteam("webdev-leads", { "corp:hiringaccess": true })]),
    ["webdev-leads-alumni", "webdev", "WEBDEV-LEADS"]
  );
  assert.equal(permissions.size, 0, "near-miss names must not grant access");
});
