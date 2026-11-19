/**
 * Which stage transitions are allowed to email an applicant.
 *
 * Moving someone to "Potential Hire" used to send a mail subject-lined
 * "Waitlisted for <team>". Potential Hire is an internal grouping the
 * recruiting team uses while still deciding, so that told applicants they had
 * been passed over before it was true. Removed at the bootcamp leads' request
 * on 2026-09-02; this locks it down so it cannot quietly come back.
 */
const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const { Applicant } = require("../../dist/models/Applicant.js");
const { Application, ApplicationStage } = require("../../dist/models/Application.js");
const { ATSController } = require("../../dist/controllers/ATSController.js");

const TEAM_PK = "team-webdev-fa26";
const RECRUITER_PK = 7001;

let mongo;

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri("people-portal-test"));
});

test.after(async () => {
  await mongoose.disconnect();
  if (mongo) await mongo.stop();
});

test.beforeEach(async () => {
  await Promise.all([Applicant.deleteMany({}), Application.deleteMany({})]);
});

const recruiterRequest = () => ({
  session: {
    authorizedUser: {
      pk: RECRUITER_PK,
      sub: `sub-${RECRUITER_PK}`,
      username: "recruiter",
      email: "recruiter@example.invalid",
      name: "Recruiter",
      is_superuser: true,
      groups: [],
      attributes: {},
    },
  },
});

/**
 * Builds a controller whose outbound effects are captured rather than sent.
 * Returns the controller plus the list of mails it attempted.
 */
function controllerWithCapturedEmail() {
  const controller = new ATSController();
  const sent = [];

  controller.emailClient = { send: async (message) => { sent.push(message); return true; } };

  /* Stand in for Authentik so the test needs no directory. */
  controller.authentikClient = {
    getGroupInfo: async () => ({
      pk: TEAM_PK,
      name: "webdev-fa26",
      /* getAuthorizedHiringTeam requires peoplePortalCreation and refuses
         anything flagged for deletion before it even looks at permissions. */
      attributes: {
        friendlyName: "Web Dev",
        teamType: "PROJECT",
        peoplePortalCreation: true,
        flaggedForDeletion: false,
      },
      users: [],
      subteams: [],
    }),
    getRootTeamsForUsername: async () => ({ teams: [] }),
  };

  return { controller, sent };
}

/* Applicant email is uniquely indexed, so a test seeding twice needs
   distinct addresses. */
let seedCounter = 0;

async function seedApplication(stage = ApplicationStage.APPLIED) {
  const applicant = await Applicant.create({
    email: `applicant-${++seedCounter}@example.invalid`,
    fullName: `Applicant ${seedCounter}`,
    profile: new Map(),
  });
  const application = await Application.create({
    applicantId: applicant._id,
    teamPk: TEAM_PK,
    rolePreferences: [{ role: "Software Engineer", subteamPk: "subteam-webdev-frontend" }],
    stage,
    responses: {},
    stars: 0,
  });
  return { applicant, application };
}

test("moving an applicant to Potential Hire sends no email", async () => {
  /* Potential Hire is only reachable from Interview. */
  const { application } = await seedApplication(ApplicationStage.INTERVIEW);
  const { controller, sent } = controllerWithCapturedEmail();

  const result = await controller.updateApplicationStage(
    recruiterRequest(), TEAM_PK, String(application._id),
    { stage: ApplicationStage.POTENTIAL_HIRE }
  );

  assert.equal(result.error, undefined, `transition rejected: ${result.message}`);
  assert.deepEqual(sent, [], "Potential Hire must not notify the applicant");
});

test("no email sent to Potential Hire mentions being waitlisted", async () => {
  const { application } = await seedApplication(ApplicationStage.INTERVIEW);
  const { controller, sent } = controllerWithCapturedEmail();

  await controller.updateApplicationStage(
    recruiterRequest(), TEAM_PK, String(application._id),
    { stage: ApplicationStage.POTENTIAL_HIRE }
  );

  const wording = sent.map((m) => `${m.subject ?? ""} ${m.templateName ?? ""}`).join(" ");
  assert.doesNotMatch(wording, /waitlist/i);
  assert.doesNotMatch(wording, /RecruitPotentialHireInfo/);
});

test("the stage change itself still persists", async () => {
  const { application } = await seedApplication(ApplicationStage.INTERVIEW);
  const { controller } = controllerWithCapturedEmail();

  await controller.updateApplicationStage(
    recruiterRequest(), TEAM_PK, String(application._id),
    { stage: ApplicationStage.POTENTIAL_HIRE }
  );

  const reloaded = await Application.findById(application._id);
  assert.equal(reloaded.stage, ApplicationStage.POTENTIAL_HIRE,
    "the applicant should still move columns, just silently");
});

test("Potential Hire is still a real stage the model accepts", () => {
  assert.equal(ApplicationStage.POTENTIAL_HIRE, "Potential Hire");
});

/* ── the transition state machine ─────────────────────────────────────────
   Discovered while writing the tests above: stages are not freely assignable,
   VALID_TRANSITIONS gates every move. Worth pinning down, because a kanban
   drag maps straight onto this. */

test("Potential Hire cannot be reached directly from Applied", async () => {
  const { application } = await seedApplication(ApplicationStage.APPLIED);
  const { controller, sent } = controllerWithCapturedEmail();

  const result = await controller.updateApplicationStage(
    recruiterRequest(), TEAM_PK, String(application._id),
    { stage: ApplicationStage.POTENTIAL_HIRE }
  );

  assert.equal(result.error, "BadRequest");
  assert.match(result.message, /Invalid transition/);
  assert.deepEqual(sent, []);
});

test("Hired and Rejected are terminal", async () => {
  for (const terminal of [ApplicationStage.HIRED, ApplicationStage.REJECTED]) {
    const { application } = await seedApplication(terminal);
    const { controller } = controllerWithCapturedEmail();

    const result = await controller.updateApplicationStage(
      recruiterRequest(), TEAM_PK, String(application._id),
      { stage: ApplicationStage.INTERVIEW }
    );

    assert.equal(result.error, "BadRequest", `${terminal} should accept no onward transition`);
  }
});

test("re-setting the current stage is idempotent and silent", async () => {
  const { application } = await seedApplication(ApplicationStage.INTERVIEW);
  const { controller, sent } = controllerWithCapturedEmail();

  const result = await controller.updateApplicationStage(
    recruiterRequest(), TEAM_PK, String(application._id),
    { stage: ApplicationStage.INTERVIEW }
  );

  assert.equal(result.error, undefined);
  assert.match(result.message, /already set/i);
  assert.deepEqual(sent, [], "a no-op must not re-send mail");
});

test("an application from another team is not found through this route", async () => {
  const { application } = await seedApplication(ApplicationStage.INTERVIEW);
  const { controller } = controllerWithCapturedEmail();

  const result = await controller.updateApplicationStage(
    recruiterRequest(), "team-someone-else", String(application._id),
    { stage: ApplicationStage.POTENTIAL_HIRE }
  );

  assert.equal(result.error, "NotFound");
});
