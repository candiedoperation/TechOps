/**
 * T5.2: Statement of Work upload rules.
 *
 * The controller is driven directly, with S3 replaced by an in-memory store,
 * Authentik by a fixed project team, and the ProjectSow model by an in-memory
 * table, so these run without AWS, Authentik or MongoDB.
 */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");

const {
  ProjectSowController,
  HorizonSowController,
} = require("../../dist/controllers/ProjectSowController.js");
const { ProjectSow } = require("../../dist/models/ProjectSow.js");
const {
  isProjectLeadership,
  isProjectMember,
  matchesSignature,
  sowFileTypeFor,
  sowS3Key,
} = require("../../dist/utils/sow.js");
const {
  isHorizonServiceAuthorized,
} = require("../../dist/utils/horizon-service-auth.js");
const { expressAuthentication } = require("../../dist/auth.js");

/* ---------- fixtures ---------- */

const PROJECT_PK = "proj-studybuddy";
const LEAD_PK = 101;
const ENGINEER_PK = 202;
const STRANGER_PK = 303;
const EXEC_PK = 404;

const TEAM = {
  pk: PROJECT_PK,
  name: "StudyBuddyFall2026",
  parentPk: null,
  attributes: { teamType: "PROJECT", seasonType: "FALL", seasonYear: 2026 },
  users: [],
  subteams: [
    {
      name: "StudyBuddyLeadership",
      attributes: { friendlyName: "Leadership" },
      users: [{ pk: "101" }],
    },
    {
      name: "StudyBuddyEngineering",
      attributes: { friendlyName: "Engineering" },
      users: [{ pk: "202" }],
    },
  ],
};

const PDF_BYTES = Buffer.concat([
  Buffer.from("%PDF-1.7\n"),
  Buffer.from("statement of work"),
]);
const DOCX_BYTES = Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.from("word/document.xml"),
]);
/* A Windows program renamed to look like a PDF. */
const EXE_BYTES = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(64)]);

const sessionFor = (pk) => ({
  session: {
    authorizedUser: {
      pk,
      sub: `sub-${pk}`,
      username: `user${pk}`,
      email: `user${pk}@example.invalid`,
      name: `User ${pk}`,
      is_superuser: false,
      groups: [],
      attributes: {},
    },
  },
});

/* In-memory stand-in for S3. */
function memoryStorage() {
  const objects = new Map();
  return {
    objects,
    async presignUpload(key, contentType) {
      return { url: "https://s3.example.invalid/bucket", fields: { key, "content-type": contentType } };
    },
    async sizeOf(key) {
      return objects.has(key) ? objects.get(key).length : null;
    },
    async read(key) {
      return objects.get(key) ?? null;
    },
    async presignDownload(key) {
      return `https://s3.example.invalid/${key}?signed=1`;
    },
    async remove(key) {
      objects.delete(key);
    },
  };
}

/* In-memory stand-in for the ProjectSow collection, including its unique index. */
let rows = [];
const matches = (row, q) => Object.entries(q).every(([k, v]) => row[k] === v);
const query = (value) => ({ exec: async () => value, sort: () => query(value) });
ProjectSow.findOne = (q) => query(rows.find((r) => matches(r, q)) ?? null);
ProjectSow.find = (q) => query(rows.filter((r) => matches(r, q)));
ProjectSow.deleteOne = (q) => {
  rows = rows.filter((r) => r._id !== q._id);
  return query({ deletedCount: 1 });
};
ProjectSow.create = async (doc) => {
  const clash = rows.some(
    (r) =>
      r.projectPk === doc.projectPk &&
      r.seasonType === doc.seasonType &&
      r.seasonYear === doc.seasonYear
  );
  if (clash) throw Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
  const row = { ...doc, _id: crypto.randomUUID() };
  rows.push(row);
  return row;
};

function makeController(storage = memoryStorage()) {
  const controller = new ProjectSowController();
  controller.storage = storage;
  controller.authentikClient = {
    getGroupInfo: async (pk) => {
      if (pk !== PROJECT_PK) throw new Error("not found");
      return TEAM;
    },
  };
  controller.isExecutive = async (req) => req.session.authorizedUser.pk === EXEC_PK;
  return controller;
}

const expectStatus = (status) => (e) => {
  assert.equal(e.status, status, e.message);
  return true;
};

async function uploadAs(controller, pk, fileName, bytes) {
  const req = sessionFor(pk);
  const { key } = await controller.getSowUploadUrl(req, PROJECT_PK, { fileName });
  controller.storage.objects.set(key, bytes); /* the browser's direct upload */
  return controller.confirmSowUpload(req, PROJECT_PK, { fileName });
}

test.beforeEach(() => {
  rows = [];
});

/* ---------- pure rules ---------- */

test("only .pdf and .docx names are accepted", () => {
  assert.equal(sowFileTypeFor("Plan.PDF").extension, "pdf");
  assert.equal(sowFileTypeFor("plan.final.docx").extension, "docx");
  for (const bad of ["plan.doc", "plan.exe", "plan", "plan.pdf.exe"]) {
    assert.equal(sowFileTypeFor(bad), null, bad);
  }
});

test("file signatures are checked from the bytes, not the name", () => {
  assert.equal(matchesSignature(PDF_BYTES, sowFileTypeFor("a.pdf").signature), true);
  assert.equal(matchesSignature(DOCX_BYTES, sowFileTypeFor("a.docx").signature), true);
  assert.equal(matchesSignature(EXE_BYTES, sowFileTypeFor("a.pdf").signature), false);
  assert.equal(matchesSignature(PDF_BYTES, sowFileTypeFor("a.docx").signature), false);
});

test("SOWs are stored under sows/{year}-{season}/{projectPk}.{ext}", () => {
  assert.equal(sowS3Key(2026, "FALL", "abc", "pdf"), "sows/2026-FALL/abc.pdf");
});

test("leadership means the Leadership subteam; members include every subteam", () => {
  assert.equal(isProjectLeadership(TEAM, LEAD_PK), true);
  assert.equal(isProjectLeadership(TEAM, ENGINEER_PK), false);
  assert.equal(isProjectMember(TEAM, ENGINEER_PK), true);
  assert.equal(isProjectMember(TEAM, STRANGER_PK), false);

  /* Team Owners (where the creating Project Lead is stored) count as leadership. */
  assert.equal(isProjectLeadership({ users: [{ pk: 7 }] }, 7), true);
  /* Older teams named the subteam "<Project>Lead". */
  const legacy = { subteams: [{ attributes: { friendlyName: "StudyBuddyLead" }, users: [{ pk: 8 }] }] };
  assert.equal(isProjectLeadership(legacy, 8), true);

  const deleted = {
    subteams: [{ ...TEAM.subteams[0], attributes: { friendlyName: "Leadership", flaggedForDeletion: true } }],
  };
  assert.equal(isProjectLeadership(deleted, LEAD_PK), false);
});

/* ---------- upload flow ---------- */

test("the project lead can upload a PDF, and it is fingerprinted", async () => {
  const controller = makeController();
  const sow = await uploadAs(controller, LEAD_PK, "sow.pdf", PDF_BYTES);

  assert.equal(sow.projectPk, PROJECT_PK);
  assert.equal(sow.seasonType, "FALL");
  assert.equal(sow.seasonYear, 2026);
  assert.equal(sow.contentType, "application/pdf");
  assert.equal(sow.uploadedBy, LEAD_PK);
  assert.equal(sow.uploadedByName, `User ${LEAD_PK}`);
  assert.equal(sow.sizeBytes, PDF_BYTES.length);
  assert.equal(sow.sha256, crypto.createHash("sha256").update(PDF_BYTES).digest("hex"));
  assert.equal(controller.statusCode, 201);
});

test("a DOCX is accepted too", async () => {
  const sow = await uploadAs(makeController(), LEAD_PK, "sow.docx", DOCX_BYTES);
  assert.equal(
    sow.contentType,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  );
});

test("a non-PDF/DOCX file name is refused before any upload link is made", async () => {
  await assert.rejects(
    () => makeController().getSowUploadUrl(sessionFor(LEAD_PK), PROJECT_PK, { fileName: "sow.exe" }),
    expectStatus(400)
  );
});

test("a renamed file is caught by its signature, refused and deleted", async () => {
  const controller = makeController();
  await assert.rejects(
    () => uploadAs(controller, LEAD_PK, "sow.pdf", EXE_BYTES),
    expectStatus(400)
  );
  assert.equal(controller.storage.objects.size, 0, "the bad file must be removed from storage");
  assert.equal(rows.length, 0, "nothing must be saved");
});

test("confirming without uploading anything is refused", async () => {
  await assert.rejects(
    () => makeController().confirmSowUpload(sessionFor(LEAD_PK), PROJECT_PK, { fileName: "sow.pdf" }),
    expectStatus(400)
  );
});

test("a second upload for the same semester gets 409", async () => {
  const controller = makeController();
  await uploadAs(controller, LEAD_PK, "sow.pdf", PDF_BYTES);

  await assert.rejects(
    () => controller.getSowUploadUrl(sessionFor(LEAD_PK), PROJECT_PK, { fileName: "v2.docx" }),
    expectStatus(409)
  );
  await assert.rejects(
    () => controller.confirmSowUpload(sessionFor(LEAD_PK), PROJECT_PK, { fileName: "sow.pdf" }),
    expectStatus(409)
  );
  assert.equal(rows.length, 1);
});

test("two confirms racing still give 409 (database unique index)", async () => {
  const controller = makeController();
  controller.storage.objects.set("sows/2026-FALL/proj-studybuddy.pdf", PDF_BYTES);
  const req = sessionFor(LEAD_PK);
  const results = await Promise.allSettled([
    controller.confirmSowUpload(req, PROJECT_PK, { fileName: "sow.pdf" }),
    controller.confirmSowUpload(req, PROJECT_PK, { fileName: "sow.pdf" }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const rejected = results.find((r) => r.status === "rejected");
  assert.equal(rejected.reason.status, 409);
});

test("an engineer (not leadership) gets 403 when uploading", async () => {
  const controller = makeController();
  await assert.rejects(
    () => controller.getSowUploadUrl(sessionFor(ENGINEER_PK), PROJECT_PK, { fileName: "sow.pdf" }),
    expectStatus(403)
  );
  await assert.rejects(
    () => controller.confirmSowUpload(sessionFor(ENGINEER_PK), PROJECT_PK, { fileName: "sow.pdf" }),
    expectStatus(403)
  );
});

test("an executive can upload for any project", async () => {
  const sow = await uploadAs(makeController(), EXEC_PK, "sow.pdf", PDF_BYTES);
  assert.equal(sow.uploadedBy, EXEC_PK);
});

test("an unknown project is a 404", async () => {
  await assert.rejects(
    () => makeController().getSowUploadUrl(sessionFor(EXEC_PK), "nope", { fileName: "sow.pdf" }),
    expectStatus(404)
  );
});

/* ---------- viewing and deleting ---------- */

test("members see the SOW with a download link; strangers get 403", async () => {
  const controller = makeController();
  await uploadAs(controller, LEAD_PK, "sow.pdf", PDF_BYTES);

  const view = await controller.getProjectSow(sessionFor(ENGINEER_PK), PROJECT_PK);
  assert.equal(view.sow.fileName, "sow.pdf");
  assert.match(view.sow.downloadUrl, /signed=1/);
  assert.equal(view.canUpload, false);
  assert.equal(view.canDelete, false);

  await assert.rejects(
    () => controller.getProjectSow(sessionFor(STRANGER_PK), PROJECT_PK),
    expectStatus(403)
  );
});

test("before any upload, only leadership is offered the upload button", async () => {
  const controller = makeController();
  const lead = await controller.getProjectSow(sessionFor(LEAD_PK), PROJECT_PK);
  const engineer = await controller.getProjectSow(sessionFor(ENGINEER_PK), PROJECT_PK);
  assert.equal(lead.sow, null);
  assert.equal(lead.canUpload, true);
  assert.equal(engineer.canUpload, false);
});

test("only an executive can delete, which allows a corrected upload", async () => {
  const controller = makeController();
  await uploadAs(controller, LEAD_PK, "old-draft.pdf", PDF_BYTES);

  await assert.rejects(
    () => controller.deleteProjectSow(sessionFor(LEAD_PK), PROJECT_PK),
    expectStatus(403)
  );

  await controller.deleteProjectSow(sessionFor(EXEC_PK), PROJECT_PK);
  assert.equal(rows.length, 0);
  assert.equal(controller.storage.objects.size, 0);

  const fixed = await uploadAs(controller, LEAD_PK, "final.docx", DOCX_BYTES);
  assert.equal(fixed.fileName, "final.docx");
});

/* ---------- Horizon service endpoint ---------- */

test("the Horizon token must match exactly, and an unset token refuses everyone", () => {
  assert.equal(isHorizonServiceAuthorized("Bearer s3cret", "s3cret"), true);
  assert.equal(isHorizonServiceAuthorized("Bearer wrong", "s3cret"), false);
  assert.equal(isHorizonServiceAuthorized("s3cret", "s3cret"), false);
  assert.equal(isHorizonServiceAuthorized(undefined, "s3cret"), false);
  assert.equal(isHorizonServiceAuthorized("Bearer ", ""), false);
  assert.equal(isHorizonServiceAuthorized("Bearer anything", undefined), false);
});

test("the horizon security scheme rejects requests without the token with 401", async () => {
  const request = (authorization) => ({ get: () => authorization, session: {} });
  const previous = process.env.HORIZON_SERVICE_TOKEN;
  try {
    process.env.HORIZON_SERVICE_TOKEN = "s3cret";
    assert.equal(await expressAuthentication(request("Bearer s3cret"), "horizon"), true);
    await assert.rejects(() => expressAuthentication(request(undefined), "horizon"), expectStatus(401));
    await assert.rejects(() => expressAuthentication(request("Bearer nope"), "horizon"), expectStatus(401));

    delete process.env.HORIZON_SERVICE_TOKEN;
    await assert.rejects(() => expressAuthentication(request("Bearer s3cret"), "horizon"), expectStatus(401));
  } finally {
    if (previous === undefined) delete process.env.HORIZON_SERVICE_TOKEN;
    else process.env.HORIZON_SERVICE_TOKEN = previous;
  }
});

test("Horizon lists one semester's SOWs with download links", async () => {
  const controller = makeController();
  await uploadAs(controller, LEAD_PK, "sow.pdf", PDF_BYTES);
  rows.push({ ...rows[0], _id: "other", projectPk: "older", seasonType: "SPRING" });

  const horizon = new HorizonSowController();
  horizon.storage = controller.storage;
  const list = await horizon.listSemesterSows("FALL", 2026);

  assert.equal(list.length, 1);
  assert.equal(list[0].projectPk, PROJECT_PK);
  assert.ok(list[0].sha256);
  assert.match(list[0].downloadUrl, /signed=1/);
});
