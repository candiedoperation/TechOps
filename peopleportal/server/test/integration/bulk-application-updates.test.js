const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const { Applicant } = require("../../dist/models/Applicant.js");
const {
  Application,
  ApplicationStage,
} = require("../../dist/models/Application.js");
const {
  BulkApplicationRecipientStatus,
  BulkApplicationUpdateJob,
  BulkApplicationUpdateRecipient,
} = require("../../dist/models/BulkApplicationUpdate.js");
const { ATSController } = require("../../dist/controllers/ATSController.js");
const { agendaClient } = require("../../dist/clients/AgendaClient/index.js");
const { EmailClient } = require("../../dist/clients/EmailClient/index.js");
const { DefinedJobs } = require("../../dist/clients/AgendaClient/Jobs/index.js");

const TEAM_PK = "team-webdev-fa26";
let mongo;
let applicantCounter = 0;
let originalScheduleJobOnce;
let originalEmailSend;
let scheduledJobs;

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri("people-portal-test"));
});

test.after(async () => {
  await mongoose.disconnect();
  if (mongo) await mongo.stop();
});

test.beforeEach(async () => {
  await Promise.all([
    Applicant.deleteMany({}),
    Application.deleteMany({}),
    BulkApplicationUpdateJob.deleteMany({}),
    BulkApplicationUpdateRecipient.deleteMany({}),
  ]);
  scheduledJobs = [];
  originalScheduleJobOnce = agendaClient.scheduleJobOnce;
  agendaClient.scheduleJobOnce = async (data) => scheduledJobs.push(data);
  originalEmailSend = EmailClient.prototype.send;
});

test.afterEach(() => {
  agendaClient.scheduleJobOnce = originalScheduleJobOnce;
  EmailClient.prototype.send = originalEmailSend;
});

const recruiterRequest = () => ({
  session: {
    authorizedUser: {
      pk: 7001,
      sub: "sub-7001",
      username: "recruiter",
      email: "recruiter@example.invalid",
      name: "Recruiter",
      is_superuser: true,
      groups: [],
      attributes: {},
    },
  },
});

function controllerWithTeam() {
  const controller = new ATSController();
  controller.authentikClient = {
    getGroupInfo: async () => ({
      pk: TEAM_PK,
      name: "webdev-fa26",
      attributes: {
        friendlyName: "Web Dev",
        peoplePortalCreation: true,
        flaggedForDeletion: false,
      },
      users: [],
      subteams: [],
    }),
  };
  return controller;
}

async function seedApplication(stage = ApplicationStage.APPLIED) {
  applicantCounter += 1;
  const applicant = await Applicant.create({
    email: `applicant-${applicantCounter}@example.invalid`,
    fullName: `Applicant ${applicantCounter}`,
    profile: new Map(),
  });
  const application = await Application.create({
    applicantId: applicant._id,
    teamPk: TEAM_PK,
    rolePreferences: [
      { role: "Software Engineer", subteamPk: "subteam-webdev-frontend" },
    ],
    stage,
    responses: {},
    stars: 0,
  });
  return { applicant, application };
}

function interviewPayload(applicationIds) {
  return {
    applicationIds,
    stage: ApplicationStage.INTERVIEW,
    interviewLink: "https://example.invalid/interview",
    interviewGuidelines: "Please prepare to discuss your recent work and interests.",
  };
}

test("queues eligible applicants and persists per-recipient validation failures", async () => {
  const { application: eligible } = await seedApplication();
  const { application: terminal } = await seedApplication(
    ApplicationStage.REJECTED,
  );
  const controller = controllerWithTeam();

  const result = await controller.createBulkApplicationUpdate(
    recruiterRequest(),
    TEAM_PK,
    interviewPayload([
      String(eligible._id),
      String(terminal._id),
      "not-an-object-id",
    ]),
  );

  assert.equal(result.queued, true);
  assert.equal(result.queuedRecipients, 1);
  assert.equal(result.validationFailedRecipients, 2);
  assert.equal(scheduledJobs.length, 1);

  const recipients = await BulkApplicationUpdateRecipient.find({
    jobId: result.jobId,
  }).sort({ applicationId: 1 });
  assert.equal(
    recipients.filter(
      (recipient) =>
        recipient.status === BulkApplicationRecipientStatus.PENDING,
    ).length,
    1,
  );
  assert.equal(
    recipients.filter(
      (recipient) =>
        recipient.status ===
        BulkApplicationRecipientStatus.VALIDATION_FAILED,
    ).length,
    2,
  );

  const [details, summaries] = await Promise.all([
    controller.getBulkApplicationUpdate(
      recruiterRequest(),
      TEAM_PK,
      result.jobId,
    ),
    controller.getBulkApplicationUpdates(recruiterRequest(), TEAM_PK),
  ]);
  assert.equal(details.recipients.length, 3);
  assert.equal(
    summaries.find((summary) => summary.jobId === result.jobId).counts.total,
    3,
  );
});

test("worker changes stage, sends the configured template, and persists success", async () => {
  const { applicant, application } = await seedApplication();
  const controller = controllerWithTeam();
  const created = await controller.createBulkApplicationUpdate(
    recruiterRequest(),
    TEAM_PK,
    interviewPayload([String(application._id)]),
  );
  const sent = [];
  EmailClient.prototype.send = async (request) => {
    sent.push(request);
  };

  await DefinedJobs.sendBulkApplicationUpdates.workerFunction({
    attrs: { data: { jobId: created.jobId } },
  });

  const updatedApplication = await Application.findById(application._id);
  const recipient = await BulkApplicationUpdateRecipient.findOne({
    jobId: created.jobId,
    applicationId: String(application._id),
  });
  const job = await BulkApplicationUpdateJob.findById(created.jobId);

  assert.equal(updatedApplication.stage, ApplicationStage.INTERVIEW);
  assert.equal(
    updatedApplication.stageHistory.at(-1).bulkJobId,
    created.jobId,
  );
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, applicant.email);
  assert.equal(sent[0].templateName, "RecruitInterviewRequest");
  assert.equal(recipient.status, BulkApplicationRecipientStatus.SENT);
  assert.ok(recipient.sentAt);
  assert.equal(job.status, "completed");
});

test("email failures remain retryable without repeating the stage change", async () => {
  const { application } = await seedApplication();
  const controller = controllerWithTeam();
  const created = await controller.createBulkApplicationUpdate(
    recruiterRequest(),
    TEAM_PK,
    {
      applicationIds: [String(application._id)],
      stage: ApplicationStage.REJECTED,
    },
  );
  EmailClient.prototype.send = async () => {
    throw new Error("SMTP unavailable");
  };

  await DefinedJobs.sendBulkApplicationUpdates.workerFunction({
    attrs: { data: { jobId: created.jobId } },
  });

  const failedRecipient = await BulkApplicationUpdateRecipient.findOne({
    jobId: created.jobId,
  });
  assert.equal(failedRecipient.status, BulkApplicationRecipientStatus.FAILED);
  assert.equal(failedRecipient.failurePhase, "email");
  assert.ok(failedRecipient.stageChangedAt);

  const originalHistoryLength = (
    await Application.findById(application._id)
  ).stageHistory.length;
  let retriedEmail;
  EmailClient.prototype.send = async (request) => {
    retriedEmail = request;
  };
  const retryResult = await controller.retryBulkApplicationUpdate(
    recruiterRequest(),
    TEAM_PK,
    created.jobId,
  );
  assert.equal(retryResult.queuedRecipients, 1);
  assert.equal(scheduledJobs.length, 2);

  await DefinedJobs.sendBulkApplicationUpdates.workerFunction({
    attrs: { data: { jobId: created.jobId } },
  });
  const completedRecipient = await BulkApplicationUpdateRecipient.findOne({
    jobId: created.jobId,
  });
  const finalApplication = await Application.findById(application._id);

  assert.equal(completedRecipient.status, BulkApplicationRecipientStatus.SENT);
  assert.equal(retriedEmail.templateName, "RecruitApplicationDeclined");
  assert.equal(finalApplication.stageHistory.length, originalHistoryLength);
});

test("a queue outage is recorded and can be retried", async () => {
  const { application } = await seedApplication();
  const controller = controllerWithTeam();
  agendaClient.scheduleJobOnce = async () => {
    throw new Error("Agenda unavailable");
  };

  const created = await controller.createBulkApplicationUpdate(
    recruiterRequest(),
    TEAM_PK,
    {
      applicationIds: [String(application._id)],
      stage: ApplicationStage.REJECTED,
    },
  );
  assert.equal(created.error, "QueueUnavailable");

  const failedRecipient = await BulkApplicationUpdateRecipient.findOne({
    jobId: created.jobId,
  });
  assert.equal(failedRecipient.failurePhase, "queue");
  assert.equal(failedRecipient.status, BulkApplicationRecipientStatus.FAILED);

  agendaClient.scheduleJobOnce = async (data) => scheduledJobs.push(data);
  const retryResult = await controller.retryBulkApplicationUpdate(
    recruiterRequest(),
    TEAM_PK,
    created.jobId,
  );
  const queuedRecipient = await BulkApplicationUpdateRecipient.findById(
    failedRecipient._id,
  );
  assert.equal(retryResult.queuedRecipients, 1);
  assert.equal(queuedRecipient.status, BulkApplicationRecipientStatus.PENDING);
  assert.equal(queuedRecipient.stageChangedAt, undefined);
  assert.equal(scheduledJobs.length, 1);
});

test("bulk updates reject stages without a matching status email", async () => {
  const { application } = await seedApplication();
  const controller = controllerWithTeam();

  const result = await controller.createBulkApplicationUpdate(
    recruiterRequest(),
    TEAM_PK,
    {
      applicationIds: [String(application._id)],
      stage: ApplicationStage.POTENTIAL_HIRE,
    },
  );

  assert.equal(result.error, "BadRequest");
  assert.equal(scheduledJobs.length, 0);
});
