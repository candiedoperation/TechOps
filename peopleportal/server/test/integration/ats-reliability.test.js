const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const { Applicant } = require("../../dist/models/Applicant.js");
const { Application, ApplicationStage: Stage } = require("../../dist/models/Application.js");
const { SubteamConfig } = require("../../dist/models/SubteamConfig.js");
const { TeamRecruitingStatus } = require("../../dist/models/TeamRecruitingStatus.js");
const { Invite } = require("../../dist/models/Invites.js");
const { ATSController } = require("../../dist/controllers/ATSController.js");
const { BindleController } = require("../../dist/controllers/BindleController.js");
const { RedisClient } = require("../../dist/clients/RedisClient/index.js");
const {
  AuthentikClientError,
  AuthentikClientErrorType: ErrorType,
} = require("../../dist/clients/AuthentikClient/models.js");
const signature = require("../../dist/utils/s3-validation.js");

const TEAM = "team-ats-test";
const SUBTEAM = "subteam-ats-test";
const ANSWER = "one two three four five six seven eight nine ten";
const INTERVIEW = {
  stage: Stage.INTERVIEW,
  interviewLink: "https://interview.example.invalid",
  interviewGuidelines: "Please prepare to discuss your projects and answer questions.",
};
let mongo;

// Use a disposable replica set so transaction tests never use the app's database.
test.before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(mongo.getUri("ats-reliability-test"));
  await Promise.all([
    Applicant.init(),
    Application.init(),
    Invite.init(),
    SubteamConfig.init(),
    TeamRecruitingStatus.init(),
  ]);
});
test.after(async () => {
  await mongoose.disconnect();
  if (mongo) await mongo.stop();
});
test.beforeEach(async () => {
  await Promise.all([
    Application.deleteMany({}),
    Applicant.deleteMany({}),
    Invite.deleteMany({}),
    SubteamConfig.deleteMany({}),
    TeamRecruitingStatus.deleteMany({}),
  ]);
});

async function setup(t, stage) {
  // Every case starts with one applicant and an open team/subteam. Directory,
  // email, and S3 calls are replaced below so failures can be tested deliberately.
  const applicant = await Applicant.create({
    email: "student@terpmail.umd.edu",
    fullName: "Student Tester",
    profile: { whyAppDev: "Original profile" },
  });
  const root = {
    pk: TEAM,
    name: "ats-team",
    attributes: { friendlyName: "ATS Team", peoplePortalCreation: true, flaggedForDeletion: false },
    subteamPkList: [SUBTEAM],
    subteams: [],
  };
  const sub = { ...root, pk: SUBTEAM, parentPk: TEAM, parentInfo: root };
  root.subteams = [{ ...sub, parentInfo: undefined }];
  await SubteamConfig.create({
    subteamPk: SUBTEAM,
    isRecruiting: true,
    roles: ["SWE"],
    roleSpecificQuestions: {},
  });
  await TeamRecruitingStatus.create({
    teamPk: TEAM,
    isRecruiting: true,
    recruitingSubteamPks: [SUBTEAM],
  });
  const actor = {
    pk: 7,
    name: "Recruiter",
    email: "recruiter@terpmail.umd.edu",
    username: "recruiter",
    groups: [],
    is_superuser: true,
    attributes: {},
  };
  const request = {
    session: {
      authorizedUser: actor,
      tempsession: { user: { email: applicant.email, name: "Student Updated" } },
    },
  };
  const body = {
    teamPk: TEAM,
    rolePreferences: [{ role: "SWE", subteamPk: SUBTEAM }],
    profile: {
      resumeUrl: `resumes/${applicant._id}.pdf`,
      whyAppDev: "Updated profile",
      instagramFollow: "yes",
    },
    responses: { "Why are you interested in ATS Team?": ANSWER },
  };
  const controller = new ATSController();
  const sent = [],
    members = [];
  controller.authentikClient = {
    getGroupInfo: async (pk) => (pk === SUBTEAM ? sub : root),
    getGroupsInfoByPks: async () => new Map([[TEAM, root]]),
    getUserInfoFromEmail: async (email) => {
      if (email === actor.email) return { pk: "7", email: actor.email, name: actor.name };
      throw new AuthentikClientError(ErrorType.USER_NOT_FOUND);
    },
  };
  controller.emailClient = {
    send: async (message) => {
      sent.push(message);
      return true;
    },
  };
  controller.orgController.authentikClient = controller.authentikClient;
  controller.orgController.emailClient = controller.emailClient;
  controller.orgController.addTeamMember = async (...args) => {
    members.push(args);
  };
  t.mock.method(signature, "validateS3FileSignature", async () => true);
  t.mock.method(BindleController, "getEffectivePermissionSet", () => new Set());
  t.mock.method(RedisClient, "get", async () => null);
  t.mock.method(RedisClient, "set", async () => true);
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "warn", () => {});
  let application;
  if (stage)
    application = await Application.create({
      applicantId: applicant._id,
      teamPk: TEAM,
      rolePreferences: body.rolePreferences,
      stage,
      responses: {},
    });
  return { applicant, application, root, request, body, controller, sent, members, actor };
}

test("submission commits profile, application and application link together", async (t) => {
  const c = await setup(t);
  const result = await c.controller.applyToTeam(c.body, c.request);
  assert.equal(result.error, undefined);
  const saved = await Applicant.findById(c.applicant._id);
  assert.equal(saved.profile.get("whyAppDev"), "Updated profile");
  assert.deepEqual(saved.applicationIds.map(String), [String(result.id)]);
  assert.equal(await Application.countDocuments({ _id: result.id }), 1);
});

test("application creation failure rolls back profile and application link", async (t) => {
  const c = await setup(t);
  t.mock.method(Application, "create", async () => {
    throw new Error("creation failed");
  });
  const result = await c.controller.applyToTeam(c.body, c.request);
  assert.equal(c.controller.getStatus(), 500);
  assert.equal(result.error, "ServerError");
  const saved = await Applicant.findById(c.applicant._id);
  assert.equal(saved.profile.get("whyAppDev"), "Original profile");
  assert.deepEqual(saved.applicationIds, []);
  assert.equal(await Application.countDocuments(), 0);
});

test("concurrent submissions produce one application, one link and a 409", async (t) => {
  const c = await setup(t);
  const original = Application.findOne;
  let arrived = 0,
    release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  t.mock.method(Application, "findOne", function (...args) {
    const query = original.apply(this, args);
    const exec = query.exec.bind(query);
    query.exec = async () => {
      const result = await exec();
      if (++arrived === 2) release();
      await gate;
      return result;
    };
    return query;
  });
  const other = new ATSController();
  other.authentikClient = c.controller.authentikClient;
  const results = await Promise.all([
    c.controller.applyToTeam(c.body, c.request),
    other.applyToTeam(c.body, c.request),
  ]);
  assert.equal(results.filter((r) => r.id).length, 1);
  assert.equal(results.filter((r) => r.error === "DuplicateApplication").length, 1);
  assert.ok([c.controller.getStatus(), other.getStatus()].includes(409));
  assert.equal(await Application.countDocuments(), 1);
  assert.equal((await Applicant.findById(c.applicant._id)).applicationIds.length, 1);
});

for (const corruptedList of [false, true]) {
  test(`foreign subteam is rejected even when it offers SWE${corruptedList ? " and appears in the recruitment list" : ""}`, async (t) => {
    const c = await setup(t);
    await SubteamConfig.create({ subteamPk: "foreign", isRecruiting: true, roles: ["SWE"] });
    if (corruptedList)
      await TeamRecruitingStatus.updateOne(
        { teamPk: TEAM },
        { $addToSet: { recruitingSubteamPks: "foreign" } },
      );
    c.body.rolePreferences = [{ role: "SWE", subteamPk: "foreign" }];
    const result = await c.controller.applyToTeam(c.body, c.request);
    assert.equal(result.error, "InvalidRole");
    assert.equal(c.controller.getStatus(), 400);
    assert.equal(await Application.countDocuments(), 0);
    assert.equal(
      (await Applicant.findById(c.applicant._id)).profile.get("whyAppDev"),
      "Original profile",
    );
  });
}

test("failed interview email is retried with saved payload without a second history entry", async (t) => {
  const c = await setup(t, Stage.APPLIED);
  c.controller.emailClient.send = async (message) => {
    c.sent.push(message);
    if (c.sent.length === 1) throw new Error("SMTP offline");
    return true;
  };
  const first = await c.controller.updateApplicationStage(
    c.request,
    TEAM,
    String(c.application._id),
    INTERVIEW,
  );
  assert.equal(first.error, "ServerError");
  const pending = await Application.findById(c.application._id);
  assert.equal(pending.stage, Stage.INTERVIEW);
  assert.equal(pending.pendingStageAction.state, "pending");
  // Send a different link on retry to prove the original saved payload wins.
  const result = await c.controller.updateApplicationStage(
    c.request,
    TEAM,
    String(c.application._id),
    { stage: Stage.INTERVIEW, interviewLink: "https://changed.example.invalid" },
  );
  assert.equal(result.error, undefined);
  const saved = await Application.findById(c.application._id);
  assert.equal(saved.pendingStageAction, undefined);
  assert.equal(saved.stageHistory.length, 1);
  assert.equal(c.sent[1].templateVars.interviewLink, INTERVIEW.interviewLink);
  await c.controller.updateApplicationStage(c.request, TEAM, String(c.application._id), {
    stage: Stage.INTERVIEW,
  });
  assert.equal(c.sent.length, 2);
});

test("a pending action blocks concurrent retries and later stages", async (t) => {
  const c = await setup(t, Stage.APPLIED);
  let entered, finish;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const gate = new Promise((resolve) => {
    finish = resolve;
  });
  c.controller.emailClient.send = async () => {
    c.sent.push("email");
    entered();
    await gate;
    return true;
  };
  const first = c.controller.updateApplicationStage(
    c.request,
    TEAM,
    String(c.application._id),
    INTERVIEW,
  );
  try {
    await started;
    for (const stage of [Stage.INTERVIEW, Stage.REJECTED]) {
      const result = await c.controller.updateApplicationStage(
        c.request,
        TEAM,
        String(c.application._id),
        { stage },
      );
      assert.equal(result.error, "StageActionConflict");
      assert.equal(c.controller.getStatus(), 409);
    }
  } finally {
    finish();
  }
  assert.equal((await first).error, undefined);
  assert.equal(c.sent.length, 1);
  assert.equal((await Application.findById(c.application._id)).stage, Stage.INTERVIEW);
});

test("expired processing lease can be reclaimed after a server restart", async (t) => {
  const c = await setup(t, Stage.INTERVIEW);
  await Application.updateOne(
    { _id: c.application._id },
    {
      $set: {
        pendingStageAction: {
          id: "restart-action",
          stage: Stage.INTERVIEW,
          input: INTERVIEW,
          state: "processing",
          completedSteps: [],
          leaseToken: "dead-worker",
          leaseUntil: new Date(Date.now() - 1000),
          inviteId: new mongoose.Types.ObjectId().toString(),
          sender: { name: c.actor.name, email: c.actor.email },
        },
      },
    },
  );
  const result = await c.controller.updateApplicationStage(
    c.request,
    TEAM,
    String(c.application._id),
    { stage: Stage.INTERVIEW },
  );
  assert.equal(result.error, undefined);
  assert.equal(c.sent.length, 1);
  assert.equal((await Application.findById(c.application._id)).pendingStageAction, undefined);
});

test("hiring retry skips completed membership and retries only acceptance email", async (t) => {
  const c = await setup(t, Stage.INTERVIEW);
  c.controller.authentikClient.getUserInfoFromEmail = async () => ({ pk: "8" });
  c.controller.emailClient.send = async (message) => {
    c.sent.push(message);
    if (c.sent.length === 1) throw new Error("SMTP offline");
    return true;
  };
  const first = await c.controller.updateApplicationStage(
    c.request,
    TEAM,
    String(c.application._id),
    { stage: Stage.HIRED, hiredRole: "SWE", hiredSubteamPk: SUBTEAM },
  );
  assert.equal(first.error, "ServerError");
  assert.ok(
    (await Application.findById(c.application._id)).pendingStageAction.completedSteps.includes(
      "membership",
    ),
  );
  const retry = await c.controller.updateApplicationStage(
    c.request,
    TEAM,
    String(c.application._id),
    { stage: Stage.HIRED },
  );
  assert.equal(retry.error, undefined);
  assert.equal(c.members.length, 1);
  assert.equal(c.sent.length, 2);
});

test("new-member retry reuses the invite and onboarding URL after email failure", async (t) => {
  const c = await setup(t, Stage.INTERVIEW);
  c.controller.emailClient.send = async (message) => {
    c.sent.push(message);
    if (c.sent.length === 1) throw new Error("SMTP offline");
    return true;
  };
  const first = await c.controller.updateApplicationStage(
    c.request,
    TEAM,
    String(c.application._id),
    { stage: Stage.HIRED, hiredRole: "SWE", hiredSubteamPk: SUBTEAM },
  );
  assert.equal(first.error, "ServerError");
  assert.equal(await Invite.countDocuments(), 1);
  const retry = await c.controller.updateApplicationStage(
    c.request,
    TEAM,
    String(c.application._id),
    { stage: Stage.HIRED },
  );
  assert.equal(retry.error, undefined);
  assert.equal(await Invite.countDocuments(), 1);
  assert.equal(c.sent[0].templateVars.onboardUrl, c.sent[1].templateVars.onboardUrl);
});

test("directory outage during hiring leaves pending work without creating an invite", async (t) => {
  const c = await setup(t, Stage.INTERVIEW);
  c.controller.authentikClient.getUserInfoFromEmail = async () => {
    throw new AuthentikClientError(ErrorType.SERVER_CONNECTION_ERROR);
  };
  const result = await c.controller.updateApplicationStage(
    c.request,
    TEAM,
    String(c.application._id),
    { stage: Stage.HIRED, hiredRole: "SWE", hiredSubteamPk: SUBTEAM },
  );
  assert.equal(result.error, "ServerError");
  assert.equal(await Invite.countDocuments(), 0);
  assert.equal(c.members.length, 0);
  assert.equal(c.sent.length, 0);
  assert.equal((await Application.findById(c.application._id)).pendingStageAction.state, "pending");
});

test("membership completed before a role-write failure is reconciled on retry", async (t) => {
  const c = await setup(t, Stage.INTERVIEW);
  c.controller.authentikClient.getUserInfoFromEmail = async () => ({ pk: "8" });
  c.controller.orgController.addTeamMember = async (...args) => {
    c.members.push(args);
    throw new Error("group added but role write failed");
  };
  let roles = {};
  c.controller.authentikClient.getUserInfo = async () => ({
    groups: [SUBTEAM],
    attributes: { roles },
  });
  c.controller.authentikClient.updateUserAttributes = async (_, attributes) => {
    roles = attributes.roles;
  };
  const first = await c.controller.updateApplicationStage(
    c.request,
    TEAM,
    String(c.application._id),
    { stage: Stage.HIRED, hiredRole: "SWE", hiredSubteamPk: SUBTEAM },
  );
  assert.equal(first.error, "ServerError");
  const retry = await c.controller.updateApplicationStage(
    c.request,
    TEAM,
    String(c.application._id),
    { stage: Stage.HIRED },
  );
  assert.equal(retry.error, undefined);
  assert.equal(c.members.length, 1);
  assert.equal(roles[SUBTEAM], "SWE");
  assert.equal(c.sent.length, 1);
});

test("retry still requires the current user's hiring permission", async (t) => {
  const c = await setup(t, Stage.APPLIED);
  c.controller.emailClient.send = async () => {
    throw new Error("SMTP offline");
  };
  await c.controller.updateApplicationStage(c.request, TEAM, String(c.application._id), INTERVIEW);
  c.request.session.authorizedUser.is_superuser = false;
  const retry = await c.controller.updateApplicationStage(
    c.request,
    TEAM,
    String(c.application._id),
    { stage: Stage.INTERVIEW },
  );
  assert.equal(retry.error, "Forbidden");
  assert.equal(c.controller.getStatus(), 403);
});

test("a missing directory group is hidden without deleting recruitment data", async (t) => {
  const c = await setup(t);
  c.controller.authentikClient.getGroupsInfoByPks = async () => new Map();
  assert.deepEqual(await c.controller.getAllRecruitingTeams(), []);
  assert.equal(await TeamRecruitingStatus.countDocuments({ teamPk: TEAM }), 1);
  c.controller.authentikClient.getGroupsInfoByPks = async () => new Map([[TEAM, c.root]]);
  assert.equal((await c.controller.getAllRecruitingTeams()).length, 1);
});
