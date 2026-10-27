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

import { AuthentikClient } from "../../clients/AuthentikClient";
import {
    AuthentikClientError,
    AuthentikClientErrorType,
} from "../../clients/AuthentikClient/models";
import { RedisClient } from "../../clients/RedisClient";
import { SubteamConfig } from "../../models/SubteamConfig";
import { TeamRecruitingStatus } from "../../models/TeamRecruitingStatus";
import { Application, ApplicationStage } from "../../models/Application";
import {
    CacheEnvelope,
    isCacheEnvelope,
    isCacheStale,
    wrapCacheValue,
} from "../../utils/cache-envelope";
import {
    ATSResponse,
    ATSSubteamConfigRequest,
    formatTeamSummary,
} from "./ATSHelpers";

const OPEN_TEAMS_CACHE_KEY = "ats:openteams";
/* Past this the entry is refreshed, but it is still served while that happens,
   so no applicant waits for the rebuild. */
const OPEN_TEAMS_CACHE_SOFT_TTL_SECONDS = 300;
/* The Redis expiry, and the absolute ceiling on staleness if every background
   refresh fails. Correctness comes from invalidating on write; this only bounds
   how long a *missed* invalidation can serve a stale roster. */
const OPEN_TEAMS_CACHE_HARD_TTL_SECONDS = 3600;

/* Recruitment configuration and discovery. MongoDB owns the roles and open/closed
 * settings; Authentik supplies team metadata; Redis caches the public listings. */
export class ATSRecruitmentService {
    constructor(
        private readonly response: ATSResponse,
        private readonly authentikClient: AuthentikClient,
    ) {}

    private static openTeamsRefreshInFlight = false;

    async getSubTeamATSConfig(teamId: string) {
        const config = (await SubteamConfig.findOne({ subteamPk: teamId })
            .lean()
            .exec()) as any;
        if (!config) {
            this.response.setStatus(404);
            return {
                error: "Not Found",
                message: `Subteam config with ID ${teamId} not found`,
            };
        }

        // Fetch the subteam and parent together when the directory supports it.
        const authentikSubteamInfo = await this.authentikClient.getGroupInfo(
            config.subteamPk,
            { includeParentInfo: true },
        );

        let authentikParentInfo = authentikSubteamInfo.parentInfo;
        if (!authentikParentInfo) {
            /* Fallback for Legacy Implementation (Authentik <2025.12) */
            authentikParentInfo = await this.authentikClient.getGroupInfo(
                authentikSubteamInfo.parentPk,
            );
        }

        return {
            ...config,
            subteamInfo: formatTeamSummary(authentikSubteamInfo),

            parentInfo: formatTeamSummary(authentikParentInfo),
        };
    }

    async createOrUpdateSubteamConfig(
        teamId: string,
        body: ATSSubteamConfigRequest,
    ) {
        const { isRecruiting, roles, roleSpecificQuestions } = body;

        if (roles.length === 0) {
            this.response.setStatus(400);
            return {
                error: "Bad Request",
                message: "Roles are required",
            };
        }

        // Use findOneAndUpdate with upsert to create or update
        const updatedConfig = await SubteamConfig.findOneAndUpdate(
            { subteamPk: teamId }, // filter
            {
                subteamPk: teamId,
                isRecruiting,
                roles,
                roleSpecificQuestions: roleSpecificQuestions || {},
            }, // update data
            {
                upsert: true, // Create if doesn't exist
                new: true, // Return updated document
                setDefaultsOnInsert: true, // Apply schema defaults on insert
            },
        )
            .lean()
            .exec();

        // Keep the parent team's public recruitment status in sync with this subteam.
        const subteamInfo = await this.authentikClient.getGroupInfo(
            updatedConfig.subteamPk,
        );
        if (updatedConfig.isRecruiting) {
            await this.addSubteamToRecruiting(
                subteamInfo.parentPk,
                updatedConfig.subteamPk,
            );
        } else {
            await this.removeSubteamFromRecruiting(
                subteamInfo.parentPk,
                updatedConfig.subteamPk,
            );
        }

        // Convert Map back to object for JSON response
        return updatedConfig;
    }

    async getAllRecruitingTeams() {
        const cached =
            await RedisClient.get<CacheEnvelope<any[]>>(OPEN_TEAMS_CACHE_KEY);

        if (isCacheEnvelope<any[]>(cached)) {
            if (isCacheStale(cached, OPEN_TEAMS_CACHE_SOFT_TTL_SECONDS))
                this.refreshOpenTeamsInBackground();

            return cached.value;
        }

        /* A cold or invalidated cache is the only path that waits on a build. */
        return this.buildAndCacheOpenTeams();
    }

    private refreshOpenTeamsInBackground() {
        if (ATSRecruitmentService.openTeamsRefreshInFlight) return;
        ATSRecruitmentService.openTeamsRefreshInFlight = true;

        /* Deliberately not awaited. Nothing may escape: an unhandled rejection
           here would take the process down for a stale cache entry. */
        void this.buildAndCacheOpenTeams()
            .catch((e: any) =>
                console.error(
                    `Background refresh of the open-teams cache failed: ${e?.message ?? e}`,
                ),
            )
            .finally(() => {
                ATSRecruitmentService.openTeamsRefreshInFlight = false;
            });
    }

    private async buildAndCacheOpenTeams() {
        const validRecruitingTeams = await this.buildOpenTeams();
        await RedisClient.set(
            OPEN_TEAMS_CACHE_KEY,
            wrapCacheValue(validRecruitingTeams),
            OPEN_TEAMS_CACHE_HARD_TTL_SECONDS,
        );

        return validRecruitingTeams;
    }

    private async buildOpenTeams() {
        /* Fetch All teams that are recruiting currently */
        const recruitingTeams: any[] = await TeamRecruitingStatus.find({
            isRecruiting: true,
        })
            .lean()
            .exec();

        /*
         * 01/21/2026 (@atheesh): Optimization from O(N*M) to O(N)
         * Previously, this loop made a DB call and an API call for every subteam (M) of every team (N).
         *
         * Now, we batch fetch all SubteamConfigs in one DB query. Furthermore, we utilize the already
         * fetched `authentikTeamInfo` (Parent) and its `subteams` array (Children) to populate the
         * recruitment info, eliminating the need for the redundant Authentik API calls that were
         * happening in `getSubTeamATSConfig`. This aligns with the "Authentik 2025.12+" update.
         */
        const allSubteamPks = recruitingTeams.flatMap(
            (t) => t.recruitingSubteamPks,
        );
        const allConfigs = await SubteamConfig.find({
            subteamPk: { $in: allSubteamPks },
        })
            .lean()
            .exec();
        const configMap = new Map(allConfigs.map((c: any) => [c.subteamPk, c]));

        /*
         * The remaining O(N) was N sequential Authentik round trips, one per
         * recruiting team, each of which then fetched every subteam again just
         * to populate members this endpoint never reads. At 13 teams that was
         * roughly 65 serial requests. Both are gone: members are not requested,
         * and the teams resolve in a single bulk lookup.
         */
        const teamInfoByPk = await this.authentikClient.getGroupsInfoByPks(
            recruitingTeams.map((t) => t.teamPk),
            {
                includeUsers: false,
                includeChildren: true,
                disableSubteamMemberPopulate: true,
            },
        );

        /* Populate Team and Subteam Info */
        const validRecruitingTeams: any[] = [];
        const missingTeamPks: string[] = [];

        for (const team of recruitingTeams) {
            const authentikTeamInfo = teamInfoByPk.get(team.teamPk);
            if (!authentikTeamInfo) {
                missingTeamPks.push(team.teamPk);
                continue;
            }

            const recruitingSubteams = new Set(team.recruitingSubteamPks);
            const parentInfoObj = formatTeamSummary(authentikTeamInfo);

            team.teamInfo = parentInfoObj;
            team.subteamInfo = {};
            for (const sub of authentikTeamInfo.subteams) {
                if (recruitingSubteams.has(sub.pk)) {
                    const config = configMap.get(sub.pk);

                    const subteamInfoObj = formatTeamSummary(sub);

                    team.subteamInfo[sub.pk] = {
                        ...subteamInfoObj,
                        recruitmentInfo: config
                            ? {
                                  ...config,
                                  subteamInfo: subteamInfoObj,
                                  parentInfo: parentInfoObj,
                              }
                            : null,
                    };
                }
            }

            validRecruitingTeams.push(team);
        }

        // A missing directory result may be temporary. Hide it from this response,
        // but retain its MongoDB configuration so it can return when lookup recovers.
        if (missingTeamPks.length > 0) {
            console.warn(
                `Recruiting teams missing from the directory response: ${missingTeamPks.join(", ")}. Records preserved for review.`,
            );
        }

        return validRecruitingTeams;
    }

    async getTeamDetails(teamId: string) {
        try {
            // Get team info from Authentik
            const teamInfo = await this.authentikClient.getGroupInfo(teamId);

            // Get team recruiting status
            const teamStatus = await TeamRecruitingStatus.findOne({
                teamPk: teamId,
            }).exec();

            if (!teamStatus || !teamStatus.isRecruiting) {
                this.response.setStatus(403);
                return {
                    error: "NotRecruiting",
                    message: "This team is not currently recruiting",
                };
            }

            // Fetch configs for all recruiting subteams
            const recruitingSubteams = await Promise.all(
                teamStatus.recruitingSubteamPks.map(async (subteamPk) => {
                    const config = await SubteamConfig.findOne({
                        subteamPk,
                    }).exec();
                    const subteamInfo =
                        await this.authentikClient.getGroupInfo(subteamPk);

                    return {
                        subteamPk: subteamPk,
                        friendlyName:
                            subteamInfo.attributes.friendlyName ||
                            subteamInfo.name,
                        description: subteamInfo.attributes.description,
                        roles: config?.roles || [],
                        roleSpecificQuestions:
                            config?.roleSpecificQuestions || {},
                    };
                }),
            );

            return {
                teamPk: teamId,
                teamInfo: formatTeamSummary(teamInfo),
                recruitingSubteams: recruitingSubteams,
            };
        } catch (err) {
            if (
                err instanceof AuthentikClientError &&
                err.code === AuthentikClientErrorType.GROUP_NOT_FOUND
            ) {
                this.response.setStatus(404);
                return {
                    error: "TeamNotFound",
                    message: "The requested team could not be found.",
                };
            }

            this.response.setStatus(500);
            return {
                error: "ServerError",
                message: "Failed to fetch team details",
            };
        }
    }

    async addSubteamToRecruiting(teamId: string, subteamId: string) {
        const updatedTeam = await TeamRecruitingStatus.findOneAndUpdate(
            { teamPk: teamId },
            {
                $addToSet: { recruitingSubteamPks: subteamId },
                teamPk: teamId,
            },
            { upsert: true, new: true },
        )
            .lean()
            .exec();

        // Set isRecruiting based on array length
        if (
            updatedTeam.recruitingSubteamPks.length > 0 &&
            !updatedTeam.isRecruiting
        ) {
            await TeamRecruitingStatus.updateOne(
                { teamPk: teamId },
                { isRecruiting: true },
            );
            updatedTeam.isRecruiting = true;
        }

        /* After every write, never before: invalidating first leaves a window in
           which a concurrent read repopulates the cache from pre-update rows. */
        await RedisClient.delete(OPEN_TEAMS_CACHE_KEY);
        return updatedTeam;
    }

    async removeSubteamFromRecruiting(teamId: string, subteamId: string) {
        const updatedTeam = await TeamRecruitingStatus.findOneAndUpdate(
            { teamPk: teamId },
            { $pull: { recruitingSubteamPks: subteamId } },
            { new: true },
        )
            .lean()
            .exec();

        if (!updatedTeam) {
            this.response.setStatus(404);
            return { error: "Not Found", message: `Team ${teamId} not found` };
        }

        // Set isRecruiting to false if no subteams left
        if (
            updatedTeam.recruitingSubteamPks.length === 0 &&
            updatedTeam.isRecruiting
        ) {
            await TeamRecruitingStatus.updateOne(
                { teamPk: teamId },
                { isRecruiting: false },
            );
            updatedTeam.isRecruiting = false;
        }

        await RedisClient.delete(OPEN_TEAMS_CACHE_KEY);
        return updatedTeam;
    }

    async getTeamRecruitmentStats() {
        const [teamsRes, grouped] = await Promise.all([
            this.authentikClient.getGroupsList({ limit: 500 }),
            Application.aggregate([
                {
                    $group: {
                        _id: { teamPk: "$teamPk", stage: "$stage" },
                        count: { $sum: 1 },
                    },
                },
            ]).exec(),
        ]);

        /* teamPk -> stage -> count */
        const byTeam = new Map<string, Record<string, number>>();
        for (const row of grouped as {
            _id: { teamPk: string; stage: string };
            count: number;
        }[]) {
            const stages = byTeam.get(row._id.teamPk) ?? {};
            stages[row._id.stage] = row.count;
            byTeam.set(row._id.teamPk, stages);
        }

        const stageKeys = Object.values(ApplicationStage);

        const teams = teamsRes.teams.map((team) => {
            const stages = byTeam.get(team.pk) ?? {};
            const counts: Record<string, number> = {};
            let total = 0;

            for (const stage of stageKeys) {
                const n = stages[stage] ?? 0;
                counts[stage] = n;
                total += n;
            }

            return {
                teamPk: team.pk,
                name: team.friendlyName || team.name,
                counts,
                total,
            };
        });

        /* Busiest first: an executive scanning this wants the teams with
           something happening, not alphabetical order. */
        teams.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));

        return { stages: stageKeys, teams };
    }
}
