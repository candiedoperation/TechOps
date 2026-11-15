/**
 * Loaded before every test file via --require.
 *
 * Importing almost any module transitively loads config.ts, which constructs
 * every shared-resource client at import time; those constructors read their
 * environment variables immediately. Loading .env.test first is what makes a
 * plain `require("../../dist/...")` work at all.
 */
require("dotenv").config({
    path: require("node:path").resolve(__dirname, "..", "..", ".env.test"),
    override: false,
    quiet: true,
});

process.env.NODE_ENV = "test";
