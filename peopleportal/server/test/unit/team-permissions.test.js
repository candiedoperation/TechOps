/**
 * GET /api/org/teams/:teamId/permissions tells the web UI which controls to
 * disable. It is informational (every route still enforces its own bindles),
 * but it must agree with bindlesAuthVerify or the UI would grey out things the
 * user can do, or leave enabled things the server will refuse.
 */
const assert = require("node:assert/strict");
const test = require("node:test");
const { OrgController } = require("../../dist/controllers/OrgController.js");
const { PeoplePortalClient } = require("../../dist/clients/PeoplePortalClient/index.js");

const CLIENT = PeoplePortalClient.TAG;

const teamInfo = {
  name: "webdev-fa26",
  pk: "team-1",
  parentPk: undefined,
  attributes: { peoplePortalCreation: true },
  subteams: [
    { name: "webdev-leads", pk: "sub-1", attributes: { bindlePermissions: { [CLIENT]: { "corp:membermgmt": true, "corp:hiringaccess": false } } } },
  ],
};

const reqFor = (groups, { superuser = false } = {}) => ({
  session: { authorizedUser: { pk: 1, username: "user1", is_superuser: superuser, groups } },
});

const controllerFor = (team) => {
  const controller = new OrgController();
  controller.authentikClient = { getGroupInfo: async () => team };
  return controller;
};

test("a member of a bindle-holding subteam gets exactly those bindles", async () => {
  const result = await controllerFor(teamInfo).getTeamPermissions(reqFor(["webdev-leads"]), "team-1");
  assert.deepEqual(result, { unrestricted: false, bindles: ["corp:membermgmt"] });
});

test("a user in no subteam gets no bindles", async () => {
  const result = await controllerFor(teamInfo).getTeamPermissions(reqFor(["unrelated"]), "team-1");
  assert.deepEqual(result, { unrestricted: false, bindles: [] });
});

test("a team owner is unrestricted", async () => {
  const result = await controllerFor(teamInfo).getTeamPermissions(reqFor(["webdev-fa26"]), "team-1");
  assert.equal(result.unrestricted, true);
});

test("a superuser is unrestricted", async () => {
  const result = await controllerFor(teamInfo).getTeamPermissions(reqFor([], { superuser: true }), "team-1");
  assert.equal(result.unrestricted, true);
});
