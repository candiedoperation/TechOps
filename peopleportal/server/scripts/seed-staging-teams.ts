/**
 * Copies team recruiting fixtures from this Mac's development stack to the
 * isolated People Portal staging environment.
 *
 * Teams are not MongoDB documents. Authentik owns the team hierarchy, while
 * MongoDB stores recruiting configuration keyed by Authentik UUIDs. This tool
 * therefore creates/matches the Authentik groups first, builds an old-to-new
 * UUID map, and only then upserts the two Mongo collections that configure
 * recruiting.
 *
 * The command is a dry run unless --apply is present:
 *
 *   PEOPLEPORTAL_SEED_COOKIE='peopleportal_sid=s%3A...' \
 *     ../../nx run pplserver:seed-staging-teams
 *
 *   PEOPLEPORTAL_SEED_COOKIE='peopleportal_sid=s%3A...' \
 *     ../../nx run pplserver:seed-staging-teams -- --team='AI Research Lab' --apply
 *
 * Required local services:
 *   - MongoDB at PEOPLEPORTAL_MONGO_URL
 *   - Authentik at PEOPLEPORTAL_AUTHENTIK_ENDPOINT
 *
 * Apply additionally requires key-based SSH to PEOPLEPORTAL_STAGING_SSH
 * (root@appdev00 by default). No records are deleted, and applicants,
 * applications, members, meetings, events, and invites are never copied.
 */

import { spawn } from "node:child_process";

import mongoose from "mongoose";

import { loadEnvironmentFiles } from "../src/config/environment";

loadEnvironmentFiles();

const DEFAULT_STAGING_URL = "https://appdev-corp.iancoutinho.net";
const DEFAULT_STAGING_SSH = "root@appdev00";
const ALLOWED_STAGING_HOST = "appdev-corp.iancoutinho.net";

interface Args {
    apply: boolean;
    selectedTeams: string[];
}

interface TeamAttributeDefinition {
    friendlyName: string;
    teamType: "PROJECT" | "CORPORATE" | "BOOTCAMP" | "SERVICE";
    seasonType: "FALL" | "SPRING" | "ROLLING";
    seasonYear: number;
    description: string;
    teamStartDate?: string;
    teamEndDate?: string;
    requestorRole?: string;
    [key: string]: unknown;
}

interface GetGroupInfoResponse {
    pk: string;
    name: string;
    parentPk: string | null;
    subteamPkList: string[];
    attributes: TeamAttributeDefinition;
}

interface TeamInformationBrief extends TeamAttributeDefinition {
    pk: string;
    name: string;
    parent: string | null;
}

interface RecruitingStatusDocument {
    teamPk: string;
    isRecruiting: boolean;
    recruitingSubteamPks: string[];
}

interface SubteamConfigDocument {
    subteamPk: string;
    isRecruiting: boolean;
    roles: string[];
    roleSpecificQuestions: Record<string, string[]>;
}

interface SourceTeam {
    root: GetGroupInfoResponse;
    subteams: GetGroupInfoResponse[];
    recruitingStatus: RecruitingStatusDocument;
    subteamConfigs: Map<string, SubteamConfigDocument>;
}

interface StagingTeamDetail {
    team: TeamInformationBrief;
    subteams: TeamInformationBrief[];
}

function parseArgs(argv: string[]): Args {
    const selectedTeams: string[] = [];
    let apply = false;

    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index]!;
        if (argument === "--apply") {
            apply = true;
            continue;
        }
        if (argument === "--team") {
            const value = argv[++index];
            if (!value) throw new Error("--team requires a team name");
            selectedTeams.push(value);
            continue;
        }
        if (argument.startsWith("--team=")) {
            const value = argument.slice("--team=".length);
            if (!value) throw new Error("--team requires a team name");
            selectedTeams.push(value);
            continue;
        }
        if (argument === "-h" || argument === "--help") {
            console.log(
                "Usage: nx run pplserver:seed-staging-teams -- [--team NAME ...] [--apply]\n" +
                "\nWithout --apply, prints the source and staging plan without changing data."
            );
            process.exit(0);
        }
        throw new Error(`Unknown argument: ${argument}`);
    }

    return { apply, selectedTeams };
}

function normalized(value: string | undefined): string {
    return (value ?? "").trim().toLocaleLowerCase();
}

function attributes(group: GetGroupInfoResponse): TeamAttributeDefinition {
    return group.attributes;
}

function groupLabel(group: GetGroupInfoResponse): string {
    return attributes(group).friendlyName || group.name;
}

function briefLabel(group: TeamInformationBrief): string {
    return group.friendlyName || group.name;
}

function identity(group: { name: string } & Partial<TeamAttributeDefinition>): string {
    return [
        normalized(group.friendlyName),
        group.teamType ?? "",
        group.seasonType ?? "",
        String(group.seasonYear ?? ""),
    ].join("|");
}

async function readLocalAuthentikGroups(pks: readonly string[]): Promise<Map<string, GetGroupInfoResponse>> {
    const endpoint = process.env.PEOPLEPORTAL_AUTHENTIK_ENDPOINT?.replace(/\/$/, "");
    const token = process.env.PEOPLEPORTAL_AUTHENTIK_TOKEN;
    if (!endpoint) throw new Error("PEOPLEPORTAL_AUTHENTIK_ENDPOINT is not set");
    if (!token) throw new Error("PEOPLEPORTAL_AUTHENTIK_TOKEN is not set");

    const wanted = new Set(pks);
    const groups = new Map<string, GetGroupInfoResponse>();
    let page = 1;
    let totalPages = 1;

    while (page <= totalPages && groups.size < wanted.size) {
        const params = new URLSearchParams({
            include_users: "false",
            include_children: "true",
            include_parents: "true",
            page: String(page),
            page_size: "1000",
        });
        const response = await fetch(`${endpoint}/api/v3/core/groups/?${params.toString()}`, {
            headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        });
        if (!response.ok) {
            throw new Error(`Local Authentik groups request failed with HTTP ${response.status}`);
        }
        const body = await response.json() as any;
        for (const entry of body.results ?? []) {
            if (!wanted.has(entry.pk)) continue;
            groups.set(entry.pk, {
                pk: entry.pk,
                name: entry.name,
                parentPk: entry.parent ?? entry.parents?.[0] ?? null,
                subteamPkList: entry.children ?? [],
                attributes: entry.attributes,
            });
        }
        totalPages = body.pagination?.total_pages ?? 1;
        page++;
    }
    return groups;
}

async function readSource(selectedNames: string[]): Promise<SourceTeam[]> {
    const mongoUrl = process.env.PEOPLEPORTAL_MONGO_URL;
    if (!mongoUrl) throw new Error("PEOPLEPORTAL_MONGO_URL is not set");

    const connection = mongoose.createConnection(mongoUrl, { serverSelectionTimeoutMS: 8_000 });
    try {
        await connection.asPromise();
        const statuses = await connection.collection<RecruitingStatusDocument>("teamrecruitingstatuses")
            .find({}, { projection: { _id: 0, teamPk: 1, isRecruiting: 1, recruitingSubteamPks: 1 } })
            .toArray();
        const configs = await connection.collection<SubteamConfigDocument>("subteamconfigs")
            .find({}, { projection: { _id: 0, subteamPk: 1, isRecruiting: 1, roles: 1, roleSpecificQuestions: 1 } })
            .toArray();

        if (statuses.length === 0) {
            throw new Error("Local MongoDB has no teamrecruitingstatuses to seed");
        }

        const rootsByPk = await readLocalAuthentikGroups(statuses.map((status) => status.teamPk));

        const missingRoots = statuses
            .map((status) => status.teamPk)
            .filter((pk) => !rootsByPk.has(pk));
        if (missingRoots.length > 0) {
            throw new Error(
                `Local Authentik is missing ${missingRoots.length} Mongo-referenced team(s): ${missingRoots.join(", ")}`
            );
        }

        const wantedNames = new Set(selectedNames.map(normalized));
        const selectedStatuses = statuses.filter((status) => {
            if (wantedNames.size === 0) return true;
            const root = rootsByPk.get(status.teamPk)!;
            return wantedNames.has(normalized(root.name)) || wantedNames.has(normalized(groupLabel(root)));
        });

        if (selectedStatuses.length === 0) {
            throw new Error(`No Mongo-referenced team matched: ${selectedNames.join(", ")}`);
        }
        if (wantedNames.size > 0) {
            const matched = new Set(
                selectedStatuses.flatMap((status) => {
                    const root = rootsByPk.get(status.teamPk)!;
                    return [normalized(root.name), normalized(groupLabel(root))];
                })
            );
            const unmatched = selectedNames.filter((name) => !matched.has(normalized(name)));
            if (unmatched.length > 0) throw new Error(`Unknown team selection: ${unmatched.join(", ")}`);
        }

        const childPks = new Set<string>();
        for (const status of selectedStatuses) {
            const root = rootsByPk.get(status.teamPk)!;
            for (const pk of root.subteamPkList ?? []) childPks.add(pk);
            for (const pk of status.recruitingSubteamPks ?? []) childPks.add(pk);
        }

        const childrenByPk = await readLocalAuthentikGroups([...childPks]);
        const configByPk = new Map(configs.map((config) => [config.subteamPk, config]));

        return selectedStatuses
            .map((status): SourceTeam => {
                const root = rootsByPk.get(status.teamPk)!;
                const sourceSubteamPks = new Set([
                    ...(root.subteamPkList ?? []),
                    ...(status.recruitingSubteamPks ?? []),
                ]);
                const subteams = [...sourceSubteamPks]
                    .map((pk) => childrenByPk.get(pk))
                    .filter((group): group is GetGroupInfoResponse => group !== undefined);
                const subteamConfigs = new Map<string, SubteamConfigDocument>();
                for (const subteam of subteams) {
                    const config = configByPk.get(subteam.pk);
                    if (config) subteamConfigs.set(subteam.pk, config);
                }
                return { root, subteams, recruitingStatus: status, subteamConfigs };
            })
            .sort((left, right) => groupLabel(left.root).localeCompare(groupLabel(right.root)));
    } finally {
        await connection.close().catch(() => undefined);
    }
}

function stagingConfig(): { baseUrl: string; cookie?: string; sshHost: string } {
    const baseUrl = (process.env.PEOPLEPORTAL_STAGING_BASE_URL ?? DEFAULT_STAGING_URL).replace(/\/$/, "");
    const parsed = new URL(baseUrl);
    if (parsed.hostname !== ALLOWED_STAGING_HOST && process.env.PEOPLEPORTAL_ALLOW_SEED_HOST !== "true") {
        throw new Error(
            `Refusing destination ${parsed.hostname}. Set PEOPLEPORTAL_ALLOW_SEED_HOST=true to use a non-staging host.`
        );
    }

    return {
        baseUrl,
        cookie: process.env.PEOPLEPORTAL_SEED_COOKIE,
        sshHost: process.env.PEOPLEPORTAL_STAGING_SSH ?? DEFAULT_STAGING_SSH,
    };
}

async function stagingApi(
    baseUrl: string,
    cookie: string,
    method: string,
    route: string,
    body?: unknown
): Promise<any> {
    const response = await fetch(`${baseUrl}${route}`, {
        method,
        headers: {
            "Content-Type": "application/json",
            Cookie: cookie,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let parsed: any;
    try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = undefined; }

    if (!response.ok) {
        const detail = parsed?.message ?? parsed?.error ?? text.slice(0, 240);
        throw new Error(`${method} ${route} -> ${response.status}: ${detail}`);
    }
    return parsed;
}

async function listStagingTeams(baseUrl: string, cookie: string): Promise<TeamInformationBrief[]> {
    const teams: TeamInformationBrief[] = [];
    let cursor: string | undefined;
    do {
        const params = new URLSearchParams({ limit: "200", includeArchived: "true" });
        if (cursor) params.set("cursor", cursor);
        const response = await stagingApi(baseUrl, cookie, "GET", `/api/org/teams?${params.toString()}`);
        teams.push(...(response?.teams ?? []));
        cursor = response?.nextCursor;
    } while (cursor);
    return teams;
}

async function listStagingSubteams(
    baseUrl: string,
    cookie: string,
    parentPk: string
): Promise<TeamInformationBrief[]> {
    const subteams: TeamInformationBrief[] = [];
    let cursor: string | undefined;
    do {
        const params = new URLSearchParams({
            limit: "200",
            includeArchived: "true",
            subgroupsOnly: "true",
        });
        if (cursor) params.set("cursor", cursor);
        const response = await stagingApi(baseUrl, cookie, "GET", `/api/org/teams?${params.toString()}`);
        subteams.push(...(response?.teams ?? []).filter((team: TeamInformationBrief) => team.parent === parentPk));
        cursor = response?.nextCursor;
    } while (cursor);
    return subteams;
}

function matchRoot(source: GetGroupInfoResponse, candidates: TeamInformationBrief[]): TeamInformationBrief | undefined {
    const exactName = candidates.filter((candidate) => candidate.name === source.name);
    if (exactName.length === 1) return exactName[0];

    const sourceIdentity = identity({ name: source.name, ...attributes(source) });
    const semantic = candidates.filter((candidate) => identity(candidate) === sourceIdentity);
    if (semantic.length > 1) {
        throw new Error(`Staging has multiple matches for ${groupLabel(source)}; refusing an ambiguous import`);
    }
    return semantic[0];
}

function matchSubteam(
    source: GetGroupInfoResponse,
    candidates: TeamInformationBrief[]
): TeamInformationBrief | undefined {
    const exactName = candidates.find((candidate) => candidate.name === source.name);
    if (exactName) return exactName;

    const sameLabel = candidates.filter(
        (candidate) => normalized(briefLabel(candidate)) === normalized(groupLabel(source))
    );
    if (sameLabel.length > 1) {
        throw new Error(`Staging has multiple subteams named ${groupLabel(source)}`);
    }
    return sameLabel[0];
}

function wait(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function getStagingDetail(baseUrl: string, cookie: string, teamPk: string): Promise<StagingTeamDetail> {
    const response = await stagingApi(baseUrl, cookie, "GET", `/api/org/teams/${teamPk}`);
    return {
        team: response.team,
        subteams: response.subteams ?? [],
    };
}

function runSsh(sshHost: string, remoteCommand: string, input?: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn("ssh", ["-o", "BatchMode=yes", sshHost, remoteCommand], {
            stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
        child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
        child.on("error", reject);
        child.on("close", (code) => {
            if (code === 0) resolve(stdout.trim());
            else reject(new Error(`SSH preflight/import failed (${code}): ${stderr.trim() || stdout.trim()}`));
        });
        if (input !== undefined) child.stdin.end(input);
    });
}

const remoteMongoDiscovery = [
    "mongo_container=$(docker ps --filter label=com.docker.compose.service=mongo --format '{{.Names}}' | head -n 1)",
    "test -n \"$mongo_container\"",
    "docker exec -i \"$mongo_container\" mongosh people-portal --quiet",
].join("\n");

async function preflightSsh(sshHost: string): Promise<void> {
    const output = await runSsh(
        sshHost,
        remoteMongoDiscovery,
        "const d=db.getSiblingDB('people-portal'); print(JSON.stringify({ok:1,collections:d.getCollectionNames().length}));\n"
    );
    if (!output.includes('"ok":1')) throw new Error(`Unexpected staging MongoDB preflight response: ${output}`);
}

function createMongoImport(
    sources: SourceTeam[],
    rootPkMap: Map<string, string>,
    subteamPkMap: Map<string, string>
): string {
    const operations: string[] = ["const targetDb = db.getSiblingDB('people-portal');", "const now = new Date();"];

    for (const source of sources) {
        const destinationRootPk = rootPkMap.get(source.root.pk)!;
        const destinationRecruitingPks = source.recruitingStatus.recruitingSubteamPks.map((sourcePk) => {
            const destinationPk = subteamPkMap.get(sourcePk);
            if (!destinationPk) throw new Error(`No staging UUID mapping for recruiting subteam ${sourcePk}`);
            return destinationPk;
        });
        const statusPayload = {
            teamPk: destinationRootPk,
            isRecruiting: Boolean(source.recruitingStatus.isRecruiting),
            recruitingSubteamPks: destinationRecruitingPks,
        };
        operations.push(
            `targetDb.teamrecruitingstatuses.updateOne({teamPk:${JSON.stringify(destinationRootPk)}},` +
            `{$set:${JSON.stringify(statusPayload)},$setOnInsert:{createdAt:now,__v:0},$currentDate:{updatedAt:true}},{upsert:true});`
        );

        for (const [sourceSubteamPk, config] of source.subteamConfigs) {
            const destinationSubteamPk = subteamPkMap.get(sourceSubteamPk);
            if (!destinationSubteamPk) continue;
            const configPayload = {
                subteamPk: destinationSubteamPk,
                isRecruiting: Boolean(config.isRecruiting),
                roles: config.roles ?? [],
                roleSpecificQuestions: config.roleSpecificQuestions ?? {},
            };
            operations.push(
                `targetDb.subteamconfigs.updateOne({subteamPk:${JSON.stringify(destinationSubteamPk)}},` +
                `{$set:${JSON.stringify(configPayload)},$setOnInsert:{createdAt:now,__v:0},$currentDate:{updatedAt:true}},{upsert:true});`
            );
        }
    }
    operations.push(
        "print(JSON.stringify({ok:1,teamRecruitingStatuses:targetDb.teamrecruitingstatuses.countDocuments(),subteamConfigs:targetDb.subteamconfigs.countDocuments()}));"
    );
    return `${operations.join("\n")}\n`;
}

async function applySeed(
    sources: SourceTeam[],
    baseUrl: string,
    cookie: string,
    sshHost: string,
    stagingTeams: TeamInformationBrief[]
): Promise<void> {
    const rootPkMap = new Map<string, string>();
    const subteamPkMap = new Map<string, string>();

    for (const source of sources) {
        let destination = matchRoot(source.root, stagingTeams);
        const sourceAttributes = attributes(source.root);

        if (!destination) {
            if (sourceAttributes.seasonType === "ROLLING" || sourceAttributes.teamType === "SERVICE") {
                throw new Error(
                    `Service team ${groupLabel(source.root)} is missing in staging; boot staging once so service teams are provisioned`
                );
            }

            const created = await stagingApi(baseUrl, cookie, "POST", "/api/org/teams/create", {
                friendlyName: sourceAttributes.friendlyName,
                teamType: sourceAttributes.teamType,
                seasonType: sourceAttributes.seasonType,
                seasonYear: sourceAttributes.seasonYear,
                description: sourceAttributes.description || `Seeded from local development on ${new Date().toISOString().slice(0, 10)}.`,
                teamStartDate: sourceAttributes.teamStartDate,
                teamEndDate: sourceAttributes.teamEndDate ?? new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10),
                requestorRole: String(sourceAttributes.requestorRole ?? "Team Owner"),
            });
            if (!created?.pk) {
                throw new Error(`Staging did not return a team UUID for ${groupLabel(source.root)} (was creation left pending?)`);
            }
            destination = { ...created.attributes, name: created.name, pk: created.pk, parent: null };
            stagingTeams.push(destination);
            console.log(`  created  team      ${groupLabel(source.root)}`);
        } else {
            console.log(`  exists   team      ${groupLabel(source.root)}`);
        }
        rootPkMap.set(source.root.pk, destination.pk);

        let detail = await getStagingDetail(baseUrl, cookie, destination.pk);
        for (const sourceSubteam of source.subteams) {
            const sourceSubteamAttributes = attributes(sourceSubteam);
            let destinationSubteam = matchSubteam(sourceSubteam, detail.subteams);

            if (!destinationSubteam) {
                try {
                    const created = await stagingApi(
                        baseUrl,
                        cookie,
                        "POST",
                        `/api/org/teams/${destination.pk}/subteam`,
                        {
                            friendlyName: sourceSubteamAttributes.friendlyName,
                            description: sourceSubteamAttributes.description || "Seeded from local development.",
                        }
                    );
                    if (!created?.pk) throw new Error(`Staging did not return a UUID for subteam ${groupLabel(sourceSubteam)}`);
                    destinationSubteam = {
                        ...created.attributes,
                        name: created.name,
                        pk: created.pk,
                        parent: destination.pk,
                    };
                    detail.subteams.push(destinationSubteam);
                    console.log(`  created  subteam   ${groupLabel(source.root)} / ${groupLabel(sourceSubteam)}`);
                } catch (creationError) {
                    /* Authentik can return the root before its template-created
                       children appear in a detail read. A duplicate POST then
                       returns a generic 500. Refresh briefly and reuse it. */
                    for (let attempt = 0; attempt < 5 && !destinationSubteam; attempt++) {
                        await wait(500);
                        detail = await getStagingDetail(baseUrl, cookie, destination.pk);
                        destinationSubteam = matchSubteam(sourceSubteam, detail.subteams);
                    }
                    if (!destinationSubteam) {
                        const listedSubteams = await listStagingSubteams(baseUrl, cookie, destination.pk);
                        destinationSubteam = matchSubteam(sourceSubteam, listedSubteams);
                    }
                    if (!destinationSubteam) throw creationError;
                    console.log(`  exists   subteam   ${groupLabel(source.root)} / ${groupLabel(sourceSubteam)}`);
                }
            } else {
                console.log(`  exists   subteam   ${groupLabel(source.root)} / ${groupLabel(sourceSubteam)}`);
            }
            subteamPkMap.set(sourceSubteam.pk, destinationSubteam.pk);
        }
    }

    const mongoScript = createMongoImport(sources, rootPkMap, subteamPkMap);
    const result = await runSsh(sshHost, remoteMongoDiscovery, mongoScript);
    console.log(`\nMongoDB: ${result.split("\n").at(-1)}`);
}

function validateApplyPlan(sources: SourceTeam[], stagingTeams: TeamInformationBrief[]): void {
    for (const source of sources) {
        const sourceAttributes = attributes(source.root);
        const destination = matchRoot(source.root, stagingTeams);
        if (!destination && (sourceAttributes.seasonType === "ROLLING" || sourceAttributes.teamType === "SERVICE")) {
            throw new Error(
                `Service team ${groupLabel(source.root)} is missing in staging; boot staging once so service teams are provisioned`
            );
        }
        if (!destination && !["FALL", "SPRING"].includes(sourceAttributes.seasonType)) {
            throw new Error(
                `Team ${groupLabel(source.root)} has unsupported season type ${sourceAttributes.seasonType}`
            );
        }
    }
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    const sources = await readSource(args.selectedTeams);
    const config = stagingConfig();

    console.log(`${args.apply ? "APPLY" : "DRY RUN"}: local recruiting fixtures -> ${config.baseUrl}`);
    console.log(`source MongoDB teams: ${sources.length}`);
    for (const source of sources) {
        console.log(
            `  ${groupLabel(source.root)}: ${source.subteams.length} subteam(s), ` +
            `${source.subteamConfigs.size} config(s), recruiting=${source.recruitingStatus.isRecruiting}`
        );
    }

    if (!config.cookie) {
        if (args.apply) {
            throw new Error(
                "PEOPLEPORTAL_SEED_COOKIE is required. Sign in to staging as an executive and copy the peopleportal_sid cookie."
            );
        }
        console.log("\nNo PEOPLEPORTAL_SEED_COOKIE was supplied, so the dry run stops at the local source plan.");
        return;
    }

    const me = await stagingApi(config.baseUrl, config.cookie, "GET", "/api/auth/userinfo");
    if (!me?.isExecutive) throw new Error("The staging session is valid but is not an executive session");
    const stagingTeams = await listStagingTeams(config.baseUrl, config.cookie);

    console.log(`\nstaging currently has ${stagingTeams.length} root team(s)`);
    for (const source of sources) {
        const match = matchRoot(source.root, stagingTeams);
        console.log(`  ${match ? "match " : "create"}  ${groupLabel(source.root)}`);
    }

    if (!args.apply) {
        console.log("\nDry run only. Re-run with --apply to create/match groups and upsert recruiting configuration.");
        return;
    }

    await preflightSsh(config.sshHost);
    console.log(`\nSSH and staging MongoDB preflight passed via ${config.sshHost}.`);
    validateApplyPlan(sources, stagingTeams);
    await applySeed(sources, config.baseUrl, config.cookie, config.sshHost, stagingTeams);
    console.log("\nSeed complete. No applicants, applications, members, meetings, events, or invites were copied.");
}

main().catch((error: unknown) => {
    console.error(`\nStaging team seed failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
});
