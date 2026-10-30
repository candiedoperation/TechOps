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
 * Seeds fake Applicants + Applications against whichever subteam(s) are
 * currently recruiting, for local ATS/recruiting testing.
 *
 * Unlike scripts/seed.ts, this writes directly to MongoDB and S3 instead of
 * going through the HTTP API. That's a deliberate exception to this repo's
 * API-first seeding convention: the applicant OTP flow stores its one-time
 * code in `req.session.tempsession`, and sessions are an in-process
 * `expressSession.MemoryStore` (see app.ts), not Redis or Mongo. An external
 * script has no way to read back a code the server only logged/emailed to
 * itself, so driving 20 real signups through /api/auth/otpinit would mean
 * scraping server stdout. Writing the two flat Applicant/Application
 * collections directly is the pragmatic alternative -- both schemas are
 * simple and were read directly from src/models before writing this, so
 * drift risk is low, and this only ever targets a local dev database.
 *
 * Each seeded applicant also gets a REAL resume object uploaded to
 * `resumes/<applicantId>.pdf` in S3 (the same key format ATSController
 * expects), using whatever PDF RESUME_PDF_PATH points at, so the recruiter's
 * actual "download resume" button works against this seed data too.
 *
 *   npx tsx scripts/seed-ats-applicants.ts [count]
 *   nx run pplserver:seed-ats [-- count]
 *
 * Requires (already in .env for this project):
 *   PEOPLEPORTAL_MONGO_URL
 *   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION, S3_BUCKET_NAME
 * And requires at least one team to already have isRecruiting=true with a
 * subteam config that has roles configured (set this up via the
 * /org/teams/:teamId/recruitment page first -- this script finds whichever
 * team is recruiting, it does not create one).
 */

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import mongoose from "mongoose";
import fs from "fs";

import { loadEnvironmentFiles, isProduction } from "../src/config/environment";
loadEnvironmentFiles();

import { Applicant } from "../src/models/Applicant";
import { Application, ApplicationStage } from "../src/models/Application";
import { TeamRecruitingStatus } from "../src/models/TeamRecruitingStatus";
import { SubteamConfig } from "../src/models/SubteamConfig";

const COUNT = Number(process.argv[2] ?? 20);

const RESUME_PDF_PATH =
    process.env.SEED_RESUME_PDF ??
    "/Users/aditswami/.cursor/projects/Users-aditswami-projects-app-dev-TechOps/attachments/d079c193-3405-4c52-9b09-c75b3a127580/Testudo_-_Unofficial_Transcript.pdf";

/* Just for varied, readable fixture names -- not meant to be exhaustive. */
const FIRST_NAMES = ["Ada", "Grace", "Alan", "Katherine", "Barbara", "Margaret", "Tim", "Linus", "Donald", "Edsger", "Radia", "Vint", "Dennis", "Ken", "Brian", "Steve", "Bill", "Lynn", "Frances", "Hedy"];
const LAST_NAMES = ["Lovelace", "Hopper", "Turing", "Johnson", "Liskov", "Hamilton", "Berners-Lee", "Torvalds", "Knuth", "Dijkstra", "Perlman", "Cerf", "Ritchie", "Thompson", "Kernighan", "Wozniak", "Gates", "Conway", "Allen", "Lamarr"];

function nth<T>(arr: T[], i: number): T {
    return arr[i % arr.length];
}

async function main(): Promise<void> {
    if (isProduction) {
        throw new Error("Refusing to seed with NODE_ENV=production.");
    }

    const mongoUrl = process.env.PEOPLEPORTAL_MONGO_URL;
    if (!mongoUrl) throw new Error("PEOPLEPORTAL_MONGO_URL is not set.");
    await mongoose.connect(mongoUrl);

    const bucket = process.env.S3_BUCKET_NAME;
    if (!bucket) throw new Error("S3_BUCKET_NAME is not set -- resumes can't upload without it.");

    if (!fs.existsSync(RESUME_PDF_PATH)) {
        throw new Error(`Resume PDF not found at ${RESUME_PDF_PATH}. Set SEED_RESUME_PDF to override.`);
    }
    const resumeBytes = fs.readFileSync(RESUME_PDF_PATH);

    const s3 = new S3Client({
        region: process.env.AWS_REGION || "us-east-1",
        credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
        },
    });

    /* Find whatever's actually recruiting right now -- never hardcode a pk. */
    const teamStatus = await TeamRecruitingStatus.findOne({ isRecruiting: true }).lean();
    if (!teamStatus) {
        throw new Error(
            "No team has isRecruiting=true. Enable recruiting on a team's subteam " +
            "via /org/teams/:teamId/recruitment first."
        );
    }

    const configs = await SubteamConfig.find({
        subteamPk: { $in: teamStatus.recruitingSubteamPks },
        isRecruiting: true,
    }).lean();

    const rolePool: { role: string; subteamPk: string }[] = [];
    for (const config of configs) {
        for (const role of config.roles) {
            rolePool.push({ role, subteamPk: config.subteamPk });
        }
    }

    if (rolePool.length === 0) {
        throw new Error(
            `Team ${teamStatus.teamPk} is recruiting but none of its recruiting subteams ` +
            `have roles configured yet. Add roles in the recruitment config UI first.`
        );
    }

    console.log(`team        : ${teamStatus.teamPk}`);
    console.log(`subteams    : ${configs.map((c) => c.subteamPk).join(", ")}`);
    console.log(`roles found : ${rolePool.map((r) => r.role).join(", ")}`);
    console.log(`resume      : ${RESUME_PDF_PATH} (${resumeBytes.length} bytes)`);
    console.log(`bucket      : ${bucket} (${process.env.AWS_REGION})\n`);

    let createdCount = 0;
    let skippedCount = 0;

    for (let i = 1; i <= COUNT; i++) {
        const first = nth(FIRST_NAMES, i - 1);
        const last = nth(LAST_NAMES, i - 1);
        const fullName = `${first} ${last}`;
        const email = `seed-applicant-${i}-${first.toLowerCase()}.${last.toLowerCase()}@example.com`;

        const existing = await Applicant.findOne({ email });
        if (existing) {
            const dupeApp = await Application.findOne({ applicantId: existing._id, teamPk: teamStatus.teamPk });
            if (dupeApp) {
                skippedCount++;
                console.log(`  exists   ${fullName.padEnd(20)} ${email}`);
                continue;
            }
        }

        const applicantId = existing?._id ?? new mongoose.Types.ObjectId();
        const resumeKey = `resumes/${applicantId}.pdf`;
        const profile = new Map(Object.entries({
            resumeUrl: resumeKey,
            whyAppDev: "Seeded for local ATS end-to-end testing.",
            instagramFollow: "yes",
        }));

        const applicant = existing
            ? await Applicant.findByIdAndUpdate(existing._id, { $set: { profile } }, { new: true })
            : await Applicant.create({ _id: applicantId, email, fullName, profile });

        /* Upload the same resume PDF for every seeded applicant, keyed exactly
           how ATSController expects it, so the recruiter's real "download
           resume" button works against seeded data instead of 404ing. */
        await s3.send(new PutObjectCommand({
            Bucket: bucket,
            Key: resumeKey,
            Body: resumeBytes,
            ContentType: "application/pdf",
        }));

        /* Spread across every open role/subteam instead of piling everyone
           onto the first one, so every column/role has something in it. */
        const pick = nth(rolePool, i - 1);

        const application = await Application.create({
            applicantId: applicant!._id,
            teamPk: teamStatus.teamPk,
            rolePreferences: [pick],
            stage: ApplicationStage.APPLIED,
            responses: {
                "Why are you interested in this team?": "Seeded response for local ATS testing.",
            },
            appliedAt: new Date(),
            stageHistory: [{ stage: ApplicationStage.APPLIED, changedAt: new Date() }],
        });

        await Applicant.findByIdAndUpdate(applicant!._id, { $push: { applicationIds: application._id } });

        createdCount++;
        console.log(`  created  ${fullName.padEnd(20)} ${email.padEnd(45)} role=${pick.role}`);
    }

    console.log(`\n${createdCount} created, ${skippedCount} skipped (already applied).`);
    console.log(`Open /org/teams/${teamStatus.teamPk}/recruitment in the webui to see them on the board.`);

    await mongoose.disconnect();
}

main().catch((e: unknown) => {
    console.error(`\nSeed failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
});
