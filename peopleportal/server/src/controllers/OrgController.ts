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

import * as express from 'express';
import path from 'path';
import { Error, FlattenMaps, HydratedDocument, Types } from 'mongoose';
import { Request, Body, Controller, Get, Patch, Path, Post, Queries, Route, SuccessResponse, Put, Security, Delete, Tags, Query } from "tsoa";
import { AddGroupMemberRequest, GetGroupInfoResponse, GetTeamsListResponse, GetUserListOptions, GetUserListResponse, RemoveGroupMemberRequest, SeasonType, TeamType, UserInformationBrief, GetTeamsForUsernameResponse, AuthentikClientError, CreateUserRequest, ServiceSeasonType, AuthentikClientErrorType, TeamInformationDetail, GetTeamsListDetailResponse, UserInformationPartial, TeamAttributeDefinition, TeamInformationBrief, GetTeamMembershipsResponse } from "../clients/AuthentikClient/models";
import { AuthentikClient } from "../clients/AuthentikClient";
import { Invite } from "../models/Invites";
import { EmailClient } from "../clients/EmailClient";
import { SharedResourceClient } from '../clients';
import { ENABLED_SHARED_RESOURCES, ENABLED_TEAMSETTING_RESOURCES, ENABLED_SERVICE_TEAMS, TEAM_TYPE_CONFIGS } from '../config';
import { SlackClient } from '../clients/SlackClient';
import { AWSClient } from '../clients/AWSClient';
import { checkPhotoHasFace } from '../clients/PhotoCheckClient/PhotoCheckClient';
import { s3Client, BUCKET_NAME } from '../clients/AWSClient/S3Client';
import { GetObjectCommand, PutObjectCommand, CopyObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { sanitizeUserFullName, validateTeamName, capitalizeString, validatePersonName } from '../utils/strings';
import { BindleController, EnabledBindlePermissions } from '../controllers/BindleController';
import { AuthorizedUser } from '../clients/OpenIdClient';
import { executiveAuthVerify } from '../auth';
import { TeamCreationRequest, TeamCreationRequestStatus, ITeamCreationRequest } from '../models/TeamCreationRequest';
import { CustomValidationError, ResourceAccessError, SharedResourcesError, describeUnknownError } from '../utils/errors';
import { ExpressRequestBindleExtension } from '../types/express';
import { validateS3FileSignature, FILE_SIGNATURES, getS3ObjectBytes, deleteTempAvatar } from '../utils/s3-validation';
import { signAvatarUrl, invalidateAvatarUrlCache } from '../utils/avatars';
import { normalizeLinkedInProfileUrl } from '../utils/linkedin';
import MarkdownIt from "markdown-it";
import zxcvbn from 'zxcvbn';
import { IUserReview, UserReview } from '../models/UserReview';

import type { DocumentJSON } from "../utils/types";

export interface EnabledRootSettings {
    [key: string]: boolean
}

export interface RootTeamSettingMap {
    [key: string]: RootTeamSettingInfo
}

export interface RootTeamSettingInfo {
    friendlyName: string,
    description: string,
}

interface APIGetCommonTeamsResponse {
    teams: TeamInformationBrief[];
}

interface APIGetReviewResponse {
    review: DocumentJSON<IUserReview> | null;
}

interface APIGetReviewsOptions {
    before?: Date;
    after?: Date;
    teamId?: Date;

    sortBy?: "updatedAt" | "rating";
    ascending?: boolean;

    offset?: number;
    limit?: number;

    getAggregateData?: boolean;
}

interface APIGetReviewsResponse {
    reviews: DocumentJSON<IUserReview>[];
    aggregateData?: {
        totalReviews: number,
        averageRating: number
    };
}

interface APICreateReviewRequest {
    rating: number;
    title: string;
    content: string;
    teamId: string;
}

interface APICreateReviewResponse {
    review: DocumentJSON<IUserReview>;
}

/* Define Request Interfaces */
interface APIUserInfoResponse extends UserInformationBrief {

}

interface APICreateSubTeamRequest {
    friendlyName: string,
    description: string
}

export interface APICreateTeamRequest {
    friendlyName: string,
    teamType: TeamType,
    seasonType: SeasonType,
    seasonYear: number,
    description: string,
    teamStartDate?: string,
    teamEndDate: string,
    requestorRole: string
}

interface APIUpdateTeamRequest {
    /** @minLength 1 */
    friendlyName?: string,
    /** @minLength 1 */
    description?: string,
    teamStartDate?: string,
    teamEndDate?: string,
}

interface APITeamInfoResponse {
    team: GetGroupInfoResponse,
    subteams: GetGroupInfoResponse[]
}

interface APITeamMemberAddResponse {
    coreAdditionComplete: boolean,
}

interface APITeamInviteCreateRequest {
    inviteeName: string;
    inviteeEmail: string;
    roleTitle: string;
    subteamPk: string;
}

interface APITeamInviteGetResponse {
    inviteName: string;
    inviteEmail: string;
    roleTitle: string;
    teamPk: string;
    subteamPk: string;
    inviterPk: number;
    expiresAt: Date;
    slackInviteLink: string;
}

interface APITeamInviteAcceptRequest {
    password: string;
    major: string;
    expectedGrad: Date;
    phoneNumber: string;
    linkedinUrl?: string;
    avatarKey?: string;
}

interface APIGetTeamsListOptions {
    search?: string,
    subgroupsOnly?: boolean,
    includeUsers?: boolean,
    /** When false (default), archived teams are excluded from the results. @default false */
    includeArchived?: boolean,

    /** @default 20 */
    limit?: number;
    /** Base-64 Encoded Cursor */
    cursor?: string;
}


interface APIGetOrgChartResponse {
    root: OrgChartNode;
}

interface OrgChartNode {
    id: string; // PK or unique ID
    name: string;
    type: "ROOT_MEMBER" | "DIVISION" | "PERSON";
    attributes?: {
        friendlyName?: string;
        description?: string;
        role?: string;              // The person's role (e.g., "President", "Developer")
        email?: string;
        teamContext?: string[];     // Breadcrumb: ["SubteamName", "RootTeamName"] for display
        [key: string]: any;
    };
    children?: OrgChartNode[];
    siblings?: OrgChartNode[];      // Horizontal siblings at the same level (for frontend to render horizontally)
    isPrimaryExpansion?: boolean;   // If true, this person is the expansion anchor
    hasChildren?: boolean;          // For lazy loading indicator
}


interface APIGetOrgChartOptions {
    /** 
     * If true, recursively fetches all subteams and their members. 
     * If false, returns only the Division Apex structure (without subteams populated).
     * @default true
     */
    expandAll?: boolean;
}

interface ExpressRequestAuthUserShim {
    session: { authorizedUser: AuthorizedUser }
}

interface ExpressRequestBindleShim {
    bindle: ExpressRequestBindleExtension
}

interface APITeamCreationRequestResponse {
    _id: string;
    requestorPk: number;
    requestorName: string;
    requestorEmail: string;
    createTeamRequest: APICreateTeamRequest;
    status: TeamCreationRequestStatus;
    createdAt: Date;
}

/**
 * Validates a graduation date string.
 * Accepts ISO date strings in the format YYYY-MM-DD.
 */
function isValidGradDate(value: string): boolean {
    const match = value.match(/^(Spring|Summer|Fall|Winter)-(\d{4})$/);
    if (!match) return false;
    const year = parseInt(match[2]!, 10);
    return year >= 2000 && year <= 2100;
}

@Route("/api/org")
export class OrgController extends Controller {
    private teamSettingList: { [key: string]: RootTeamSettingMap } = {}
    private sharedResources: SharedResourceClient[];
    private readonly authentikClient;
    private readonly emailClient;
    private readonly slackClient;

    constructor() {
        super()
        this.authentikClient = new AuthentikClient()
        this.emailClient = new EmailClient()
        this.slackClient = ENABLED_SHARED_RESOURCES.slackClient as SlackClient
        this.sharedResources = Object.values(ENABLED_SHARED_RESOURCES)

        for (const teamSettingResource of Object.values(ENABLED_TEAMSETTING_RESOURCES)) {
            const resourceName = teamSettingResource.getResourceName()
            this.teamSettingList[resourceName] = teamSettingResource.getSupportedSettings()
        }
    }

    private validateTeamDateRange(startDate: string, endDate: string) {
        const parsedStart = new Date(startDate);
        const parsedEnd = new Date(endDate);

        if (Number.isNaN(parsedStart.getTime())) {
            throw new CustomValidationError(400, "Invalid team start date");
        }

        if (Number.isNaN(parsedEnd.getTime())) {
            throw new CustomValidationError(400, "Invalid team end date");
        }

        if (parsedStart > parsedEnd) {
            throw new CustomValidationError(400, "Team start date must be on or before team end date");
        }
    }

    /**
     * Fetches the list of people in the organization.
     * Uses the Authentik Client for internal filtering.
     * 
     * @param options Options for searching and pagination
     * @returns Paginated List of People in the Organization
     */
    @Get("people")
    @Tags("People Management")
    @SuccessResponse(200)
    @Security("oidc")
    async getPeople(@Queries() options: GetUserListOptions): Promise<GetUserListResponse> {
        const userList = await this.authentikClient.getUserList(options)

        /* Enrich with Avatars */
        await Promise.all(userList.users.map(async (user) => {
            user.avatar = await signAvatarUrl(user.pk, user.attributes.avatar);
        }));

        return userList;
    }

    /**
     * Fetches basic user information and additional attributes set
     * by People Portal, given the user's primary key ID.
     * 
     * @param personId Internal User ID
     * @returns User Information
     */
    @Get("people/{personId}")
    @Tags("People Management")
    @SuccessResponse(200)
    @Security("oidc")
    async getPersonInfo(@Path() personId: number): Promise<APIUserInfoResponse> {
        const authentikUserInfo = await this.authentikClient.getUserInfo(personId)
        authentikUserInfo.avatar = await signAvatarUrl(personId.toString(), authentikUserInfo.attributes.avatar);

        return {
            ...authentikUserInfo
        }
    }

    /**
     * Gets all common teams between the requesting user and
     * another person given their id.
     * 
     * @param req express Request object
     * @param personId id of the person to get common teams.
     * @returns APIGetCommonTeamsResponse
     */
    @Get("people/{personId}/commonteams")
    @Tags("People Management")
    @SuccessResponse(200)
    @Security("oidc")
    async getCommonTeams(
        @Request() req: express.Request,
        @Path() personId: number
    ): Promise<APIGetCommonTeamsResponse> {
        // Get user info
        const userInfo = await this.authentikClient.getUserInfo(personId)
            .catch((e) => {
                throw new ResourceAccessError(400, `Failed to fetch user info: ${e}`)
            });

        // Get common teams
        const authorizedUser = req.session.authorizedUser!;

        const [userTeams, requesterTeams] = await Promise.all([
            this.authentikClient.getRootTeamsForUsername(userInfo.username)
                .catch((e) => {
                    throw new ResourceAccessError(400, `Failed to fetch user teams: ${e}`)
                }),
            this.authentikClient.getRootTeamsForUsername(authorizedUser.username)
                .catch((e) => {
                    throw new ResourceAccessError(400, `Failed to fetch user teams: ${e}`)
                })
        ]);

        const commonTeams = userTeams.teams.filter((t) =>
            requesterTeams.teams.find((team) => team.pk === t.pk) !== undefined
        );

        // Return team info
        return { teams: commonTeams };
    }

    /**
     * Gets the requestor's review (if it exists) of a user
     * for a certain team.
     * 
     * @param req express Request object
     * @param personId id of the target person
     * @param teamId id of the target team
     * @returns APIGetReviewResponse
     */
    @Get("people/{personId}/reviews/{teamId}")
    @Tags("People Management")
    @SuccessResponse(200)
    @Security("bindles", ["corp:reviewaccess"])
    async getReview(
        @Request() req: express.Request,
        @Path() personId: number,
        @Path() teamId: string
    ): Promise<APIGetReviewResponse> {
        // 0. Ensure requester and user id are not equal
        if (req.session.authorizedUser!.pk === personId) {
            throw new CustomValidationError(403, "Can not access own reviews.");
        }
        // 1. Ensure user exists
        const userInfo = await this.authentikClient.getUserInfo(personId)
            .catch((e) => {
                throw new ResourceAccessError(400, `Failed to fetch user info: ${e}`)
            });

        // 2. Ensure user is in the target team
        let userTeams: GetTeamsForUsernameResponse;
        try {
            userTeams = await this.authentikClient.getRootTeamsForUsername(userInfo.username);
        } catch (e) {
            console.error(e);
            throw new ResourceAccessError(500, "Failed to get user team membership");
        }

        if (userTeams.teams.findIndex((team) => team.pk === teamId) === -1) {
            // User is not in target team.
            throw new CustomValidationError(403, "User is not in target team.");
        }

        // 3. Find document and return it.
        try {
            const review = await UserReview.findOne({
                userId: personId,
                creatorId: req.session.authorizedUser!.pk,
                teamId: teamId,
            }).lean().exec();
            return { review: review };
        } catch (e) {
            console.error(e);
            throw new ResourceAccessError(500, "Failed to fetch review");
        }
    }


    /**
     * Gets a list of reviews made on the given person. Requires
     * executive permissions. Options can be given to filter,
     * sort, and attain aggregate data such as average rating
     * and total review count (with the filters applied).
     * 
     * @param personId pk of the person.
     * @param options APIGetReviewsOptions
     * @returns APIGetReviewsResponse
     */
    @Get("people/{personId}/reviews")
    @Tags("People Management")
    @SuccessResponse(200)
    @Security("executive")
    async getReviews(
        @Path() personId: number,
        @Queries() options: APIGetReviewsOptions
    ): Promise<APIGetReviewsResponse> {

        // Max 100 reviews returned.
        const limit = Math.min(100, options.limit ?? 10);

        if (limit < 0) {
            throw new CustomValidationError(400, "Limit can not be negative.");
        }

        if (options.before && options.after && options.before.getTime() < options.after.getTime()) {
            throw new CustomValidationError(400, "The 'before' timestamp can not be before the 'after' timestamp.");
        }

        // Build query
        const filters: Record<string, any> = {
            userId: personId,
            ...(options.before !== undefined || options.after !== undefined) && {
                updatedAt: {
                    ...(options.before !== undefined && { $lte: options.before }),
                    ...(options.after !== undefined && { $gte: options.after }),
                }
            },
            ...(options.teamId !== undefined && { teamId: options.teamId }),
        };

        // Just return the aggregate data
        if (limit === 0) {
            if (options.getAggregateData === false) {
                return { reviews: [] };
            }
            try {
                const result = await UserReview.aggregate([
                    { $match: filters },
                    {
                        $facet: {
                            stats: [
                                {
                                    $group: {
                                        _id: null,
                                        average: { $avg: "$rating" },
                                        count: { $sum: 1 }
                                    }
                                }
                            ]
                        }
                    }
                ]).exec();
                const { average, count } = result[0]?.stats[0] ?? { average: 0, count: 0 };

                return { reviews: [], aggregateData: { totalReviews: count, averageRating: average } };
            } catch (e) {
                throw new ResourceAccessError(500, `Failed to fetch reviews: ${e}`);
            }
        }

        let query = UserReview.find(filters);

        if (options.sortBy !== undefined) {
            const ascending = (options.ascending ?? true) ? 'asc' : 'desc';
            query = query.sort({ [options.sortBy]: ascending });
        }

        query = query.skip(options.offset ?? 0).limit(limit);

        try {
            if (options.getAggregateData === false) {
                const results = await query.lean().exec();
                return { reviews: results };
            }

            const [results, aggregateResult] = await Promise.all([
                query.lean().exec(),
                UserReview.aggregate([
                    { $match: filters },
                    {
                        $facet: {
                            stats: [{
                                $group: {
                                    _id: null,
                                    average: { $avg: "$rating" },
                                    count: { $sum: 1 }
                                }
                            }]
                        }
                    }
                ]).exec()
            ]);

            const { average, count } = aggregateResult[0]?.stats[0] ?? { average: 0, count: 0 };
            return { reviews: results, aggregateData: { totalReviews: count, averageRating: average } };

        } catch (e) {
            throw new ResourceAccessError(500, `Failed to fetch reviews: ${e}`);
        }
    }

    /**
     * Write an internal review for a person. the requestor and person
     * must both be in body.teamId and the requestor must have the
     * corp:reviewaccess bindle in that team.
     * 
     * @param req express Request object
     * @param personId pk of the person being reviewed
     * @param body APICreateReviewRequest instance
     * @returns APICreateReviewResponse instance
     */
    @Post("people/{personId}/reviews")
    @Tags("People Management")
    @SuccessResponse(201)
    // First scope is teamId path (see bindlesAuthVerify)
    @Security("bindles", ["body.teamId", "corp:reviewaccess"])
    async writeReview(
        @Request() req: express.Request,
        @Path() personId: number,
        @Body() body: APICreateReviewRequest
    ): Promise<APICreateReviewResponse> {
        // User refers to the personId, requester refers to the user making the request.

        // 0. Ensure user and requester aren't the same
        if (personId === req.session.authorizedUser!.pk) {
            throw new CustomValidationError(403, "You can not review yourself.");
        }

        // 1. Ensure user exists
        const userInfo = await this.authentikClient.getUserInfo(personId)
            .catch((e) => { throw new ResourceAccessError(400, `Failed to fetch user info: ${e}`) });

        // 2. Ensure user is in the target team
        let userTeams: GetTeamsForUsernameResponse;
        try {
            userTeams = await this.authentikClient.getRootTeamsForUsername(userInfo.username);
        } catch (e) {
            console.error(e);
            throw new ResourceAccessError(500, "Failed to get user team membership");
        }

        if (userTeams.teams.findIndex((team) => team.pk === body.teamId) === -1) {
            // User is not in target team.
            throw new CustomValidationError(403, "User is not in target team.");
        }

        // 3. Requester is authorized to write the review. Check if a review was already made for this team.
        try {
            const existingReview = await UserReview.findOne({
                userId: personId,
                creatorId: req.session.authorizedUser!.pk,
                teamId: body.teamId,
            }).lean().exec();
            if (existingReview !== null) {
                throw new CustomValidationError(400, "Review already created.");
            }
        } catch (e) {
            console.error(e);
            if (e instanceof CustomValidationError) {
                throw e;
            }
            throw new ResourceAccessError(500, "Failed to fetch review.");
        }

        // 4. Create review.
        let review: HydratedDocument<IUserReview>;
        try {
            review = await UserReview.create({
                userId: personId,
                creatorId: req.session.authorizedUser!.pk,
                ...body,
            });
        } catch (e) {
            if (e instanceof Error.ValidationError) {
                throw new CustomValidationError(400, `Invalid Review: ${e}`);
            }
            console.error(e);
            throw new ResourceAccessError(500, "Failed to create review");
        }

        return { review: review.toJSON() };
    }

    /**
     * Edit an existing review for a person. The requestor must
     * have the corp:reviewaccess bindle in the team being requested.
     * Only permits the review author to edit the review.
     * 
     * @param req express Request object
     * @param personId pk of the person being reviewed
     * @param reviewId ObjectID of the review
     * @param body APICreateReviewRequest instance
     * @returns APICreateReviewResponse instance
     */
    @Put("people/{personId}/reviews/{reviewId}")
    @Tags("People Management")
    @SuccessResponse(200)
    // First scope is teamId path (see bindlesAuthVerify)
    @Security("bindles", ["body.teamId", "corp:reviewaccess"])
    async editReview(
        @Request() req: express.Request,
        @Path() personId: number,
        @Path() reviewId: string,
        @Body() body: APICreateReviewRequest
    ): Promise<APICreateReviewResponse> {
        // 0. Ensure user and requester aren't the same
        if (personId === req.session.authorizedUser!.pk) {
            throw new CustomValidationError(403, "You can not review yourself.");
        }

        // 1. Get Review
        const review = await UserReview.findById(reviewId).exec()
            .catch((e) => { throw new ResourceAccessError(500, `Failed to fetch review: ${e}`) });

        if (review === null) {
            throw new CustomValidationError(404, "Review does not exist");
        }

        // 2. Validation Checks
        // Ensure creator and user ids match
        if (review.creatorId !== req.session.authorizedUser!.pk) {
            // Return does not exist for obscurity
            throw new CustomValidationError(404, "Review does not exist");
        }
        if (review.userId !== personId) {
            throw new CustomValidationError(400, "User ID does not match");
        }

        // Ensure teamId matches review
        if (review.teamId !== body.teamId) {
            throw new CustomValidationError(400, "Team ID does not match.");
        }

        // 3. Update Review
        review.rating = body.rating;
        review.title = body.title;
        review.content = body.content;
        await review.save();

        // 4. Return updated document
        return { review: review.toJSON() };
    }

    /**
     * Delete an existing review for a person.
     * Permites either the author or any executives to 
     * delete the review.
     * 
     * @param req express Request object
     * @param personId pk of the person being reviewed
     * @param reviewId ObjectID of the review
     * @returns void
     */
    @Delete("people/{personId}/reviews/{reviewId}")
    @Tags("People Management")
    @SuccessResponse(204)
    @Security("oidc")
    async deleteReview(
        @Request() req: express.Request,
        @Path() personId: number,
        @Path() reviewId: string
    ) {
        // 1. Get Review
        const review = await UserReview.findById(reviewId).exec()
            .catch((e) => { throw new ResourceAccessError(500, `Failed to fetch review: ${e}`) });

        if (review === null) {
            throw new CustomValidationError(404, "Review does not exist");
        }

        // 2. Validation Checks
        /* The review must belong to the person named in the path. Checked before
           the authorization branch, and reported as a 404 like every other
           rejection here, so the endpoint never confirms a review's existence. */
        if (review.userId !== personId) {
            throw new CustomValidationError(404, "Review does not exist");
        }

        // Ensure creator and user ids match
        if (review.creatorId !== req.session.authorizedUser!.pk) {
            /* Allow exec/superuser to delete other's reviews. executiveAuthVerify
               is async and REJECTS for non-executives rather than returning false,
               so it must be awaited inside a try/catch. Negating the bare promise
               is always false, which silently grants every caller. */
            let isExecutive = false;
            try {
                isExecutive = await executiveAuthVerify(req, [], true);
            } catch {
                isExecutive = false;
            }

            if (!isExecutive) {
                // Return does not exist for obscurity
                throw new CustomValidationError(404, "Review does not exist");
            }
        }

        // 3. Delete Review
        try {
            await review.deleteOne().exec();
        } catch (e) {
            throw new ResourceAccessError(500, `Failed to delete review: ${e}`);
        }
    }

    /**
     * Updates the profile attributes of a user. Only the authenticated user
     * can update their own profile. Supports updating major, expected graduation
     * date, phone number, and avatar.
     * 
     * @param req Express Request Object
     * @param personId Internal User ID
     * @param body Update Request Body
     */
    @Patch("people/{personId}")
    @Tags("People Management")
    @SuccessResponse(200)
    @Security("oidc")
    async updatePersonInfo(
        @Request() req: express.Request,
        @Path() personId: number,
        @Body() body: {
            major?: string;
            expectedGrad?: string;
            phoneNumber?: string;
            linkedinUrl?: string;
            avatarKey?: string;
        }
    ): Promise<{ success: boolean }> {
        const authorizedUser = (req as any).session.authorizedUser as AuthorizedUser;
        const callerInfo = await this.authentikClient.getUserInfoFromEmail(authorizedUser.email);

        if (Number(callerInfo.pk) !== personId) {
            this.setStatus(403);
            throw new CustomValidationError(403, "You can only update your own profile.");
        }

        const updatePayload: Record<string, any> = {};
        if (body.major !== undefined) {
            if (body.major === "") {
                updatePayload.major = "";
            } else {
                if (body.major.length > 100) throw new CustomValidationError(400, "Invalid major.");
                updatePayload.major = capitalizeString(body.major);
            }
        }

        if (body.expectedGrad !== undefined) {
            if (body.expectedGrad === "") {
                updatePayload.expectedGrad = "";
            } else {
                if (!isValidGradDate(body.expectedGrad)) throw new CustomValidationError(400, "Invalid graduation date.");
                updatePayload.expectedGrad = body.expectedGrad;
            }
        }

        if (body.phoneNumber !== undefined) {
            if (body.phoneNumber === "") {
                updatePayload.phoneNumber = "";
            } else {
                const digits = body.phoneNumber.replace(/[\s\-().+]/g, "");
                if (!/^\d{10,15}$/.test(digits)) throw new CustomValidationError(400, "Invalid phone number.");
                updatePayload.phoneNumber = body.phoneNumber;
            }
        }

        if (body.linkedinUrl !== undefined) {
            const normalizedLinkedinUrl = normalizeLinkedInProfileUrl(body.linkedinUrl);
            if (normalizedLinkedinUrl === null) {
                throw new CustomValidationError(400, "Please enter a valid LinkedIn profile URL.");
            }
            updatePayload.linkedinUrl = normalizedLinkedinUrl;
        }

        if (Object.keys(updatePayload).length > 0) {
            await this.authentikClient.updateUserAttributes(personId, updatePayload);
        }

        // Handle avatar update
        if (body.avatarKey) {
            const avatarKey = path.posix.normalize(body.avatarKey);
            const expectedPrefix = `avatars/temp/profile/${personId}/`;
            if (!avatarKey.startsWith(expectedPrefix) || avatarKey.includes('..')) {
                throw new CustomValidationError(400, "Invalid avatar key");
            }

            try {
                const filename = path.posix.basename(avatarKey);
                const ext = filename.includes('.') ? filename.split('.').pop()?.toLowerCase() : '';
                const allowedExtensions = ['png', 'jpg', 'jpeg', 'gif', 'webp'];
                if (!ext || !allowedExtensions.includes(ext)) {
                    throw new CustomValidationError(400, "Invalid avatar file extension.");
                }

                const newKey = `avatars/${personId}/avatar.${ext}`;

                // Validate magic bytes
                const allowedAvatars = [FILE_SIGNATURES.PNG, FILE_SIGNATURES.JPEG, FILE_SIGNATURES.GIF, FILE_SIGNATURES.WEBP];
                const isValid = await validateS3FileSignature(avatarKey, allowedAvatars);
                if (!isValid) {
                    await deleteTempAvatar(avatarKey);
                    throw new CustomValidationError(400, "Invalid image file.");
                }

                const imageBytes = await getS3ObjectBytes(avatarKey);
                if (!imageBytes) {
                    await deleteTempAvatar(avatarKey);
                    throw new CustomValidationError(400, "Upload failed, please try again.");
                }

                const faceCheckResult = await checkPhotoHasFace(imageBytes);
                if (faceCheckResult.passed === false) {
                    await deleteTempAvatar(avatarKey);
                    if (faceCheckResult.reason === "file_too_large") {
                        throw new CustomValidationError(400, "File is too large. Please upload an image smaller than 1 MB.");
                    }
                    if (faceCheckResult.reason === "image_dimensions_too_large") {
                        throw new CustomValidationError(400, "Image dimensions are too large. Please use an image no larger than 4096 x 4096 pixels.");
                    }
                    throw new CustomValidationError(400, "Please upload a photo of only your face.");
                }

                // Capture old key before overwriting
                const existingUser = await this.authentikClient.getUserInfo(personId);
                const oldAvatarKey = existingUser.attributes.avatar;

                // Copy new avatar into place
                await s3Client.send(new CopyObjectCommand({
                    Bucket: BUCKET_NAME,
                    CopySource: `${BUCKET_NAME}/${avatarKey}`,
                    Key: newKey
                }));

                // Commit: point DB at new avatar
                await this.authentikClient.updateUserAttributes(personId, { avatar: newKey });
                invalidateAvatarUrlCache(personId);

                // Best-effort cleanup — failures here are non-fatal
                if (oldAvatarKey && oldAvatarKey !== newKey) {
                    try {
                        await s3Client.send(new DeleteObjectCommand({ Bucket: BUCKET_NAME, Key: oldAvatarKey }));
                    } catch (e) {
                        console.error("Failed to delete old avatar", e);
                    }
                }

                try {
                    await s3Client.send(new DeleteObjectCommand({ Bucket: BUCKET_NAME, Key: avatarKey }));
                } catch (e) {
                    console.error("Failed to delete temp avatar after commit", e);
                }

            } catch (e) {
                if (e instanceof CustomValidationError) throw e;
                console.error("Failed to process avatar update", e);
                throw new CustomValidationError(500, "Failed to update avatar.");
            }
        }

        return { success: true };
    }

    /**
     * Generates a pre-signed URL for uploading a profile picture for an
     * authenticated user editing their own profile.
     * 
     * @param req Express Request Object
     * @param fileName Name of the file
     * @param contentType MIME type of the file
     */
    @Get("people/avatar/profile-upload-url")
    @Tags("People Management")
    @SuccessResponse(200)
    @Security("oidc")
    async getProfileAvatarUploadUrl(
        @Request() req: express.Request,
        @Query() fileName: string,
        @Query() contentType: string
    ): Promise<{ uploadUrl: string, key: string, fields: Record<string, string> }> {
        const authorizedUser = (req as any).session.authorizedUser as AuthorizedUser;
        const callerInfo = await this.authentikClient.getUserInfoFromEmail(authorizedUser.email);

        const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
        if (!allowedTypes.includes(contentType)) {
            throw new CustomValidationError(400, "Invalid file type. Only images are allowed.");
        }

        const safeFileName = path.posix.basename(fileName);
        const ext = safeFileName.includes('.') ? safeFileName.split('.').pop()?.toLowerCase() : '';
        const allowedExtensions = ['png', 'jpg', 'jpeg', 'gif', 'webp'];
        if (!ext || !allowedExtensions.includes(ext)) {
            throw new CustomValidationError(400, "Invalid file name. Only image extensions are allowed.");
        }

        const timestamp = Date.now();
        const key = `avatars/temp/profile/${callerInfo.pk}/${timestamp}.${ext}`;

        const { url, fields } = await createPresignedPost(s3Client, {
            Bucket: BUCKET_NAME,
            Key: key,
            Conditions: [
                ["content-length-range", 0, 819200],
                ["eq", "$Content-Type", contentType],
            ],
            Fields: { "Content-Type": contentType },
            Expires: 300,
        });

        return { uploadUrl: url, key, fields };
    }

    /**
     * Fetches the list of all People Portal teams in the organization that
     * the user is a member of. Uses the username query parameter for user
     * information. **List size is capped to 1000.**
     * 
     * **Code Duplication Warning:**
     * This API is the same as `/api/org/myteams` except that the latter uses
     * the session cookie to obtain the username. The latter API is still
     * kept and will not be deprecated considering breaking changes.
     * 
     * @param req Express Request Object
     * @param username People Portal Username
     * @returns Teams user is a member of
     */
    @Get("people/{username}/memberof")
    @Tags("Team Management")
    @SuccessResponse(200)
    @Security("oidc")
    async getUserRootTeams(@Request() req: express.Request, @Path() username: string): Promise<GetTeamsForUsernameResponse> {
        return await this.authentikClient.getRootTeamsForUsername(username)
    }

    /**
     * Fetches all subteam and root memberships for the user with parents.
     */
    @Get("people/{username}/memberships")
    @Tags("Team Management")
    @SuccessResponse(200)
    @Security("oidc")
    async getUserTeamMemberships(@Path() username: string): Promise<GetTeamMembershipsResponse> {
        return await this.authentikClient.getTeamMembershipsForUsername(username)
    }

    /**
     * Provides the list of available root team settings supported
     * by People Portal teams.
     * 
     * @returns Team Settings List
     */
    @Get("teamsettings")
    @Tags("Team Configuration")
    @SuccessResponse(200)
    @Security("oidc")
    async listRootTeamSettings() {
        return this.teamSettingList;
    }

    /**
     * Fetches the list of all People Portal teams in the organization.
     * API includes a Base64-encoded cursor for pagination to assist with
     * post fetch filtering from Authentik and infinite scrolling.
     * 
     * @param options Get Team List Options
     * @returns Cursor-Paginated List of Teams
     */
    @Get("teams")
    @Tags("Team Management")
    @SuccessResponse(200)
    @Security("oidc")
    async getTeams(@Queries() options: APIGetTeamsListOptions): Promise<GetTeamsListResponse> {
        return await this.authentikClient.getGroupsList(options)
    }

    @Get("orgchart")
    @Tags("Team Management")
    @SuccessResponse(200)
    @Security("oidc")
    async getOrgChart(@Queries() options?: APIGetOrgChartOptions): Promise<APIGetOrgChartResponse> {
        const shouldExpandAll = options?.expandAll ?? true;

        // 1. Fetch Root Team (Exec Board)
        let execTeam: any;
        try {
            const pk = await this.authentikClient.getGroupPkFromName("ExecutiveBoardMembers");
            execTeam = await this.authentikClient.getGroupInfo(pk, { includeUsers: true });
        } catch {
            return { root: { id: "error", name: "Exec Board Not Found", type: "ROOT_MEMBER" } };
        }

        const execUsers = execTeam.users || [];
        const execTeamName = execTeam.attributes?.friendlyName || execTeam.name;

        if (execUsers.length === 0) {
            return { root: { id: "error", name: "Exec Board Not Found2", type: "ROOT_MEMBER" } };
        }

        // 2. Identify President (Primary Root)
        let presidentIndex = execUsers.findIndex((u: any) => {
            const role = u.attributes?.roles?.[execTeam.pk];
            return role && role.toLowerCase().includes("president");
        });
        if (presidentIndex === -1) presidentIndex = 0;

        // 3. Create President Node
        const presidentUser = execUsers[presidentIndex]!;
        const rootNode: OrgChartNode = {
            id: execTeam.pk,
            name: presidentUser.name,
            type: "ROOT_MEMBER",
            attributes: {
                role: presidentUser.attributes?.roles?.[execTeam.pk] || "President",
                email: presidentUser.email,
                teamContext: [execTeamName],
                realUserPk: presidentUser.pk,
                avatar: await signAvatarUrl(presidentUser.pk, presidentUser.attributes.avatar)
            },
            siblings: [],
            children: []
        };

        // 4. Add Other Execs as Siblings
        // We use Promise.all to map async operations
        await Promise.all(execUsers.map(async (u: any, idx: number) => {
            if (idx === presidentIndex) return;
            rootNode.siblings!.push({
                id: u.pk.toString(), // Siblings are just people
                name: u.name,
                type: "ROOT_MEMBER",
                attributes: {
                    role: u.attributes?.roles?.[execTeam.pk] || "Executive",
                    email: u.email,
                    teamContext: [execTeamName],
                    avatar: await signAvatarUrl(u.pk, u.attributes.avatar)
                },
                children: []
            });
        }));

        // 5. Initialize Divisions
        /* Keyed by TeamType rather than string: Object.keys then yields real
           enum members, so the teamType comparison below is type-checked and a
           bad key fails to compile instead of silently matching no teams. */
        const divisions: Partial<Record<TeamType, OrgChartNode>> = {
            [TeamType.PROJECT]: { id: "div_project", name: "Projects", type: "DIVISION", children: [], hasChildren: true },
            [TeamType.BOOTCAMP]: { id: "div_bootcamp", name: "Bootcamp", type: "DIVISION", children: [], hasChildren: true },
            [TeamType.CORPORATE]: { id: "div_corporate", name: "Corporate", type: "DIVISION", children: [], hasChildren: true },
        };

        let allTeamsRes: GetTeamsListDetailResponse;
        try {
            allTeamsRes = await this.authentikClient.getGroupsListDetail({ limit: 500, includeUsers: true });
        } catch (e) {
            return { root: { id: "error", name: "Could not fetch groups list.", type: "ROOT_MEMBER" } };
        }

        const allTeams = allTeamsRes.teams;

        // 6. Pre-populate Divisions with Team Owners (Level 3)
        // We do this REGARDLESS of expandAll to ensure they are visible.
        // We check for "Roots" of each type.
        for (const type of Object.keys(divisions) as TeamType[]) {
            const divRoots = allTeams.filter(t =>
                !t.flaggedForDeletion &&
                t.teamType === type &&
                !t.parent // Only "Root" teams of this type
            );

            // for (const detailedTeam of divRoots) 
            const nodes = await Promise.all(divRoots.map(async (detailedTeam) => {
                // Fetch detailed info to get OWNERS
                try {
                    const owners = detailedTeam.users || [];
                    const teamName = detailedTeam.friendlyName || detailedTeam.name;

                    if (owners.length > 0) {
                        const primaryOwner = owners[0]!;

                        // Check if this team has subteams (to set hasChildren for the Owner)
                        // Use the direct list from detailed info as source of truth
                        const hasSubteams = (detailedTeam.subteamPkList && detailedTeam.subteamPkList.length > 0) || false;

                        const ownerNode: OrgChartNode = {
                            id: detailedTeam.pk, // USES TEAM PK so expansion fetches Team Members
                            name: primaryOwner.name,
                            type: "PERSON",
                            attributes: {
                                role: primaryOwner.attributes?.roles?.[detailedTeam.pk] || "Owner",
                                email: primaryOwner.email,
                                teamContext: [teamName],
                                realUserPk: primaryOwner.pk,
                                avatar: await signAvatarUrl(primaryOwner.pk, primaryOwner.attributes.avatar)
                            },
                            siblings: [],
                            children: [],
                            hasChildren: hasSubteams // Lazy load indicator
                        };

                        // Add sibling owners
                        ownerNode.siblings = await Promise.all(owners.slice(1).map(async (o: any) => ({
                            id: o.pk.toString(),
                            name: o.name,
                            type: "PERSON",
                            attributes: {
                                role: o.attributes?.roles?.[detailedTeam.pk] || "Co-Owner",
                                email: o.email,
                                avatar: await signAvatarUrl(o.pk, o.attributes.avatar)
                            }
                        })));

                        // If expandAll is true, populate children (Subteams)
                        if (shouldExpandAll && hasSubteams) {
                            // This part would duplicate the "getOrgChartNode" logic. 
                            // For simplicity/robustness, we can leave it empty and let frontend lazy-load,
                            // OR implemented the recursive fetching here.
                            // Given "simplify", let's rely on the lazy load unless user REALLY wants full dump.
                            // User script: "we just populate them prehand...?"
                            // Let's populate if requested.
                            const subMembers = await this.getAllSubteamMembers(detailedTeam.pk, teamName, allTeams);
                            ownerNode.children = subMembers;
                        }

                        return ownerNode;
                    }
                } catch (e) {
                    // console.error(`Failed to process team ${team.name}`, e);
                }
            }));

            if (divisions[type]) {
                divisions[type].children = nodes.filter((node) => node !== undefined);
            }


        }



        // Attach populated divisions to Root
        // Only attach if they have children (Teams)
        const activeDivisions = Object.values(divisions).filter(d => d.children && d.children.length > 0);
        rootNode.children = activeDivisions;
        rootNode.hasChildren = activeDivisions.length > 0;

        return { root: rootNode };
    }

    /**
     * Gets the expanded Org Chart Node for a specific person/team.
     * Useful for lazy loading subtrees in the Org Chart visualization.
     * Returns people from subteams under the given team.
     * 
     * @param teamId Team PK (the team whose subteam members to fetch)
     */
    @Get("orgchart/node/{teamId}")
    @Tags("Team Management")
    @SuccessResponse(200)
    @Security("oidc")
    async getOrgChartNode(@Path() teamId: string): Promise<OrgChartNode> {
        // Case A: Virtual Division ID (e.g. "div_project")
        // NOTE: With the logic above, we pre-populate divisions, so this might not be hit often
        // unless we want to support "Lazy Divisions" again. The verification step above handles "Semi-Lazy".
        // But let's keep it safe.
        if (teamId.startsWith("div_")) {
            // Re-use logic from getOrgChart to populate specifically this division
            // For now return empty or implement if needed. 
            // The frontend "Load Members" on a division triggers this if we returned empty children.
            // Since we pre-populate, this shouldn't be primary path.
            return { id: teamId, name: "Division", type: "DIVISION", children: [] };
        }

        // Case B: Real Team ID (User clicked on a Team Owner)
        // This is the core "Level 4" logic.

        // 1. Fetch Team Info to check validity/get basic info
        const safeTeamId = teamId; // It's a GUID
        let teamInfo;
        try {
            teamInfo = await this.authentikClient.getGroupInfo(safeTeamId, { includeUsers: true });
        } catch {
            // Fallback/Error
            return { id: safeTeamId, name: "Unknown", type: "PERSON" };
        }

        // 2. Fetch all context to check structure (optional optimization: cache this?)
        // We need this to check for deeper nesting if we support recursion.

        /* For now, allTeamsContext is unused in getAllSubteamMembers, so we don't need to make this call. */
        // const allTeamsRes = await this.authentikClient.getGroupsList({ limit: 1000, includeUsers: false });

        // 3. Get Members (Subteams + Direct Members if any not owners?) 
        // Logic: "subteam members... added as reporting under"
        // Authentik structure: Root Team has "Owners" (Users) and "Subteams" (Groups). Users in Subteams are the members.

        const rootTeamName = teamInfo.attributes?.friendlyName || teamInfo.name;

        // const subMembers = await this.getAllSubteamMembers(safeTeamId, rootTeamName, allTeamsRes.teams);
        const subMembers = await this.getAllSubteamMembers(safeTeamId, rootTeamName, []); // Removed unnecessary allTeamsRes (unused)

        // Re-construct the Parent Node (Team Owner) to return with children
        // The frontend merges this result.
        const owners = teamInfo.users || [];
        const primaryOwner = owners[0] || { name: "Unknown", pk: 0, email: "", attributes: { avatar: undefined } };

        return {
            id: safeTeamId,
            name: primaryOwner.name,
            type: "PERSON",
            attributes: {
                role: "Owner",
                email: primaryOwner.email,
                teamContext: [rootTeamName],
                /* id above is the TEAM pk, because expansion uses it to fetch the
                   team's members. The card still shows a person, so carry their
                   real pk separately or the UI has no way to link to them. Same
                   reason as the other owner node. */
                realUserPk: primaryOwner.pk,
                avatar: await signAvatarUrl(primaryOwner.pk, primaryOwner.attributes.avatar)
            },
            children: subMembers,
            hasChildren: subMembers.length > 0
        };
    }

    // Helper to recursively collect all people under a team
    private async getAllSubteamMembers(rootTeamId: string, rootTeamName: string, allTeamsContext: any[]): Promise<OrgChartNode[]> {
        const results: OrgChartNode[] = [];

        // Get full tree from Authentik (recursively fetches subteams)
        // Note: getGroupInfo internally recurses if we don't disable it.
        const rootDetailed = await this.authentikClient.getGroupInfo(rootTeamId, { includeUsers: true });

        const processSubteams = async (subteams: any[]) => {
            for (const sub of subteams) {
                if (sub.attributes?.flaggedForDeletion) continue;

                const subName = sub.attributes?.friendlyName || sub.name;
                const members = sub.users || [];

                await Promise.all(members.map(async (m: any) => {
                    results.push({
                        id: m.pk.toString(), // Members are People
                        name: m.name,
                        type: "PERSON",
                        attributes: {
                            role: m.attributes?.roles?.[sub.pk] || "Member",
                            email: m.email,
                            teamContext: [rootTeamName, subName],
                            avatar: await signAvatarUrl(m.pk, m.attributes.avatar)
                        },
                        children: []
                        // Members are leaves in this structure
                    });
                }));

                if (sub.subteams) {
                    await processSubteams(sub.subteams);
                }
            }
        };

        if (rootDetailed.subteams) {
            await processSubteams(rootDetailed.subteams);
        }

        return results;
    }


    /**
     * Fetches the list of all People Portal teams in the organization that
     * the user is a member of. Uses the Request Session Cookie for user
     * information. **List size is capped to 1000.**
     * 
     * @param req Express Request Object
     * @returns Non-Paginated List of Teams
     */
    @Get("myteams")
    @Tags("Team Management")
    @SuccessResponse(200)
    @Security("oidc")
    async getMyTeams(@Request() req: express.Request): Promise<GetTeamsForUsernameResponse> {
        return await this.authentikClient.getRootTeamsForUsername(req.session.authorizedUser!.username)
    }

    /**
     * Creates a new invite for a user to join a team. To call the API,
     * the user must either be a team owner or have the `corp:membermgmt`
     * bindle. The invitee is automatically sent an email with a unique
     * invite link for onboarding.
     * 
     * Bindle Exceptions:
     * - This function supports being called by the ATS Module allowing
     *   the ATS to create invites on behalf of the requester.
     * 
     * - The ATS module is enforced to require the `corp:hiringaccess` bindle
     *   to offset for the bindle exception.
     * 
     * **Non-Standard Behavior:** We do not check if the subteam is archived 
     * or not. A team/subteam state can change before someone accepts an invite. 
     * Therefore, the check is done during onboarding.
     * 
     * @param req Express Request Object
     * @param inviteReq Invite Create Request
     */
    @Post("teams/{teamId}/externalinvite")
    @Tags("User Onboarding", "Team Management")
    @SuccessResponse(201)
    @Security("bindles", ["corp:membermgmt"])
    async createInvite(
        @Request() req: express.Request | ExpressRequestAuthUserShim & ExpressRequestBindleShim,
        @Body() inviteReq: APITeamInviteCreateRequest,
        @Path("teamId") _teamId?: string,
    ) {
        /* Validate & Normalize Name */
        const cleanedName = validatePersonName(inviteReq.inviteeName);
        inviteReq.inviteeName = capitalizeString(cleanedName);

        /* Check if Email is in Supported Domain */
        if (!inviteReq.inviteeEmail.endsWith("@terpmail.umd.edu")) {
            throw new CustomValidationError(
                400,
                "You can only onboard people with @terpmail.umd.edu addresses!"
            )
        }

        /* Check if External User is a part of Org */
        try {
            /* We throw the Validation Error if the user is already in the org */
            const user = await this.authentikClient.getUserInfoFromEmail(inviteReq.inviteeEmail)
            throw new CustomValidationError(
                400,
                `${user.name} is already in the organization! Please use the Existing Members feature to add them to your team.`
            )
        } catch (e) {
            /* We Gracefully Handle All But Previous Error! */
            if (e instanceof CustomValidationError)
                throw e;
        }

        /* Gather Additional Data */
        const authorizedUser = req.session.authorizedUser!;
        const invitorInfo = await this.authentikClient.getUserInfoFromEmail(authorizedUser.email)
        const teamInfo = req.bindle!.teamInfo;
        const destination = await this.authentikClient.getGroupInfo(inviteReq.subteamPk, { includeParentInfo: true });
        if (!teamInfo.attributes.peoplePortalCreation ||
            !destination.attributes.peoplePortalCreation ||
            teamInfo.attributes.flaggedForDeletion ||
            destination.attributes.flaggedForDeletion ||
            destination.parentPk !== teamInfo.pk) {
            throw new CustomValidationError(400, "Invite destination must be an active subteam of the authorized team");
        }

        /* Create New Invite */
        const createdInvite = await Invite.create({
            inviteName: inviteReq.inviteeName,
            inviteEmail: inviteReq.inviteeEmail,
            roleTitle: inviteReq.roleTitle,
            teamName: teamInfo.attributes.friendlyName,
            teamPk: teamInfo.pk,
            subteamPk: inviteReq.subteamPk,
            inviterPk: invitorInfo.pk,
            expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000) /* 48 Hours */
        })

        /* Send an Email to the Invitee and the Invitor */
        const onboardUrl = `${process.env.PEOPLEPORTAL_BASE_URL}/onboard/${createdInvite._id}`;
        await this.emailClient.send({
            to: inviteReq.inviteeEmail,
            cc: [invitorInfo.email],
            replyTo: [invitorInfo.email],
            subject: `Congrats! You're accepted to ${teamInfo.attributes.friendlyName}`,
            templateName: "RecruitNewMemberOnboard",
            templateVars: {
                inviteeName: inviteReq.inviteeName,
                invitorName: invitorInfo.name,
                teamName: teamInfo.attributes.friendlyName,
                roleTitle: inviteReq.roleTitle,
                onboardUrl
            }
        })
    }

    /**
     * Generates a pre-signed URL for uploading a profile picture.
     * This endpoint is public to allow users to upload avatars during onboarding
     * (before they have an account).
     * 
     * @param inviteId Invite ID for validation and path generation
     * @param fileName Name of the file
     * @param contentType MIME type of the file
     */
    @Get("people/avatar/upload-url")
    @Tags("User Onboarding")
    @SuccessResponse(200)
    async getAvatarUploadUrl(
        @Query() inviteId: string,
        @Query() fileName: string,
        @Query() contentType: string
    ): Promise<{ uploadUrl: string, key: string, fields: Record<string, string> }> {

        const invite = await Invite.findById(inviteId).exec();
        if (!invite) {
            throw new CustomValidationError(400, "Invalid Invite ID");
        }

        if (invite.expiresAt < new Date()) {
            throw new CustomValidationError(400, "Invite has expired");
        }

        const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
        if (!allowedTypes.includes(contentType)) {
            throw new CustomValidationError(400, "Invalid file type. Only images are allowed.");
        }

        const ext = fileName.split('.').pop();
        const timestamp = Date.now();
        const key = `avatars/temp/${inviteId}/${timestamp}.${ext}`;

        // Create Presigned POST with conditions
        const { url, fields } = await createPresignedPost(s3Client, {
            Bucket: BUCKET_NAME,
            Key: key,
            Conditions: [
                ["content-length-range", 0, 819200], // Max 800K
                ["eq", "$Content-Type", contentType], // Enforce Content-Type
            ],
            Fields: {
                "Content-Type": contentType,
            },
            Expires: 300, // 5 minutes
        });

        return { uploadUrl: url, key, fields };
    }

    /**
     * Generates a pre-signed URL for downloading a user's avatar.
     * Uses in-memory caching to reduce S3 API calls.
     * 
     * @param userPk The PK of the user whose avatar to fetch
     */
    @Get("people/avatar/download-url")
    @Tags("People Management")
    @SuccessResponse(200)
    @Security("oidc")
    async getAvatarDownloadUrl(@Query() userPk: string): Promise<{ url: string }> {

        const pkNumber = parseInt(userPk);
        if (isNaN(pkNumber)) {
            throw new CustomValidationError(400, "Invalid User PK");
        }

        const userInfo = await this.authentikClient.getUserInfo(pkNumber);
        const avatarKey = userInfo.attributes.avatar;

        const url = await signAvatarUrl(userPk, avatarKey);

        this.setHeader('Cache-Control', 'public, max-age=86400');
        return { url };
    }

    /**
     * Public API since Invite IDs are unique and can't be guessed. Additionally,
     * temporary authentication through OTP is supported but would need an overhaul.
     * 
     * @param inviteId Invite UUID
     * @returns Invite Information
     */
    @Get("invites/{inviteId}")
    @Tags("User Onboarding")
    @SuccessResponse(200)
    async getInviteInfo(@Path() inviteId: string): Promise<APITeamInviteGetResponse> {
        const invite = await Invite.findById(inviteId).lean<APITeamInviteGetResponse>().exec()
        if (!invite || !invite.teamPk || invite.expiresAt <= new Date())
            throw new CustomValidationError(400, "Invalid or expired invite")

        return {
            ...invite,
            slackInviteLink: this.slackClient.getSlackInviteLink()
        }
    }

    /**
     * Accepts an invite to join a team. The invitee must provide a password
     * and major. The invitee is automatically added to the team and given
     * the role specified in the invite. Slack and other verification checks
     * are in place.
     * 
     * @param inviteId Invite UUID
     * @param req Accept Invite Request
     */
    @Put("invites/{inviteId}")
    @Tags("User Onboarding")
    @SuccessResponse(201)
    async acceptInvite(@Path() inviteId: string, @Body() req: APITeamInviteAcceptRequest) {
        /* Sanitize Request */
        req.major = capitalizeString(req.major);

        const normalizedLinkedinUrl = normalizeLinkedInProfileUrl(req.linkedinUrl ?? "");
        if (normalizedLinkedinUrl === null) {
            throw new CustomValidationError(400, "Please enter a valid LinkedIn profile URL.");
        }

        const invite = await Invite.findById(inviteId).exec()
        if (!invite || !invite.teamPk || invite.expiresAt <= new Date())
            throw new CustomValidationError(400, "Invalid or expired invite")

        /* Validate Password Complexity */
        if (req.password) {
            if (req.password.length < 12) {
                throw new CustomValidationError(
                    400,
                    "Password must be at least 12 characters long"
                );
            }

            const strength = zxcvbn(req.password);
            if (strength.score < 2) {
                throw new CustomValidationError(
                    400,
                    "Password is too weak. Please choose a stronger password."
                );
            }
        }

        /* Check Slack Presence! */
        const slackPresence = await this.slackClient.validateUserPresence(invite.inviteEmail)
        if (!slackPresence)
            throw new Error("User has not joined the Slack Workspace!")

        /* Check if Subteam is Valid and Isn't Archived */
        const rootTeam = await this.authentikClient.getGroupInfo(invite.teamPk)
        const subteam = await this.authentikClient.getGroupInfo(invite.subteamPk, { includeParentInfo: true })
        const isSubteamArchived = subteam.attributes.flaggedForDeletion
        if (!rootTeam.attributes.peoplePortalCreation ||
            !subteam.attributes.peoplePortalCreation ||
            rootTeam.attributes.flaggedForDeletion ||
            isSubteamArchived ||
            subteam.parentPk !== invite.teamPk) {
            throw new CustomValidationError(400, "Invite destination is no longer valid");
        }

        /* Construct New Request */
        const createUserRequest: CreateUserRequest = {
            name: invite.inviteName,
            email: invite.inviteEmail,
            password: req.password,
            attributes: {
                major: req.major,
                expectedGrad: req.expectedGrad,
                phoneNumber: req.phoneNumber,
                linkedinUrl: normalizedLinkedinUrl,
                roles: {}
            }
        }

        if (!isSubteamArchived) {
            createUserRequest.groupPk = invite.subteamPk
            createUserRequest.attributes.roles = {
                [invite.subteamPk]: invite.roleTitle
            }
        }

        if (req.avatarKey) {
            const normalizedKey = path.posix.normalize(req.avatarKey);
            const expectedPrefix = `avatars/temp/${inviteId}/`;
            if (!normalizedKey.startsWith(expectedPrefix) || normalizedKey.includes('..')) {
                throw new CustomValidationError(400, "Invalid avatar key");
            }
        }

        await this.authentikClient.createNewUser(createUserRequest)

        if (req.avatarKey) {
            try {
                const createdUser = await this.authentikClient.getUserInfoFromEmail(createUserRequest.email);
                const userPk = createdUser.pk;

                const ext = req.avatarKey.split('.').pop();
                const newKey = `avatars/${userPk}/avatar.${ext}`;

                const allowedAvatars = [FILE_SIGNATURES.PNG, FILE_SIGNATURES.JPEG, FILE_SIGNATURES.GIF, FILE_SIGNATURES.WEBP];
                const isValid = await validateS3FileSignature(req.avatarKey, allowedAvatars);
                if (!isValid) {
                    console.error("Profile picture was not valid. Account created anyway.");
                    await deleteTempAvatar(req.avatarKey);
                    await invite.deleteOne();
                    return;
                }

                const imageBytes = await getS3ObjectBytes(req.avatarKey);
                if (!imageBytes) {
                    console.error("Failed to fetch avatar bytes. Account created anyway.");
                    await deleteTempAvatar(req.avatarKey);
                    await invite.deleteOne();
                    return;
                }

                const faceCheckResult = await checkPhotoHasFace(imageBytes);
                if (faceCheckResult.passed === false) {
                    console.error("Avatar failed face check. Account created anyway.");
                    await deleteTempAvatar(req.avatarKey);
                    await invite.deleteOne();
                    return;
                }

                await s3Client.send(new CopyObjectCommand({
                    Bucket: BUCKET_NAME,
                    CopySource: `${BUCKET_NAME}/${req.avatarKey}`,
                    Key: newKey
                }));

                await this.authentikClient.updateUserAttributes(parseInt(userPk as any), {
                    avatar: newKey
                });

                /* Second avatar write path; mirror the invalidate the profile-edit
                   path does so the two stay symmetric. */
                invalidateAvatarUrlCache(parseInt(userPk as any));

                await s3Client.send(new DeleteObjectCommand({
                    Bucket: BUCKET_NAME,
                    Key: req.avatarKey
                }));

            } catch (e) {
                // Don't fail the whole request, just log error. User is created.
                console.error("Failed to process avatar", e);
            }
        }

        await invite.deleteOne()
    }

    /**
     * Verifies if a user is a member of the Slack Workspace. Uses the
     * Slack Shared Resources Client for operations.
     * 
     * @param req Verify Slack Request
     * @returns True if the user is a member of the Slack Workspace, false otherwise
     */
    @Post("tools/verifyslack")
    @Tags("Generic Organization Tools")
    @SuccessResponse(200)
    async verifySlack(@Body() req: { email: string }): Promise<boolean> {
        return await this.slackClient.validateUserPresence(req.email)
    }

    /**
     * Provides information about a specific team in the organization. Includes
     * subteams, users and attributes. Access granted to all OIDC authenticated
     * users without any bindle restrictions.
     * 
     * @param teamId Team ID
     * @returns Team Information
     */
    @Get("teams/{teamId}")
    @Tags("Team Configuration")
    @SuccessResponse(200)
    @Security("oidc")
    async getTeamInfo(@Path() teamId: string): Promise<APITeamInfoResponse> {
        const primaryTeam = await this.authentikClient.getGroupInfo(teamId);

        /* Recursive Team Population Logic for Authentik Versions less than 2025.8 */
        // const subteamList = await this.authentikClient.getGroupsList({
        //     subgroupsOnly: true,
        //     search: primaryTeam.attributes.friendlyName.replaceAll(" ", "")
        // })

        // const subteamResponses: GetGroupInfoResponse[] = []
        // const filteredSubTeams = subteamList.teams.filter((team) => team.parent == teamId)
        // for (const team of filteredSubTeams) {
        //     subteamResponses.push(await this.authentikClient.getGroupInfo(team.pk))
        // }

        if (primaryTeam.users) {
            await Promise.all(primaryTeam.users.map(async (user) => {
                user.avatar = await signAvatarUrl(user.pk, user.attributes.avatar);
            }));
        }

        if (primaryTeam.subteams) {
            await Promise.all(primaryTeam.subteams.map(async (sub) => {
                if (sub.users) {
                    await Promise.all(sub.users.map(async (user) => {
                        user.avatar = await signAvatarUrl(user.pk, user.attributes.avatar);
                    }));
                }
            }));
        }

        return {
            team: primaryTeam,
            subteams: primaryTeam.subteams
        }
    }

    /**
     * Provides a list of available bindles, collated from shared resources,
     * that are supported by teams. This feature is usually populated and used
     * in a subteam-level context.
     * 
     * @param teamId Team ID
     * @returns Bindle Permissions Map
     */
    @Get("teams/{teamId}/bindles")
    @Tags("Team Configuration", "Bindle Authorization Layer")
    @SuccessResponse(200)
    @Security("oidc")
    async getTeamBindles(@Path() teamId: string): Promise<{ [key: string]: EnabledBindlePermissions }> {
        const teamInfo = await this.authentikClient.getGroupInfo(teamId);
        return teamInfo.attributes.bindlePermissions ?? {}; /* Legacy Teams don't have bindles! */
    }

    /**
     * Updates the bindle permissions for a team. This method is used in a
     * subteam-level context. Team Owners can update subteam level permissions
     * and other members need to hold the `corp:permissionsmgmt` bindle.
     * 
     * **WARNING:**
     * This method does not sync the bindles for users across the shared resources.
     * A seperate team bindle sync call needs to be made to sync bindles for all subteams and
     * users in a team.
     * 
     * @param teamId Team or Subteam ID
     * @param bindleConf Bindle Permissions Map
     */
    @Patch("teams/{teamId}/bindles")
    @Tags("Team Configuration", "Bindle Authorization Layer")
    @SuccessResponse(201)
    @Security("bindles", ["corp:permissionsmgmt"])
    async updateTeamBindles(@Path() teamId: string, @Body() bindleConf: { [key: string]: EnabledBindlePermissions }) {
        const bindlePermissions = BindleController.sanitizeBindlePermissions(bindleConf);
        await this.authentikClient.updateBindlePermissions(teamId, bindlePermissions);
    }

    /**
     * Signs the avatar URL for a given user.
     * Uses in-memory caching to reduce S3 API calls.
     * 
     * @param userPk User PK
     * @param avatarKey S3 Key for Avatar
     * @returns Signed URL or empty string
     */
    /**
     * Generates a temporary link to access the team's AWS Console. Account Provisioning
     * is handled by AWSClient and Root Team Settings. Access is moderated by the Bindle
     * Authorization Layer.
     * 
     * To enable AWS Access, the team owner or `corp:rootsettings` bindle is required. For 
     * generating a console link from this API, the user must either be a Team Owner or
     * hold the corp:awsaccess bindle.
     * 
     * @param req Express Request Object
     * @param teamId Team ID
     * @returns Temporary AWS Console Link
     */
    @Get("teams/{teamId}/awsaccess")
    @Tags("Team External Integrations")
    @SuccessResponse(201)
    @Security("bindles", ["corp:awsaccess"])
    async fetchAWSAccessCredentials(@Request() req: express.Request, @Path() teamId: string) {
        const res = (req as any).res as express.Response
        res.setHeader('Content-Type', 'text/plain');
        res.setHeader('Transfer-Encoding', 'chunked');

        const awsRes = Object.values(ENABLED_TEAMSETTING_RESOURCES).find((res) => res.getResourceName() == "AWSClient") as unknown as AWSClient;

        res.write(JSON.stringify({ progressPercent: 10, status: "Retrieving Team Credentials..." }))
        const teamInfo = req.bindle!.teamInfo

        // Check if provisioning is enabled
        const settings = teamInfo.attributes.rootTeamSettings?.[awsRes.getResourceName()];
        const shouldProvision = settings && settings["awsclient:provision"] === true;

        if (!shouldProvision) {
            res.write(JSON.stringify({ progressPercent: 100, status: "AWS Provisioning is not enabled for this team.", error: true }))
            res.end()
            return
        }

        /* Provide Progess Update */
        res.write(JSON.stringify({ progressPercent: 30, status: "Locating AWS Account..." }))

        const name = teamInfo.name
        const accountId = await awsRes.findAccountIdByName(teamInfo.name);

        if (!accountId) {
            res.write(JSON.stringify({ progressPercent: 100, status: "AWS Account not found! Please contact an administrator.", error: true }))
            res.end()
            return
        }

        res.write(JSON.stringify({ progressPercent: 60, status: "Generating Session..." }))
        try {
            const currentUser = req.session.authorizedUser?.name ?? "GenericDashboardUser"
            const link = await awsRes.generateConsoleLink(accountId, sanitizeUserFullName(currentUser))
            res.write(JSON.stringify({ progressPercent: 100, status: "Link Generated!", link: link }))
        } catch (e: any) {
            res.write(JSON.stringify({ progressPercent: 100, status: "Failed to generate link: " + e.message, error: true }))
        }

        res.end()
    }

    /**
     * Updates the Root Team Settings for a Team. To perform this action, the user
     * must either be a Team Owner or hold the `corp:rootsettings` bindle.
     * 
     * @param teamId Team ID
     * @param conf Root Team Settings Map
     */
    @Patch("teams/{teamId}/updateconf")
    @Tags("Team Configuration")
    @SuccessResponse(201)
    @Security("bindles", ["corp:rootsettings"])
    async updateRootTeamSetting(@Path() teamId: string, @Body() conf: { [key: string]: EnabledRootSettings }) {
        /* Filter for only the available settings */
        const applySettingsList: { [key: string]: EnabledRootSettings } = {};
        for (const client in conf) {
            if (!this.teamSettingList[client])
                continue;

            const supportedSettings = this.teamSettingList[client];
            const filteredSettings: EnabledRootSettings = {};
            for (const setting in conf[client]) {
                if (!supportedSettings[setting])
                    continue;

                /* Update Filtered Setting */
                filteredSettings[setting] = conf[client][setting] ?? false;
            }

            /* Apply the Filtered Settings to the Final List */
            applySettingsList[client] = filteredSettings;
        }

        /* Call Authentik to Update the Attributes */
        await this.authentikClient.updateRootTeamSettings(teamId, applySettingsList);

        /* Get updated team info and sync each RootTeamSettingClient */
        const updatedTeamInfo = await this.authentikClient.getGroupInfo(teamId);
        for (const client of Object.values(ENABLED_TEAMSETTING_RESOURCES)) {
            await client.syncSettingUpdate(updatedTeamInfo);
        }
    }

    /**
     * Adds an existing member to a team. To perform this action, the user must 
     * either be a Team Owner or hold the `corp:membermgmt` bindle.
     * 
     * @param teamId Team ID
     * @param req User PK
     */
    @Post("teams/{teamId}/addmember")
    @Tags("Team Management")
    @SuccessResponse(201)
    @Security("bindles", ["corp:membermgmt"])
    async addTeamMember(@Path() teamId: string, @Body() req: { userPk: number, roleTitle: string }) {
        await this.addTeamMemberWrapper({
            groupId: teamId,
            userPk: req.userPk,
            roleTitle: req.roleTitle
        })
    }

    /**
     * Removes an existing member from a team. To perform this action, the user must 
     * either be a Team Owner or hold the `corp:membermgmt` bindle.
     * 
     * @param teamId Team ID
     * @param req User PK
     */
    @Post("teams/{teamId}/removemember")
    @Tags("Team Management")
    @SuccessResponse(201)
    @Security("bindles", ["corp:membermgmt"])
    async removeTeamMember(@Request() req: express.Request, @Path() teamId: string, @Body() body: { userPk: number }) {
        /* Needs Is Team owner Middleware?! */
        await this.removeTeamMemberWrapper({
            groupId: teamId,
            groupInfo: req.bindle!.teamInfo,
            userPk: body.userPk
        })
    }

    /**
     * Creates a new subteam inside a team. To perform this action, the user must
     * either be a Team Owner or hold the `corp:subteamaccess` bindle.
     * 
     * @param teamId Team ID
     * @param req Subteam Information
     * @returns Created Subteam Information
     */
    @Post("teams/{teamId}/subteam")
    @Tags("Subteam Management")
    @SuccessResponse(201)
    @Security("bindles", ["corp:subteamaccess"])
    async createSubTeam(@Request() req: express.Request | ExpressRequestBindleShim, @Path() teamId: string, @Body() body: APICreateSubTeamRequest): Promise<GetGroupInfoResponse> {
        body.friendlyName = validateTeamName(body.friendlyName);
        body.description = capitalizeString(body.description);
        const parentInfo = req.bindle!.teamInfo;

        if (parentInfo.subteams && parentInfo.subteams.length >= 15) {
            throw new CustomValidationError(
                400,
                "Maximum number of subteams (15) reached for this team."
            );
        }

        const createdSubTeam = await this.authentikClient.createNewTeam({
            parent: teamId,
            parentName: parentInfo.attributes.friendlyName,
            attributes: {
                friendlyName: body.friendlyName,
                teamType: parentInfo.attributes.teamType,
                seasonType: parentInfo.attributes.seasonType,
                seasonYear: parentInfo.attributes.seasonYear,
                description: body.description,
            }
        })

        /* Return the Sub team */
        return createdSubTeam
    }



    /**
     * Fetches information about a specific Team Creation Request. To access this endpoint,
     * the user must pass the Executive Authorization Layer.
     * 
     * @param requestId Request ID
     * @returns Team Creation Request Information
     */
    @Get("teamrequests/{requestId}")
    @Tags("Team Management")
    @SuccessResponse(200)
    @Security("executive")
    async getTeamCreationRequest(@Path() requestId: string): Promise<APITeamCreationRequestResponse> {
        const request = await TeamCreationRequest.findById(requestId).lean<APITeamCreationRequestResponse>().exec();
        if (!request) {
            throw new CustomValidationError(404, "Team Creation Request not found");
        }
        /* Manually cast _id to string if needed, though lean() handles it mostly */
        return { ...request, _id: request._id.toString() } as unknown as APITeamCreationRequestResponse;
    }

    /**
     * Approves a Team Creation Request, creates a new team and notifies the requester via
     * email. To access this endpoint, the user must pass the Executive Authorization Layer.
     * 
     * @param req Express Request
     * @param requestId Request ID
     */
    @Post("teamrequests/{requestId}")
    @Tags("Team Management")
    @SuccessResponse(201, "Team Created & Request Approved")
    @Security("executive")
    async approveTeamCreationRequest(@Request() req: express.Request, @Path() requestId: string) {
        const authorizedUser = req.session.authorizedUser!;
        const request = await TeamCreationRequest.findById(requestId);
        if (!request) {
            throw new CustomValidationError(404, "Team Creation Request not found");
        }

        try {
            /* Create the Team */
            /* We use the requester's PK as the owner, not the approver! */
            await this.createTeamWrapper(request.createTeamRequest, request.requestorPk);

            /* Send Email Update */
            await this.emailClient.send({
                to: request.requestorEmail,
                replyTo: [authorizedUser.email],
                subject: `Update on your Team Creation Request`,
                templateName: "MgmtTeamRequestUpdate",
                templateVars: {
                    requesterName: (await this.authentikClient.getUserInfo(request.requestorPk)).name,
                    teamName: request.createTeamRequest.friendlyName,
                    status: "approved",
                    approverName: authorizedUser.name
                }
            });
        } catch (e) {
            if (e instanceof AuthentikClientError) {
                /* Send Email Update */
                await this.emailClient.send({
                    to: request.requestorEmail,
                    replyTo: [authorizedUser.email],
                    subject: `Team Creation Failed`,
                    templateName: "MgmtTeamRequestFailed",
                    templateVars: {
                        requesterName: (await this.authentikClient.getUserInfo(request.requestorPk)).name,
                        teamName: request.createTeamRequest.friendlyName,
                        approverName: authorizedUser.name,
                        errorMessage: e.message,
                        exceptionTrace: e.stack
                    }
                });
            }
        } finally {
            /* Delete the Request */
            await request.deleteOne();
        }
    }

    /**
     * Declines a Team Creation Request, Deletes it from the database and notifies
     * the requester via email. To access this endpoint, the user must pass the 
     * Executive Authorization Layer.
     * 
     * @param req Express Request
     * @param requestId Request ID
     */
    @Delete("teamrequests/{requestId}")
    @Tags("Team Management")
    @SuccessResponse(200, "Request Declined & Deleted")
    @Security("executive")
    async declineTeamCreationRequest(@Request() req: express.Request, @Path() requestId: string) {
        const authorizedUser = req.session.authorizedUser!;
        const request = await TeamCreationRequest.findById(requestId);
        if (!request) {
            throw new CustomValidationError(404, "Team Creation Request not found");
        }

        /* Send Email Update */
        await this.emailClient.send({
            to: request.requestorEmail,
            replyTo: [authorizedUser.email],
            subject: `Update on your Team Creation Request`,
            templateName: "MgmtTeamRequestUpdate",
            templateVars: {
                requesterName: (await this.authentikClient.getUserInfo(request.requestorPk)).name,
                teamName: request.createTeamRequest.friendlyName,
                status: "declined",
                approverName: authorizedUser.name
            }
        });

        /* Delete the Request */
        await request.deleteOne();
    }

    /**
     * Public API to request the creation of a new team.
     * 
     * If the requester is an Executive or Superuser, the team is created immediately (Auto-Approved).
     * Otherwise, a request is submitted for Executive Board review.
     * 
     * @param req Express Request
     * @param createTeamReq Team Creation Payload
     * @returns Created Team Info (201) or Pending Status (202)
     */
    @Post("teams/create")
    @Tags("Team Management")
    @SuccessResponse(201, "Team Created")
    @Security("oidc")
    async createTeam(
        @Request() req: express.Request,
        @Body() createTeamReq: APICreateTeamRequest
    ): Promise<GetGroupInfoResponse | { message: string, status: string }> {
        /* Santize Request */
        createTeamReq.friendlyName = validateTeamName(createTeamReq.friendlyName);
        createTeamReq.description = capitalizeString(createTeamReq.description);
        createTeamReq.teamStartDate = createTeamReq.teamStartDate ?? new Date().toISOString().slice(0, 10);
        this.validateTeamDateRange(createTeamReq.teamStartDate, createTeamReq.teamEndDate);

        /* Check for Authorized User */
        const authorizedUser = req.session.authorizedUser!;
        let isExecutive = false;

        /* Check for Executive Authority (Auto-Approve) */
        try {
            isExecutive = await executiveAuthVerify(
                req, [],
                true /* Skip OIDC Check */
            );
        } catch (e) {
            isExecutive = false;
        }

        if (isExecutive) {
            /* Auto-Approve */
            const team = await this.createTeamWrapper(createTeamReq, authorizedUser.pk);
            this.setStatus(201);
            return team;
        } else {
            /* Fetch Executive Board (Service Team) Members for CC */
            /* We do this BEFORE creating the request because if we can't notify the Exec Board,
               there is no point in creating the request as it will sit in limbo. */
            const execTeamPk = await this.authentikClient.getGroupPkFromName("ExecutiveBoardMembers");
            const execTeamInfo = await this.authentikClient.getGroupInfo(execTeamPk);
            const execEmails = execTeamInfo.users.map(u => u.email);

            if (execEmails.length < 1)
                throw new CustomValidationError(500, "No Executive Board Members found. Please contact an Administrator.");
            /* Submit Request */
            const teamCreationRequest = await TeamCreationRequest.create({
                requestorPk: authorizedUser.pk,
                requestorName: authorizedUser.name,
                requestorEmail: authorizedUser.email,
                createTeamRequest: createTeamReq,
                status: TeamCreationRequestStatus.PENDING
            });

            /* Send Email to Executive Board */
            await this.emailClient.send({
                to: authorizedUser.email,
                cc: execEmails,
                subject: `New Team Creation Request: ${createTeamReq.friendlyName}`,
                templateName: "MgmtTeamCreateRequest",
                templateVars: {
                    requesterName: authorizedUser.name,
                    teamName: createTeamReq.friendlyName,
                    teamDescription: createTeamReq.description,
                    teamType: createTeamReq.teamType,
                    seasonType: createTeamReq.seasonType,
                    seasonYear: createTeamReq.seasonYear,
                    requesterRole: createTeamReq.requestorRole,
                    requestUrl: `${process.env.PEOPLEPORTAL_BASE_URL}/org/teamrequests/${teamCreationRequest.id}`
                }
            });

            this.setStatus(202);
            return {
                message: "Your Team Creation Request has been Submitted for Review! Please check your email for updates.",
                status: "PENDING"
            };
        }
    }

    /**
     * Syncs Shared Permissions for a team. Internally, this routine will call
     * `handleOrgBindleSync` for each shared resource that is enabled. For better
     * User experience, this routine emits HTTP Server-Sent Events (SSEs) to the
     * client to provide real-time progress updates.
     * 
     * @param req Express Request Object
     * @param teamId Team ID
     */
    @Patch("teams/{teamId}/syncbindles")
    @Tags("Team Configuration", "Bindle Authorization Layer")
    @SuccessResponse(200)
    @Security("bindles", ["corp:bindlesync"])
    async syncOrgBindles(@Request() req: express.Request, @Path() teamId: string) {
        const res = (req as any).res as express.Response
        res.setHeader('Content-Type', 'text/plain');
        res.setHeader('Transfer-Encoding', 'chunked');

        /* Obtain Teams and Compute Progress Effort */
        const teamInfo = req.bindle!.teamInfo
        const computeEffort = teamInfo.users.length +
            teamInfo.subteams.reduce((acc, val) => acc + val.users.length, 0)

        let updatedResources = 0
        let errors: Map<string, Error> = new Map();

        for (const sharedResource of this.sharedResources) {
            try {
                await sharedResource.handleOrgBindleSync(teamInfo, (updatedResourceCount, status) => {
                    /* Update Progress and Write Output */
                    updatedResources += updatedResourceCount

                    /* Add Newline Delimiter to Ensure that client can parse distinct JSON objects, Helps when concurrent callbacks are fired causing TCP coalescing */
                    res.write(JSON.stringify({ progressPercent: (updatedResources / computeEffort) * 100, status }) + "\n")
                })
            } catch (e) {
                if (e instanceof Error) {
                    errors.set(sharedResource.getResourceName(), e);
                } else {
                    errors.set(sharedResource.getResourceName(), new Error(
                        `Unknown Error: ${describeUnknownError(e)}`
                    ));
                }
            }
        }

        /* Write All the Errors during the Process... */
        console.log(errors);
        res.end()
    }

    /**
     * Updates the team's name and description. To perform this action,
     * the user must either be a Team Owner or hold the `corp:rootsettings`
     * bindle.
     * 
     * @param teamId Team ID
     * @param conf Team Name and Description Update Payload
     */
    @Patch("teams/{teamId}")
    @Tags("Team Configuration")
    @SuccessResponse(200)
    @Security("bindles", ["corp:rootsettings"])
    async updateTeamAttributes(@Path() teamId: string, @Body() conf: APIUpdateTeamRequest) {
        if (conf.friendlyName) {
            conf.friendlyName = validateTeamName(conf.friendlyName);
        }
        if (conf.description) {
            conf.description = capitalizeString(conf.description);
        }

        if (conf.teamStartDate !== undefined || conf.teamEndDate !== undefined) {
            const teamInfo = await this.authentikClient.getGroupInfo(teamId);
            const effectiveStartDate = conf.teamStartDate ?? teamInfo.attributes.teamStartDate;
            const effectiveEndDate = conf.teamEndDate ?? teamInfo.attributes.teamEndDate;

            if (!effectiveStartDate || !effectiveEndDate) {
                throw new CustomValidationError(400, "Both team start date and end date are required");
            }

            this.validateTeamDateRange(
                effectiveStartDate,
                effectiveEndDate,
            );
        }

        /* Strictly restrict updates to allowed fields to prevent attribute pollution */
        await this.authentikClient.updateGroupInformation(teamId, conf as Record<string, string | undefined>);
    }

    /**
     * Performs a soft-delete by flagging the team for deletion. People Portal teams
     * can never be deleted considering the potential impacts caused by deleted states
     * on Shared Resources. Instead, the soft-delete mechanism follows these rules:
     * 
     * - If the team is a subteam (has a parent), it removes 
     *   all members to immediately revoke access.
     * 
     * - If the team is a root team (has no parent), it is just
     *   flagged for deletion as their deletion is overengineering.
     * 
     * To perform this action on a subteam, the user must either be a Team Owner or 
     * hold the `corp:subteamaccess` bindle.
     * 
     * To perform this action on a root team, the user must pass the Executive
     * Authorization Layer as a **Superuser** (`su:exclusive` scope).
     * 
     * @param teamId Team ID
     */
    @Delete("teams/{teamId}")
    @Tags("Team Management")
    @SuccessResponse(200)
    @Security("bindles", ["corp:subteamaccess"])
    async deleteTeam(@Request() req: express.Request, @Path() teamId: string) {
        const teamInfo = req.bindle!.teamInfo;

        /* If Root Team, Enforce Executive Authorization */
        if (!teamInfo.parentPk) {
            await executiveAuthVerify(
                req, ["su:exclusive"],
                true /* Skip OIDC Check as its done by Bindles Auth */
            );
        }

        /* 1. Flag for Deletion */
        await this.authentikClient.flagGroupForDeletion(teamId);

        /* 2. If subteam, remove all members */
        if (teamInfo.parentPk)
            await this.authentikClient.removeAllTeamMembers(teamId);

        // sync bindles
    }

    /**
     * Archives a root team. Archiving preserves all data but makes the team's
     * Shared Resources read-only (Ex. Gitea repositories and Slack channels are
     * archived). Each Shared Resource and Root Team Setting client is asked to
     * archive its resources, and the team is stamped with an `archivedAt`
     * timestamp so it surfaces as archived in the executive console.
     *
     * Only root teams may be archived, and the caller must pass the Executive
     * Authorization Layer as a **Superuser** (`su:exclusive` scope).
     *
     * @param teamId Team ID
     */
    @Post("teams/{teamId}/archive")
    @Tags("Team Management")
    @SuccessResponse(200)
    @Security("bindles", ["corp:subteamaccess"])
    async archiveTeam(@Request() req: express.Request, @Path() teamId: string) {
        const teamInfo = req.bindle!.teamInfo;

        /* Archiving is a root-team, executive-only operation */
        if (teamInfo.parentPk) {
            throw new CustomValidationError(
                400,
                "Only root teams can be archived."
            );
        }

        await executiveAuthVerify(
            req, ["su:exclusive"],
            true /* Skip OIDC Check as its done by Bindles Auth */
        );

        let errors: Map<string, Error> = new Map();
        const recordError = (resourceName: string, e: unknown) => {
            errors.set(resourceName, e instanceof Error ? e : new Error(
                `Unknown Error: ${describeUnknownError(e)}`
            ));
        };

        /* 1. Archive Shared Resources (Gitea repos, Slack channels, etc.) */
        for (const sharedResource of this.sharedResources) {
            try {
                await sharedResource.archiveTeam(teamInfo, () => { /* progress not streamed */ });
            } catch (e) {
                recordError(sharedResource.getResourceName(), e);
            }
        }

        /* 2. Archive Root Team Setting Resources (AWS, etc.) */
        for (const settingResource of Object.values(ENABLED_TEAMSETTING_RESOURCES)) {
            try {
                await settingResource.archiveTeam(teamInfo);
            } catch (e) {
                recordError(settingResource.getResourceName(), e);
            }
        }

        if (errors.size > 0)
            console.error("[OrgController] Archive completed with errors:", errors);

        /* 3. Stamp the team as archived */
        const actorEmail = req.session.authorizedUser?.email;
        let archivedBy: string | undefined;
        if (actorEmail) {
            try {
                archivedBy = (await this.authentikClient.getUserInfoFromEmail(actorEmail)).pk;
            } catch { /* Audit attribution is best-effort */ }
        }

        await this.authentikClient.archiveGroup(teamId, archivedBy);
    }

    /* === HELPER ROUTINES === */
    private isGroupSubteam(group: GetGroupInfoResponse): boolean {
        return !!group.parentPk;
    }

    /* Other Wrapper Functions */
    private async createTeamWrapper(createTeamReq: APICreateTeamRequest, ownerPk: number): Promise<GetGroupInfoResponse> {
        /* Validate Team Name Request */
        createTeamReq.friendlyName = validateTeamName(createTeamReq.friendlyName);

        /* Create the New Team */
        const newTeam = await this.authentikClient.createNewTeam({
            attributes: {
                friendlyName: createTeamReq.friendlyName,
                teamType: createTeamReq.teamType,
                seasonType: createTeamReq.seasonType,
                seasonYear: createTeamReq.seasonYear,
                description: createTeamReq.description,
                teamStartDate: createTeamReq.teamStartDate ?? new Date().toISOString().slice(0, 10),
                teamEndDate: createTeamReq.teamEndDate,
            }
        })

        /* Add the Creator to Team Owners. Awaited: unawaited, creation could
           report success before the owner existed, and a failure vanished as
           an unhandled rejection. */
        await this.addTeamMemberWrapper({
            groupId: newTeam.pk,
            userPk: ownerPk,
            roleTitle: createTeamReq.requestorRole
        })

        /* Construct Bindle Shim for Optimized Create Sub Team Calls */
        const bindleShim: ExpressRequestBindleShim = {
            bindle: {
                requestedPermissions: [],
                teamInfo: newTeam,
            }
        }

        /* Team Templates: Makes Life Easier! */
        const teamConfig = TEAM_TYPE_CONFIGS[createTeamReq.teamType];
        if (teamConfig) {
            for (const subteamConfig of teamConfig.defaultSubteams) {
                /* Create Subteam */
                const subteam = await this.createSubTeam(bindleShim, newTeam.pk, {
                    friendlyName: subteamConfig.friendlyName,
                    description: subteamConfig.description
                });

                /* Apply Bindles if Defined */
                if (subteamConfig.bindles) {
                    await this.updateTeamBindles(subteam.pk, subteamConfig.bindles);
                }
            }
        }

        return newTeam;
    }

    async addTeamMemberWrapper(request: AddGroupMemberRequest): Promise<APITeamMemberAddResponse> {
        const userInfo = await this.authentikClient.getUserInfo(request.userPk);
        const targetGroupInfo = await this.authentikClient.getGroupInfo(request.groupId);
        let rootTeamInfo: GetGroupInfoResponse;

        /* Identify Root Team */
        if (targetGroupInfo.parentInfo) {
            /* It's a subteam, fetch the parent (Root Team) */
            rootTeamInfo = await this.authentikClient.getGroupInfo(targetGroupInfo.parentInfo.pk);
        } else {
            /* It is the Root Team */
            rootTeamInfo = targetGroupInfo;
        }

        /* Collect all Forbidden Group IDs (Root + All Subteams) */
        const familyPks = new Set<string>();
        familyPks.add(rootTeamInfo.pk);
        rootTeamInfo.subteamPkList.forEach(pk => familyPks.add(pk));

        /* Check for Intersection with User's Current Groups */
        const userGroupPks = userInfo.groups;
        for (const groupPk of userGroupPks) {
            if (familyPks.has(groupPk)) {
                this.setStatus(409); // Conflict
                throw new CustomValidationError(409, "User is already a member of this team hierarchy (Root or another Subteam).");
            }
        }

        const coreAdditionComplete = await this.authentikClient.addGroupMember(request)

        /* Update User's Role Attribute. Awaited so the role is persisted before
           the caller is told the member was added. */
        await this.authentikClient.updateUserAttributes(request.userPk, {
            roles: {
                ...userInfo.attributes.roles,
                [request.groupId]: request.roleTitle
            }
        })

        return {
            coreAdditionComplete,
        }
    }

    async removeTeamMemberWrapper(request: RemoveGroupMemberRequest): Promise<void> {
        const userInfo = await this.authentikClient.getUserInfo(request.userPk)
        const groupInfo = request.groupInfo ?? await this.authentikClient.getGroupInfo(request.groupId)

        /* Check if we're removing the last owner from a Root Team */
        if (!this.isGroupSubteam(groupInfo)) {
            if (groupInfo.users.length <= 1) {
                this.setStatus(409);
                throw new Error("Cannot Remove the last Team Owner. Add someone else to remove yourself.");
            }
        }

        /* Get Parent Team Name if available, otherwise fallback to current group */
        let teamName = groupInfo.attributes.friendlyName ?? groupInfo.name
        if (groupInfo.parentPk) {
            const parentInfo = await this.authentikClient.getGroupInfo(groupInfo.parentPk)
            teamName = parentInfo.attributes.friendlyName ?? parentInfo.name
        }

        /* Remove the Role Attribute from Authentik if it exists */
        if (userInfo.attributes.roles && userInfo.attributes.roles[request.groupId]) {
            const updatedRoles = { ...userInfo.attributes.roles }
            delete updatedRoles[request.groupId]
            await this.authentikClient.updateUserAttributes(request.userPk, { roles: updatedRoles })
        }

        await this.authentikClient.removeGroupMember(request)
    }
}
