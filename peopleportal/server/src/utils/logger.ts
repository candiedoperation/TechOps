/**
  People Portal Server
  Copyright (C) 2026  Atheesh Thirumalairajan

  This program is free software: you can redistribute it and/or modify
  it under the terms of the GNU General Public License as published by
  the Free Software Foundation, either version 3 of the License, or
  (at your option) any later version.

  This program is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
  GNU General Public License for more details.

  You should have received a copy of the GNU General Public License
  along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { AsyncLocalStorage } from "async_hooks";
import { randomUUID } from "crypto";
import type { NextFunction, Request, Response } from "express";
import loglevel from "loglevel";
import pino, { type DestinationStream, type Logger } from "pino";
import {
    ENVIRONMENT,
    isProduction,
    isTest,
    loadEnvironmentFiles,
} from "../config/environment";

/* Imports are hoisted above app.ts's own env loading, so make sure LOG_LEVEL
   from the .env files is visible before we read it. Loading is idempotent. */
loadEnvironmentFiles();

const LEVELS = ["trace", "debug", "info", "warn", "error", "fatal", "silent"];

/**
 * LOG_LEVEL picks how chatty the server is. Unset means "info", except under
 * test where the default is "silent" so test output stays readable.
 */
export function resolveLogLevel(raw = process.env.LOG_LEVEL): string {
    const wanted = raw?.trim().toLowerCase();
    if (wanted && LEVELS.includes(wanted)) return wanted;
    return isTest ? "silent" : "info";
}

/**
 * Production writes one JSON object per line so logs can be searched and
 * filtered by field. Everywhere else gets readable, colourised output through
 * pino-pretty (a devDependency, so it is simply skipped if absent).
 */
function createDestination(): DestinationStream | undefined {
    if (isProduction || isTest) return undefined;
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const pretty = require("pino-pretty");
        return pretty({ colorize: true, ignore: "pid,hostname" });
    } catch {
        return undefined;
    }
}

/**
 * Errors are logged as type, message, stack and (for HTTP failures) the status.
 * Axios and similar errors also carry the whole request - headers with bearer
 * tokens, bodies with passwords - so those properties are dropped, not logged.
 */
export function serializeError(err: unknown): unknown {
    const base = pino.stdSerializers.err(err as Error) as Record<
        string,
        unknown
    >;
    if (!base || typeof base !== "object") return base;
    for (const key of ["config", "request", "response", "headers", "toJSON"])
        delete base[key];
    const status = (err as { response?: { status?: number } })?.response
        ?.status;
    if (typeof status === "number") base.status = status;
    return base;
}

/* Each key is covered at the top level and one level down: pino's "*.x" only
   matches nested keys, so a bare { password } would otherwise slip through. */
const SENSITIVE_KEYS = [
    "token",
    "accessToken",
    "refreshToken",
    "secret",
    "password",
];
export const REDACT = {
    paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        ...SENSITIVE_KEYS,
        ...SENSITIVE_KEYS.map((key) => `*.${key}`),
    ],
    censor: "[redacted]",
};

const level = resolveLogLevel();

/** The request currently being served, so any log line can be tied back to it. */
const requestContext = new AsyncLocalStorage<{ id: string; req: Request }>();

export const logger: Logger = pino(
    {
        level,
        base: { env: ENVIRONMENT },
        /* Anything logged while a request is in flight (controllers, clients,
           the error handler) automatically carries its request id and user. */
        mixin() {
            const ctx = requestContext.getStore();
            if (!ctx) return {};
            return {
                requestId: ctx.id,
                userId: ctx.req.session?.authorizedUser?.pk,
            };
        },
        /* Errors passed as { err } are expanded into type, message and stack. */
        serializers: { err: serializeError },
        /* Never let credentials reach a log line, whatever gets logged. */
        redact: REDACT,
    },
    createDestination(),
);

/* A few clients still log through loglevel. Drive it from the same LOG_LEVEL so
   there is a single knob, instead of a hardcoded level in app.ts. */
loglevel.setLevel(
    (level === "fatal"
        ? "error"
        : level) as loglevel.LogLevelDesc /* pino and loglevel share names */,
);

/** Request augmentation: every request carries an id. */
declare module "express-serve-static-core" {
    interface Request {
        id: string;
    }
}

/**
 * Logs one line per request when it finishes: method, route, status, duration
 * and user id. The route is the matched pattern (/teams/:teamId), not the raw
 * URL, so query strings and ids never end up in the message and the field
 * stays searchable. The request id is returned in X-Request-Id and is added to
 * every log line written while the request is in flight, which ties error lines
 * to the request that produced them.
 *
 * Register this before every other middleware so timing covers all of them.
 */
export function requestLogger(
    req: Request,
    res: Response,
    next: NextFunction,
): void {
    const start = process.hrtime.bigint();
    req.id = randomUUID();
    res.setHeader("X-Request-Id", req.id);

    res.on("finish", () => {
        const route = req.route?.path
            ? `${req.baseUrl}${req.route.path}`
            : undefined;
        const fields = {
            requestId: req.id,
            method: req.method,
            route: route ?? "(unmatched)",
            status: res.statusCode,
            durationMs: Number(process.hrtime.bigint() - start) / 1e6,
            userId: req.session?.authorizedUser?.pk,
        };

        /* Static assets and the SPA fallback match no API route; keep their
           successful hits out of the way at debug. */
        if (res.statusCode >= 500) logger.error(fields, "request failed");
        else if (res.statusCode >= 400) logger.warn(fields, "request rejected");
        else if (!route) logger.debug(fields, "request completed");
        else logger.info(fields, "request completed");
    });

    requestContext.run({ id: req.id, req }, next);
}

/**
 * Flattens a Map of named failures into { name: message } so it logs as
 * structured fields rather than an opaque Map dump.
 */
export function errorMap(errors: Map<string, Error>): Record<string, string> {
    return Object.fromEntries(
        [...errors].map(([name, error]) => [name, error.message]),
    );
}
