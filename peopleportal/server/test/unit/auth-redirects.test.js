/**
 * AuthController helpers: post-login redirect resolution and the applicant
 * view of an application. Both are pure so they can be checked without a
 * session or a database.
 */
const assert = require("node:assert/strict");
const test = require("node:test");
const {
    resolveSameOriginPath,
    toApplicantApplication,
} = require("../../dist/controllers/AuthController.js");

const ORIGIN = "https://portal.example.com";

/* ── resolveSameOriginPath ──────────────────────────────────────────────── */
test("a single-slash relative path is kept with its query and fragment", () => {
    assert.equal(resolveSameOriginPath("/", ORIGIN), "/");
    assert.equal(resolveSameOriginPath("/ats/apply", ORIGIN), "/ats/apply");
    assert.equal(
        resolveSameOriginPath("/api/docs?x=1#frag", ORIGIN),
        "/api/docs?x=1#frag",
    );
});

test("an absolute URL on the same origin is reduced to its path", () => {
    assert.equal(
        resolveSameOriginPath(
            `${ORIGIN}/api/docs/oauth2-redirect?state=abc`,
            ORIGIN,
        ),
        "/api/docs/oauth2-redirect?state=abc",
    );
});

test("targets on another origin are rejected", () => {
    for (const target of [
        "https://evil.example/",
        "http://portal.example.com/", // scheme differs
        "https://portal.example.com.evil.example/",
        "https://portal.example.com:8443/",
    ]) {
        assert.equal(resolveSameOriginPath(target, ORIGIN), undefined, target);
    }
});

test("protocol-relative and backslash forms are rejected", () => {
    for (const target of [
        "//evil.example",
        "//evil.example/path",
        "/\\evil.example",
        "\\\\evil.example",
        "/\\/evil.example",
        "///evil.example",
    ]) {
        assert.equal(resolveSameOriginPath(target, ORIGIN), undefined, target);
    }
});

test("non-http schemes and unparsable values are rejected", () => {
    for (const target of [
        "javascript:alert(1)",
        "data:text/html,hi",
        "mailto:someone@example.com",
        "http://[::1",
    ]) {
        assert.equal(resolveSameOriginPath(target, ORIGIN), undefined, target);
    }
});

test("empty, undefined, and a bad origin yield undefined", () => {
    assert.equal(resolveSameOriginPath(undefined, ORIGIN), undefined);
    assert.equal(resolveSameOriginPath("", ORIGIN), undefined);
    assert.equal(resolveSameOriginPath("/ok", "not a url"), undefined);
});

/* ── toApplicantApplication ─────────────────────────────────────────────── */
test("only applicant-facing fields are returned", () => {
    const view = toApplicantApplication({
        _id: "abc",
        applicantId: "owner",
        teamPk: "team-1",
        teamName: "Platform",
        rolePreferences: [
            {
                role: "Engineer",
                subteamPk: "sub-1",
                subteamName: "Infra",
                _id: "p1",
            },
        ],
        stage: "Interview",
        appliedAt: new Date("2026-01-02T00:00:00Z"),
        responses: { "Why?": "Because" },
        hiredRole: "Engineer",
        hiredSubteamPk: "sub-1",
        stageHistory: [
            {
                stage: "Applied",
                changedAt: new Date(),
                changedBy: "lead@example.com",
            },
        ],
        stars: 4,
        notes: "internal remarks",
        appDevInternalPk: 99,
        createdAt: new Date(),
        updatedAt: new Date(),
        __v: 0,
    });

    assert.deepEqual(Object.keys(view).sort(), [
        "_id",
        "appliedAt",
        "hiredRole",
        "hiredSubteamPk",
        "responses",
        "rolePreferences",
        "stage",
        "teamName",
        "teamPk",
    ]);
    assert.deepEqual(view.rolePreferences, [
        { role: "Engineer", subteamPk: "sub-1", subteamName: "Infra" },
    ]);
    assert.equal(view.teamName, "Platform");
    assert.equal(view.stage, "Interview");
    assert.deepEqual(view.responses, { "Why?": "Because" });
});

test("missing optional collections default to empty", () => {
    const view = toApplicantApplication({
        _id: "x",
        teamPk: "t",
        stage: "Applied",
    });
    assert.deepEqual(view.rolePreferences, []);
    assert.deepEqual(view.responses, {});
});
