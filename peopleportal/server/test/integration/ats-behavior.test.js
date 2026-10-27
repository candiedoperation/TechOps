const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const { createHash } = require("node:crypto");

process.env.TZ = "UTC";
process.env.S3_BUCKET_NAME = "ats-test-bucket";

const { Applicant } = require("../../dist/models/Applicant.js");
const { Application, ApplicationStage: Stage } = require("../../dist/models/Application.js");
const { SubteamConfig } = require("../../dist/models/SubteamConfig.js");
const { TeamRecruitingStatus } = require("../../dist/models/TeamRecruitingStatus.js");
const { RedisClient } = require("../../dist/clients/RedisClient/index.js");
const signature = require("../../dist/utils/s3-validation.js");
const presigner = require("@aws-sdk/s3-request-presigner");
const presignedPost = require("@aws-sdk/s3-presigned-post");
const { BindleController } = require("../../dist/controllers/BindleController.js");
const {
  AuthentikClientError,
  AuthentikClientErrorType,
} = require("../../dist/clients/AuthentikClient/models.js");

// Run the same cases against a saved pre-refactor build when comparing behavior.
function loadController() {
  if (!process.env.ATS_BASELINE_CONTROLLER) {
    return require("../../dist/controllers/ATSController.js").ATSController;
  }
  const filename = path.resolve(__dirname, "../../dist/controllers/ATSController.before.js");
  const baseline = new Module(filename, module);
  baseline.filename = filename;
  baseline.paths = Module._nodeModulePaths(path.dirname(filename));
  baseline._compile(fs.readFileSync(process.env.ATS_BASELINE_CONTROLLER, "utf8"), filename);
  return baseline.exports.ATSController;
}

const ATSController = loadController();
const observations = {};
const digestPath = path.resolve(__dirname, "../fixtures/ats-behavior.sha256.json");
const baselineDigests = process.env.ATS_CAPTURE_BASELINE
  ? undefined
  : JSON.parse(fs.readFileSync(digestPath, "utf8"));
const digest = (observation) =>
  createHash("sha256").update(JSON.stringify(observation)).digest("hex");
const TEAM = "team-1";
const SUBTEAM = "subteam-1";
const APPLICANT = "65a000000000000000000001";
const APPLICATION = "65a000000000000000000002";
const RESUME = `resumes/${APPLICANT}.pdf`;
const ANSWER = "one two three four five six seven eight nine ten";
const NOW = Date.UTC(2026, 9, 27, 12);

function normalize(value) {
  if (value === undefined) return { $undefined: true };
  if (value instanceof Date) return { $date: value.toISOString() };
  if (value instanceof Map) return { $map: [...value].map(([k, v]) => [k, normalize(v)]) };
  if (Array.isArray(value)) return value.map(normalize);
  if (value instanceof Error) return { $error: value.name, message: value.message };
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => typeof v !== "function")
        .map(([k, v]) => [k, normalize(v)]),
    );
  }
  return value;
}

function fixture(t, options = {}) {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const calls = [];
  const record = (name, ...args) => calls.push([name, ...normalize(args)]);
  const actor = {
    name: "Recruiter",
    username: "recruiter",
    email: "reviewer@example.invalid",
    groups: [],
    is_superuser: true,
  };
  const profile = {
    resumeUrl: RESUME,
    whyAppDev: "I enjoy building useful tools.",
    instagramFollow: "yes",
  };
  const applicant = {
    _id: APPLICANT,
    email: "student@example.invalid",
    fullName: "Student Name",
    profile: new Map(Object.entries(profile)),
  };
  const config = {
    subteamPk: SUBTEAM,
    isRecruiting: true,
    roles: ["SWE"],
    roleSpecificQuestions: { SWE: ["Explain a project"] },
  };
  const status = { teamPk: TEAM, isRecruiting: true, recruitingSubteamPks: [SUBTEAM] };
  const root = {
    pk: TEAM,
    name: "team-name",
    parentPk: null,
    subteamPkList: [SUBTEAM],
    attributes: {
      friendlyName: "Team One",
      description: "A team",
      seasonType: "Fall",
      seasonYear: "2026",
      peoplePortalCreation: true,
      flaggedForDeletion: false,
    },
    subteams: [],
  };
  const subteam = {
    ...root,
    pk: SUBTEAM,
    name: "subteam-name",
    parentPk: TEAM,
    parentInfo: root,
    subteams: [],
  };
  root.subteams.push({ ...subteam, parentInfo: undefined });
  const application = {
    _id: APPLICATION,
    applicantId: APPLICANT,
    teamPk: TEAM,
    rolePreferences: [{ role: "SWE", subteamPk: SUBTEAM }],
    stage: options.stage || Stage.APPLIED,
    appliedAt: new Date(NOW),
    stars: 0,
    responses: new Map([["Explain a project", ANSWER]]),
    stageHistory: [],
    async save() {
      record("Application.save", this);
      if (options.saveFails) throw new Error("save failed");
    },
  };

  function query(value) {
    const q = {
      select(...args) {
        record("select", ...args);
        return q;
      },
      populate(...args) {
        record("populate", ...args);
        const populate = (app) => (app ? { ...app, applicantId: applicant } : app);
        value = Array.isArray(value) ? value.map(populate) : populate(value);
        return q;
      },
      lean() {
        record("lean");
        return q;
      },
      sort(...args) {
        record("sort", ...args);
        return q;
      },
      exec: async () => value,
      then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
    };
    return q;
  }

  function modelMethod(model, name, label, result) {
    t.mock.method(model, name, (...args) => {
      record(label, ...args);
      if (options.databaseFails === label) throw new Error("database failed");
      return query(typeof result === "function" ? result(...args) : result);
    });
  }
  modelMethod(Applicant, "findOne", "Applicant.findOne", () =>
    options.noApplicant ? null : applicant,
  );
  modelMethod(Applicant, "findById", "Applicant.findById", () =>
    options.noApplicant ? null : applicant,
  );
  modelMethod(Applicant, "findByIdAndUpdate", "Applicant.findByIdAndUpdate", () =>
    options.applicantDisappears ? null : applicant,
  );
  modelMethod(Applicant, "findOneAndUpdate", "Applicant.findOneAndUpdate", applicant);
  t.mock.method(Applicant.db, "transaction", async (operation) => operation({}));
  modelMethod(Application, "findOne", "Application.findOne", (filter) => {
    if (options.noApplication || filter.teamPk !== TEAM) return null;
    if (!filter._id) return options.duplicate ? application : null;
    return application;
  });
  modelMethod(Application, "find", "Application.find", () =>
    options.emptyApplications ? [] : [application],
  );
  modelMethod(Application, "exists", "Application.exists", () => !options.noApplication);
  modelMethod(Application, "aggregate", "Application.aggregate", [
    { _id: { teamPk: TEAM, stage: Stage.APPLIED }, count: 2 },
  ]);
  t.mock.method(Application, "create", async (data) => {
    record("Application.create", data);
    if (options.createFails) throw new Error("create failed");
    return Array.isArray(data) ? [{ ...data[0], _id: APPLICATION }] : { ...data, _id: APPLICATION };
  });
  function patchApplication(update) {
    const set = (key, value, remove = false) => {
      const parts = key.split(".");
      let target = application;
      for (const part of parts.slice(0, -1)) target = target[part] ??= {};
      if (remove) delete target[parts.at(-1)];
      else target[parts.at(-1)] = value;
    };
    for (const [key, value] of Object.entries(update.$set || {})) set(key, value);
    for (const key of Object.keys(update.$unset || {})) set(key, undefined, true);
    for (const [key, value] of Object.entries(update.$push || {})) application[key].push(value);
  }
  modelMethod(Application, "findOneAndUpdate", "Application.findOneAndUpdate", (filter, update) => {
    if (options.saveFails) throw new Error("save failed");
    patchApplication(update);
    return application;
  });
  modelMethod(Application, "updateOne", "Application.updateOne", (filter, update) => {
    patchApplication(update);
    return { matchedCount: 1 };
  });
  modelMethod(SubteamConfig, "findOne", "SubteamConfig.findOne", () =>
    options.noConfig ? null : config,
  );
  modelMethod(SubteamConfig, "find", "SubteamConfig.find", () =>
    options.noConfig ? [] : [config],
  );
  modelMethod(SubteamConfig, "findOneAndUpdate", "SubteamConfig.findOneAndUpdate", () => config);
  modelMethod(TeamRecruitingStatus, "findOne", "TeamRecruitingStatus.findOne", () =>
    options.noStatus ? null : status,
  );
  modelMethod(TeamRecruitingStatus, "find", "TeamRecruitingStatus.find", [status]);
  modelMethod(TeamRecruitingStatus, "deleteMany", "TeamRecruitingStatus.deleteMany", {});
  modelMethod(TeamRecruitingStatus, "updateOne", "TeamRecruitingStatus.updateOne", {});
  modelMethod(
    TeamRecruitingStatus,
    "findOneAndUpdate",
    "TeamRecruitingStatus.findOneAndUpdate",
    (filter, update) => {
      if (options.noStatus) return null;
      if (update.$pull) status.recruitingSubteamPks = [];
      return status;
    },
  );

  for (const method of ["get", "set", "delete"]) {
    t.mock.method(RedisClient, method, async (...args) => {
      record(`Redis.${method}`, ...args);
      if (method === "get") return options.cache;
      return true;
    });
  }
  t.mock.method(signature, "validateS3FileSignature", async (...args) => {
    record("validateS3FileSignature", ...args);
    if (options.signatureThrows) throw new Error("storage failed");
    return options.signature !== false;
  });
  t.mock.method(presigner, "getSignedUrl", async (client, command, settings) => {
    record("getSignedUrl", command.input, settings);
    if (options.signingFails) throw new Error("signing failed");
    return `https://storage.example.invalid/${command.input.Key}`;
  });
  t.mock.method(presignedPost, "createPresignedPost", async (client, settings) => {
    record("createPresignedPost", settings);
    if (options.signingFails) throw new Error("signing failed");
    return { url: "https://storage.example.invalid/upload", fields: { key: settings.Key } };
  });
  t.mock.method(
    BindleController,
    "getEffectivePermissionSet",
    () => new Set(options.hiringPermission ? ["corp:hiringaccess"] : []),
  );

  const controller = new ATSController();
  controller.authentikClient = {
    async getGroupInfo(pk, settings) {
      record("getGroupInfo", pk, settings);
      if (options.groupNotFound)
        throw new AuthentikClientError(AuthentikClientErrorType.GROUP_NOT_FOUND, "missing group");
      if (options.authentikFails) throw new Error("directory failed");
      return pk === SUBTEAM ? subteam : root;
    },
    async getGroupsInfoByPks(...args) {
      record("getGroupsInfoByPks", ...args);
      if (options.authentikFails) throw new Error("directory failed");
      return new Map(options.missingGroup ? [] : [[TEAM, root]]);
    },
    async getGroupsList(...args) {
      record("getGroupsList", ...args);
      return {
        teams: [
          { pk: TEAM, friendlyName: "Team One", name: "team-name" },
          { pk: "team-empty", name: "Empty" },
        ],
      };
    },
    async getUserInfoFromEmail(...args) {
      record("getUserInfoFromEmail", ...args);
      if (!options.internalMember)
        throw new AuthentikClientError(AuthentikClientErrorType.USER_NOT_FOUND);
      return { pk: "7" };
    },
  };
  controller.emailClient = {
    async send(message) {
      record("email", message);
      if (options.emailFails) throw new Error("mail failed");
      return true;
    },
  };
  controller.orgController = {
    async createInvite(...args) {
      record("createInvite", ...args);
      if (options.inviteFails) throw new Error("invite failed");
    },
    async addTeamMember(...args) {
      record("addTeamMember", ...args);
      if (options.membershipFails) throw new Error("membership failed");
    },
    async createInviteForATS(...args) {
      record("createInviteForATS", ...args);
      if (options.inviteFails) throw new Error("invite failed");
    },
  };
  const req = {
    session: {
      authorizedUser: actor,
      tempsession: { user: { email: applicant.email, name: applicant.fullName } },
    },
    protocol: "http",
    get: () => "localhost:3000",
  };
  const input = {
    teamPk: TEAM,
    rolePreferences: [{ role: "SWE", subteamPk: SUBTEAM }],
    profile: { ...profile },
    responses: { "Explain a project": ANSWER, "Why are you interested in Team One?": ANSWER },
  };
  if (options.prepare)
    options.prepare({
      actor,
      profile,
      applicant,
      config,
      status,
      root,
      subteam,
      application,
      req,
      input,
    });
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "warn", () => {});
  return { controller, calls, req, input, applicant, application, config, status, root };
}

function check(name, method, args, expected = {}, options = {}) {
  test(name, async (t) => {
    const context = fixture(t, options);
    let body, thrown;
    try {
      body = await (typeof method === "function"
        ? method(context)
        : context.controller[method](...args(context)));
    } catch (error) {
      thrown = error;
    }
    await new Promise(setImmediate);
    await new Promise(setImmediate);
    const actual = {
      body: normalize(body),
      status: normalize(context.controller.getStatus()),
      headers: normalize(context.controller.getHeaders()),
      thrown: normalize(thrown),
      calls: context.calls,
    };
    observations[name] = actual;
    if (baselineDigests) {
      // These workflows deliberately changed persistence. Their API responses
      // still match the original; the reliability suite checks their new writes.
      const changedWorkflow = [
        "applyToTeam",
        "updateApplicationStage",
        "getAllRecruitingTeams",
      ].includes(method);
      const { calls, ...response } = actual;
      assert.equal(
        digest(changedWorkflow ? response : actual),
        changedWorkflow ? baselineDigests[name].response : baselineDigests[name].trace,
        "ATS response or side effects changed; use ATS_BEHAVIOR_SNAPSHOT to inspect the trace",
      );
    }
    if ("status" in expected) assert.equal(context.controller.getStatus(), expected.status);
    if (expected.error) assert.equal(body?.error, expected.error);
    if (expected.message) assert.equal(body?.message, expected.message);
    if (expected.thrown) assert.equal(thrown?.message, expected.thrown);
    else assert.equal(thrown, undefined);
    if (expected.verify) expected.verify(body, context);
  });
}

const upload = ({ req }) => [req, "resume.pdf", "application/pdf"];
const submission = ({ input, req }) => [input, req];
const stage =
  (value, extra = {}) =>
  ({ req }) => [req, TEAM, APPLICATION, { stage: value, ...extra }];
const noGuest = ({ req }) => {
  delete req.session.tempsession;
};

check("upload: valid PDF", "getResumeUploadUrl", upload, {
  verify: (body) => assert.equal(body.key, RESUME),
});
check(
  "upload: missing session",
  "getResumeUploadUrl",
  upload,
  { status: 401, error: "Unauthorized" },
  { prepare: noGuest },
);
for (const name of ["resume.txt", "resume", "../resume.pdf", "a/resume.pdf", "a\\resume.pdf"]) {
  check(
    `upload: rejects ${name}`,
    "getResumeUploadUrl",
    ({ req }) => [req, name, "application/pdf"],
    { status: 400 },
  );
}
check(
  "upload: invalid MIME",
  "getResumeUploadUrl",
  ({ req }) => [req, "resume.pdf", "text/plain"],
  { status: 400, error: "InvalidContentType" },
);
check(
  "upload: missing applicant",
  "getResumeUploadUrl",
  upload,
  { status: 404 },
  { noApplicant: true },
);
check(
  "upload: signing failure propagates",
  "getResumeUploadUrl",
  upload,
  { thrown: "signing failed" },
  { signingFails: true },
);

for (const key of [RESUME, `resumes/./${APPLICANT}.pdf`, `resumes/folder/../${APPLICANT}.pdf`]) {
  check(`download: ${key}`, "getResumeDownloadUrl", ({ req }) => [req, key], {
    status: 307,
    verify: (body, c) =>
      assert.equal(c.controller.getHeaders().Location, `https://storage.example.invalid/${RESUME}`),
  });
}
check(
  "download: another applicant",
  "getResumeDownloadUrl",
  ({ req }) => [req, "resumes/other.pdf"],
  { status: 403 },
);
check(
  "download: no guest",
  "getResumeDownloadUrl",
  ({ req }) => [req, RESUME],
  { status: 401 },
  { prepare: noGuest },
);
check(
  "download: signing failure",
  "getResumeDownloadUrl",
  ({ req }) => [req, RESUME],
  { status: 404 },
  { signingFails: true },
);

check("submission: success", "applyToTeam", submission, {
  verify: (body) => assert.equal(body.id, APPLICATION),
});
check("submission: internal member", "applyToTeam", submission, {}, { internalMember: true });
check("submission: incomplete request", "applyToTeam", ({ req }) => [{}, req], {
  status: 400,
  error: "InvalidRequest",
});
check("submission: no guest", "applyToTeam", submission, { status: 401 }, { prepare: noGuest });
check(
  "submission: recruitment closed",
  "applyToTeam",
  submission,
  { status: 403 },
  {
    prepare: ({ status }) => {
      status.isRecruiting = false;
    },
  },
);
check(
  "submission: invalid role",
  "applyToTeam",
  submission,
  { status: 400, error: "InvalidRole" },
  {
    prepare: ({ input }) => {
      input.rolePreferences[0].role = "PM";
    },
  },
);
for (const [field, value, error] of [
  ["resumeUrl", "", "MissingRequiredField"],
  ["resumeUrl", "resume.txt", "InvalidFileType"],
  ["whyAppDev", "", "MissingRequiredField"],
  ["whyAppDev", "word ".repeat(201), "WordCountExceeded"],
  ["instagramFollow", "", "MissingRequiredField"],
  ["linkedinUrl", "broken", "InvalidURL"],
  ["githubUrl", "broken", "InvalidURL"],
]) {
  check(
    `submission: invalid ${field} ${error}`,
    "applyToTeam",
    submission,
    { status: 400, error },
    {
      prepare: ({ input }) => {
        input.profile[field] = value;
      },
    },
  );
}
for (const [value, error] of [
  ["", "MissingResponse"],
  ["short", "ResponseTooShort"],
  ["a".repeat(2001), "ResponseTooLong"],
]) {
  check(
    `submission: ${error}`,
    "applyToTeam",
    submission,
    { status: 400, error },
    {
      prepare: ({ input }) => {
        input.responses["Explain a project"] = value;
      },
    },
  );
}
check(
  "submission: missing applicant",
  "applyToTeam",
  submission,
  { status: 404 },
  { noApplicant: true },
);
check(
  "submission: duplicate",
  "applyToTeam",
  submission,
  { status: 409, error: "DuplicateApplication" },
  { duplicate: true },
);
check(
  "submission: resume belongs to someone else",
  "applyToTeam",
  submission,
  { status: 400, error: "InvalidResumeKey" },
  {
    prepare: ({ input }) => {
      input.profile.resumeUrl = "resumes/other.pdf";
    },
  },
);
check(
  "submission: invalid PDF signature",
  "applyToTeam",
  submission,
  { status: 400, error: "InvalidFileSignature" },
  { signature: false },
);
check(
  "submission: storage exception",
  "applyToTeam",
  submission,
  { status: 500, error: "FileProcessingError" },
  { signatureThrows: true },
);
check(
  "submission: applicant disappears",
  "applyToTeam",
  submission,
  { status: 404 },
  { applicantDisappears: true },
);
check(
  "submission: application creation fails",
  "applyToTeam",
  submission,
  { status: 500 },
  { createFails: true },
);
check(
  "submission: directory fails",
  "applyToTeam",
  submission,
  { status: 500 },
  { authentikFails: true },
);

check(
  "profile: merges changes",
  "updateProfile",
  ({ req }) => [{ githubUrl: "https://example.invalid" }, req],
  { message: "Profile updated successfully" },
);
check(
  "profile: no guest",
  "updateProfile",
  ({ req }) => [{}, req],
  { status: 401 },
  { prepare: noGuest },
);
check(
  "profile: missing applicant",
  "updateProfile",
  ({ req }) => [{}, req],
  { status: 404 },
  { noApplicant: true },
);
check(
  "profile: rejects another resume",
  "updateProfile",
  ({ req }) => [{ resumeUrl: "resumes/other.pdf" }, req],
  { status: 400 },
);
check(
  "profile: verifies changed resume",
  "updateProfile",
  ({ req }) => [{ resumeUrl: RESUME }, req],
  {},
  {
    prepare: ({ applicant }) => {
      applicant.profile.delete("resumeUrl");
    },
  },
);
check(
  "profile: invalid signature",
  "updateProfile",
  ({ req }) => [{ resumeUrl: RESUME }, req],
  { status: 400 },
  {
    signature: false,
    prepare: ({ applicant }) => {
      applicant.profile.delete("resumeUrl");
    },
  },
);

check("applications: cards", "getTeamApplications", () => [TEAM], {
  verify: (body) => assert.equal(body[0].applicantId, APPLICANT),
});
check(
  "applications: empty",
  "getTeamApplications",
  () => [TEAM],
  { verify: (body) => assert.deepEqual(body, []) },
  { emptyApplications: true },
);
check(
  "applications: query failure throws",
  "getTeamApplications",
  () => [TEAM],
  { status: 500, thrown: "Failed to fetch applications" },
  { databaseFails: "Application.find" },
);
check("application: details", "getApplicationDetails", () => [TEAM, APPLICATION], {
  verify: (body) => assert.equal(body.id, APPLICATION),
});
check(
  "application: missing",
  "getApplicationDetails",
  () => [TEAM, APPLICATION],
  { status: 404 },
  { noApplication: true },
);
check(
  "application: optional fields",
  "getApplicationDetails",
  () => [TEAM, APPLICATION],
  {},
  {
    prepare: ({ application }) => {
      application.notes = "Existing";
      application.hiredRole = "SWE";
      application.appDevInternalPk = 7;
    },
  },
);

for (const [name, body, error] of [
  ["empty", {}, "BadRequest"],
  ["zero stars", { stars: 0 }, "BadRequest"],
  ["high stars", { stars: 6 }, "BadRequest"],
  ["rating", { stars: 4 }, undefined],
  ["notes", { notes: "Some feedback" }, undefined],
  ["both", { stars: 5, notes: "Useful feedback" }, undefined],
  ["blank notes", { notes: "   " }, "BadRequest"],
  ["unclosed fence", { notes: "```js\nhello" }, "BadRequest"],
]) {
  check(
    `feedback: ${name}`,
    "updateApplicationFeedback",
    ({ req }) => [req, TEAM, APPLICATION, body],
    error ? { status: 400, error } : { verify: (result) => assert.equal(result.success, true) },
  );
}
check(
  "feedback: prepends existing notes",
  "updateApplicationFeedback",
  ({ req }) => [req, TEAM, APPLICATION, { notes: "New" }],
  {},
  {
    prepare: ({ application }) => {
      application.notes = "Old";
    },
  },
);
check(
  "feedback: wrong team",
  "updateApplicationFeedback",
  ({ req }) => [req, "other", APPLICATION, { stars: 4 }],
  { status: 404 },
);
check(
  "feedback: save failure",
  "updateApplicationFeedback",
  ({ req }) => [req, TEAM, APPLICATION, { stars: 4 }],
  { status: 500 },
  { saveFails: true },
);

check("recruiter resume: signed URL", "getApplicantUrls", () => [TEAM, APPLICANT], {
  verify: (body) => assert.equal(body.resumeUrl, `https://storage.example.invalid/${RESUME}`),
});
check(
  "recruiter resume: no application",
  "getApplicantUrls",
  () => [TEAM, APPLICANT],
  { status: 404 },
  { noApplication: true },
);
check(
  "recruiter resume: bad key omitted",
  "getApplicantUrls",
  () => [TEAM, APPLICANT],
  { verify: (body) => assert.equal(body.resumeUrl, undefined) },
  {
    prepare: ({ applicant }) => {
      applicant.profile.set("resumeUrl", "resumes/other.pdf");
    },
  },
);
check(
  "recruiter resume: signing failure omitted",
  "getApplicantUrls",
  () => [TEAM, APPLICANT],
  {},
  { signingFails: true },
);
check("history: application exists", "getApplicantApplications", () => [TEAM, APPLICANT], {
  verify: (body) => assert.equal(body[0].rolePreferences[0].subteamName, "Team One"),
});
check(
  "history: no team application",
  "getApplicantApplications",
  () => [TEAM, APPLICANT],
  { status: 404 },
  { noApplication: true },
);

check("stages: list", "getApplicationStages", () => [], {
  verify: (body) =>
    assert.deepEqual(
      body.map((row) => row.name),
      Object.values(Stage),
    ),
});
check(
  "stage: missing user",
  "updateApplicationStage",
  stage(Stage.INTERVIEW),
  { status: 401 },
  {
    prepare: ({ req }) => {
      delete req.session.authorizedUser;
    },
  },
);
check(
  "stage: missing application",
  "updateApplicationStage",
  stage(Stage.INTERVIEW),
  { status: 404 },
  { noApplication: true },
);
check(
  "stage: no hiring permission",
  "updateApplicationStage",
  stage(Stage.INTERVIEW),
  { status: 403 },
  {
    prepare: ({ req }) => {
      req.session.authorizedUser.is_superuser = false;
    },
  },
);
check("stage: same stage", "updateApplicationStage", stage(Stage.APPLIED), {
  message: "Stage already set",
});
check("stage: invalid transition", "updateApplicationStage", stage(Stage.HIRED), { status: 400 });
check("stage: interview requires link", "updateApplicationStage", stage(Stage.INTERVIEW), {
  status: 400,
});
check(
  "stage: interview requires guidelines",
  "updateApplicationStage",
  stage(Stage.INTERVIEW, { interviewLink: "https://example.invalid" }),
  { status: 400 },
);
check(
  "stage: interview notification",
  "updateApplicationStage",
  stage(Stage.INTERVIEW, {
    interviewLink: "https://example.invalid",
    interviewGuidelines: "a".repeat(50),
  }),
  { message: "Stage updated successfully" },
);
check("stage: rejection notification", "updateApplicationStage", stage(Stage.REJECTED), {
  message: "Stage updated successfully",
});
check(
  "stage: potential hire stays silent",
  "updateApplicationStage",
  stage(Stage.POTENTIAL_HIRE),
  { verify: (_, c) => assert.equal(c.calls.filter(([name]) => name === "email").length, 0) },
  { stage: Stage.INTERVIEW },
);
check(
  "stage: missing hire destination",
  "updateApplicationStage",
  stage(Stage.HIRED),
  { status: 400 },
  { stage: Stage.INTERVIEW },
);
for (const internalMember of [false, true]) {
  check(
    `stage: hired ${internalMember ? "existing" : "new"} member`,
    "updateApplicationStage",
    stage(Stage.HIRED, { hiredRole: "SWE", hiredSubteamPk: SUBTEAM }),
    { message: "Stage updated successfully" },
    { stage: Stage.INTERVIEW, internalMember },
  );
}
check(
  "stage: outside hire destination",
  "updateApplicationStage",
  stage(Stage.HIRED, { hiredRole: "SWE", hiredSubteamPk: "other" }),
  { status: 400 },
  { stage: Stage.INTERVIEW },
);
check(
  "stage: email failure after save",
  "updateApplicationStage",
  stage(Stage.REJECTED),
  { status: 500 },
  { emailFails: true },
);
check(
  "stage: membership failure",
  "updateApplicationStage",
  stage(Stage.HIRED, { hiredRole: "SWE", hiredSubteamPk: SUBTEAM }),
  { status: 500 },
  { stage: Stage.INTERVIEW, internalMember: true, membershipFails: true },
);

check("config: get", "getSubTeamATSConfig", () => [SUBTEAM], {
  verify: (body) => assert.equal(body.parentInfo.pk, TEAM),
});
check(
  "config: missing",
  "getSubTeamATSConfig",
  () => [SUBTEAM],
  { status: 404 },
  { noConfig: true },
);
check("config: update", "createOrUpdateSubteamConfig", ({ config }) => [SUBTEAM, config]);
check(
  "config: empty roles",
  "createOrUpdateSubteamConfig",
  () => [SUBTEAM, { isRecruiting: true, roles: [], roleSpecificQuestions: {} }],
  { status: 400 },
);
check(
  "config: stop recruiting",
  "createOrUpdateSubteamConfig",
  ({ config }) => [SUBTEAM, config],
  {},
  {
    prepare: ({ config }) => {
      config.isRecruiting = false;
    },
  },
);
check(
  "config: removal of missing recruiting status preserves response",
  "createOrUpdateSubteamConfig",
  ({ config }) => [SUBTEAM, config],
  { status: 404 },
  {
    noStatus: true,
    prepare: ({ config }) => {
      config.isRecruiting = false;
    },
  },
);
check(
  "recruitment: add subteam",
  "addSubteamToRecruiting",
  () => [TEAM, SUBTEAM],
  {},
  {
    prepare: ({ status }) => {
      status.isRecruiting = false;
    },
  },
);
check("recruitment: remove last subteam", "removeSubteamFromRecruiting", () => [TEAM, SUBTEAM], {
  verify: (body) => assert.equal(body.isRecruiting, false),
});
check(
  "recruitment: missing team removal",
  "removeSubteamFromRecruiting",
  () => [TEAM, SUBTEAM],
  { status: 404 },
  { noStatus: true },
);
check("open team: details", "getTeamDetails", () => [TEAM], {
  verify: (body) => assert.equal(body.recruitingSubteams[0].subteamPk, SUBTEAM),
});
check("open team: closed", "getTeamDetails", () => [TEAM], { status: 403 }, { noStatus: true });
check(
  "open team: directory failure",
  "getTeamDetails",
  () => [TEAM],
  { status: 500 },
  { authentikFails: true },
);
check(
  "open team: group not found",
  "getTeamDetails",
  () => [TEAM],
  { status: 404, error: "TeamNotFound" },
  { groupNotFound: true },
);
check("open teams: cold cache", "getAllRecruitingTeams", () => [], {
  verify: (body) => assert.equal(body[0].teamInfo.pk, TEAM),
});
check(
  "open teams: fresh cache",
  "getAllRecruitingTeams",
  () => [],
  { verify: (body) => assert.deepEqual(body, [{ cached: true }]) },
  { cache: { value: [{ cached: true }], cachedAt: NOW } },
);
check(
  "open teams: missing group cleanup",
  "getAllRecruitingTeams",
  () => [],
  { verify: (body) => assert.deepEqual(body, []) },
  { missingGroup: true },
);
check(
  "open teams: stale cache survives refresh failure",
  "getAllRecruitingTeams",
  () => [],
  { verify: (body) => assert.deepEqual(body, [{ cached: true }]) },
  { cache: { value: [{ cached: true }], cachedAt: NOW - 301000 }, authentikFails: true },
);
check(
  "open teams: shared refresh across controller instances",
  async ({ controller, calls }) => {
    const other = new ATSController();
    other.authentikClient = controller.authentikClient;
    const results = await Promise.all([
      controller.getAllRecruitingTeams(),
      other.getAllRecruitingTeams(),
    ]);
    await new Promise(setImmediate);
    assert.equal(calls.filter(([name]) => name === "getGroupsInfoByPks").length, 1);
    return results;
  },
  () => [],
  {},
  { cache: { value: [{ cached: true }], cachedAt: NOW - 301000 } },
);
check("statistics: populated and empty teams", "getTeamRecruitmentStats", () => [], {
  verify: (body) =>
    assert.deepEqual(
      body.teams.map((team) => team.total),
      [2, 0],
    ),
});

test.after(() => {
  if (process.env.ATS_CAPTURE_BASELINE) {
    fs.mkdirSync(path.dirname(digestPath), { recursive: true });
    fs.writeFileSync(
      digestPath,
      JSON.stringify(
        Object.fromEntries(
          Object.entries(observations).map(([name, trace]) => {
            const { calls, ...response } = trace;
            return [name, { trace: digest(trace), response: digest(response) }];
          }),
        ),
        null,
        2,
      ) + "\n",
    );
  }
  if (process.env.ATS_BEHAVIOR_SNAPSHOT) {
    fs.writeFileSync(process.env.ATS_BEHAVIOR_SNAPSHOT, JSON.stringify(observations, null, 2));
  }
});
