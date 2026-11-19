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

/**
 * Environment resolution, in the spirit of Django's settings modules.
 *
 * Files are layered lowest-priority first, so a value set in a more specific
 * file wins and nothing needs to be duplicated:
 *
 *     .env                     shared defaults, committed-adjacent
 *     .env.<environment>       per-environment overrides (.env.development, ...)
 *     .env.<environment>.local your machine only, gitignored
 *
 * Anything already present in the real process environment always wins over all
 * of them, so container and CI variables are never clobbered by a stray file.
 */

import fs from "fs";
import path from "path";
import dotenv from "dotenv";

export type NodeEnvironment = "development" | "test" | "production";

const VALID_ENVIRONMENTS: NodeEnvironment[] = ["development", "test", "production"];

function resolveEnvironment(): NodeEnvironment {
    const raw = (process.env.NODE_ENV ?? "development").toLowerCase();
    if (!VALID_ENVIRONMENTS.includes(raw as NodeEnvironment)) {
        throw new Error(
            `NODE_ENV must be one of ${VALID_ENVIRONMENTS.join(", ")} (received "${raw}")`
        );
    }
    return raw as NodeEnvironment;
}

export const ENVIRONMENT: NodeEnvironment = resolveEnvironment();
export const isDevelopment = ENVIRONMENT === "development";
export const isTest = ENVIRONMENT === "test";
export const isProduction = ENVIRONMENT === "production";

/** Loads the .env layers for the active environment. Safe to call twice. */
export function loadEnvironmentFiles(cwd: string = process.cwd()): string[] {
    const candidates = [
        ".env",
        `.env.${ENVIRONMENT}`,
        `.env.${ENVIRONMENT}.local`,
    ];

    const loaded: string[] = [];
    for (const candidate of candidates) {
        const file = path.resolve(cwd, candidate);
        if (!fs.existsSync(file)) continue;
        /* override:false keeps the real process environment authoritative and
           makes the layering order above meaningful. */
        dotenv.config({ path: file, override: false, quiet: true });
        loaded.push(candidate);
    }
    return loaded;
}

/**
 * Variables without which the server cannot serve a real request. Checked only
 * outside development and test so a contributor can boot a partial stack, while
 * production still fails fast and loudly rather than at the first request.
 */
const REQUIRED_IN_PRODUCTION = [
    "PEOPLEPORTAL_BASE_URL",
    "PEOPLEPORTAL_MONGO_URL",
    "PEOPLEPORTAL_TOKEN_SECRET",
    "PEOPLEPORTAL_OIDC_DSCVURL",
    "PEOPLEPORTAL_OIDC_CLIENTID",
    "PEOPLEPORTAL_OIDC_CLIENTSECRET",
    "PEOPLEPORTAL_AUTHENTIK_ENDPOINT",
    "PEOPLEPORTAL_AUTHENTIK_TOKEN",
] as const;

/** Present-but-empty is as broken as absent, and much harder to spot. */
function isBlank(value: string | undefined): boolean {
    return value === undefined || value.trim() === "";
}

export function assertRequiredEnvironment(): void {
    if (!isProduction) return;

    const missing = REQUIRED_IN_PRODUCTION.filter((key) => isBlank(process.env[key]));
    if (missing.length > 0) {
        throw new Error(
            `Missing required environment variables in production: ${missing.join(", ")}`
        );
    }

    if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
        throw new Error(
            "NODE_TLS_REJECT_UNAUTHORIZED=0 disables all TLS verification and must not be set in production"
        );
    }
}

/** Reads a boolean flag; only an explicit "true" enables it. */
export function envFlag(key: string, fallback = false): boolean {
    const raw = process.env[key];
    if (isBlank(raw)) return fallback;
    return raw!.trim().toLowerCase() === "true";
}

/** Reads an integer, falling back when unset or unparseable. */
export function envInt(key: string, fallback: number): number {
    const raw = process.env[key];
    if (isBlank(raw)) return fallback;
    const parsed = Number.parseInt(raw!, 10);
    return Number.isNaN(parsed) ? fallback : parsed;
}

/** Reads a variable that must exist, with a message naming the caller's need. */
export function envRequired(key: string): string {
    const raw = process.env[key];
    if (isBlank(raw)) {
        throw new Error(`Required environment variable ${key} is not set`);
    }
    return raw!;
}
