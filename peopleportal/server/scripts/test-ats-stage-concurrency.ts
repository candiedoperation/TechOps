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
 * Exercises ATSController.updateApplicationStage's concurrency behavior,
 * including the specific case this script exists to answer: two requests
 * racing to move the SAME application to two different (or the same)
 * destination stages at once.
 *
 * This hits the real HTTP API, unlike seed-ats-applicants.ts. The thing
 * under test IS the API's concurrency handling, so writing to Mongo
 * directly would bypass exactly the code path we're trying to observe.
 * Mongo is only read here, never written, to look up seeded fixtures and
 * to inspect the final persisted state after each race.
 *
 * AUTHENTICATION: same pattern as scripts/seed.ts, because
 * updateApplicationStage requires @Security("bindles", ["corp:hiringaccess"]),
 * which reads the session cookie, not a header. Sign in to the webui as
 * someone with hiring access on the recruiting team, copy the session
 * cookie (DevTools > Application > Cookies > peopleportal_sid), then:
 *
 *   PEOPLEPORTAL_SEED_COOKIE="peopleportal_sid=s%3A..." \
 *     npx tsx scripts/test-ats-stage-concurrency.ts
 *
 * Only ever touches Applicant docs whose email starts with "seed-applicant-"
 * (the fixtures seed-ats-applicants.ts creates), so this can never land on a
 * real candidate's application by accident. Run seed-ats-applicants.ts again
 * first if there aren't at least 6 of them still sitting in "Applied" --
 * that script skips anyone who already has an application, so re-running it
 * tops up fresh ones without disturbing what you've already moved by hand.
 */

import mongoose from "mongoose";

import { loadEnvironmentFiles, isProduction } from "../src/config/environment";
loadEnvironmentFiles();

import { Applicant } from "../src/models/Applicant";
import { Application, ApplicationStage } from "../src/models/Application";

const BASE_URL = (process.env.PEOPLEPORTAL_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const COOKIE =
    process.env.PEOPLEPORTAL_SEED_COOKIE ??
    process.argv.find((a) => a.startsWith("--cookie="))?.slice("--cookie=".length);

interface ApiResult {
    status: number;
    body: any;
}

async function api(method: string, route: string, body?: unknown): Promise<ApiResult> {
    const res = await fetch(`${BASE_URL}${route}`, {
        method,
        headers: {
            "Content-Type": "application/json",
            ...(COOKIE ? { Cookie: COOKIE } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: any;
    try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = text; }
    return { status: res.status, body: parsed };
}

function fmt(r: PromiseSettledResult<ApiResult>): string {
    if (r.status === "fulfilled") return `HTTP ${r.value.status} -> ${JSON.stringify(r.value.body)}`;
    return `THREW -> ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`;
}

const INTERVIEW_BODY = (n: number) => ({
    stage: ApplicationStage.INTERVIEW,
    interviewLink: `https://meet.example.com/seed-interview-${n}`,
    interviewGuidelines:
        "Please join five minutes early with your resume ready to discuss. This is a seeded test interview slot, not a real one.",
});

async function main(): Promise<void> {
    if (isProduction) {
        throw new Error("Refusing to run against NODE_ENV=production.");
    }
    if (!/localhost|127\.0\.0\.1|host\.docker\.internal/.test(BASE_URL)) {
        throw new Error(`PEOPLEPORTAL_BASE_URL (${BASE_URL}) is not local; refusing to run.`);
    }
    if (!COOKIE) {
        throw new Error(
            "No session cookie. Sign in to the webui as someone with hiring access on the " +
            "recruiting team, copy the session cookie, then:\n" +
            '  PEOPLEPORTAL_SEED_COOKIE="peopleportal_sid=s%3A..." npx tsx scripts/test-ats-stage-concurrency.ts'
        );
    }

    const mongoUrl = process.env.PEOPLEPORTAL_MONGO_URL;
    if (!mongoUrl) throw new Error("PEOPLEPORTAL_MONGO_URL is not set.");
    await mongoose.connect(mongoUrl);

    /* Only ever touch fixtures seed-ats-applicants.ts created. */
    const seededApplicants = await Applicant.find({ email: /^seed-applicant-/ }).lean();
    const seededIds = seededApplicants.map((a) => a._id);
    const byEmail = new Map(seededApplicants.map((a) => [String(a._id), a.email]));
    const nameOf = (app: any) => byEmail.get(String(app.applicantId)) ?? String(app.applicantId);

    const applications = await Application.find({
        applicantId: { $in: seededIds },
        stage: ApplicationStage.APPLIED,
    }).lean();

    if (applications.length < 6) {
        throw new Error(
            `Only found ${applications.length} seeded applications still in 'Applied'. Need at ` +
            `least 6 fresh ones -- run seed-ats-applicants.ts again (it tops up, skipping anyone ` +
            `who already has an application for this team).`
        );
    }

    const teamId = applications[0].teamPk;
    console.log(`team: ${teamId}`);
    console.log(`acting via session cookie against: ${BASE_URL}\n`);

    /* ---------------------------------------------------------------------
     * PHASE 1: move several DIFFERENT candidates through different stages
     * at the same time. These don't share a document, so this is the
     * baseline "does ordinary concurrent traffic work at all" check,
     * before phase 2/3 go looking for an actual race on one record.
     * ------------------------------------------------------------------- */
    console.log("PHASE 1: concurrent moves across different candidates\n");

    const [toInterview, toRejected, toPotentialHire, toHired] = applications.slice(0, 4);

    const phase1 = await Promise.allSettled([
        api("PUT", `/api/ats/applications/${teamId}/${toInterview._id}/stage`, INTERVIEW_BODY(1)),

        api("PUT", `/api/ats/applications/${teamId}/${toRejected._id}/stage`, {
            stage: ApplicationStage.REJECTED,
        }),

        (async () => {
            await api("PUT", `/api/ats/applications/${teamId}/${toPotentialHire._id}/stage`, INTERVIEW_BODY(2));
            return api("PUT", `/api/ats/applications/${teamId}/${toPotentialHire._id}/stage`, {
                stage: ApplicationStage.POTENTIAL_HIRE,
            });
        })(),

        (async () => {
            await api("PUT", `/api/ats/applications/${teamId}/${toHired._id}/stage`, INTERVIEW_BODY(3));
            const pref = toHired.rolePreferences[0];
            return api("PUT", `/api/ats/applications/${teamId}/${toHired._id}/stage`, {
                stage: ApplicationStage.HIRED,
                hiredRole: pref.role,
                hiredSubteamPk: pref.subteamPk,
            });
        })(),
    ]);

    const phase1Labels = [
        `${nameOf(toInterview)} -> Interview`,
        `${nameOf(toRejected)} -> Rejected`,
        `${nameOf(toPotentialHire)} -> Interview -> Potential Hire`,
        `${nameOf(toHired)} -> Interview -> Hired`,
    ];
    phase1.forEach((r, i) => console.log(`  ${phase1Labels[i].padEnd(45)} ${fmt(r)}`));

    /* ---------------------------------------------------------------------
     * PHASE 2: the actual question -- two requests racing on the SAME
     * application, targeting two DIFFERENT destination stages at once.
     * ------------------------------------------------------------------- */
    console.log("\nPHASE 2: two requests racing on the SAME application (Rejected vs Hired)\n");

    const raceTarget = applications[4];
    /* Put it in Interview first, sequentially, so both Rejected and Hired
       are simultaneously valid destinations when the race starts. */
    await api("PUT", `/api/ats/applications/${teamId}/${raceTarget._id}/stage`, INTERVIEW_BODY(4));

    const racePref = raceTarget.rolePreferences[0];
    const [raceA, raceB] = await Promise.allSettled([
        api("PUT", `/api/ats/applications/${teamId}/${raceTarget._id}/stage`, { stage: ApplicationStage.REJECTED }),
        api("PUT", `/api/ats/applications/${teamId}/${raceTarget._id}/stage`, {
            stage: ApplicationStage.HIRED,
            hiredRole: racePref.role,
            hiredSubteamPk: racePref.subteamPk,
        }),
    ]);

    console.log(`  candidate: ${nameOf(raceTarget)} (${raceTarget._id})`);
    console.log(`    request A (-> Rejected): ${fmt(raceA)}`);
    console.log(`    request B (-> Hired)   : ${fmt(raceB)}`);

    const afterRace = await Application.findById(raceTarget._id).lean();
    console.log(`    final persisted stage  : ${afterRace?.stage}`);
    console.log(`    stageHistory entries   : ${afterRace?.stageHistory.map((h) => h.stage).join(" -> ")}`);
    console.log(`    (check the server's console for how many of these actually sent an email)`);

    /* ---------------------------------------------------------------------
     * PHASE 3: two requests racing on the SAME application, targeting the
     * SAME destination stage -- does the applicant get double-emailed?
     * ------------------------------------------------------------------- */
    console.log("\nPHASE 3: two requests racing on the SAME application, SAME target (both -> Rejected)\n");

    const dupeTarget = applications[5];
    const [dupeA, dupeB] = await Promise.allSettled([
        api("PUT", `/api/ats/applications/${teamId}/${dupeTarget._id}/stage`, { stage: ApplicationStage.REJECTED }),
        api("PUT", `/api/ats/applications/${teamId}/${dupeTarget._id}/stage`, { stage: ApplicationStage.REJECTED }),
    ]);

    console.log(`  candidate: ${nameOf(dupeTarget)} (${dupeTarget._id})`);
    console.log(`    request A: ${fmt(dupeA)}`);
    console.log(`    request B: ${fmt(dupeB)}`);

    const afterDupe = await Application.findById(dupeTarget._id).lean();
    console.log(`    final persisted stage  : ${afterDupe?.stage}`);
    console.log(`    stageHistory entries   : ${afterDupe?.stageHistory.map((h) => h.stage).join(" -> ")}`);
    console.log(`    (two 'Rejected' entries here would mean the rejection email almost certainly went out twice)`);

    await mongoose.disconnect();
}

main().catch((e: unknown) => {
    console.error(`\nFailed: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
});
