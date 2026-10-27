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

import type * as express from "express";
import { Types } from "mongoose";
import path from "path";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { AuthentikClient } from "../../clients/AuthentikClient";
import type { GetGroupInfoResponse } from "../../clients/AuthentikClient/models";
import {
    Applicant,
    IApplicant,
    ApplicantProfile,
} from "../../models/Applicant";
import { Application, ApplicationStage } from "../../models/Application";
import { SubteamConfig } from "../../models/SubteamConfig";
import { TeamRecruitingStatus } from "../../models/TeamRecruitingStatus";
import { s3Client, BUCKET_NAME } from "../../clients/AWSClient/S3Client";
import {
    ATSResponse,
    ATSTeamApplicationRequest,
    resumeKeyFor,
    createResumeDownloadUrl,
    validateResumeUpload,
    validateApplicantProfile,
    validateApplicationResponses,
    verifyApplicantResume,
} from "./ATSHelpers";

/* Applicant workflow: authorize the guest session, validate the request and
 * uploaded PDF, then save the submission. File bytes stay in object storage;
 * MongoDB stores the applicant's resume key and application data. */
export class ATSApplicantService {
    constructor(
        private readonly response: ATSResponse,
        private readonly authentikClient: AuthentikClient,
    ) {}

    async getResumeUploadUrl(
        request: express.Request,
        fileName: string,
        contentType: string,
    ) {
        const userEmail = request.session.tempsession?.user?.email;
        if (!userEmail) {
            this.response.setStatus(401);
            return {
                error: "Unauthorized",
                message: "User session not found.",
            };
        }

        const validationError = validateResumeUpload(
            fileName,
            contentType,
            this.response,
        );
        if (validationError) return validationError;

        // Guest authentication creates the applicant before requesting an upload.
        const applicant = await Applicant.findOne({ email: userEmail }).exec();
        if (!applicant) {
            this.response.setStatus(404);
            return {
                error: "ApplicantNotFound",
                message: "Applicant not found",
            };
        }

        const key = resumeKeyFor(applicant._id);

        // Use presigned POST to enforce file size limits on S3 side
        const { url, fields } = await createPresignedPost(s3Client, {
            Bucket: BUCKET_NAME,
            Key: key,
            Conditions: [
                ["content-length-range", 0, 10 * 1024 * 1024], // 10MB limit
                { "content-type": "application/pdf" },
            ],
            Fields: {
                "content-type": "application/pdf",
            },
            Expires: 600, // 10 minutes
        });

        // Uploads go straight to storage. This app URL checks ownership on download.
        const protocol = request.protocol;
        const host = request.get("host");
        const publicUrl = `${protocol}://${host}/api/ats/resume/download?key=${encodeURIComponent(key)}`;

        return {
            uploadUrl: url,
            fields,
            publicUrl,
            key,
        };
    }

    async getResumeDownloadUrl(request: any, key: string) {
        const userEmail = request.session?.tempsession?.user?.email;

        // A guest can download only the resume belonging to their own applicant ID.
        if (!userEmail) {
            this.response.setStatus(401);
            return {
                error: "Unauthorized",
                message: "User session not found.",
            };
        }

        const applicant = await Applicant.findOne({ email: userEmail });
        const normalizedKey = path.posix.normalize(key);
        const expectedKey = resumeKeyFor(applicant?._id);

        if (
            !applicant ||
            normalizedKey !== expectedKey ||
            normalizedKey.includes("..")
        ) {
            this.response.setStatus(403);
            return {
                error: "Forbidden",
                message: "You do not have permission to access this file.",
            };
        }

        // Signing a URL does not check whether the object exists or is readable.
        try {
            const downloadUrl = await createResumeDownloadUrl(normalizedKey);

            // Storage serves the PDF; the backend returns only a temporary redirect.
            this.response.setStatus(307);
            this.response.setHeader("Location", downloadUrl);
            return;
        } catch (error) {
            console.error("Error generating download URL:", error);
            this.response.setStatus(404);
            return {
                error: "NotFound",
                message: "File not found or access denied.",
            };
        }
    }

    async applyToTeam(
        body: ATSTeamApplicationRequest,
        request: express.Request,
    ) {
        try {
            const { teamPk, rolePreferences, profile, responses } = body;

            // 1. Require an application payload and a verified applicant session.
            if (
                !teamPk ||
                !rolePreferences ||
                rolePreferences.length === 0 ||
                !profile
            ) {
                this.response.setStatus(400);
                return {
                    error: "InvalidRequest",
                    message:
                        "TeamPk, role preferences, and profile are required.",
                };
            }

            const userEmail = request.session.tempsession?.user?.email;
            if (!userEmail) {
                this.response.setStatus(401);
                return {
                    error: "Unauthorized",
                    message:
                        "User session not found. Please verify your email.",
                };
            }

            // 2. Require an open team and roles from its own recruiting subteams.
            const teamInfo: GetGroupInfoResponse =
                await this.authentikClient.getGroupInfo(teamPk);
            const teamStatus = await TeamRecruitingStatus.findOne({
                teamPk,
            }).exec();

            if (!teamStatus || !teamStatus.isRecruiting) {
                this.response.setStatus(403);
                return {
                    error: "RecruitmentClosed",
                    message:
                        "This team is not currently accepting applications.",
                };
            }

            const roleError = await this.validateRolePreferences(
                rolePreferences,
                teamStatus.recruitingSubteamPks,
                teamInfo,
            );
            if (roleError) return roleError;

            // 3. Validate the shared profile and every question for the selected roles.
            const allQuestions = await this.collectRoleQuestions(
                teamStatus.recruitingSubteamPks,
                rolePreferences,
            );

            const profileError = validateApplicantProfile(
                profile,
                this.response,
            );
            if (profileError) return profileError;

            // The team-interest question is required in addition to role questions.
            const teamName = teamInfo.attributes.friendlyName || teamInfo.name;
            const teamQuestionKey = `Why are you interested in ${teamName}?`;
            allQuestions.add(teamQuestionKey);

            const responseError = validateApplicationResponses(
                responses,
                allQuestions,
                this.response,
            );
            if (responseError) return responseError;

            // 4. Reject duplicates before reading the uploaded file from storage.
            const applicant = await Applicant.findOne({
                email: userEmail,
            }).exec();

            if (!applicant) {
                this.response.setStatus(404);
                return {
                    error: "ApplicantNotFound",
                    message: "Applicant profile not found.",
                };
            }

            const existingApp = await Application.findOne({
                applicantId: applicant._id,
                teamPk: teamPk,
            }).exec();

            if (existingApp) {
                this.response.setStatus(409);
                return {
                    error: "DuplicateApplication",
                    message: "You have already applied to this team.",
                };
            }

            // Check ownership and PDF bytes before changing any database records.
            try {
                const resumeError = await verifyApplicantResume(
                    applicant._id,
                    profile.resumeUrl,
                    this.response,
                );
                if (resumeError) return resumeError;
            } catch (e) {
                console.error("Failed to validate resume", e);
                this.response.setStatus(500);
                return {
                    error: "FileProcessingError",
                    message: "Failed to process resume file.",
                };
            }

            // 5. Link an existing member, then commit all submission records together.
            const appDevInternalPk = await this.findInternalMemberPk(userEmail);
            const application = await this.createAndLinkApplication(
                applicant,
                body,
                appDevInternalPk,
                request.session.tempsession?.user?.name ||
                    userEmail.split("@")[0]!,
            );

            return {
                message: "Application submitted successfully",
                id: application._id,
            };
        } catch (err) {
            if (err instanceof MissingSubmissionApplicant) {
                this.response.setStatus(404);
                return {
                    error: "ApplicantNotFound",
                    message: "Applicant profile not found.",
                };
            }
            if (
                typeof err === "object" &&
                err !== null &&
                "code" in err &&
                err.code === 11000
            ) {
                this.response.setStatus(409);
                return {
                    error: "DuplicateApplication",
                    message: "You have already applied to this team.",
                };
            }
            console.error("Application submission error:", err);
            this.response.setStatus(500);
            return {
                error: "ServerError",
                message: "Failed to submit application",
            };
        }
    }

    async updateProfile(body: ApplicantProfile, request: express.Request) {
        try {
            const userEmail = request.session?.tempsession?.user?.email;
            if (!userEmail) {
                this.response.setStatus(401);
                return {
                    error: "Unauthorized",
                    message: "User session not found.",
                };
            }

            const applicant = await Applicant.findOne({ email: userEmail });
            if (!applicant) {
                this.response.setStatus(404);
                return { error: "NotFound", message: "Applicant not found." };
            }

            // Merge existing profile with new updates
            const currentProfile = applicant.profile
                ? Object.fromEntries(applicant.profile)
                : {};

            // Immediate Signature Validation for new Resume Uploads
            if (body.resumeUrl && body.resumeUrl !== currentProfile.resumeUrl) {
                const resumeError = await verifyApplicantResume(
                    applicant._id,
                    body.resumeUrl,
                    this.response,
                );
                if (resumeError) {
                    return {
                        error: resumeError.error,
                        message: resumeError.message,
                    };
                }
            }

            const updatedProfile = { ...currentProfile, ...body };

            await Applicant.findOneAndUpdate(
                { email: userEmail },
                {
                    $set: {
                        profile: updatedProfile,
                        updatedAt: new Date(),
                    },
                },
            );

            return { message: "Profile updated successfully" };
        } catch (err) {
            console.error("Error updating profile:", err);
            this.response.setStatus(500);
            return {
                error: "ServerError",
                message: "Failed to update profile",
            };
        }
    }

    private async validateRolePreferences(
        rolePreferences: ATSTeamApplicationRequest["rolePreferences"],
        recruitingSubteamPks: string[],
        teamInfo: GetGroupInfoResponse,
    ) {
        const allowedSubteams = new Set(recruitingSubteamPks);
        for (const pref of rolePreferences) {
            if (
                !allowedSubteams.has(pref.subteamPk) ||
                !teamInfo.subteamPkList.includes(pref.subteamPk)
            ) {
                this.response.setStatus(400);
                return {
                    error: "InvalidRole",
                    message:
                        "Selected roles must belong to a recruiting subteam of this team",
                };
            }
            // Check if the subteam actually offers this role
            const subteamConfig = await SubteamConfig.findOne({
                subteamPk: pref.subteamPk,
            }).exec();
            if (
                !subteamConfig ||
                !subteamConfig.isRecruiting ||
                !subteamConfig.roles.includes(pref.role)
            ) {
                this.response.setStatus(400);
                return {
                    error: "InvalidRole",
                    message: `Role '${pref.role}' is not available in the specified subteam`,
                };
            }
        }
    }

    private async collectRoleQuestions(
        subteamPks: string[],
        rolePreferences: ATSTeamApplicationRequest["rolePreferences"],
    ) {
        const allQuestions = new Set<string>();
        for (const subteamPk of subteamPks) {
            const config = await SubteamConfig.findOne({
                subteamPk,
            }).exec();
            if (config && config.isRecruiting) {
                for (const pref of rolePreferences) {
                    if (pref.subteamPk === subteamPk) {
                        // Only check if this preference belongs to this subteam
                        if (config.roles.includes(pref.role)) {
                            const roleQuestions =
                                config.roleSpecificQuestions[pref.role] || [];
                            roleQuestions.forEach((q: string) =>
                                allQuestions.add(q),
                            );
                        }
                    }
                }
            }
        }
        return allQuestions;
    }

    private async findInternalMemberPk(userEmail: string) {
        let appDevInternalPk = null;
        try {
            const internalUser =
                await this.authentikClient.getUserInfoFromEmail(userEmail);
            appDevInternalPk = internalUser.pk;
        } catch (_e) {
            /* Not previously in App Dev */
        }
        return appDevInternalPk;
    }

    private async createAndLinkApplication(
        applicant: IApplicant,
        input: ATSTeamApplicationRequest,
        appDevInternalPk: string | null,
        fullName: string,
    ) {
        // Reuse the ID if MongoDB retries the transaction. Any failure rolls back
        // the profile, application link, and application as one unit. The unique
        // applicant/team index also resolves simultaneous duplicate submissions.
        const applicationId = new Types.ObjectId();
        return Applicant.db.transaction(async (session) => {
            const updatedApplicant = await Applicant.findByIdAndUpdate(
                applicant._id,
                {
                    $set: {
                        fullName,
                        profile: new Map(Object.entries(input.profile)),
                        updatedAt: new Date(),
                    },
                    $addToSet: { applicationIds: applicationId },
                },
                { new: true, session },
            ).exec();
            if (!updatedApplicant) throw new MissingSubmissionApplicant();

            const [application] = await Application.create(
                [
                    {
                        _id: applicationId,
                        applicantId: applicant._id,
                        teamPk: input.teamPk,
                        rolePreferences: input.rolePreferences,
                        stage: ApplicationStage.APPLIED,
                        responses: new Map(Object.entries(input.responses)),
                        appliedAt: new Date(),
                        appDevInternalPk,
                        stageHistory: [
                            {
                                stage: ApplicationStage.APPLIED,
                                changedAt: new Date(),
                            },
                        ],
                    },
                ],
                { session },
            );
            if (!application) throw new Error("Application was not created");
            return application;
        });
    }
}

class MissingSubmissionApplicant extends Error {}
