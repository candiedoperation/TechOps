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

import { Body, Request, Controller, Delete, Get, Path, Post, Put, Route, SuccessResponse, Tags } from "tsoa";
import { SubteamConfig, ISubteamConfig } from "../models/SubteamConfig";
import { TeamRecruitingStatus, ITeamRecruitingStatus } from "../models/TeamRecruitingStatus";
import { AuthentikClient } from "../clients/AuthentikClient";
import { GetGroupInfoResponse, UserInformationBrief, AuthentikClientError, AuthentikClientErrorType } from "../clients/AuthentikClient/models";
import { Applicant, IApplicant, ApplicantProfile } from '../models/Applicant';
import { Application, IApplication, ApplicationStage } from "../models/Application";
import { Security } from "tsoa";
import * as express from 'express'
import path from 'path';
import { PutObjectCommand, GetObjectCommand, CopyObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { s3Client, BUCKET_NAME } from "../clients/AWSClient/S3Client";
import { Query } from "tsoa";
import { EmailClient } from "../clients/EmailClient";
import { OrgController } from "./OrgController";
import { BindleController } from "./BindleController";
import { AuthorizedUser } from "../clients/OpenIdClient";
import { validateS3FileSignature, FILE_SIGNATURES } from '../utils/s3-validation';
import MarkdownIt from "markdown-it";
import { RedisClient } from "../clients/RedisClient";
import { mapWithConcurrency } from "../utils/concurrency";
import { CacheEnvelope, isCacheEnvelope, isCacheStale, wrapCacheValue } from "../utils/cache-envelope";

// ====================
// Type Definitions
// ====================

interface ATSSubteamConfigRequest {
    isRecruiting: boolean;
    roles: string[];
    roleSpecificQuestions: { [role: string]: string[] };
}

// Team-level application request with ordered role preferences
interface ATSTeamApplicationRequest {
    teamPk: string;
    rolePreferences: { role: string, subteamPk: string }[];  // Ordered array
    profile: ApplicantProfile;
    responses: Record<string, string>;
}

interface ATSUpdateApplicationStageRequest {
    stage: ApplicationStage,
    interviewLink?: string,
    interviewGuidelines?: string,
    hiredRole?: string,
    hiredSubteamPk?: string
}

interface ATSKanbanApplicationCard {
    id: string;
    applicantId: string;
    name: string;
    rolePreferences: { role: string, subteamPk: string }[];
    appliedAt: Date;
    stage: ApplicationStage;

    /** 
     * Rating for an Applicant
     * @minimum 0 Minimum Stars is 0
     * @maximum 5 Maximum Stars is 5
     */
    stars: number;
}

interface ATSApplicationDetails extends ATSKanbanApplicationCard {
    email: string;
    profile: Record<string, string>;
    responses: Record<string, string>;
    stageHistory?: {
        stage: ApplicationStage;
        changedAt: Date;
        changedBy?: string;
    }[];
    hiredRole?: string;
    appDevInternalPk?: number;
    notes?: string;
}

// Constants
const ALLOWED_RESUME_EXTENSIONS = ['pdf'] as const;
const ALLOWED_CONTENT_TYPES = ['application/pdf'] as const;
const MAX_RESPONSE_LENGTH = 2000;
const MAX_WHY_APPDEV_WORDS = 200;
const MIN_RESPONSE_WORDS = 10;
const OPEN_TEAMS_CACHE_KEY = "ats:openteams";
/* Past this the entry is refreshed, but it is still served while that happens,
   so no applicant waits for the rebuild. */
const OPEN_TEAMS_CACHE_SOFT_TTL_SECONDS = 300;
/* The Redis expiry, and the absolute ceiling on staleness if every background
   refresh fails. Correctness comes from invalidating on write; this only bounds
   how long a *missed* invalidation can serve a stale roster. */
const OPEN_TEAMS_CACHE_HARD_TTL_SECONDS = 3600;

@Route("/api/ats")
export class ATSController extends Controller {
    private readonly authentikClient: AuthentikClient;
    private readonly emailClient: EmailClient;
    private readonly orgController: OrgController;

    constructor() {
        super()
        this.authentikClient = new AuthentikClient()
        this.emailClient = new EmailClient()
        this.orgController = new OrgController()
    }

    /**
     * Generates a presigned URL for uploading a resume to the AWS S3 bucket.
     * Checks for PDF File Type, Prevents Path Traversals and requires valid
     * Guest Authentication Token.
     * 
     * @param request Express Request Object
     * @param fileName Resume File Name
     * @param contentType Resume File Content Type
     * @returns AWS S3 Upload URL, Download URL and Key
     */
    @Get("resume/upload-url")
    @Tags("Applicant Portal")
    @Security("ats_otp")
    @SuccessResponse(200)
    async getResumeUploadUrl(@Request() request: express.Request, @Query() fileName: string, @Query() contentType: string) {
        const userEmail = request.session.tempsession?.user?.email;
        if (!userEmail) {
            this.setStatus(401);
            return { error: "Unauthorized", message: "User session not found." };
        }

        // Validate PDF only
        const fileExtension = fileName.split('.').pop()?.toLowerCase();
        if (!fileExtension || !ALLOWED_RESUME_EXTENSIONS.includes(fileExtension as any)) {
            this.setStatus(400);
            return {
                error: "InvalidFileType",
                message: `Only PDF resumes are accepted. Allowed types: ${ALLOWED_RESUME_EXTENSIONS.join(', ')}`
            };
        }

        if (!ALLOWED_CONTENT_TYPES.includes(contentType as any)) {
            this.setStatus(400);
            return { error: "InvalidContentType", message: "Invalid content type. Only PDF is accepted." };
        }

        // Prevent path traversal
        if (fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) {
            this.setStatus(400);
            return { error: "InvalidFileName", message: "Invalid file name" };
        }

        // Applicant must exist because of ats_otp security but, we'll check just in case
        const applicant = await Applicant.findOne({ email: userEmail }).exec();
        if (!applicant) {
            this.setStatus(404);
            return { error: "ApplicantNotFound", message: "Applicant not found" };
        }

        const key = `resumes/${applicant._id}.pdf`;

        // Use presigned POST to enforce file size limits on S3 side
        const { url, fields } = await createPresignedPost(s3Client, {
            Bucket: BUCKET_NAME,
            Key: key,
            Conditions: [
                ["content-length-range", 0, 10 * 1024 * 1024], // 10MB limit
                { "content-type": "application/pdf" }
            ],
            Fields: {
                "content-type": "application/pdf"
            },
            Expires: 600 // 10 minutes
        });

        // Construct the proxy URL using the request headers
        const protocol = request.protocol;
        const host = request.get('host');
        const publicUrl = `${protocol}://${host}/api/ats/resume/download?key=${encodeURIComponent(key)}`;

        return {
            uploadUrl: url,
            fields,
            publicUrl,
            key
        };
    }

    /**
     * Generates a presigned URL for downloading a resume from the AWS S3 bucket.
     * Requires valid Guest Authentication Token and intended for use by applicants
     * to view their resume and profile.
     * 
     * @param request Express Request Object
     * @param key Resume Key
     * @returns AWS S3 Download URL
     */
    @Get("resume/download")
    @Tags("Applicant Portal")
    @Security("ats_otp")
    @SuccessResponse(307, "Temporary Redirect")
    async getResumeDownloadUrl(@Request() request: any, @Query() key: string) {
        const userEmail = request.session?.tempsession?.user?.email

        // 1. Verify Authentication
        if (!userEmail) {
            this.setStatus(401);
            return { error: "Unauthorized", message: "User session not found." };
        }

        const applicant = await Applicant.findOne({ email: userEmail });
        const normalizedKey = path.posix.normalize(key);
        const expectedKey = `resumes/${applicant?._id}.pdf`;

        if (!applicant || normalizedKey !== expectedKey || normalizedKey.includes('..')) {
            this.setStatus(403);
            return { error: "Forbidden", message: "You do not have permission to access this file." };
        }

        // 3. Generate Presigned GET URL
        try {
            /* Sign the string that was validated. Signing the raw `key` while
               checking `normalizedKey` lets the two diverge, which is the shape
               every path-traversal bug takes even when S3 happens to be literal. */
            const command = new GetObjectCommand({
                Bucket: BUCKET_NAME,
                Key: normalizedKey,
            });

            const downloadUrl = await getSignedUrl(s3Client, command, { expiresIn: 900 }); // 15 minutes

            // 4. Redirect
            this.setStatus(307);
            this.setHeader('Location', downloadUrl);
            return;

        } catch (error) {
            console.error("Error generating download URL:", error);
            this.setStatus(404); // Or 500
            return { error: "NotFound", message: "File not found or access denied." };
        }
    }

    /**
     * Fetches Subteam Recruitment Configuration from the external database and populates
     * subteam and parent information via Authentik API calls. To perform this action, the
     * user must either be a Team Owner (on the parent team) or, hold the `corp:hiringaccess`
     * bindle.
     * 
     * @param teamId Subteam ID
     * @returns Subteam Recruitment Configuration
     */
    @Get("config/{teamId}")
    @Tags("Recruitment Configuration")
    @SuccessResponse(200)
    @Security("bindles", ["corp:hiringaccess"])
    async getSubTeamATSConfig(@Path() teamId: string) {
        const config = await SubteamConfig.findOne({ subteamPk: teamId }).lean().exec() as any;
        if (!config) {
            this.setStatus(404);
            return {
                error: "Not Found",
                message: `Subteam config with ID ${teamId} not found`
            };
        }

        /* Legacy Implementation w/o Authentik 2025.12+ Call Optimizations */
        // const authentikSubteamInfo = await this.authentikClient.getGroupInfo(config.subteamPk)
        // const authentikParentInfo = await this.authentikClient.getGroupInfo(authentikSubteamInfo.parentPk);

        /* 01/21/2026 (@atheesh): 50% API Call Reduction on 2025.12+ via new Client Option  */
        const authentikSubteamInfo = await this.authentikClient.getGroupInfo(
            config.subteamPk,
            { includeParentInfo: true }
        );

        let authentikParentInfo = authentikSubteamInfo.parentInfo;
        if (!authentikParentInfo) {
            /* Fallback for Legacy Implementation (Authentik <2025.12) */
            authentikParentInfo = await this.authentikClient.getGroupInfo(authentikSubteamInfo.parentPk);
        }

        return {
            ...config,
            subteamInfo: {
                name: authentikSubteamInfo.name,
                friendlyName: authentikSubteamInfo.attributes.friendlyName,
                description: authentikSubteamInfo.attributes.description,
                seasonText: `${authentikSubteamInfo.attributes.seasonType} ${authentikSubteamInfo.attributes.seasonYear}`,
                pk: authentikSubteamInfo.pk
            },

            parentInfo: {
                name: authentikParentInfo.name,
                friendlyName: authentikParentInfo.attributes.friendlyName,
                description: authentikParentInfo.attributes.description,
                seasonText: `${authentikParentInfo.attributes.seasonType} ${authentikParentInfo.attributes.seasonYear}`,
                pk: authentikParentInfo.pk
            }
        };
    }

    /**
     * Configure a subteam to recruit for specific roles with addtional role specific
     * questions. This endpoint automatically sets the `isRecruiting` status for a 
     * subteam. To perform this action, the user must either be a Team Owner or hold
     * the `corp:hiringaccess` bindle.
     * 
     * @param teamId People Portal Team ID
     * @param body Subteam Configuration Request
     * @returns Updated Subteam Recruitment Configuration
     */
    @Post("config/{teamId}")
    @Tags("Recruitment Configuration")
    @SuccessResponse(200, "Created or Updated")
    @Security("bindles", ["corp:hiringaccess"])
    async createOrUpdateSubteamConfig(@Path() teamId: string, @Body() body: ATSSubteamConfigRequest) {
        const { isRecruiting, roles, roleSpecificQuestions } = body;

        if (roles.length === 0) {
            this.setStatus(400);
            return {
                error: "Bad Request",
                message: "Roles are required"
            };
        }

        // Use findOneAndUpdate with upsert to create or update
        const updatedConfig = await SubteamConfig.findOneAndUpdate(
            { subteamPk: teamId }, // filter
            {
                subteamPk: teamId,
                isRecruiting,
                roles,
                roleSpecificQuestions: roleSpecificQuestions || {}
            }, // update data
            {
                upsert: true,        // Create if doesn't exist
                new: true,           // Return updated document
                setDefaultsOnInsert: true // Apply schema defaults on insert
            }
        ).lean().exec();

        /* Update Team Recruiting Status */
        const subteamInfo = await this.authentikClient.getGroupInfo(updatedConfig.subteamPk)
        if (updatedConfig.isRecruiting) {
            await this.addSubteamToRecruiting(subteamInfo.parentPk, updatedConfig.subteamPk)
        } else {
            await this.removeSubteamFromRecruiting(subteamInfo.parentPk, updatedConfig.subteamPk)
        }

        // Convert Map back to object for JSON response
        return updatedConfig;
    }

    /**
     * Public API that fetches the list of teams that are currently recruiting
     * new candidates. Provides a list of roles and other Recruitment Info in
     * addition to the team and subteam info.
     * 
     * @returns List of Teams Recruiting
     */
    @Get("openteams")
    @Tags("Applicant Portal")
    @SuccessResponse(200)
    async getAllRecruitingTeams() {
        const cached = await RedisClient.get<CacheEnvelope<any[]>>(OPEN_TEAMS_CACHE_KEY);

        if (isCacheEnvelope<any[]>(cached)) {
            if (isCacheStale(cached, OPEN_TEAMS_CACHE_SOFT_TTL_SECONDS))
                this.refreshOpenTeamsInBackground();

            return cached.value;
        }

        /* A cold or invalidated cache is the only path that waits on a build. */
        return this.buildAndCacheOpenTeams();
    }

    /**
     * Rebuilds the cache without making the current request wait for it.
     *
     * Guarded so that a burst of readers arriving after the soft TTL triggers
     * one rebuild rather than one per request, which is the stampede a plain
     * TTL causes. The guard is per-process, so a multi-instance deployment
     * rebuilds once per instance; that is a far cry from once per request, and
     * a distributed lock is not worth its failure modes here.
     */
    private static openTeamsRefreshInFlight = false;

    private refreshOpenTeamsInBackground() {
        if (ATSController.openTeamsRefreshInFlight) return;
        ATSController.openTeamsRefreshInFlight = true;

        /* Deliberately not awaited. Nothing may escape: an unhandled rejection
           here would take the process down for a stale cache entry. */
        void this.buildAndCacheOpenTeams()
            .catch((e: any) => console.error(`Background refresh of the open-teams cache failed: ${e?.message ?? e}`))
            .finally(() => { ATSController.openTeamsRefreshInFlight = false; });
    }

    private async buildAndCacheOpenTeams() {
        const validRecruitingTeams = await this.buildOpenTeams();
        await RedisClient.set(
            OPEN_TEAMS_CACHE_KEY,
            wrapCacheValue(validRecruitingTeams),
            OPEN_TEAMS_CACHE_HARD_TTL_SECONDS
        );

        return validRecruitingTeams;
    }

    /** The uncached build. Every Mongo and Authentik read for this page lives here. */
    private async buildOpenTeams() {
        /* Fetch All teams that are recruiting currently */
        const recruitingTeams: any[] = await TeamRecruitingStatus.find({ isRecruiting: true }).lean().exec();

        /* 
         * 01/21/2026 (@atheesh): Optimization from O(N*M) to O(N)
         * Previously, this loop made a DB call and an API call for every subteam (M) of every team (N).
         * 
         * Now, we batch fetch all SubteamConfigs in one DB query. Furthermore, we utilize the already 
         * fetched `authentikTeamInfo` (Parent) and its `subteams` array (Children) to populate the 
         * recruitment info, eliminating the need for the redundant Authentik API calls that were 
         * happening in `getSubTeamATSConfig`. This aligns with the "Authentik 2025.12+" update.
         */
        const allSubteamPks = recruitingTeams.flatMap(t => t.recruitingSubteamPks);
        const allConfigs = await SubteamConfig.find({ subteamPk: { $in: allSubteamPks } }).lean().exec();
        const configMap = new Map(allConfigs.map((c: any) => [c.subteamPk, c]));

        /*
         * The remaining O(N) was N sequential Authentik round trips, one per
         * recruiting team, each of which then fetched every subteam again just
         * to populate members this endpoint never reads. At 13 teams that was
         * roughly 65 serial requests. Both are gone: members are not requested,
         * and the teams resolve in a single bulk lookup.
         */
        const teamInfoByPk = await this.authentikClient.getGroupsInfoByPks(
            recruitingTeams.map(t => t.teamPk),
            { includeUsers: false, includeChildren: true, disableSubteamMemberPopulate: true }
        );

        /* Populate Team and Subteam Info */
        const validRecruitingTeams: any[] = [];
        const missingTeamPks: string[] = [];

        for (const team of recruitingTeams) {
            const authentikTeamInfo = teamInfoByPk.get(team.teamPk);
            if (!authentikTeamInfo) {
                /* Absent from a successful bulk lookup means the group is gone
                   from Authentik. Collected, not deleted mid-iteration. */
                missingTeamPks.push(team.teamPk);
                continue;
            }

            const recruitingSubteams = new Set(team.recruitingSubteamPks)
            const parentInfoObj = {
                name: authentikTeamInfo.name,
                friendlyName: authentikTeamInfo.attributes.friendlyName,
                description: authentikTeamInfo.attributes.description,
                seasonText: `${authentikTeamInfo.attributes.seasonType} ${authentikTeamInfo.attributes.seasonYear}`,
                pk: authentikTeamInfo.pk
            };

            team.teamInfo = parentInfoObj;
            team.subteamInfo = {};
            for (const sub of authentikTeamInfo.subteams) {
                if (recruitingSubteams.has(sub.pk)) {
                    const config = configMap.get(sub.pk);

                    const subteamInfoObj = {
                        name: sub.name,
                        friendlyName: sub.attributes.friendlyName,
                        description: sub.attributes.description,
                        seasonText: `${sub.attributes.seasonType} ${sub.attributes.seasonYear}`,
                        pk: sub.pk
                    };

                    team.subteamInfo[sub.pk] = {
                        ...subteamInfoObj,
                        recruitmentInfo: config ? {
                            ...config,
                            subteamInfo: subteamInfoObj,
                            parentInfo: parentInfoObj
                        } : null,
                    };
                }
            }

            validRecruitingTeams.push(team);
        }

        /*
         * 02-06-2026 (@atheesh): Data Integrity Compromise, See COE at
         * https://wiki.appdevclub.com/people-portal-dev-guide/coe/ats-open-roles-failure
         * Rows for groups Authentik no longer has are still cleaned up, now in
         * one query rather than one delete per team inside the render loop.
         */
        if (missingTeamPks.length > 0) {
            console.warn(`Recruiting Teams with PKs ${missingTeamPks.join(", ")} not found in Authentik. Cleaning up.`);
            await TeamRecruitingStatus.deleteMany({ teamPk: { $in: missingTeamPks } }).exec();
        }

        return validRecruitingTeams;
    }

    /**
     * Fetches the list of available application stages an applicant can
     * be in. To access this list, the user must be logged in via OIDC.
     * 
     * @returns List of Application Stages
     */
    @Get("stages")
    @Tags("Recruitment Actions")
    @SuccessResponse(200)
    @Security("oidc")
    async getApplicationStages() {
        // Return the ApplicationStage enum as an array of {id, name} objects
        const stages = Object.entries(ApplicationStage).map(([key, value]) => ({
            id: value,
            name: value
        }));

        return stages;
    }

    /**
     * Public endpoint that provides information about the team, its subteams and
     * the roles they're recruiting for. Ideally, this endpoint is used so that the
     * applicant can view all available roles, the role specific questions to aid in
     * selecting and ranking roles.
     * 
     * @param teamId Team ID for a currently recruiting team.
     * @returns Team Recuritment Info
     */
    @Get("openteams/{teamId}")
    @Tags("Applicant Portal")
    @SuccessResponse(200)
    async getTeamDetails(@Path() teamId: string) {
        try {
            // Get team info from Authentik
            const teamInfo = await this.authentikClient.getGroupInfo(teamId);

            // Get team recruiting status
            const teamStatus = await TeamRecruitingStatus.findOne({ teamPk: teamId }).exec();

            if (!teamStatus || !teamStatus.isRecruiting) {
                this.setStatus(403);
                return {
                    error: "NotRecruiting",
                    message: "This team is not currently recruiting"
                };
            }

            // Fetch configs for all recruiting subteams
            const recruitingSubteams = await Promise.all(
                teamStatus.recruitingSubteamPks.map(async (subteamPk) => {
                    const config = await SubteamConfig.findOne({ subteamPk }).exec();
                    const subteamInfo = await this.authentikClient.getGroupInfo(subteamPk);

                    return {
                        subteamPk: subteamPk,
                        friendlyName: subteamInfo.attributes.friendlyName || subteamInfo.name,
                        description: subteamInfo.attributes.description,
                        roles: config?.roles || [],
                        roleSpecificQuestions: config?.roleSpecificQuestions || {}
                    };
                })
            );

            return {
                teamPk: teamId,
                teamInfo: {
                    name: teamInfo.name,
                    friendlyName: teamInfo.attributes.friendlyName,
                    description: teamInfo.attributes.description,
                    seasonText: `${teamInfo.attributes.seasonType} ${teamInfo.attributes.seasonYear}`,
                    pk: teamInfo.pk
                },
                recruitingSubteams: recruitingSubteams
            };

        } catch (err) {
            if (err instanceof AuthentikClientError && err.code === AuthentikClientErrorType.GROUP_NOT_FOUND) {
                this.setStatus(404);
                return {
                    error: "TeamNotFound",
                    message: "The requested team could not be found."
                };
            }

            this.setStatus(500);
            return {
                error: "ServerError",
                message: "Failed to fetch team details"
            };
        }
    }

    /**
     * Fetches all applications for a team in a lightweight format suitable for
     * the Kanban board. To perform this action, the user must either be a Team Owner 
     * or hold the `corp:hiringaccess` bindle.
     * 
     * @param teamId People Portal Team ID
     * @returns Candidate Applications List
     */
    @Get("applications/{teamId}")
    @Tags("Recruitment Actions")
    @Security("bindles", ["corp:hiringaccess"])
    @SuccessResponse(200)
    async getTeamApplications(@Path() teamId: string): Promise<ATSKanbanApplicationCard[]> {
        try {
            // Fetch all applications for this team directly - ONE per applicant!
            // Project only necessary fields for the summary view
            const applications = await Application.find({
                teamPk: teamId
            })
                .select('applicantId stage rolePreferences appliedAt stars')
                .populate<{ applicantId: IApplicant }>('applicantId', 'fullName')
                .lean()
                .exec();

            // Map to Kanban-friendly format
            const kanbanData: ATSKanbanApplicationCard[] = applications.map((app) => ({
                id: app._id.toString(),
                applicantId: app.applicantId._id.toString(),
                name: app.applicantId.fullName || 'Unknown Applicant',
                stage: app.stage,
                rolePreferences: app.rolePreferences,
                appliedAt: app.appliedAt,
                stars: app.stars || 0
            }));

            return kanbanData;
        } catch (err) {
            console.error("Error fetching applications:", err);
            this.setStatus(500);
            throw new Error("Failed to fetch applications");
        }
    }

    /**
     * Fetches all information about an application including, preferred roles,
     * responses to role specific questions and the application stage history.
     * To perform this action, the user must either be a Team Owner or hold 
     * the `corp:hiringaccess` bindle.
     * 
     * @param teamId People Portal Team ID
     * @param applicationId Application ID
     * @returns Full Application Details
     */
    @Get("applications/{teamId}/{applicationId}/info")
    @Tags("Recruitment Actions")
    @Security("bindles", ["corp:hiringaccess"])
    @SuccessResponse(200)
    async getApplicationDetails(@Path() teamId: string, @Path() applicationId: string): Promise<ATSApplicationDetails | { error: string, message: string }> {
        try {
            const app = await Application.findOne({ _id: applicationId, teamPk: teamId })
                .populate<{ applicantId: IApplicant }>('applicantId')
                .lean()
                .exec();

            if (!app) {
                this.setStatus(404);
                return { error: "NotFound", message: "Application not found" };
            }

            return {
                id: app._id.toString(),
                applicantId: app.applicantId._id.toString(),
                name: app.applicantId.fullName || 'Unknown Applicant',
                email: app.applicantId.email || '',
                stage: app.stage,
                rolePreferences: app.rolePreferences,
                appliedAt: app.appliedAt,
                stars: app.stars || 0,

                // Detailed fields
                profile: app.applicantId.profile as any,
                responses: app.responses as any,
                stageHistory: app.stageHistory,
                ...(app.notes ? { notes: app.notes } : {}),
                ...(app.hiredRole ? { hiredRole: app.hiredRole } : {}),
                ...(app.appDevInternalPk ? { appDevInternalPk: app.appDevInternalPk } : {})
            };

        } catch (err) {
            console.error("Error fetching application details:", err);
            this.setStatus(500);
            return { error: "ServerError", message: "Failed to fetch application details" };
        }
    }

    /**
     * Updates a candidate's star rating and any notes that are added for
     * feedback. To perform this action, the user must either be a Team Owner 
     * or hold the `corp:hiringaccess` bindle.
     * 
     * @param teamId People Portal Team ID
     * @param applicationId Application ID
     * @param stars New star rating (1-5)
     * @param notes Interview Feedback in Markdown Format
     */

    @Put("applications/{teamId}/{applicationId}/feedback")
    @Tags("Recruitment Actions")
    @SuccessResponse(200)
    @Security("bindles", ["corp:hiringaccess"])
    async updateApplicationFeedback(
        @Request() req: express.Request,
        @Path() teamId: string,
        @Path() applicationId: string,
        @Body() body: { stars?: number, notes?: string }
    ) {
        try {
            const { stars, notes } = body;

            if (stars === undefined && !notes) {
                this.setStatus(400);
                return { error: "BadRequest", message: "Stars or notes must be provided" };
            }

            if (stars !== undefined && (typeof stars !== 'number' || stars < 1 || stars > 5)) {
                this.setStatus(400);
                return { error: "BadRequest", message: "Stars must be a number between 1 and 5" };
            }

            // 1. Fetch Existing Application
            const app = await Application.findOne({ _id: applicationId, teamPk: teamId });
            if (!app) {
                this.setStatus(404);
                return { error: "NotFound", message: "Application not found" };
            }

            // 2. Update Stars
            if (stars !== undefined) {
                app.stars = stars;
            }

            // 3. Update Notes (Append with Header)
            if (notes) {
                // Validate Markdown (Empty Check)
                if (!notes.trim()) {
                    this.setStatus(400);
                    return { error: "BadRequest", message: "Notes cannot be empty" };
                }

                // Validate Markdown Structure (Unclosed Fences)
                const md = new MarkdownIt({ html: false });
                const sentinel = "___MARKDOWN_SENTINEL___";
                const tokens = md.parse(notes + "\n\n" + sentinel, {});

                // If sentinel is trapped inside a code/fence block, the previous block was unclosed
                const isTrapped = tokens.some(token =>
                    (token.type === 'fence' || token.type === 'code_block') &&
                    token.content.includes(sentinel)
                );

                if (isTrapped) {
                    this.setStatus(400);
                    return { error: "BadRequest", message: "Invalid Markdown Structure" };
                }

                const authorizedUser: AuthorizedUser = req.session.authorizedUser!;
                const authorName = authorizedUser.name;

                // Format Date: "Jan 22, 2026 at 3:45pm"
                const now = new Date();
                const formattedDate = new Intl.DateTimeFormat('en-US', {
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric',
                    hour: 'numeric',
                    minute: 'numeric',
                    hour12: true
                }).format(now);

                const noteHeader = `###### ${authorName}  \n*${formattedDate}*`;
                const existingNotes = app.notes || "";
                const separator = existingNotes ? "\n\n---\n\n" : "";
                app.notes = `${noteHeader}\n\n${notes}${separator}${existingNotes}`;
            }

            // 4. Save Changes
            await app.save();
            return { success: true, stars: app.stars, notes: app.notes };
        } catch (err) {
            this.setStatus(500);
            return { error: "ServerError", message: "Failed to update stars" };
        }
    }

    /**
     * Provides a signed AWS S3 URL to access the applicant's resume
     * obtained from their profile. To obtain the resume, the user
     * must either be a team owner or hold the `corp:hiringaccess` 
     * bindle.
     * 
     * Information about the applicant will only be available if they applied
     * to the team provided in the request.
     * 
     * @param teamId People Portal Team ID
     * @param applicantId Applicant's ID
     * @returns Signed S3 Download URL
     */
    @Get("applications/{teamId}/{applicantId}/resume")
    @Tags("Recruitment Actions")
    @SuccessResponse(200)
    @Security("bindles", ["corp:hiringaccess"])
    async getApplicantUrls(@Path() teamId: string, @Path() applicantId: string) {
        try {
            const teamApplication = await Application.exists({ applicantId, teamPk: teamId });
            if (!teamApplication) {
                this.setStatus(404);
                return { error: "NotFound", message: "Applicant not found" };
            }

            const applicant = await Applicant.findById(applicantId);
            if (!applicant) {
                this.setStatus(404);
                return { error: "NotFound", message: "Applicant not found" };
            }

            const profile = applicant.profile || new Map<string, string>();
            let resumeDownloadUrl: string | undefined;

            const resumeUrl = profile.get('resumeUrl');
            if (resumeUrl) {
                try {
                    const expectedKey = `resumes/${applicant._id}.pdf`;
                    if (path.posix.normalize(resumeUrl) === expectedKey && !resumeUrl.includes("..")) {
                        const command = new GetObjectCommand({
                            Bucket: BUCKET_NAME,
                            Key: expectedKey,
                        });
                        resumeDownloadUrl = await getSignedUrl(s3Client, command, { expiresIn: 900 }); // 15 mins
                    }

                } catch (s3Error) {
                    console.error("Error signing S3 URL:", s3Error);
                    // Fallback or just ignore, maybe client can deal with the raw key or empty string?
                    // We'll leave it undefined if signing fails.
                }
            }

            return {
                resumeUrl: resumeDownloadUrl,
            };

        } catch (err) {
            console.error("Error fetching applicant URLs:", err);
            this.setStatus(500);
            return { error: "ServerError", message: "Failed to fetch applicant URLs" };
        }
    }

    /**
     * Updates the stage for an Application to a team. Stages are determined
     * by the ApplicationStage enum. Additionally, stage state changes are
     * permitted based on the following ruleset:
     * 
     * - Applications in the **Applied** stage can only be moved to **Interview** or **Rejected**
     * - Applications in the **Interview** stage can only be moved to **Potential Hire**, **Hired**, or **Rejected**
     * - Applications in the **Potential Hire** stage can only be moved to **Hired** or **Rejected**
     * - Applications in the **Hired** stage are not movable
     * - Applications in the **Rejected** stage are not movable
     * 
     * On stage changes, the applicants are notified immediately through emails and therefore, stage
     * changes require additional request information based on the following:
     * 
     * - Transitions to **Interview** need Interview Guidelines and Link for Scheduling
     * - Transitions to **Rejected** directly send an email without additional information
     * - Transitions to **Potential Hire** directly sends an email by auto populating contact info
     * - Transtions to **Hired** happen based on a ruleset:
     *   - If the user is an existing App Dev member, they are automatically added to the team
     *     and an email is sent notifying them about the change.
     * 
     *   - Otherwise, we generate a unique invite link, valid for 48 hours, and send them an email
     *     with onboarding instructions.
     * 
     * To perform this action, the user must either be a team owner or hold the `corp:hiringaccess`
     * bindle. Additionally, requests will only be allowed if the Applicant has applied to the
     * team provided in the request.
     * 
     * @param req Express Request Object
     * @param teamId People Portal Team ID
     * @param applicationId Candidate Application ID
     * @param body Stage Update Payload
     * @returns Stage Update Status
     */
    @Put("applications/{teamId}/{applicationId}/stage")
    @Tags("Recruitment Actions")
    @SuccessResponse(200, "Stage updated")
    @Security("bindles", ["corp:hiringaccess"])
    async updateApplicationStage(
        @Request() req: express.Request,
        @Path() teamId: string,
        @Path() applicationId: string,
        @Body() body: ATSUpdateApplicationStageRequest
    ) {
        try {
            const { stage, interviewLink, interviewGuidelines, hiredRole, hiredSubteamPk } = body;

            if (!req.session?.authorizedUser) {
                this.setStatus(401);
                return { error: "Unauthorized", message: "Authenticated user not found" };
            }

            /* Always scope the lookup to the team in the route. */
            const application = await Application.findOne({ _id: applicationId, teamPk: teamId });
            if (!application) {
                this.setStatus(404);
                return { error: "NotFound", message: "Application not found" };
            }

            const teamInfo = await this.getAuthorizedHiringTeam(req.session.authorizedUser, application.teamPk);
            if (!teamInfo) {
                this.setStatus(403);
                return { error: "Forbidden", message: "You do not have hiring access to this team" };
            }

            const applicant = await Applicant.findById(application.applicantId);
            if (!applicant) {
                this.setStatus(404);
                return { error: "NotFound", message: "Applicant not found" };
            }

            const currentStage = application.stage;

            // Idempotency check
            if (currentStage === stage) {
                return { message: "Stage already set", application: { id: application._id, stage: application.stage } };
            }

            // Transition Validation
            const VALID_TRANSITIONS: Record<string, ApplicationStage[]> = {
                [ApplicationStage.APPLIED]: [ApplicationStage.INTERVIEW, ApplicationStage.REJECTED],
                [ApplicationStage.INTERVIEW]: [ApplicationStage.POTENTIAL_HIRE, ApplicationStage.HIRED, ApplicationStage.REJECTED],
                [ApplicationStage.POTENTIAL_HIRE]: [ApplicationStage.HIRED, ApplicationStage.REJECTED],
                [ApplicationStage.HIRED]: [],
                [ApplicationStage.REJECTED]: []
            };

            const allowed = VALID_TRANSITIONS[currentStage] || [];
            if (!allowed.includes(stage)) {
                this.setStatus(400);
                return { error: "BadRequest", message: `Invalid transition from ${currentStage} to ${stage}` };
            }

            // Mandatory Field Checks
            if (stage === ApplicationStage.INTERVIEW) {
                if (!interviewLink) {
                    this.setStatus(400);
                    return { error: "BadRequest", message: "Interview Link is required for Interview stage" };
                }

                if (!interviewGuidelines || interviewGuidelines.length < 50 || interviewGuidelines.length > 500) {
                    this.setStatus(400);
                    return { error: "BadRequest", message: "Interview Guidelines are required (50-500 characters)" };
                }
            }

            if (stage === ApplicationStage.HIRED) {
                if (!hiredRole || !hiredSubteamPk) {
                    this.setStatus(400);
                    return { error: "BadRequest", message: "Hired Role and Subteam are required for Hired stage" };
                }

                if (!(await this.isValidHireDestination(teamInfo, hiredSubteamPk, hiredRole))) {
                    this.setStatus(400);
                    return { error: "BadRequest", message: "Hired role and subteam must belong to an active team destination" };
                }

                /* Add Hired Role and Hired Subteam PK to the Application */
                application.hiredRole = hiredRole;
                application.hiredSubteamPk = hiredSubteamPk;
            }

            // Update stage and history
            application.stage = stage;
            application.stageHistory.push({
                stage: stage,
                changedAt: new Date(),
                changedBy: `${req.session.authorizedUser?.name} (${req.session.authorizedUser?.username})`
            });

            /* Save the Application and Send Emails */
            await application.save();

            /* Get Parent Team Information and Handle Stage Specific Logic */
            if (stage === ApplicationStage.INTERVIEW) {
                await this.emailClient.send({
                    to: applicant.email,
                    cc: [req.session.authorizedUser!.email],
                    replyTo: [req.session.authorizedUser!.email],
                    subject: `Next Steps: ${teamInfo.attributes.friendlyName} Interview`,
                    templateName: "RecruitInterviewRequest",
                    templateVars: {
                        applicantName: applicant.fullName,
                        interviewerName: req.session.authorizedUser!.name,
                        teamName: teamInfo.attributes.friendlyName,
                        interviewLink: interviewLink,
                        interviewGuidelines: interviewGuidelines
                    }
                })
                /* Potential Hire deliberately notifies nobody. It is an internal
                   grouping the recruiting team uses while deciding, and the old
                   "Waitlisted for ..." mail told applicants they had been passed
                   over before that was true. Requested by the bootcamp leads,
                   2026-09-02. The RecruitPotentialHireInfo template is kept for
                   a future opt-in send. */
            } else if (stage === ApplicationStage.HIRED) {
                await this.processHiredStageTransition(
                    req.session.authorizedUser!, teamInfo,
                    application, applicant
                );
            } else if (stage === ApplicationStage.REJECTED) {
                await this.emailClient.send({
                    to: applicant.email,
                    cc: [req.session.authorizedUser!.email],
                    replyTo: [req.session.authorizedUser!.email],
                    subject: `Update on ${teamInfo.attributes.friendlyName}`,
                    templateName: "RecruitApplicationDeclined",
                    templateVars: {
                        applicantName: applicant.fullName,
                        teamName: teamInfo.attributes.friendlyName,
                    }
                })
            }

            return {
                message: "Stage updated successfully",
                application: {
                    id: application._id,
                    stage: application.stage,
                    hiredRole: application.hiredRole
                }
            };
        } catch (err) {
            console.error("Error updating application stage:", err);
            this.setStatus(500);
            return { error: "ServerError", message: "Failed to update application stage" };
        }
    }

    /**
     * Fetches all the other teams the applicant has applied to and the
     * stage they're currently in for those teams. To access this, the 
     * user needs to be a Team Owner or have the `corp:hiringaccess` bindle.
     * 
     * Information about the applicant will only be available if they applied
     * to the team provided in the request.
     * 
     * @param teamId People Portal Team ID
     * @param applicantId Candidate's Applicant ID
     * @returns List of Other Applications
     */
    @Get("applications/{teamId}/{applicantId}/otherapps")
    @Tags("Recruitment Actions")
    @SuccessResponse(200)
    @Security("bindles", ["corp:hiringaccess"])
    async getApplicantApplications(@Path() teamId: string, @Path() applicantId: string) {
        try {
            const teamApplication = await Application.exists({ applicantId, teamPk: teamId });
            if (!teamApplication) {
                this.setStatus(404);
                return { error: "NotFound", message: "Applicant not found" };
            }

            const applications = await Application.find({ applicantId: applicantId })
                .lean()
                .sort({ appliedAt: -1 })
                .exec();

            const results = await Promise.all(applications.map(async (app: any) => {
                let teamName = app.teamPk;

                try {
                    const teamInfo = await this.authentikClient.getGroupInfo(app.teamPk);
                    if (teamInfo && teamInfo.attributes && teamInfo.attributes.friendlyName) {
                        teamName = teamInfo.attributes.friendlyName;
                    } else if (teamInfo && teamInfo.name) {
                        teamName = teamInfo.name;
                    }
                } catch (e) {
                    console.error(`Failed to fetch team info for ${app.teamPk}`, e);
                }

                // Enrich role preferences with subteam names
                const rolePreferencesWithNames = await Promise.all((app.rolePreferences || []).map(async (pref: any) => {
                    let subteamName = pref.subteamPk;
                    try {
                        const subteamInfo = await this.authentikClient.getGroupInfo(pref.subteamPk);
                        subteamName = subteamInfo.attributes?.friendlyName || subteamInfo.name;
                    } catch (e) {
                        console.error(`Failed to fetch subteam info for ${pref.subteamPk}`, e);
                    }
                    return { ...pref, subteamName };
                }));

                return {
                    id: app._id,
                    teamPk: app.teamPk,
                    teamName: teamName,
                    rolePreferences: rolePreferencesWithNames,
                    stage: app.stage,
                    appliedAt: app.appliedAt,
                    hiredRole: app.hiredRole
                };
            }));

            return results;

        } catch (err) {
            console.error("Error fetching applicant applications:", err);
            this.setStatus(500);
            return { error: "ServerError", message: "Failed to fetch applicant history" };
        }
    }

    /**
     * Primary Endpoint for either an internal or external user to submit their application
     * to a team that's currently recruiting. For access to this API, the user must be 
     * authenticated via the Guest Authorization Layer.
     * 
     * This handler performs basic request and session validation, verifies that the team exists 
     * and is actively recruiting, validates the user’s selected roles and profile information, 
     * checks required application questions and responses, prevents duplicate applications, 
     * updates or creates the applicant record, sets attributes for existing internal members, 
     * and finally creates a new application.
     * 
     * @param body Team Application Request
     * @param request Express Request Object
     * @returns Application Submission Status
     */
    @Post("applications/apply")
    @Tags("Applicant Portal")
    @SuccessResponse(201, "Application submitted")
    @Security("ats_otp")
    async applyToTeam(
        @Body() body: ATSTeamApplicationRequest,
        @Request() request: express.Request
    ) {
        try {
            const { teamPk, rolePreferences, profile, responses } = body;

            // 1. Basic Validation
            if (!teamPk || !rolePreferences || rolePreferences.length === 0 || !profile) {
                this.setStatus(400);
                return {
                    error: "InvalidRequest",
                    message: "TeamPk, role preferences, and profile are required."
                };
            }

            const userEmail = request.session.tempsession?.user?.email;
            if (!userEmail) {
                this.setStatus(401);
                return { error: "Unauthorized", message: "User session not found. Please verify your email." };
            }

            // 2. Verify team exists and is recruiting
            const teamInfo: GetGroupInfoResponse = await this.authentikClient.getGroupInfo(teamPk);
            const teamStatus = await TeamRecruitingStatus.findOne({ teamPk }).exec();

            if (!teamStatus || !teamStatus.isRecruiting) {
                this.setStatus(403);
                return {
                    error: "RecruitmentClosed",
                    message: "This team is not currently accepting applications."
                };
            }

            // 3. Collect all available roles from recruiting subteams
            const allAvailableRoles = new Set<string>();
            const allQuestions = new Set<string>();

            for (const subteamPk of teamStatus.recruitingSubteamPks) {
                const config = await SubteamConfig.findOne({ subteamPk }).exec();
                if (config && config.isRecruiting) {
                    config.roles.forEach(role => allAvailableRoles.add(role));
                }
            }

            // 4. Validate all selected roles are available
            for (const pref of rolePreferences) {
                // Check if the subteam actually offers this role
                const subteamConfig = await SubteamConfig.findOne({ subteamPk: pref.subteamPk }).exec();
                if (!subteamConfig || !subteamConfig.isRecruiting || !subteamConfig.roles.includes(pref.role)) {
                    this.setStatus(400);
                    return {
                        error: "InvalidRole",
                        message: `Role '${pref.role}' is not available in the specified subteam`
                    };
                }
            }

            // 5. Collect role-specific questions for selected roles
            for (const subteamPk of teamStatus.recruitingSubteamPks) {
                const config = await SubteamConfig.findOne({ subteamPk }).exec();
                if (config && config.isRecruiting) {
                    if (config && config.isRecruiting) {
                        for (const pref of rolePreferences) {
                            if (pref.subteamPk === subteamPk) { // Only check if this preference belongs to this subteam
                                if (config.roles.includes(pref.role)) {
                                    const roleQuestions = config.roleSpecificQuestions[pref.role] || [];
                                    roleQuestions.forEach((q: string) => allQuestions.add(q));
                                }
                            }
                        }
                    }
                }
            }

            // 6. Validate personal profile
            if (!profile.resumeUrl || profile.resumeUrl.trim() === '') {
                this.setStatus(400);
                return { error: "MissingRequiredField", message: "Resume URL is required" };
            }

            if (!profile.resumeUrl.toLowerCase().endsWith('.pdf')) {
                this.setStatus(400);
                return { error: "InvalidFileType", message: "Only PDF resumes are accepted" };
            }

            if (!profile.whyAppDev || profile.whyAppDev.trim() === '') {
                this.setStatus(400);
                return { error: "MissingRequiredField", message: "Please provide 'Why App Dev'" };
            }

            if (!profile.instagramFollow || profile.instagramFollow.trim() === '') {
                this.setStatus(400);
                return { error: "MissingRequiredField", message: "Please confirm Instagram follow" };
            }

            if (profile.linkedinUrl && profile.linkedinUrl.trim() !== "") {
                try { new URL(profile.linkedinUrl) } catch {
                    this.setStatus(400);
                    return { error: "InvalidURL", message: "Please provide a valid LinkedIn URL" };
                }
            }

            if (profile.githubUrl && profile.githubUrl.trim() !== "") {
                try { new URL(profile.githubUrl) } catch {
                    this.setStatus(400);
                    return { error: "InvalidURL", message: "Please provide a valid GitHub URL" };
                }
            }

            const whyAppDevWords = profile.whyAppDev.trim().split(/\s+/).filter(Boolean).length;
            if (whyAppDevWords > MAX_WHY_APPDEV_WORDS) {
                this.setStatus(400);
                return {
                    error: "WordCountExceeded",
                    message: `'Why App Dev' must be ${MAX_WHY_APPDEV_WORDS} words or less`
                };
            }

            // 7. Validate responses - Team question
            const teamName = teamInfo.attributes.friendlyName || teamInfo.name;
            const teamQuestionKey = `Why are you interested in ${teamName}?`;
            allQuestions.add(teamQuestionKey);

            for (const question of Array.from(allQuestions)) {
                if (!responses[question] || responses[question].trim() === '') {
                    this.setStatus(400);
                    return {
                        error: "MissingResponse",
                        message: `Please answer: ${question}`
                    };
                }

                if (responses[question].length > MAX_RESPONSE_LENGTH) {
                    this.setStatus(400);
                    return {
                        error: "ResponseTooLong",
                        message: `Response too long for: ${question}. Maximum ${MAX_RESPONSE_LENGTH} characters.`
                    };
                }

                const wordCount = responses[question].trim().split(/\s+/).filter(Boolean).length;
                if (wordCount < MIN_RESPONSE_WORDS) {
                    this.setStatus(400);
                    return {
                        error: "ResponseTooShort",
                        message: `Response too short for: ${question}. Please provide at least ${MIN_RESPONSE_WORDS} words.`
                    };
                }
            }

            // 8. Check for duplicate application
            const applicant = await Applicant.findOne({ email: userEmail }).exec();

            if (!applicant) {
                this.setStatus(404);
                return { error: "ApplicantNotFound", message: "Applicant profile not found." };
            }

            const existingApp = await Application.findOne({
                applicantId: applicant._id,
                teamPk: teamPk
            }).exec();

            if (existingApp) {
                this.setStatus(409);
                return {
                    error: "DuplicateApplication",
                    message: "You have already applied to this team."
                };
            }

            // 9. Validate the server-issued resume key before persisting profile changes.
            try {
                const expectedResumeKey = `resumes/${applicant._id}.pdf`;
                if (path.posix.normalize(profile.resumeUrl) !== expectedResumeKey || profile.resumeUrl.includes("..")) {
                    this.setStatus(400);
                    return { error: "InvalidResumeKey", message: "Invalid resume upload." };
                }

                const isValidSignature = await validateS3FileSignature(profile.resumeUrl, [FILE_SIGNATURES.PDF]);
                if (!isValidSignature) {
                    this.setStatus(400);
                    return { error: "InvalidFileSignature", message: "The uploaded file is not a valid PDF." };
                }
            } catch (e) {
                console.error("Failed to validate resume", e);
                this.setStatus(500);
                return { error: "FileProcessingError", message: "Failed to process resume file." };
            }

            // 9.1 Update the already authenticated applicant.
            const updatedApplicant = await Applicant.findByIdAndUpdate(
                applicant._id,
                {
                    $set: {
                        fullName: request.session.tempsession?.user?.name || userEmail.split('@')[0],
                        profile: new Map(Object.entries(profile)),
                        updatedAt: new Date()
                    }
                },
                { new: true }
            ).exec();
            if (!updatedApplicant) {
                this.setStatus(404);
                return { error: "ApplicantNotFound", message: "Applicant profile not found." };
            }

            // 9.5 Check Previous App Dev History, if exists!
            let appDevInternalPk = null;
            try {
                const internalUser = await this.authentikClient.getUserInfoFromEmail(userEmail)
                appDevInternalPk = internalUser.pk
            } catch (_e) {
                /* Not previously in App Dev */
            }

            // 10. Create application with ordered role preferences
            const application = await Application.create({
                applicantId: updatedApplicant._id,
                teamPk: teamPk,
                rolePreferences: rolePreferences,  // Ordered array of roles
                stage: ApplicationStage.APPLIED,
                responses: new Map(Object.entries(responses)),
                appliedAt: new Date(),
                appDevInternalPk,
                stageHistory: [{
                    stage: ApplicationStage.APPLIED,
                    changedAt: new Date()
                }]
            });

            await Applicant.findByIdAndUpdate(
                updatedApplicant._id,
                { $push: { applicationIds: application._id } }
            ).exec();

            return {
                message: "Application submitted successfully",
                id: application._id
            };

        } catch (err) {
            console.error("Application submission error:", err);
            this.setStatus(500);
            return {
                error: "ServerError",
                message: "Failed to submit application"
            };
        }
    }

    /**
     * Updates the applicant's recruitment profile with common questions and
     * other updates like their Resume. To access this API, a token from the
     * Guest Authentication Layer is needed.
     * 
     * @param body Applicant Profile Payload
     * @param request Express Request Object
     * @returns Profile Update Status
     */
    @Post("profile")
    @Tags("Applicant Portal")
    @SuccessResponse(200, "Profile Updated")
    @Security("ats_otp")
    async updateProfile(@Body() body: ApplicantProfile, @Request() request: express.Request) {
        try {
            const userEmail = request.session?.tempsession?.user?.email
            if (!userEmail) {
                this.setStatus(401);
                return { error: "Unauthorized", message: "User session not found." };
            }

            const applicant = await Applicant.findOne({ email: userEmail });
            if (!applicant) {
                this.setStatus(404);
                return { error: "NotFound", message: "Applicant not found." };
            }

            // Merge existing profile with new updates
            const currentProfile = applicant.profile ? Object.fromEntries(applicant.profile) : {};

            // Immediate Signature Validation for new Resume Uploads
            if (body.resumeUrl && body.resumeUrl !== currentProfile.resumeUrl) {
                const expectedKey = `resumes/${applicant._id}.pdf`;
                if (path.posix.normalize(body.resumeUrl) !== expectedKey || body.resumeUrl.includes("..")) {
                    this.setStatus(400);
                    return { error: "InvalidResumeKey", message: "Invalid resume upload." };
                }

                const isValid = await validateS3FileSignature(body.resumeUrl, [FILE_SIGNATURES.PDF]);
                if (!isValid) {
                    this.setStatus(400);
                    return { error: "InvalidFileSignature", message: "The uploaded file is not a valid PDF." };
                }
            }

            const updatedProfile = { ...currentProfile, ...body };

            await Applicant.findOneAndUpdate(
                { email: userEmail },
                {
                    $set: {
                        profile: updatedProfile,
                        updatedAt: new Date()
                    }
                }
            );

            return { message: "Profile updated successfully" };

        } catch (err) {
            console.error("Error updating profile:", err);
            this.setStatus(500);
            return { error: "ServerError", message: "Failed to update profile" };
        }
    }

    /* ==== APPLICATION STAGE CHANGE EMAIL HELPERS ==== */
    async processHiredStageTransition(authorizedUser: AuthorizedUser, teamInfo: GetGroupInfoResponse, application: IApplication, applicant: IApplicant): Promise<void> {
        /* This helper is callable independently of tsoa middleware. Re-check the
         * authorization and destination immediately before changing membership or
         * creating an invite so direct controller calls cannot bypass ATS policy. */
        const authorizedTeam = await this.getAuthorizedHiringTeam(authorizedUser, application.teamPk);
        if (!authorizedTeam || !application.hiredRole || !application.hiredSubteamPk ||
            !(await this.isValidHireDestination(authorizedTeam, application.hiredSubteamPk, application.hiredRole))) {
            throw new Error("Unauthorized hired-stage transition");
        }

        teamInfo = authorizedTeam;
        /* If Applicant is an internal member, we do not send onboard invites! */
        const applicantEmail = applicant.email;
        let user: UserInformationBrief;
        try {
            user = await this.authentikClient.getUserInfoFromEmail(applicantEmail);
        } catch (_) {
            /* Onboard the User */
            await this.orgController.createInvite(
                {
                    session: { authorizedUser },
                    bindle: {
                        teamInfo,
                        requestedPermissions: []
                    }
                },
                {
                    inviteeName: applicant.fullName,
                    inviteeEmail: applicantEmail,
                    roleTitle: application.hiredRole!,
                    subteamPk: application.hiredSubteamPk!
                }
            );
            return;
        }

        /* Do not convert downstream membership/email failures into external invites. */
        await this.orgController.addTeamMember(application.hiredSubteamPk!, { userPk: +user.pk, roleTitle: application.hiredRole! });
        await this.emailClient.send({
            to: applicantEmail,
            cc: [authorizedUser.email],
            replyTo: [authorizedUser.email],
            subject: `Congrats! You're accepted to ${teamInfo.attributes.friendlyName}`,
            templateName: "RecruitExistingMemberAcceptance",
            templateVars: {
                inviteeName: applicant.fullName,
                invitorName: authorizedUser.name,
                teamName: teamInfo.attributes.friendlyName,
                roleTitle: application.hiredRole!,
            }
        });
    }

    /** Team-scoped ATS authorization: root owner or effective hiring bindle. */
    private async getAuthorizedHiringTeam(authorizedUser: AuthorizedUser, teamPk: string): Promise<GetGroupInfoResponse | null> {
        const teamInfo = await this.authentikClient.getGroupInfo(teamPk);
        if (!teamInfo.attributes.peoplePortalCreation || teamInfo.attributes.flaggedForDeletion) return null;
        if (authorizedUser.is_superuser) return teamInfo;

        const isOwner = authorizedUser.groups.includes(teamInfo.name);
        const permissions = BindleController.getEffectivePermissionSet(teamInfo, authorizedUser.groups);
        return isOwner || permissions.has("corp:hiringaccess") ? teamInfo : null;
    }

    /** A hire may only target a live subteam under the application's root team,
     * and the role must be configured for that exact destination. */
    private async isValidHireDestination(teamInfo: GetGroupInfoResponse, subteamPk: string, role: string): Promise<boolean> {
        if (teamInfo.attributes.flaggedForDeletion || !teamInfo.subteamPkList.includes(subteamPk)) return false;

        const destination = await this.authentikClient.getGroupInfo(subteamPk, { includeParentInfo: true });
        if (!destination.attributes.peoplePortalCreation ||
            destination.parentPk !== teamInfo.pk ||
            destination.attributes.flaggedForDeletion) return false;

        const config = await SubteamConfig.findOne({ subteamPk }).lean().exec();
        return !!config && config.roles.includes(role);
    }

    /* === HELPER METHODS === */
    async addSubteamToRecruiting(@Path() teamId: string, @Path() subteamId: string) {
        const updatedTeam = await TeamRecruitingStatus.findOneAndUpdate(
            { teamPk: teamId },
            {
                $addToSet: { recruitingSubteamPks: subteamId },
                teamPk: teamId
            },
            { upsert: true, new: true }
        ).lean().exec();

        // Set isRecruiting based on array length
        if (updatedTeam.recruitingSubteamPks.length > 0 && !updatedTeam.isRecruiting) {
            await TeamRecruitingStatus.updateOne(
                { teamPk: teamId },
                { isRecruiting: true }
            );
            updatedTeam.isRecruiting = true;
        }

        /* After every write, never before: invalidating first leaves a window in
           which a concurrent read repopulates the cache from pre-update rows. */
        await RedisClient.delete(OPEN_TEAMS_CACHE_KEY);
        return updatedTeam;
    }

    async removeSubteamFromRecruiting(@Path() teamId: string, @Path() subteamId: string) {
        const updatedTeam = await TeamRecruitingStatus.findOneAndUpdate(
            { teamPk: teamId },
            { $pull: { recruitingSubteamPks: subteamId } },
            { new: true }
        ).lean().exec();

        if (!updatedTeam) {
            this.setStatus(404);
            return { error: "Not Found", message: `Team ${teamId} not found` };
        }

        // Set isRecruiting to false if no subteams left
        if (updatedTeam.recruitingSubteamPks.length === 0 && updatedTeam.isRecruiting) {
            await TeamRecruitingStatus.updateOne(
                { teamPk: teamId },
                { isRecruiting: false }
            );
            updatedTeam.isRecruiting = false;
        }

        await RedisClient.delete(OPEN_TEAMS_CACHE_KEY);
        return updatedTeam;
    }

    /**
     * Per-team recruitment totals for the executive console, one row per active
     * team with a count for each application stage.
     *
     * Teams come from the groups list, which excludes archived ones, so a team
     * that has been archived drops off this page rather than lingering with a
     * frozen count. Teams that have never received an application are still
     * listed, with zeroes, because "nobody applied" is the thing an executive
     * most wants to see.
     *
     * Counts are aggregated in one grouped query rather than a count per team
     * per stage, which would be teams x stages round trips.
     *
     * @returns One row per active team, plus the stage keys used
     */
    @Get("teamstats")
    @Tags("Recruitment Actions")
    @SuccessResponse(200)
    @Security("executive")
    async getTeamRecruitmentStats() {
        const [teamsRes, grouped] = await Promise.all([
            this.authentikClient.getGroupsList({ limit: 500 }),
            Application.aggregate([
                { $group: { _id: { teamPk: "$teamPk", stage: "$stage" }, count: { $sum: 1 } } }
            ]).exec(),
        ]);

        /* teamPk -> stage -> count */
        const byTeam = new Map<string, Record<string, number>>();
        for (const row of grouped as { _id: { teamPk: string, stage: string }, count: number }[]) {
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
