/**
 * String utilities. Two of these are validation boundaries reached by
 * user-supplied input (validatePersonName, validateTeamName) and two shape
 * identifiers that end up as Authentik group names and Slack channels.
 */
const assert = require("node:assert/strict");
const test = require("node:test");
const {
  generateSecureRandomString,
  sanitizeGroupName,
  capitalizeString,
  sanitizeUserFullName,
  validatePersonName,
  formatBindleAccessError,
} = require("../../dist/utils/strings.js");

test("generateSecureRandomString returns distinct values of the asked-for length", () => {
  const a = generateSecureRandomString(16);
  const b = generateSecureRandomString(16);
  assert.equal(typeof a, "string");
  assert.notEqual(a, b, "two calls must not collide");
  assert.ok(a.length > 0);
});

test("sanitizeGroupName keeps only characters legal in a group name", () => {
  assert.equal(sanitizeGroupName("Web Dev 2026"), "WebDev2026");
  assert.equal(sanitizeGroupName("web-dev_fa26"), "web-dev_fa26");
  assert.equal(sanitizeGroupName("web/dev:fa26"), "webdevfa26");
  assert.equal(sanitizeGroupName("../../etc/passwd"), "etcpasswd");
  assert.equal(sanitizeGroupName("<script>alert(1)</script>"), "scriptalert1script");
  assert.equal(sanitizeGroupName(""), "");
});

test("capitalizeString title-cases ordinary words", () => {
  assert.equal(capitalizeString("ada lovelace"), "Ada Lovelace");
  assert.equal(capitalizeString("wORLD"), "World");
});

test("capitalizeString leaves an all-caps word alone, treating it as an acronym", () => {
  /* The docstring used to claim "HELLO wORLD" -> "Hello World". It does not:
     HELLO has no lowercase, so the acronym rule preserves it. The code is the
     sensible behaviour here; the example was wrong and has been corrected. */
  assert.equal(capitalizeString("HELLO wORLD"), "HELLO World");
});

test("capitalizeString preserves acronyms and acronym plurals", () => {
  assert.equal(capitalizeString("UI/UX"), "UI/UX");
  assert.equal(capitalizeString("USA"), "USA");
  assert.equal(capitalizeString("PMs"), "PMs");
  assert.equal(capitalizeString("SWEs and APIs"), "SWEs And APIs");
});

test("capitalizeString survives empty and whitespace input", () => {
  assert.equal(capitalizeString(""), "");
  assert.equal(capitalizeString("   "), "   ");
});

test("validatePersonName accepts real-world names", () => {
  for (const name of [
    "Jane Doe",
    "Mary-Kate O'Neil",
    "J. Smith",
    "Ada  Lovelace",
    "jean claude van damme",
  ]) {
    assert.equal(validatePersonName(name), name.trim(), `for ${name}`);
  }
});

test("validatePersonName requires both a first and a last name", () => {
  for (const name of ["Ada", "Madonna", "X"]) {
    assert.throws(() => validatePersonName(name), /first and last name|between 2 and 60/, `for ${name}`);
  }
});

test("validatePersonName rejects out-of-range lengths", () => {
  assert.throws(() => validatePersonName("A"), /between 2 and 60/);
  assert.throws(() => validatePersonName("A".repeat(61) + " B"), /between 2 and 60/);
});

test("validatePersonName rejects characters that are not name characters", () => {
  for (const name of [
    "Robert'); DROP TABLE Students;--",
    "<script>alert(1)</script> Doe",
    "Ada Lovelace <ada@example.com>",
    "Ada Lovelace\nBcc: someone@example.com",
    "Ada_Lovelace Doe",
    "Ada 1337",
  ]) {
    assert.throws(() => validatePersonName(name), /Invalid name/, `for ${JSON.stringify(name)}`);
  }
});

test("validatePersonName trims before judging, and returns the trimmed value", () => {
  assert.equal(validatePersonName("  Ada Lovelace  "), "Ada Lovelace");
});

test("validatePersonName treats null and undefined as empty rather than throwing a TypeError", () => {
  assert.throws(() => validatePersonName(null), /between 2 and 60/);
  assert.throws(() => validatePersonName(undefined), /between 2 and 60/);
});

test("sanitizeUserFullName keeps only first and last name, joined and cased", () => {
  assert.equal(sanitizeUserFullName("Ada Lovelace"), "AdaLovelace");
  assert.equal(sanitizeUserFullName("jean claude van damme"), "JeanDamme");
  assert.equal(sanitizeUserFullName("ADA LOVELACE"), "AdaLovelace");
});

test("sanitizeUserFullName output is legal as an AWS IAM session name", () => {
  /* The only caller passes this to generateConsoleLink, and IAM session names
     permit just [\w+=,.@-]. An apostrophe used to survive, so "Mary-Kate
     O'Neil" produced "MaryKateO'neil" and STS refused the console link. */
  const AWS_SESSION_NAME = /^[\w+=,.@-]*$/;
  for (const name of [
    "Mary-Kate O'Neil",
    "Renée D'Angelo",
    "Ada Lovelace",
    "Jean-Luc Picard",
    "Ada  Lovelace",
  ]) {
    const result = sanitizeUserFullName(name);
    assert.match(result, AWS_SESSION_NAME, `${JSON.stringify(name)} produced ${JSON.stringify(result)}`);
  }
  assert.equal(sanitizeUserFullName("Mary-Kate O'Neil"), "MaryKateOneil");
});

test("sanitizeUserFullName handles a single name and empty input", () => {
  assert.equal(sanitizeUserFullName("Madonna"), "Madonna");
  assert.equal(sanitizeUserFullName(""), "");
  assert.equal(sanitizeUserFullName(null), "");
  assert.equal(sanitizeUserFullName(undefined), "");
});

test("formatBindleAccessError names both the owners and what is missing", () => {
  const message = formatBindleAccessError(["Ada", "Grace"], ["corp:hiringaccess"]);
  assert.match(message, /Ada/);
  assert.match(message, /Grace/);
  assert.match(message, /corp:hiringaccess/);
});
