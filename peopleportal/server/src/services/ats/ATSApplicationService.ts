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
import { randomUUID } from "crypto";
import { Types } from "mongoose";
import { AuthentikClient } from "../../clients/AuthentikClient";
import {
    AuthentikClientError,
    AuthentikClientErrorType,
    type GetGroupInfoResponse,
} from "../../clients/AuthentikClient/models";
import { EmailClient } from "../../clients/EmailClient";
import { OrgController } from "../../controllers/OrgController";
import { BindleController } from "../../controllers/BindleController";
import type { AuthorizedUser } from "../../clients/OpenIdClient";
import { Applicant, IApplicant } from "../../models/Applicant";
import {
    Application,
    IApplication,
    ApplicationStage,
    PendingStageAction,
} from "../../models/Application";
import { SubteamConfig } from "../../models/SubteamConfig";
import {
    ATSResponse,
    ATSKanbanApplicationCard,
    ATSApplicationDetails,
    ATSUpdateApplicationStageRequest,
    isApplicantResumeKey,
    resumeKeyFor,
    createResumeDownloadUrl,
    validateFeedback,
    validateFeedbackNotes,
    formatFeedbackNote,
    validateStageTransition,
} from "./ATSHelpers";

/* Recruiter workflow: read applications, save manual feedback, and move an
 * application through the allowed stages. Stage follow-up work is stored with
 * the application so a failed email or membership update can be retried. */
export class ATSApplicationService {
    constructor(
        private readonly response: ATSResponse,
        private readonly authentikClient: AuthentikClient,
        private readonly emailClient: EmailClient,
        private readonly orgController: OrgController,
    ) {}

    async getApplicationStages() {
        // Return the ApplicationStage enum as an array of {id, name} objects
        const stages = Object.entries(ApplicationStage).map(([, value]) => ({
            id: value,
            name: value,
        }));

        return stages;
    }

    async getTeamApplications(
        teamId: string,
    ): Promise<ATSKanbanApplicationCard[]> {
        try {
            // Fetch all applications for this team directly - ONE per applicant!
            // Project only necessary fields for the summary view
            const applications = await Application.find({
                teamPk: teamId,
            })
                .select("applicantId stage rolePreferences appliedAt stars")
                .populate<{ applicantId: IApplicant }>(
                    "applicantId",
                    "fullName",
                )
                .lean()
                .exec();

            // Map to Kanban-friendly format
            const kanbanData: ATSKanbanApplicationCard[] = applications.map(
                (app) => ({
                    id: app._id.toString(),
                    applicantId: app.applicantId._id.toString(),
                    name: app.applicantId.fullName || "Unknown Applicant",
                    stage: app.stage,
                    rolePreferences: app.rolePreferences,
                    appliedAt: app.appliedAt,
                    stars: app.stars || 0,
                }),
            );

            return kanbanData;
        } catch (err) {
            console.error("Error fetching applications:", err);
            this.response.setStatus(500);
            throw new Error("Failed to fetch applications");
        }
    }

    async getApplicationDetails(
        teamId: string,
        applicationId: string,
    ): Promise<ATSApplicationDetails | { error: string; message: string }> {
        try {
            const app = await Application.findOne({
                _id: applicationId,
                teamPk: teamId,
            })
                .populate<{ applicantId: IApplicant }>("applicantId")
                .lean()
                .exec();

            if (!app) {
                this.response.setStatus(404);
                return { error: "NotFound", message: "Application not found" };
            }

            return {
                id: app._id.toString(),
                applicantId: app.applicantId._id.toString(),
                name: app.applicantId.fullName || "Unknown Applicant",
                email: app.applicantId.email || "",
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
                ...(app.appDevInternalPk
                    ? { appDevInternalPk: app.appDevInternalPk }
                    : {}),
            };
        } catch (err) {
            console.error("Error fetching application details:", err);
            this.response.setStatus(500);
            return {
                error: "ServerError",
                message: "Failed to fetch application details",
            };
        }
    }

    async updateApplicationFeedback(
        req: express.Request,
        teamId: string,
        applicationId: string,
        body: { stars?: number; notes?: string },
    ) {
        try {
            const { stars, notes } = body;

            const feedbackError = validateFeedback(stars, notes, this.response);
            if (feedbackError)
                return {
                    error: feedbackError.error,
                    message: feedbackError.message,
                };

            // 1. Fetch Existing Application
            const app = await Application.findOne({
                _id: applicationId,
                teamPk: teamId,
            });
            if (!app) {
                this.response.setStatus(404);
                return { error: "NotFound", message: "Application not found" };
            }

            // 2. Update Stars
            if (stars !== undefined) {
                app.stars = stars;
            }

            // 3. Prepend the new note with its author and timestamp.
            if (notes) {
                const notesError = validateFeedbackNotes(notes, this.response);
                if (notesError)
                    return {
                        error: notesError.error,
                        message: notesError.message,
                    };

                const authorizedUser: AuthorizedUser =
                    req.session.authorizedUser!;
                const authorName = authorizedUser.name;

                app.notes = formatFeedbackNote(authorName, notes, app.notes);
            }

            // 4. Save Changes
            await app.save();
            return { success: true, stars: app.stars, notes: app.notes };
        } catch (err) {
            this.response.setStatus(500);
            return { error: "ServerError", message: "Failed to update stars" };
        }
    }

    async getApplicantUrls(teamId: string, applicantId: string) {
        try {
            const teamApplication = await Application.exists({
                applicantId,
                teamPk: teamId,
            });
            if (!teamApplication) {
                this.response.setStatus(404);
                return { error: "NotFound", message: "Applicant not found" };
            }

            const applicant = await Applicant.findById(applicantId);
            if (!applicant) {
                this.response.setStatus(404);
                return { error: "NotFound", message: "Applicant not found" };
            }

            const profile = applicant.profile || new Map<string, string>();
            let resumeDownloadUrl: string | undefined;

            const resumeUrl = profile.get("resumeUrl");
            if (resumeUrl) {
                try {
                    const expectedKey = resumeKeyFor(applicant._id);
                    if (isApplicantResumeKey(applicant._id, resumeUrl)) {
                        resumeDownloadUrl =
                            await createResumeDownloadUrl(expectedKey);
                    }
                } catch (s3Error) {
                    console.error("Error signing S3 URL:", s3Error);
                    // Keep other profile links available if resume signing fails.
                }
            }

            return {
                resumeUrl: resumeDownloadUrl,
            };
        } catch (err) {
            console.error("Error fetching applicant URLs:", err);
            this.response.setStatus(500);
            return {
                error: "ServerError",
                message: "Failed to fetch applicant URLs",
            };
        }
    }

    async updateApplicationStage(
        req: express.Request,
        teamId: string,
        applicationId: string,
        body: ATSUpdateApplicationStageRequest,
    ) {
        try {
            const { stage, hiredRole, hiredSubteamPk } = body;

            if (!req.session?.authorizedUser) {
                this.response.setStatus(401);
                return {
                    error: "Unauthorized",
                    message: "Authenticated user not found",
                };
            }

            // 1. Scope the application to this team and check current hiring access.
            const application = await Application.findOne({
                _id: applicationId,
                teamPk: teamId,
            });
            if (!application) {
                this.response.setStatus(404);
                return { error: "NotFound", message: "Application not found" };
            }

            const teamInfo = await this.getAuthorizedHiringTeam(
                req.session.authorizedUser,
                application.teamPk,
            );
            if (!teamInfo) {
                this.response.setStatus(403);
                return {
                    error: "Forbidden",
                    message: "You do not have hiring access to this team",
                };
            }

            const applicant = await Applicant.findById(application.applicantId);
            if (!applicant) {
                this.response.setStatus(404);
                return { error: "NotFound", message: "Applicant not found" };
            }

            // 2. A repeated stage resumes pending work, or does nothing if completed.
            const currentStage = application.stage;
            if (currentStage === stage) {
                if (!application.pendingStageAction) {
                    return {
                        message: "Stage already set",
                        application: {
                            id: application._id,
                            stage: application.stage,
                        },
                    };
                }
                await this.finishPendingStageAction(
                    req.session.authorizedUser,
                    teamInfo,
                    application,
                    applicant,
                );
                return {
                    message: "Stage updated successfully",
                    application: {
                        id: application._id,
                        stage: application.stage,
                        hiredRole: application.hiredRole,
                    },
                };
            }

            if (application.pendingStageAction) {
                throw new StageActionConflict(
                    "Finish the pending stage action before moving this application again",
                );
            }

            // 3. Validate the transition and, for a hire, the destination role.
            const transitionError = validateStageTransition(
                currentStage,
                body,
                this.response,
            );
            if (transitionError) return transitionError;

            if (stage === ApplicationStage.HIRED) {
                if (!hiredRole || !hiredSubteamPk) {
                    this.response.setStatus(400);
                    return {
                        error: "BadRequest",
                        message:
                            "Hired Role and Subteam are required for Hired stage",
                    };
                }
                if (
                    !(await this.isValidHireDestination(
                        teamInfo,
                        hiredSubteamPk,
                        hiredRole,
                    ))
                ) {
                    this.response.setStatus(400);
                    return {
                        error: "BadRequest",
                        message:
                            "Hired role and subteam must belong to an active team destination",
                    };
                }
            }

            // 4. Save the stage, history entry, and follow-up payload atomically.
            // Potential Hire has no external action to retry.
            const changes: Record<string, unknown> = { stage };
            if (stage === ApplicationStage.HIRED)
                Object.assign(changes, { hiredRole, hiredSubteamPk });
            if (stage !== ApplicationStage.POTENTIAL_HIRE) {
                changes.pendingStageAction = {
                    id: randomUUID(),
                    stage,
                    input: body,
                    state: "pending",
                    completedSteps: [],
                    inviteId: new Types.ObjectId().toString(),
                    sender: {
                        name: req.session.authorizedUser.name,
                        email: req.session.authorizedUser.email,
                    },
                };
            }
            // Match the stage we read so concurrent reviewers cannot overwrite it.
            const updated = await Application.findOneAndUpdate(
                {
                    _id: applicationId,
                    teamPk: teamId,
                    stage: currentStage,
                    pendingStageAction: { $exists: false },
                },
                {
                    $set: changes,
                    $push: {
                        stageHistory: {
                            stage,
                            changedAt: new Date(),
                            changedBy: `${req.session.authorizedUser.name} (${req.session.authorizedUser.username})`,
                        },
                    },
                },
                { new: true, runValidators: true },
            );
            if (!updated)
                throw new StageActionConflict(
                    "Application changed; refresh and retry",
                );
            // 5. Claim and perform the saved work after the database accepts it.
            if (updated.pendingStageAction) {
                await this.finishPendingStageAction(
                    req.session.authorizedUser,
                    teamInfo,
                    updated,
                    applicant,
                );
            }

            return {
                message: "Stage updated successfully",
                application: {
                    id: updated._id,
                    stage: updated.stage,
                    hiredRole: updated.hiredRole,
                },
            };
        } catch (err) {
            if (err instanceof StageActionConflict) {
                this.response.setStatus(409);
                return { error: "StageActionConflict", message: err.message };
            }
            console.error("Error updating application stage:", err);
            this.response.setStatus(500);
            return {
                error: "ServerError",
                message: "Failed to update application stage",
            };
        }
    }

    async getApplicantApplications(teamId: string, applicantId: string) {
        try {
            const teamApplication = await Application.exists({
                applicantId,
                teamPk: teamId,
            });
            if (!teamApplication) {
                this.response.setStatus(404);
                return { error: "NotFound", message: "Applicant not found" };
            }

            const applications = await Application.find({
                applicantId: applicantId,
            })
                .lean()
                .sort({ appliedAt: -1 })
                .exec();

            const results = await Promise.all(
                applications.map(async (app: any) => {
                    let teamName = app.teamPk;

                    try {
                        const teamInfo =
                            await this.authentikClient.getGroupInfo(app.teamPk);
                        if (
                            teamInfo &&
                            teamInfo.attributes &&
                            teamInfo.attributes.friendlyName
                        ) {
                            teamName = teamInfo.attributes.friendlyName;
                        } else if (teamInfo && teamInfo.name) {
                            teamName = teamInfo.name;
                        }
                    } catch (e) {
                        console.error(
                            `Failed to fetch team info for ${app.teamPk}`,
                            e,
                        );
                    }

                    // Enrich role preferences with subteam names
                    const rolePreferencesWithNames = await Promise.all(
                        (app.rolePreferences || []).map(async (pref: any) => {
                            let subteamName = pref.subteamPk;
                            try {
                                const subteamInfo =
                                    await this.authentikClient.getGroupInfo(
                                        pref.subteamPk,
                                    );
                                subteamName =
                                    subteamInfo.attributes?.friendlyName ||
                                    subteamInfo.name;
                            } catch (e) {
                                console.error(
                                    `Failed to fetch subteam info for ${pref.subteamPk}`,
                                    e,
                                );
                            }
                            return { ...pref, subteamName };
                        }),
                    );

                    return {
                        id: app._id,
                        teamPk: app.teamPk,
                        teamName: teamName,
                        rolePreferences: rolePreferencesWithNames,
                        stage: app.stage,
                        appliedAt: app.appliedAt,
                        hiredRole: app.hiredRole,
                    };
                }),
            );

            return results;
        } catch (err) {
            console.error("Error fetching applicant applications:", err);
            this.response.setStatus(500);
            return {
                error: "ServerError",
                message: "Failed to fetch applicant history",
            };
        }
    }

    async processHiredStageTransition(
        authorizedUser: AuthorizedUser,
        teamInfo: GetGroupInfoResponse,
        application: IApplication,
        applicant: IApplicant,
        leaseToken?: string,
    ): Promise<void> {
        /* This helper is callable independently of tsoa middleware. Re-check the
         * authorization and destination immediately before changing membership or
         * creating an invite so direct controller calls cannot bypass ATS policy. */
        const authorizedTeam = await this.getAuthorizedHiringTeam(
            authorizedUser,
            application.teamPk,
        );
        if (
            !authorizedTeam ||
            !application.hiredRole ||
            !application.hiredSubteamPk ||
            !(await this.isValidHireDestination(
                authorizedTeam,
                application.hiredSubteamPk,
                application.hiredRole,
            ))
        ) {
            throw new Error("Unauthorized hired-stage transition");
        }

        teamInfo = authorizedTeam;
        const action = application.pendingStageAction;
        let memberPk = action?.memberPk;
        let recipientType = action?.recipientType;
        if (!recipientType) {
            try {
                const user = await this.authentikClient.getUserInfoFromEmail(
                    applicant.email,
                );
                memberPk = user.pk;
                recipientType = "member";
            } catch (error) {
                if (
                    !(error instanceof AuthentikClientError) ||
                    error.code !== AuthentikClientErrorType.USER_NOT_FOUND
                )
                    throw error;
                recipientType = "external";
            }
            if (leaseToken) {
                await this.updateStageAction(application, leaseToken, {
                    recipientType,
                    ...(memberPk ? { memberPk } : {}),
                });
            }
        }

        if (recipientType === "external") {
            if (action?.completedSteps.includes("notification")) return;
            const request = {
                session: { authorizedUser },
                bindle: { teamInfo, requestedPermissions: [] },
            };
            const invite = {
                inviteeName: applicant.fullName,
                inviteeEmail: applicant.email,
                roleTitle: application.hiredRole!,
                subteamPk: application.hiredSubteamPk!,
            };
            if (action && leaseToken) {
                await this.extendStageActionLease(application, leaseToken);
                await this.orgController.createInviteForATS(
                    request,
                    invite,
                    action.inviteId,
                );
                await this.completeStageActionStep(
                    application,
                    leaseToken,
                    "notification",
                );
            } else {
                await this.orgController.createInvite(request, invite);
            }
            return;
        }

        // Membership can succeed before a later role write fails. On retry, inspect
        // the directory and finish the role instead of blindly adding the member again.
        if (!action?.completedSteps.includes("membership")) {
            if (leaseToken)
                await this.extendStageActionLease(application, leaseToken);
            let alreadyAdded = false;
            if (action?.membershipStarted) {
                const member = await this.authentikClient.getUserInfo(
                    +memberPk!,
                );
                alreadyAdded = member.groups.includes(
                    application.hiredSubteamPk!,
                );
                const roles = member.attributes.roles ?? {};
                if (
                    alreadyAdded &&
                    roles[application.hiredSubteamPk!] !== application.hiredRole
                ) {
                    await this.authentikClient.updateUserAttributes(
                        +memberPk!,
                        {
                            roles: {
                                ...roles,
                                [application.hiredSubteamPk!]:
                                    application.hiredRole!,
                            },
                        },
                    );
                }
            }
            if (!alreadyAdded) {
                if (leaseToken)
                    await this.updateStageAction(application, leaseToken, {
                        membershipStarted: true,
                    });
                await this.orgController.addTeamMember(
                    application.hiredSubteamPk!,
                    { userPk: +memberPk!, roleTitle: application.hiredRole! },
                );
            }
            if (leaseToken)
                await this.completeStageActionStep(
                    application,
                    leaseToken,
                    "membership",
                );
        }
        if (action?.completedSteps.includes("notification")) return;
        if (leaseToken)
            await this.extendStageActionLease(application, leaseToken);
        // Record membership before email, so an email retry does not repeat the add.
        const sender = action?.sender ?? authorizedUser;
        await this.emailClient.send({
            to: applicant.email,
            cc: [sender.email],
            replyTo: [sender.email],
            subject: `Congrats! You're accepted to ${teamInfo.attributes.friendlyName}`,
            templateName: "RecruitExistingMemberAcceptance",
            templateVars: {
                inviteeName: applicant.fullName,
                invitorName: sender.name,
                teamName: teamInfo.attributes.friendlyName,
                roleTitle: application.hiredRole!,
            },
        });
        if (leaseToken)
            await this.completeStageActionStep(
                application,
                leaseToken,
                "notification",
            );
    }

    private async getAuthorizedHiringTeam(
        authorizedUser: AuthorizedUser,
        teamPk: string,
    ): Promise<GetGroupInfoResponse | null> {
        const teamInfo = await this.authentikClient.getGroupInfo(teamPk);
        if (
            !teamInfo.attributes.peoplePortalCreation ||
            teamInfo.attributes.flaggedForDeletion
        )
            return null;
        if (authorizedUser.is_superuser) return teamInfo;

        const isOwner = authorizedUser.groups.includes(teamInfo.name);
        const permissions = BindleController.getEffectivePermissionSet(
            teamInfo,
            authorizedUser.groups,
        );
        return isOwner || permissions.has("corp:hiringaccess")
            ? teamInfo
            : null;
    }

    private async isValidHireDestination(
        teamInfo: GetGroupInfoResponse,
        subteamPk: string,
        role: string,
    ): Promise<boolean> {
        if (
            teamInfo.attributes.flaggedForDeletion ||
            !teamInfo.subteamPkList.includes(subteamPk)
        )
            return false;

        const destination = await this.authentikClient.getGroupInfo(subteamPk, {
            includeParentInfo: true,
        });
        if (
            !destination.attributes.peoplePortalCreation ||
            destination.parentPk !== teamInfo.pk ||
            destination.attributes.flaggedForDeletion
        )
            return false;

        const config = await SubteamConfig.findOne({ subteamPk }).lean().exec();
        return !!config && config.roles.includes(role);
    }
    // A lease gives one request ownership of this action. Renew it during slow
    // external calls; after a stopped worker's lease expires, a retry can claim it.
    private static readonly STAGE_ACTION_LEASE_MS = 5 * 60 * 1000;

    private stageActionFilter(application: IApplication, leaseToken: string) {
        return {
            _id: application._id,
            teamPk: application.teamPk,
            "pendingStageAction.id": application.pendingStageAction!.id,
            "pendingStageAction.leaseToken": leaseToken,
        };
    }

    private async extendStageActionLease(
        application: IApplication,
        leaseToken: string,
    ) {
        const result = await Application.updateOne(
            this.stageActionFilter(application, leaseToken),
            {
                $set: {
                    "pendingStageAction.leaseUntil": new Date(
                        Date.now() +
                            ATSApplicationService.STAGE_ACTION_LEASE_MS,
                    ),
                },
            },
        );
        if (result.matchedCount !== 1)
            throw new StageActionConflict(
                "Stage action lease was lost; refresh and retry",
            );
    }

    private async updateStageAction(
        application: IApplication,
        leaseToken: string,
        values: Partial<PendingStageAction>,
    ) {
        const result = await Application.updateOne(
            this.stageActionFilter(application, leaseToken),
            {
                $set: Object.fromEntries(
                    Object.entries(values).map(([key, value]) => [
                        `pendingStageAction.${key}`,
                        value,
                    ]),
                ),
            },
        );
        if (result.matchedCount !== 1)
            throw new StageActionConflict(
                "Stage action lease was lost; refresh and retry",
            );
        Object.assign(application.pendingStageAction!, values);
    }

    private async completeStageActionStep(
        application: IApplication,
        leaseToken: string,
        step: string,
    ) {
        const result = await Application.updateOne(
            this.stageActionFilter(application, leaseToken),
            {
                $addToSet: { "pendingStageAction.completedSteps": step },
            },
        );
        if (result.matchedCount !== 1)
            throw new StageActionConflict(
                "Stage action lease was lost; refresh and retry",
            );
        if (!application.pendingStageAction!.completedSteps.includes(step)) {
            application.pendingStageAction!.completedSteps.push(step);
        }
    }

    private async finishPendingStageAction(
        authorizedUser: AuthorizedUser,
        teamInfo: GetGroupInfoResponse,
        application: IApplication,
        applicant: IApplicant,
    ) {
        // Claim -> run unfinished steps -> clear on success. On failure, release
        // the claim but retain the payload and completed steps for the next retry.
        const pending = application.pendingStageAction!;
        if (
            pending.stage !== application.stage ||
            pending.input.stage !== application.stage
        ) {
            throw new StageActionConflict(
                "Pending action does not match the application stage",
            );
        }
        const leaseToken = randomUUID();
        const claimed = await Application.findOneAndUpdate(
            {
                _id: application._id,
                teamPk: application.teamPk,
                "pendingStageAction.id": pending.id,
                $or: [
                    { "pendingStageAction.state": "pending" },
                    {
                        "pendingStageAction.state": "processing",
                        "pendingStageAction.leaseUntil": { $lte: new Date() },
                    },
                ],
            },
            {
                $set: {
                    "pendingStageAction.state": "processing",
                    "pendingStageAction.leaseToken": leaseToken,
                    "pendingStageAction.leaseUntil": new Date(
                        Date.now() +
                            ATSApplicationService.STAGE_ACTION_LEASE_MS,
                    ),
                },
            },
            { new: true },
        );
        if (!claimed)
            throw new StageActionConflict(
                "This stage action is already running; retry shortly",
            );

        let heartbeat: Promise<void> | undefined;
        let leaseFailure: unknown;
        const timer = setInterval(() => {
            if (heartbeat) return;
            heartbeat = this.extendStageActionLease(claimed, leaseToken)
                .catch((error: unknown) => {
                    leaseFailure = error;
                })
                .finally(() => {
                    heartbeat = undefined;
                });
        }, 30_000);
        timer.unref();
        const stopHeartbeat = async () => {
            clearInterval(timer);
            await heartbeat;
        };
        try {
            await this.performStageActions(
                authorizedUser,
                teamInfo,
                claimed,
                applicant,
                leaseToken,
            );
            await stopHeartbeat();
            if (leaseFailure) throw leaseFailure;
            const result = await Application.updateOne(
                this.stageActionFilter(claimed, leaseToken),
                { $unset: { pendingStageAction: 1 } },
            );
            if (result.matchedCount !== 1)
                throw new StageActionConflict(
                    "Stage action lease was lost; refresh and retry",
                );
        } catch (error) {
            await stopHeartbeat();
            await Application.updateOne(
                this.stageActionFilter(claimed, leaseToken),
                {
                    $set: { "pendingStageAction.state": "pending" },
                    $unset: {
                        "pendingStageAction.leaseToken": 1,
                        "pendingStageAction.leaseUntil": 1,
                    },
                },
            );
            throw error;
        } finally {
            await stopHeartbeat();
        }
    }

    private async performStageActions(
        authorizedUser: AuthorizedUser,
        teamInfo: GetGroupInfoResponse,
        application: IApplication,
        applicant: IApplicant,
        leaseToken: string,
    ) {
        const action = application.pendingStageAction!;
        if (action.completedSteps.includes("notification")) return;
        const { stage, interviewLink, interviewGuidelines } = action.input;
        const sender = action.sender;
        if (stage === ApplicationStage.HIRED) {
            await this.processHiredStageTransition(
                authorizedUser,
                teamInfo,
                application,
                applicant,
                leaseToken,
            );
            return;
        }
        await this.extendStageActionLease(application, leaseToken);
        if (stage === ApplicationStage.INTERVIEW) {
            await this.emailClient.send({
                to: applicant.email,
                cc: [sender.email],
                replyTo: [sender.email],
                subject: `Next Steps: ${teamInfo.attributes.friendlyName} Interview`,
                templateName: "RecruitInterviewRequest",
                templateVars: {
                    applicantName: applicant.fullName,
                    interviewerName: sender.name,
                    teamName: teamInfo.attributes.friendlyName,
                    interviewLink,
                    interviewGuidelines,
                },
            });
        } else if (stage === ApplicationStage.REJECTED) {
            await this.emailClient.send({
                to: applicant.email,
                cc: [sender.email],
                replyTo: [sender.email],
                subject: `Update on ${teamInfo.attributes.friendlyName}`,
                templateName: "RecruitApplicationDeclined",
                templateVars: {
                    applicantName: applicant.fullName,
                    teamName: teamInfo.attributes.friendlyName,
                },
            });
        }
        // SMTP has no atomic commit with MongoDB. A crash after delivery but before
        // this checkpoint can still cause a duplicate email on retry.
        await this.completeStageActionStep(
            application,
            leaseToken,
            "notification",
        );
    }
}

class StageActionConflict extends Error {}
