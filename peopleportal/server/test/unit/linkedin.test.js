/**
 * LinkedIn profile URL normalisation.
 *
 * This is a validation boundary, not a formatter: the value is stored on a
 * profile and later rendered as a link other members click. Anything that is
 * not unmistakably a LinkedIn profile must come back null.
 */
const assert = require("node:assert/strict");
const test = require("node:test");
const { normalizeLinkedInProfileUrl } = require("../../dist/utils/linkedin.js");

test("normalises accepted profile URLs to the canonical form", () => {
  const canonical = "https://www.linkedin.com/in/ada-lovelace";
  for (const input of [
    "https://www.linkedin.com/in/ada-lovelace",
    "https://linkedin.com/in/ada-lovelace",
    "https://www.linkedin.com/in/ada-lovelace/",
    "https://www.linkedin.com/in/ada-lovelace?trk=public",
    "https://WWW.LINKEDIN.COM/in/ada-lovelace",
  ]) {
    assert.equal(normalizeLinkedInProfileUrl(input), canonical, `for ${input}`);
  }
});

test("rejects any scheme other than https", () => {
  for (const input of [
    "http://www.linkedin.com/in/ada-lovelace",
    "javascript:alert(1)//linkedin.com/in/x",
    "ftp://www.linkedin.com/in/ada-lovelace",
    "data:text/html,<script>alert(1)</script>",
  ]) {
    assert.equal(normalizeLinkedInProfileUrl(input), null, `for ${input}`);
  }
});

test("rejects lookalike and attacker-controlled hosts", () => {
  for (const input of [
    "https://linkedin.com.evil.example/in/ada",
    "https://evil.example/in/ada",
    "https://notlinkedin.com/in/ada",
    "https://www.linkedin.com.evil.example/in/ada",
    "https://linkedin.evil.example/in/ada",
  ]) {
    assert.equal(normalizeLinkedInProfileUrl(input), null, `for ${input}`);
  }
});

test("rejects embedded credentials and explicit ports", () => {
  for (const input of [
    "https://user@www.linkedin.com/in/ada",
    "https://user:pass@www.linkedin.com/in/ada",
    "https://www.linkedin.com:8443/in/ada",
  ]) {
    assert.equal(normalizeLinkedInProfileUrl(input), null, `for ${input}`);
  }
});

test("rejects non-profile paths on the real host", () => {
  for (const input of [
    "https://www.linkedin.com/",
    "https://www.linkedin.com/company/anthropic",
    "https://www.linkedin.com/feed/",
    "https://www.linkedin.com/in/",
  ]) {
    assert.equal(normalizeLinkedInProfileUrl(input), null, `for ${input}`);
  }
});

test("treats blank input as clearing the field, not as invalid", () => {
  /* "" is the stored value meaning "no LinkedIn on file"; null means the
     input was rejected. The distinction matters to the caller, which writes
     one and refuses the other. */
  assert.equal(normalizeLinkedInProfileUrl(""), "");
  assert.equal(normalizeLinkedInProfileUrl("   "), "");
});

test("rejects input that is not a URL at all", () => {
  for (const input of ["ada-lovelace", "not a url", "https://", "http://"]) {
    assert.equal(normalizeLinkedInProfileUrl(input), null, `for ${JSON.stringify(input)}`);
  }
});

test("accepts a scheme-less profile by assuming https, never http", () => {
  /* A bare host is prepended with https://, so someone pasting from the
     address bar still works, and downgrading to http is not reachable. */
  assert.equal(
    normalizeLinkedInProfileUrl("www.linkedin.com/in/ada-lovelace"),
    "https://www.linkedin.com/in/ada-lovelace"
  );
  assert.equal(
    normalizeLinkedInProfileUrl("linkedin.com/in/ada-lovelace"),
    "https://www.linkedin.com/in/ada-lovelace"
  );
  /* The prepend must not rescue a lookalike host. */
  assert.equal(normalizeLinkedInProfileUrl("linkedin.com.evil.example/in/ada"), null);
});

test("rejects absurdly long input before parsing it", () => {
  assert.equal(normalizeLinkedInProfileUrl("https://www.linkedin.com/in/" + "a".repeat(400)), null);
});

test("a protocol-relative URL still resolves against the real host", () => {
  /* "//linkedin.com/in/ada" is valid protocol-relative input; the host check
     still applies, so this is accepted rather than being a bypass. */
  assert.equal(normalizeLinkedInProfileUrl("//linkedin.com/in/ada"), "https://www.linkedin.com/in/ada");
  assert.equal(normalizeLinkedInProfileUrl("//evil.example/in/ada"), null);
});

test("null and undefined clear the field rather than throwing", () => {
  /* OrgController calls this whenever body.linkedinUrl !== undefined, so an
     explicit JSON null arrives here. It used to throw a TypeError, which the
     route surfaced as a 500 instead of a 400. */
  assert.doesNotThrow(() => normalizeLinkedInProfileUrl(undefined));
  assert.doesNotThrow(() => normalizeLinkedInProfileUrl(null));
  assert.equal(normalizeLinkedInProfileUrl(null), "");
  assert.equal(normalizeLinkedInProfileUrl(undefined), "");
  assert.equal(normalizeLinkedInProfileUrl(12345), "");
});
