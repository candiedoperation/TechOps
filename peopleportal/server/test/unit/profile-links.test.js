/**
 * Applicant profile link checks.
 *
 * These values are stored on an application and later opened in a new tab by
 * a reviewer, so only an https URL on the expected host may pass.
 */
const assert = require("node:assert/strict");
const test = require("node:test");
const { isAllowedProfileLink } = require("../../dist/utils/profile-links.js");

test("accepts https LinkedIn URLs on linkedin.com and its subdomains", () => {
    for (const input of [
        "https://www.linkedin.com/in/ada-lovelace",
        "https://linkedin.com/in/ada-lovelace",
        "https://uk.linkedin.com/in/ada-lovelace",
        "https://WWW.LINKEDIN.COM/in/ada-lovelace",
        "  https://www.linkedin.com/in/ada-lovelace  ",
    ]) {
        assert.equal(
            isAllowedProfileLink(input, "linkedin"),
            true,
            `for ${input}`,
        );
    }
});

test("accepts https GitHub URLs on github.com and www.github.com only", () => {
    assert.equal(
        isAllowedProfileLink("https://github.com/ada", "github"),
        true,
    );
    assert.equal(
        isAllowedProfileLink("https://www.github.com/ada", "github"),
        true,
    );
    for (const input of [
        "https://gist.github.com/ada",
        "https://api.github.com/users/ada",
        "https://github.io/ada",
    ]) {
        assert.equal(
            isAllowedProfileLink(input, "github"),
            false,
            `for ${input}`,
        );
    }
});

test("rejects any scheme other than https", () => {
    for (const input of [
        "http://www.linkedin.com/in/ada-lovelace",
        "javascript:alert(1)//linkedin.com/in/x",
        "ftp://github.com/ada",
        "data:text/html,<script>alert(1)</script>",
        "//www.linkedin.com/in/ada",
    ]) {
        assert.equal(
            isAllowedProfileLink(input, "linkedin"),
            false,
            `for ${input}`,
        );
        assert.equal(
            isAllowedProfileLink(input, "github"),
            false,
            `for ${input}`,
        );
    }
});

test("rejects lookalike hosts", () => {
    for (const input of [
        "https://linkedin.com.evil.example/in/ada",
        "https://notlinkedin.com/in/ada",
        "https://evil.example/in/ada",
    ]) {
        assert.equal(
            isAllowedProfileLink(input, "linkedin"),
            false,
            `for ${input}`,
        );
    }
    for (const input of [
        "https://github.com.evil.example/ada",
        "https://notgithub.com/ada",
        "https://evil.example/github.com/ada",
    ]) {
        assert.equal(
            isAllowedProfileLink(input, "github"),
            false,
            `for ${input}`,
        );
    }
});

test("rejects embedded credentials and explicit ports", () => {
    for (const input of [
        "https://user@www.linkedin.com/in/ada",
        "https://user:pass@www.linkedin.com/in/ada",
        "https://www.linkedin.com:8443/in/ada",
    ]) {
        assert.equal(
            isAllowedProfileLink(input, "linkedin"),
            false,
            `for ${input}`,
        );
    }
});

test("does not let a LinkedIn URL pass as GitHub or vice versa", () => {
    assert.equal(
        isAllowedProfileLink("https://github.com/ada", "linkedin"),
        false,
    );
    assert.equal(
        isAllowedProfileLink("https://www.linkedin.com/in/ada", "github"),
        false,
    );
});

test("rejects blank, non-string and malformed input without throwing", () => {
    for (const input of [
        "",
        "   ",
        null,
        undefined,
        12345,
        "not a url",
        "https://",
    ]) {
        assert.doesNotThrow(() => isAllowedProfileLink(input, "linkedin"));
        assert.equal(
            isAllowedProfileLink(input, "linkedin"),
            false,
            `for ${JSON.stringify(input)}`,
        );
    }
});

test("rejects absurdly long input before parsing it", () => {
    assert.equal(
        isAllowedProfileLink(
            "https://www.linkedin.com/in/" + "a".repeat(600),
            "linkedin",
        ),
        false,
    );
});
