/**
 * Integration coverage for the review-deletion authorization path against a
 * real MongoDB, because the defect it guards was an authorization bypass:
 *
 *   if (!executiveAuthVerify(req, [], true)) { throw 404 }
 *
 * executiveAuthVerify is async, so this negated a Promise. A Promise is always
 * truthy, the branch never ran, and with @Security("oidc") on the route any
 * authenticated user could delete any review of any person.
 */
const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const { UserReview } = require("../../dist/models/UserReview.js");
const { OrgController } = require("../../dist/controllers/OrgController.js");

const AUTHOR_PK = 5001;
const SUBJECT_PK = 5002;
const STRANGER_PK = 5003;

/* Shape matching what the OIDC layer puts on the session. */
const sessionFor = (pk, { superuser = false } = {}) => ({
  session: {
    authorizedUser: {
      pk,
      sub: `sub-${pk}`,
      username: `user${pk}`,
      email: `user${pk}@example.invalid`,
      name: `User ${pk}`,
      is_superuser: superuser,
      groups: [],
      attributes: {},
    },
  },
});

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
  await UserReview.deleteMany({});
});

async function seedReview() {
  return UserReview.create({
    userId: SUBJECT_PK,
    creatorId: AUTHOR_PK,
    teamId: "team-webdev-fa26",
    rating: 5,
    title: "Strong semester",
    content: "Shipped the events API and mentored two new members.",
  });
}

test("a stranger cannot delete someone else's review", async () => {
  const review = await seedReview();
  const controller = new OrgController();

  await assert.rejects(
    () => controller.deleteReview(sessionFor(STRANGER_PK), SUBJECT_PK, String(review._id)),
    (e) => {
      /* 404 rather than 403, so the endpoint never confirms the review exists. */
      assert.equal(e.status, 404);
      return true;
    },
    "an unrelated authenticated user must not be able to delete a review"
  );

  assert.ok(await UserReview.findById(review._id), "the review must still exist");
});

test("the author can delete their own review", async () => {
  const review = await seedReview();
  const controller = new OrgController();

  await controller.deleteReview(sessionFor(AUTHOR_PK), SUBJECT_PK, String(review._id));

  assert.equal(await UserReview.findById(review._id), null, "the review should be gone");
});

test("a superuser can delete another person's review", async () => {
  const review = await seedReview();
  const controller = new OrgController();

  await controller.deleteReview(
    sessionFor(STRANGER_PK, { superuser: true }),
    SUBJECT_PK,
    String(review._id)
  );

  assert.equal(await UserReview.findById(review._id), null);
});

test("a mismatched personId is refused, and refused as a 404", async () => {
  const review = await seedReview();
  const controller = new OrgController();

  await assert.rejects(
    () => controller.deleteReview(sessionFor(AUTHOR_PK), 999999, String(review._id)),
    (e) => {
      /* Was a 400 "User ID does not match", which leaked existence to anyone
         probing ids. Every rejection on this route now looks identical. */
      assert.equal(e.status, 404);
      return true;
    }
  );

  assert.ok(await UserReview.findById(review._id));
});

test("deleting a review that does not exist is a 404", async () => {
  const controller = new OrgController();
  const absent = new mongoose.Types.ObjectId();

  await assert.rejects(
    () => controller.deleteReview(sessionFor(AUTHOR_PK), SUBJECT_PK, String(absent)),
    (e) => e.status === 404
  );
});
