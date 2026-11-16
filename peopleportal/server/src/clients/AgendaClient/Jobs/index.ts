import { Job, JobDefinition } from "agenda";
import { DateTime } from "luxon";
import { EmailClient } from "../../EmailClient";
import { EmailSendRequest } from "../../EmailClient/models";
import { Event, IEvent } from "../../../models/Event";
import { EventRsvp, RsvpStatus } from "../../../models/EventRsvp";
import { DocumentJSON } from "../../../utils/types";
import { EventController } from "../../../controllers/EventController";
import { HydratedDocument } from "mongoose";
import { ENABLED_SHARED_RESOURCES } from "../../../config";
import { SlackClient } from "../../SlackClient";
import { DiscordClient } from "../../DiscordClient";
import {
    Application,
    ApplicationStage,
} from "../../../models/Application";
import {
    BulkApplicationRecipientStatus,
    BulkApplicationUpdateJob,
    BulkApplicationUpdateRecipient,
    BulkApplicationUpdateStatus,
} from "../../../models/BulkApplicationUpdate";
import { isValidApplicationStageTransition } from "../../../models/application-stage-transitions";

interface _JobData {
    jobName: string;
    jobPayload?: JobPayload;
    options?: {
        timezone?: string; // By default, Agenda uses UTC. Be sure to set this to "America/New_York".
        skipImmediate?: boolean;
        forkMode?: boolean;
        startDate?: string | Date;
        endDate?: string | Date;
        skipDays?: number[];
    };
}

export interface JobSchedulingData extends _JobData {
    runAt: Date | string; // runAt also accepts times as strings in English.
    // See Agenda docs for schedule function.
}

export interface RecurringJobSchedulingData extends _JobData {
    schedule: string;
}

// Helper functions
class JobHelperFunctions {
    public static async sendEventReminderEmail(
        event: HydratedDocument<IEvent> | DocumentJSON<IEvent>,
        emailClient: EmailClient,
        relativeTime: string,
    ) {
        const emails = await EventRsvp.distinct("email", {
            eventId: event._id,
            status: RsvpStatus.ACCEPT,
        }).exec();

        if (emails.length == 0) {
            return;
        }

        const inviteLink = EventController.generateEventInviteLink(event);
        const gCalendarLink = EventController.generateCalendarLink(event);

        await emailClient.send({
            to: process.env.PEOPLEPORTAL_SMTP_USER!,
            bcc: emails,
            subject: `App Dev Event Reminder - ${event.eventName}`,
            templateName: "EventReminder",
            templateVars: {
                relativeTime: relativeTime,
                eventName: event.eventName,
                eventDescription: event.eventDescription,
                startTime: event.startTime.toLocaleString("en-US", {
                    timeZone: "America/New_York",
                }),
                endTime: event.endTime.toLocaleString("en-US", {
                    timeZone: "America/New_York",
                }),
                location: event.location,
                inviteLink: inviteLink,
                googleCalendarLink: gCalendarLink,
            },
        });
    }

    public static async sendEventReminderSlack(
        event: HydratedDocument<IEvent> | DocumentJSON<IEvent>,
        relativeTime: string,
    ) {
        const slackClient = ENABLED_SHARED_RESOURCES.slackClient as SlackClient;
        const announcementsChannel = await slackClient.getChannelFromName(
            EventController.SLACK_EVENT_ANNOUNCEMENT_CHANNEL,
        );
        if (announcementsChannel === null) {
            return false;
        }

        if (relativeTime === "2 Hour") {
            relativeTime += "s";
        }
        const inviteLink = EventController.generateEventInviteLink(event);
        const message =
            `*Reminder*\n` +
            `${event.eventName} starts in ${relativeTime}.\n\n` +
            `RSVP here: ${inviteLink}`;

        return await slackClient.sendMessageInChannel(
            announcementsChannel.id!,
            message,
        );
    }

    public static async sendEventReminderDiscord(
        event: HydratedDocument<IEvent> | DocumentJSON<IEvent>,
        relativeTime: string,
    ) {
        const discordClient =
            ENABLED_SHARED_RESOURCES.discordClient as DiscordClient;
        const inviteLink = EventController.generateEventInviteLink(event);
        if (relativeTime === "2 Hour") {
            relativeTime += "s";
        }
        const message =
            `## Reminder\n` +
            `**${event.eventName}** starts in ${relativeTime}.\n\n` +
            `RSVP here: ${inviteLink}`;

        try {
            const announcementsChannel = await discordClient.getChannelFromName(
                EventController.DISCORD_EVENT_ANNOUNCEMENT_CHANNEL,
            );
            if (announcementsChannel === undefined) {
                return false;
            }
            await discordClient.sendMessageInChannel(
                announcementsChannel,
                message,
            );
            return true;
        } catch (error) {
            return false;
        }
    }
}

// Define job payloads

// Empty payload parent interface (for typing)
export interface JobPayload {}

export interface SendEmailJobPayload extends JobPayload {
    request: EmailSendRequest;
}

export interface SendEventRemindersPayload extends JobPayload {
    eventId: string;
}

export interface SendBulkApplicationUpdatesPayload extends JobPayload {
    jobId: string;
}

// Define Agenda jobs here
export const DefinedJobs: Record<
    string,
    {
        workerFunction: (argument: Job<any>) => Promise<void>;
        options?: Partial<
            Pick<
                JobDefinition,
                | "lockLimit"
                | "lockLifetime"
                | "concurrency"
                | "backoff"
                | "removeOnComplete"
                | "logging"
            >
        >;
    }
> = {
    sendEventRemindersDaily: {
        workerFunction: async (job: Job<JobPayload>) => {
            const emailClient = new EmailClient();

            const ny8AM = DateTime.now().setZone("America/New_York").set({
                hour: 8,
                minute: 0,
                second: 0,
                millisecond: 0,
            });

            const today8AM = ny8AM.toUTC().toJSDate();
            const oneDay = 1000 * 60 * 60 * 24; // Day in Milliseconds
            const tomorrow8AM = new Date(today8AM.getTime() + oneDay);
            const nextWeek8AM = new Date(today8AM.getTime() + oneDay * 7);

            const tomorrowEvents = await Event.find({
                startTime: {
                    $gte: tomorrow8AM,
                    $lt: new Date(tomorrow8AM.getTime() + oneDay),
                },
            })
                .lean()
                .exec();

            const nextWeekEvents = await Event.find({
                startTime: {
                    $gte: nextWeek8AM,
                    $lt: new Date(nextWeek8AM.getTime() + oneDay),
                },
            })
                .lean()
                .exec();

            const totalEvents = [...tomorrowEvents, ...nextWeekEvents];
            for (const event of totalEvents) {
                const relTime =
                    event.startTime < nextWeek8AM ? "1 Day" : "1 Week";

                if (event.marketingChannels.includes("email")) {
                    try {
                        await JobHelperFunctions.sendEventReminderEmail(
                            event,
                            emailClient,
                            relTime,
                        );
                    } catch (error) {
                        console.error(
                            `Failed to send email reminders for event ${event._id}:`,
                            error,
                        );
                    }
                }

                if (event.marketingChannels?.includes("slack")) {
                    const success =
                        await JobHelperFunctions.sendEventReminderSlack(
                            event,
                            relTime,
                        );
                    if (!success) {
                        console.error(
                            "Failed to send Slack reminders for event:",
                            event._id,
                        );
                    }
                }

                if (event.marketingChannels?.includes("discord")) {
                    const success =
                        await JobHelperFunctions.sendEventReminderDiscord(
                            event,
                            relTime,
                        );
                    if (!success) {
                        console.error(
                            "Failed to send Discord reminders for event:",
                            event._id,
                        );
                    }
                }
            }
        },
    },

    sendEventReminders: {
        workerFunction: async (job: Job<SendEventRemindersPayload>) => {
            const event = await Event.findOne({ _id: job.attrs.data.eventId })
                .lean()
                .exec();
            if (event == null) {
                console.error(
                    `[sendEventReminders Job] - Event ${job.attrs.data.eventId} not found.`,
                );
                return;
            }

            try {
                if (event.marketingChannels?.includes("email")) {
                    const emailClient = new EmailClient();
                    await JobHelperFunctions.sendEventReminderEmail(
                        event,
                        emailClient,
                        "2 Hour",
                    );
                }

                if (event.marketingChannels?.includes("slack")) {
                    const success =
                        await JobHelperFunctions.sendEventReminderSlack(
                            event,
                            "2 Hour",
                        );
                    if (!success) {
                        console.error(
                            "Failed to send Slack reminders for event:",
                            event._id,
                        );
                    }
                }

                if (event.marketingChannels?.includes("discord")) {
                    const success =
                        await JobHelperFunctions.sendEventReminderDiscord(
                            event,
                            "2 Hour",
                        );
                    if (!success) {
                        console.error(
                            "Failed to send Discord reminders for event:",
                            event._id,
                        );
                    }
                }
            } catch (error) {
                console.error(
                    `Failed to send reminders for event ${event._id} due to error:`,
                    error,
                );
                job.fail(error?.toString() ?? event._id.toString());
            }
        },
        options: {
            removeOnComplete: true, // Frees space by removing job from MongoDB on completion
        },
    },

    sendBulkApplicationUpdates: {
        workerFunction: async (
            job: Job<SendBulkApplicationUpdatesPayload>,
        ) => {
            const bulkJob = await BulkApplicationUpdateJob.findById(
                job.attrs.data.jobId,
            ).exec();
            if (!bulkJob) {
                throw new Error(
                    `Bulk application update job ${job.attrs.data.jobId} was not found`,
                );
            }

            bulkJob.status = BulkApplicationUpdateStatus.PROCESSING;
            await bulkJob.save();

            const recipients = await BulkApplicationUpdateRecipient.find({
                jobId: bulkJob._id,
                status: {
                    $in: [
                        BulkApplicationRecipientStatus.PENDING,
                        BulkApplicationRecipientStatus.PROCESSING,
                    ],
                },
            })
                .sort({ createdAt: 1 })
                .exec();
            const emailClient = new EmailClient();

            for (const recipient of recipients) {
                recipient.status = BulkApplicationRecipientStatus.PROCESSING;
                recipient.attempts += 1;
                recipient.error = undefined;
                recipient.failurePhase = undefined;
                await recipient.save();

                try {
                    if (!recipient.stageChangedAt) {
                        const application = await Application.findOne({
                            _id: recipient.applicationId,
                            teamPk: bulkJob.teamPk,
                        }).exec();

                        if (!application) {
                            throw new Error(
                                "Application no longer exists in this team",
                            );
                        }

                        const existingBulkTransition =
                            application.stageHistory.find(
                                (entry) =>
                                    entry.bulkJobId ===
                                    bulkJob._id.toString(),
                            );
                        if (
                            application.stage === recipient.targetStage &&
                            existingBulkTransition
                        ) {
                            recipient.stageChangedAt =
                                existingBulkTransition.changedAt;
                        } else {
                            if (
                                !recipient.previousStage ||
                                application.stage !==
                                    recipient.previousStage ||
                                !isValidApplicationStageTransition(
                                    application.stage,
                                    recipient.targetStage,
                                )
                            ) {
                                throw new Error(
                                    "Application stage changed after this batch was submitted",
                                );
                            }

                            const changedAt = new Date();
                            application.stage = recipient.targetStage;
                            application.stageHistory.push({
                                stage: recipient.targetStage,
                                changedAt,
                                changedBy: `${bulkJob.requestedByName} (${bulkJob.requestedByUsername})`,
                                bulkJobId: bulkJob._id.toString(),
                            });
                            await application.save();
                            recipient.stageChangedAt = changedAt;
                        }
                        await recipient.save();
                    }

                    if (!recipient.email || !recipient.applicantName) {
                        throw new Error(
                            "Applicant contact information is unavailable",
                        );
                    }

                    if (recipient.targetStage === ApplicationStage.INTERVIEW) {
                        await emailClient.send({
                            to: recipient.email,
                            cc: [bulkJob.requestedByEmail],
                            replyTo: [bulkJob.requestedByEmail],
                            subject: `Next Steps: ${bulkJob.teamName} Interview`,
                            templateName: "RecruitInterviewRequest",
                            templateVars: {
                                applicantName: recipient.applicantName,
                                interviewerName: bulkJob.requestedByName,
                                teamName: bulkJob.teamName,
                                interviewLink: bulkJob.interviewLink,
                                interviewGuidelines:
                                    bulkJob.interviewGuidelines,
                            },
                        });
                    } else if (
                        recipient.targetStage === ApplicationStage.REJECTED
                    ) {
                        await emailClient.send({
                            to: recipient.email,
                            cc: [bulkJob.requestedByEmail],
                            replyTo: [bulkJob.requestedByEmail],
                            subject: `Update on ${bulkJob.teamName}`,
                            templateName: "RecruitApplicationDeclined",
                            templateVars: {
                                applicantName: recipient.applicantName,
                                teamName: bulkJob.teamName,
                            },
                        });
                    } else {
                        throw new Error(
                            `No bulk email template is available for ${recipient.targetStage}`,
                        );
                    }

                    recipient.status = BulkApplicationRecipientStatus.SENT;
                    recipient.failurePhase = undefined;
                    recipient.error = undefined;
                    recipient.sentAt = new Date();
                    await recipient.save();
                } catch (error: unknown) {
                    recipient.status = BulkApplicationRecipientStatus.FAILED;
                    recipient.failurePhase = recipient.stageChangedAt
                        ? "email"
                        : "stage";
                    recipient.error =
                        error instanceof Error
                            ? error.message
                            : "Unknown recipient processing error";
                    await recipient.save();
                }
            }

            const remainingRecipients =
                await BulkApplicationUpdateRecipient.countDocuments({
                    jobId: bulkJob._id,
                    status: {
                        $in: [
                            BulkApplicationRecipientStatus.PENDING,
                            BulkApplicationRecipientStatus.PROCESSING,
                        ],
                    },
                }).exec();
            const unsuccessfulRecipients =
                await BulkApplicationUpdateRecipient.countDocuments({
                    jobId: bulkJob._id,
                    status: {
                        $in: [
                            BulkApplicationRecipientStatus.FAILED,
                            BulkApplicationRecipientStatus.VALIDATION_FAILED,
                        ],
                    },
                }).exec();

            bulkJob.status = remainingRecipients
                ? BulkApplicationUpdateStatus.QUEUED
                : unsuccessfulRecipients
                  ? BulkApplicationUpdateStatus.COMPLETED_WITH_ERRORS
                  : BulkApplicationUpdateStatus.COMPLETED;
            await bulkJob.save();
        },
        options: {
            concurrency: 1,
            removeOnComplete: true,
        },
    },
};

// Define any static, repeating jobs here
export const RecurringJobs: RecurringJobSchedulingData[] = [
    {
        jobName: "sendEventRemindersDaily",
        schedule: "0 8 * * *", // 8 AM daily
        options: {
            timezone: "America/New_York",
        },
    },
];
