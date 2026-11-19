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

import { Route, Request, Controller, Get, SuccessResponse, Post, Body, Tags, Security, Path, Queries, Delete, Patch } from "tsoa";
import { EmailClient } from "../clients/EmailClient";
import { SlackClient } from "../clients/SlackClient";
import { AuthentikClient } from "../clients/AuthentikClient";
import { ENABLED_SHARED_RESOURCES, hasAdminAuthority } from '../config';
import * as express from 'express';
import { CustomValidationError, ResourceAccessError } from "../utils/errors";
import { Event, IEvent } from "../models/Event";
import { EventRsvp, IRsvp, RsvpStatus } from "../models/EventRsvp";
import { FlattenMaps, HydratedDocument, Types } from "mongoose";
import { agendaClient } from "../clients/AgendaClient";
import { DiscordClient } from "../clients/DiscordClient";


import type { DocumentJSON } from "../utils/types";

export interface GetEventListOptions {
    before?: Date;
    after?: Date;
    scopes?: string[];
}
export interface GetEventListResponse {
    data: string[],
    count: number,
}

export interface GetEventResponse {
    status: string;
    data: DocumentJSON<IEvent>
}

export interface CreateEventRequest {
    title: string;
    description: string;
    startTime: Date;
    endTime: Date;
    location: string;
    scope: string;
    marketingChannels: string[];
}
export interface CreateEventResponse {
    eventId: string,
    status: string,
    issues: string[],
}

export interface BasicEventResponse {
    status: string;
    message?: string;
    issues: string[];
}

export interface UpdateEventRequest {
    notify: boolean; // Will send update announcements.
    eventName?: string;
    eventDescription?: string;
    startTime?: Date;
    endTime?: Date;
    location?: string;
}

export interface GetRsvpsRequest {
    page: number;
    pageSize?: number;
}
export interface GetRsvpResponse {
    status: string;
    data: DocumentJSON<IRsvp>[];
    pagination: {
        totalPages: number;
    };
}

export interface RsvpRequest {
    accept: boolean;
}

export interface GetEventRsvpResponse {
    status: string;
    rsvp: DocumentJSON<IRsvp> | null;
}


@Route("/api/events/")
export class EventController extends Controller {
    public static readonly SLACK_EVENT_ANNOUNCEMENT_CHANNEL = "announcements";
    public static readonly DISCORD_EVENT_ANNOUNCEMENT_CHANNEL = "announcements";

    private readonly authentikClient;
    private readonly emailClient;
    private readonly slackClient;
    private readonly discordClient;
    
    constructor() {
        super()
        this.authentikClient = new AuthentikClient();
        this.emailClient = new EmailClient();
        this.slackClient = ENABLED_SHARED_RESOURCES.slackClient as SlackClient;
        this.discordClient = ENABLED_SHARED_RESOURCES.discordClient as DiscordClient;
    }


    /**
     * Get list of event Ids.
     */
    @Get("/")
    @SuccessResponse(200)
    @Security("oidc")
    @Security("ats_otp")
    @Tags("Event Management")
    async getListOfEvents(
        @Request() req: express.Request,
        @Queries() options?: GetEventListOptions
    ): Promise<GetEventListResponse> {
        let filters: { [key: string]: any } = {};

        if (options?.after !== undefined) {
            filters.startTime = { $gte: options.after };
        }
        if (options?.before !== undefined) {
            if (filters.startTime !== undefined) {
                filters.startTime.$lte = options.before;
            } else {
                filters.startTime = { $lte: options.before };
            }
        }

        let scopes: string[] = [];

        // Checks if user is not an authorized user (is using otp)
        if (!req.session.authorizedUser || !req.session.authorizedUser.pk) {
            // Only show public events
            scopes = ["public"];
        } else if (!req.session.authorizedUser?.is_superuser) {
            try {
                const userTeams = await this.authentikClient.getRootTeamsForUsername(req.session.authorizedUser!.username);
                if (!hasAdminAuthority(userTeams.teams, req.session.authorizedUser!.groups ?? [])) {
                    scopes = ["public", "internal"];
                }
            } catch (error) {
                throw new ResourceAccessError(500, "Failed to get team membership."); 
            }
        }

        if (options?.scopes !== undefined) {
            if (scopes.length > 0) {
                scopes = scopes.filter(scope => options.scopes?.includes(scope));
            } else {
                scopes = options?.scopes;
            }
        }

        if (scopes.length > 0) {
            filters.scope = { $in: scopes };
        }

        const query = Event.distinct("_id", filters).sort({ startTime: 'asc' }).lean();
        const results = await query.exec();
        const response = {
            data: results.map((objId) => objId.toString()),
            count: results.length,
        }

        return response;
    }


    /**
     * Return a single event's information.
     * 
     * @param req express Request object
     * @param eventId Id of the event
     * @returns Event data as json.
     */
    @Get("{eventId}")
    @SuccessResponse(200)
    @Security("oidc")
    @Security("ats_otp")
    @Tags("Event Management")
    async getEvent(
        @Request() req: express.Request,
        @Path() eventId: string,
    ): Promise<GetEventResponse> {
        // Get event data
        let query = Event.findOne({ _id: eventId });

        // Checks if user is not an authorized user (is using otp)
        if (!req.session.authorizedUser || !req.session.authorizedUser.pk) {
            // Only show public events
            query = query.where("scope").equals("public");
        } else if (!req.session.authorizedUser?.is_superuser) {
            try {
                const userTeams = await this.authentikClient.getRootTeamsForUsername(req.session.authorizedUser!.username);
                if (!hasAdminAuthority(userTeams.teams, req.session.authorizedUser!.groups ?? [])) {
                    query = query.where("scope").ne("exec");
                }
            } catch (error) {
                throw new ResourceAccessError(500, "Failed to get team membership."); 
            }
        }


        try {
            const event = await query.lean().exec();
            if (!event) {
                throw new CustomValidationError(404, `No event with id ${eventId}`);
            }
            return { status: "Success", data: event }
        } catch (error) {
            console.error(`Failed to get event data for event ${eventId}:`, error);
            throw new ResourceAccessError(500, "Failed to fetch event data");
        }
    }

    /**
     * 
     * @param req Express Request Object
     * @param body CreateEventRequest
     * @returns Object with eventId and status.
     */
    @Post("/")
    @SuccessResponse(201, "Event Created")
    @Security("events")
    @Tags("Event Management")
    async createEvent(
        @Request() req: express.Request,
        @Body() body: CreateEventRequest,
    ): Promise<CreateEventResponse> {
        // Validations
        if (body.startTime > body.endTime) {
            throw new CustomValidationError(400, "End time can't be before start time.");
        }
        if (body.title.length == 0) {
            throw new CustomValidationError(400, "No title given.");
        }

        const authorizedUser = req.session.authorizedUser!;

        const event = await Event.create({
            eventName: body.title,
            eventDescription: body.description,
            creator: authorizedUser.pk,
            startTime: body.startTime,
            endTime: body.endTime,
            location: body.location,
            scope: body.scope,
            marketingChannels: body.marketingChannels,
        });

        const gCalendarLink = EventController.generateCalendarLink(event);
        const inviteLink = EventController.generateEventInviteLink(event);
        const issues: string[] = [];

        // EMAIL INVITEES
        if (body.marketingChannels.includes("email")) {
            try {
                const userInfo = await this.resolveUserInfoFromScope(body.scope);
                if (!userInfo) {
                    throw new Error("Failed to fetch recipients.");
                }

                // Send out emails to invitees with bcc.
                const emails = userInfo.map(uInfo => uInfo.email);
                await this.emailClient.send({
                    to: process.env.PEOPLEPORTAL_SMTP_USER!,
                    cc: [authorizedUser.email],
                    bcc: emails,
                    subject: `App Dev Event Invitation - ${body.title}`,
                    templateName: "EventInvite",
                    templateVars: {
                        eventName: body.title,
                        eventDescription: body.description,
                        startTime: body.startTime.toLocaleString("en-US", { timeZone: "America/New_York" }),
                        endTime: body.endTime.toLocaleString("en-US", { timeZone: "America/New_York" }),
                        eventLocation: body.location,
                        inviteLink: inviteLink,
                        googleCalendarLink: gCalendarLink,
                    },
                });
            } catch (error) {
                console.error("Failed to send email to event invitees:", error);
                issues.push("Failed to send email.")
            }
        }

        // SLACK MESSAGE
        if (body.marketingChannels.includes("slack")) {
            const message = `*Event Announcement*\n` +
                            `>${event.eventName}\n` +
                            `Description: ${event.eventDescription}\n` +
                            `Start Time: ${event.startTime.toLocaleString("en-US", { timeZone: "America/New_York" })}\n` +
                            `End Time: ${event.endTime.toLocaleString("en-US", { timeZone: "America/New_York" })}\n` +
                            `Location: ${event.location}\n\n` +
                            `RSVP here: ${inviteLink}\n` +
                            `Add to google calendar: ${gCalendarLink}`;

            const success = await this.sendSlackMessage(message);
            if (!success) {
                issues.push("Failed to send Slack announcement.");
            }
        }

        // DISCORD MESSAGE
        if (body.marketingChannels.includes("discord")) {
            const message = `# Event Announcement\n` + 
                            `## ${event.eventName}\n` + 
                            `- Description: ${event.eventDescription}\n` +
                            `- Start Time: ${event.startTime.toLocaleString("en-US", { timeZone: "America/New_York" })}\n` +
                            `- End Time: ${event.endTime.toLocaleString("en-US", { timeZone: "America/New_York" })}\n` +
                            `- Location: ${event.location}\n\n` +
                            `RSVP here: ${inviteLink}\n` +
                            `Add to google calendar: ${gCalendarLink}`;

            const success = await this.sendDiscordMessage(message);
            if (!success) {
                issues.push("Failed to send Discord announcement.");
            }
        }
        
        // Schedule 2 Hour Reminder
        try {
            await agendaClient.scheduleJobOnce({
                jobName: "sendEventReminders",
                runAt: new Date(event.startTime.getTime() - 1000 * 60 * 60 * 2),
                jobPayload: { eventId: event._id.toString() },
                options: { timezone: "America/New_York" }
            });
        } catch (error) {
            issues.push("Failed to schedule 2 hour reminder.");
            console.error(`Failed to schedule 2 hour reminder for event ${event._id}:`, error);
        }
        

        return {
            eventId: event._id.toString(),
            status: "Event Created Successfully",
            issues: issues,
        };
    }


    /**
     * Cancels event. Deletes document from Events and all RSVPs.
     * 
     * @param req Express Request Object
     * @param eventId Id of the event to cancel
     * @param body { notify?: boolean }. If notify is true (default), will send notify invitees of event cancellation.
     * @returns BasicEventResponse
     */

    @Delete("{eventId}")
    @SuccessResponse(200, "Event cancelled.")
    @Security("events")
    @Tags("Event Management")
    async cancelEvent(
        @Request() req: express.Request,
        @Path() eventId: string,
        @Body() body?: { notify?: boolean }
    ): Promise<BasicEventResponse> {
        // Find event
        let event: HydratedDocument<IEvent> | null;
        try {
            event = await Event.findOne({ _id: eventId }).exec();
        } catch (error) {
            console.error(`Failed to get event data for event ${eventId}: `, error);
            throw new ResourceAccessError(500, `Failed to fetch event ${eventId}`);
        }
        
        if (!event) {
            throw new CustomValidationError(404, `No event with id ${eventId}`);
        }

        await agendaClient.cancelJob("sendEventReminders", { eventId: eventId });
        // Delete all RSVPs and Event
        const rsvp_deletion = await EventRsvp.deleteMany({ eventId: eventId }).exec();
        await event.deleteOne();

        const issues: string[] = [];

        if (body?.notify === false) {
            return {
                status: "Success",
                message: "Successfully cancelled event",
                issues: issues,
            };
        }

    
        if (event.marketingChannels.includes("email")) {
            try {
                const invitees = await this.resolveUserInfoFromScope(event.scope);
                if (invitees === undefined) {
                    throw new Error("Failed to fetch invitees.");
                }

                await this.emailClient.send({
                    to: process.env.PEOPLEPORTAL_SMTP_USER!,
                    cc: [req.session.authorizedUser!.email],
                    bcc: invitees.map(invitee => invitee.email),
                    subject: `App Dev Event Cancelled - ${event.eventName}`,
                    templateName: "EventCancellation",
                    templateVars: {
                        eventName: event.eventName,
                        eventDescription: event.eventDescription,
                        startTime: event.startTime.toLocaleString("en-US", { timeZone: "America/New_York" }),
                        endTime: event.endTime.toLocaleString("en-US", { timeZone: "America/New_York" }),
                    },
                });
            } catch (error) {
                console.error(`Failed to get email recipients:`, error);
                issues.push("Failed to send emails.");
            }   
        }

        // Send Slack Message
        if (event.marketingChannels.includes("slack")) {
            const message = `*Event Announcement*\n` + 
                            `${event.eventName} has been *cancelled.*`;

            const success = await this.sendSlackMessage(message);
            if (!success) {
                issues.push("Failed to send Slack announcement.");
            }
        }

        // Send Discord Message
        if (event.marketingChannels.includes("discord")) {
            const message = `# Event Announcement\n` + 
                            `**${event.eventName}** has been **cancelled**`;
            
            const success = await this.sendDiscordMessage(message);
            if (!success) {
                issues.push("Failed to send Discord announcement.");
            }
        }

        return {
            status: "Success",
            message: "Successfully cancelled event",
            issues: issues,
        };
    }


    /**
     * Updates the information of an event. Sends update announcement if
     * notify is set.
     * 
     * @param eventId id of the event
     * @param body UpdateEventRequest
     * @returns BasicEventResponse
     */
    @Patch("{eventId}")
    @SuccessResponse(200, "Event successfully updated")
    @Security("events")
    @Tags("Event Management")
    async updateEvent(
        @Path() eventId: string,
        @Body() body: UpdateEventRequest
    ): Promise<BasicEventResponse> {
        let event: HydratedDocument<IEvent> | null;
        try {
            event = await Event.findOne({ _id: eventId }).exec();
        } catch (error) {
            throw new ResourceAccessError(500, `Failed to fetch event ${eventId}`);
        }

        if (!event) {
            throw new CustomValidationError(404, `No event with id ${eventId}`);
        }

        const { notify, ...docUpdates } = body;

        // Strip undefined values and values equal to existing values.
        Object.keys(docUpdates).forEach((key) => {
            const k = key as keyof typeof docUpdates;
            let isEqual = event[k] === docUpdates[k];
            if (k.includes("Time")) {
                isEqual = (event[k] as Date).getTime() === (docUpdates[k] as Date).getTime();
            }
            if (docUpdates[k] === undefined || isEqual) {
                delete docUpdates[k];
            }
        });

        if ((docUpdates.startTime ?? event.startTime) > (docUpdates.endTime ?? event.endTime)) {
            throw new CustomValidationError(400, "startTime must be before endTime");
        }

        const issues: string[] = [];

        // Nothing to change.
        if (Object.keys(docUpdates).length == 0) {
            return { status: "Success", message: "No data changed.", issues: issues };
        }

        const friendlyNames = {
            "eventName": "Name",
            "eventDescription": "Description",
            "startTime": "Start Time",
            "endTime": "End Time",
            "location": "Location"
        };

        // Calculate diff
        const diff = Object.keys(docUpdates).map((key) => {
            const k = key as keyof typeof docUpdates;
            if (k.includes("Time")) {
                return {
                    name: friendlyNames[k],
                    oldData: event[k].toLocaleString("en-US", { timeZone: "America/New_York" }),
                    newData: docUpdates[k]!.toLocaleString("en-US", { timeZone: "America/New_York" })
                }
            }
            return {
                name: friendlyNames[k],
                oldData: event[k],
                newData: docUpdates[k]
            };
        });

        const oldName = event.eventName;

        try {
            event.set(docUpdates);
            await event.save();
        } catch (error) {
            throw new ResourceAccessError(500, "Failed to update event.")
        }

        if (docUpdates.startTime !== undefined) {
            // Re-schedule 2hr notification job.
            try {
                await agendaClient.cancelJob("sendEventReminders", { eventId: eventId });
                await agendaClient.scheduleJobOnce({
                    jobName: "sendEventReminders",
                    runAt: new Date(docUpdates.startTime.getTime() - 1000 * 60 * 60 * 2),
                    jobPayload: { eventId: event._id.toString() },
                    options: { timezone: "America/New_York" }
                });
            } catch (error) {
                issues.push("Failed to replace notification job.");
                console.error("Failed to re-schedule notification:", error);
            }
        }

        if (!body.notify) {
            return {
                status: "Success",
                message: "Successfully updated event.",
                issues: issues
            };
        }

        const gCalendarLink = EventController.generateCalendarLink(event);
        const inviteLink = EventController.generateEventInviteLink(event);

        if (event.marketingChannels.includes("slack")) {
            const message = `*Important Update*\n` + 
                            `Changes have been made to ${event.eventName}.\n` + 
                            `Please review the new information here: ${inviteLink}`;
    
            const success = await this.sendSlackMessage(message);
            if (!success) {
                issues.push("Failed to send Slack announcement.");
            }
        }

        if (event.marketingChannels.includes("discord")) {
            const message = `## Update - ${event.eventName}\n` + 
                            `Changes have been made to ${event.eventName}.\n` + 
                            `Please review the new information here: ${inviteLink}`;
            
            const success = await this.sendDiscordMessage(message);
            if (!success) {
                issues.push("Failed to send Discord announcement.");
            }
        }

        if (!event.marketingChannels.includes("email")) {
            return {
                status: "Success",
                message: "Successfully updated event",
                issues: issues,
            };
        }

        const order = ["Name", "Description", "Start Time", "End Time", "Location"];

        // Sort for cleaner diff (prevents stuff like End Time showing before Start Time)
        diff.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));

        try {
            const users = await this.resolveUserInfoFromScope(event.scope);
            if (users === undefined) {
                throw new Error("Failed to get recipients.");
            }

            const emails = users.map(user => user.email);
            

            await this.emailClient.send({
                to: process.env.PEOPLEPORTAL_SMTP_USER!,
                bcc: emails,
                subject: `Update for ${oldName}`,
                templateName: "EventUpdate",
                templateVars: {
                    eventName: oldName,
                    diff: diff,
                    googleCalendarLink: gCalendarLink,
                    inviteLink: inviteLink
                }
            });
        } catch (error) {
            console.error("Failed to send email:", error);
            issues.push("Failed to send emails.");
        }

        return {
            status: "Success",
            message: "Successfully updated event",
            issues: issues,
        };
    }


    /**
     * Returns rsvp data for a specific event.
     * @param eventId 
     * @returns { status: string, data: HydratedDocument<IRsvp>[] }
     */
    @Get("{eventId}/rsvps")
    @SuccessResponse(200)
    @Security("events")
    @Tags("Event RSVPs")
    async getRsvps(
        @Path() eventId: string,
        @Queries() queries: GetRsvpsRequest
    ): Promise<GetRsvpResponse> {

        if (queries.page < 1) {
            throw new CustomValidationError(400, "page must be positive.");
        }
        if (queries.pageSize !== undefined && queries.pageSize < 1) {
            throw new CustomValidationError(400, "pageSize must be positive.");
        }

        const pageSize = queries.pageSize ?? 25;
        const skip = (queries.page - 1) * pageSize;

        try {
            const query = EventRsvp.find({ eventId: eventId })
                .sort({ updatedAt: -1 })
                .skip(skip)
                .limit(pageSize)
                .lean();

            const [results, totalDocs] = await Promise.all([
                query.exec(),
                EventRsvp.countDocuments({ eventId: eventId }).lean()
            ]);
            return {
                status: "success",
                data: results,
                pagination: {
                    totalPages: Math.ceil(totalDocs / pageSize)
                }
            };
        } catch (error) {
            console.error(`Failed to get RSVPs for event ${eventId}:`, error);
            throw new ResourceAccessError(500, "Failed to fetch RSVPs");
        }
    }
    
    /**
     * 
     * Endpoint to RSVP user to an event given its id.
     * Will get user email through either the session,
     * or if the user is not yet an App Dev member, gets
     * email through a tempsession.
     * 
     * @param req Will be used to get session or tempsession
     * @param eventId object id of the event to rsvp to (string)
     * @param body Rsvp Request
     */
    @Post("{eventId}/rsvp")
    @SuccessResponse(201, "Rsvp Created")
    @Security("ats_otp")
    @Security("oidc")
    @Tags("Event RSVPs")
    async rsvpToEvent(
        @Request() req: express.Request,
        @Path() eventId: string,
        @Body() body: RsvpRequest,
    ): Promise<BasicEventResponse> {
        // Check if event exists
        const event = await Event.findOne({ _id: eventId });
        if (!event) {
            throw new CustomValidationError(404, `No event with id ${eventId}`);
        }

        // Ensure email is available through session or tempsession
        const email = req.session.authorizedUser?.email ?? req.session.tempsession?.user?.email;
        if (email === undefined) {
            throw new CustomValidationError(401, "User session not found.");
        }

        // Check if user is allowed to join event.
        if (event.scope !== "public") {
            // Check if user has an account.
            const userPk = req.session.authorizedUser?.pk;
            if (userPk === undefined) {
                throw new CustomValidationError(401, "User session not found.");
            }

            let authorized = false;

            // Check if user is in invited users
            if (event.scope === "internal") {
                authorized = true;
            }
            else if (event.scope === "exec") {
                if (req.session.authorizedUser?.is_superuser) {
                    authorized = true;
                } else {
                    try {
                        const userTeams = await this.authentikClient.getRootTeamsForUsername(req.session.authorizedUser!.username);
                        authorized = hasAdminAuthority(userTeams.teams, req.session.authorizedUser!.groups ?? []);
                    } catch (error) {
                        throw new ResourceAccessError(500, "Failed to get team membership."); 
                    }
                }
            }
            

            if (!authorized) {
                throw new CustomValidationError(403, "Unauthorized to RSVP to event.");
            }
        }

        // Check if RSVP already exists.
        let rsvp: HydratedDocument<IRsvp> | null;
        rsvp = await EventRsvp.findOne({
            eventId: eventId,
            email: email,
        });

        let status = body.accept ? RsvpStatus.ACCEPT : RsvpStatus.DECLINE;
        if (rsvp && rsvp.status == RsvpStatus.ACCEPT && !body.accept) {
            status = RsvpStatus.CANCEL;
        }

        // Update existing rsvp or create new one.
        if (rsvp) {
            rsvp.status = status;
            await rsvp.save();
        } else {
            await EventRsvp.create({
                eventId: eventId,
                status: status,
                email: email,
            });
        }

        const issues: string[] = [];
        // Get Google Calendar Link
        const gCalendarLink = EventController.generateCalendarLink(event);

        try {
            // Send confirmation email
            await this.emailClient.send({
                to: email!,
                subject: "App Dev Event RSVP Confirmation",
                templateName: "RsvpConfirmation",
                templateVars: {
                    action: status,
                    eventName: event.eventName,
                    eventDescription: event.eventDescription,
                    startTime: event.startTime.toLocaleString("en-US", { timeZone: "America/New_York" }),
                    endTime: event.endTime.toLocaleString("en-US", { timeZone: "America/New_York" }),
                    eventLocation: event.location,
                    googleCalendarLink: gCalendarLink,
                }
            });
        } catch (error) {
            console.error("Failed to send confirmation email for RSVP.");
            issues.push("Failed to send confirmation email.");
        }
        

        return { 
            status: "Success",
            message: "Successfully RSVP'd to event.",
            issues: issues
        };

    }


    /**
     * Checks if current user has RSVP'd to the given event.
     * Returns rsvp data if user has RSVP'd, and null otherwise.
     * 
     * @param eventId id of the event.
     * @param req express Request object
     * @returns { status: string, rsvpData: DocumentJSON<IRsvp> | null }
     */
    @Get("{eventId}/rsvp")
    @Security("oidc")
    @Security("ats_otp")
    @SuccessResponse(200)
    @Tags("Event RSVPs")
    async getRsvpForEvent(
        @Path() eventId: string,
        @Request() req: express.Request,
    ): Promise<GetEventRsvpResponse> {
        // Get event
        const event = await Event.findOne({ _id: eventId }).lean().exec();
        if (!event) {
            throw new CustomValidationError(404, `No event with id ${eventId}`);
        }
    
        // Ensure email is available through session or tempsession
        const email = req.session.authorizedUser?.email ?? req.session.tempsession?.user?.email;
        if (email === undefined) {
            throw new CustomValidationError(401, "User session not found.");
        }

        const rsvp = await EventRsvp.findOne({ eventId: eventId, email: email }).lean().exec();
        if (!rsvp) {
            return {
                status: "Success",
                rsvp: null,
            };
        }
        
        return {
            status: "Success",
            rsvp: rsvp,
        };
    }

    private async sendSlackMessage(message: string) : Promise<boolean> {
        const slackChannel = await this.slackClient.getChannelFromName(EventController.SLACK_EVENT_ANNOUNCEMENT_CHANNEL);
        if (slackChannel?.id !== undefined) {
            const success = await this.slackClient.sendMessageInChannel(slackChannel.id!, message);
            if (!success) {
                console.error("Failed to send slack message.");
                return false;
            }
            return success;
        } else {
            console.error("Slack announcements channel not found.");
            return false;
        }
    }

    private async sendDiscordMessage(message: string) : Promise<boolean> {
        try {
            const discordChannel = await this.discordClient.getChannelFromName(EventController.DISCORD_EVENT_ANNOUNCEMENT_CHANNEL);
            if (discordChannel !== undefined) {
                await this.discordClient.sendMessageInChannel(discordChannel, message);
            } else {
                throw new Error("Could not find announcements channel.")
            }
            return true;
        } catch (error) {
            console.error("Failed to send discord announcement:", error);
            return false;
        }
    }

    /**
     * Generates a link accessible on the frontend allowing users
     * to RSVP to events.
     * 
     * @param event Mongoose Event Document
     * @returns Generated link : string
     */
    public static generateEventInviteLink(event: HydratedDocument<IEvent> | DocumentJSON<IEvent>) {
        return `${process.env.PEOPLEPORTAL_BASE_URL}/community/events/${event._id}/attendance`;
    }


    /**
     * Private helper method to get deduplicated list of user info from
     * event scope.
     * 
     * @param scope scope of event.
     * @returns Deduplicated array of user info for all invitees.
     */
    private async resolveUserInfoFromScope(scope: string) {
        if (scope === "public" || scope === "internal") {
            // Return all internal members
            const allUsers = await this.authentikClient.getFullUserList();
            return allUsers.users;
        } 
        else if (scope === "exec") {
            /* ExecutiveBoardMembers only: an exec event is exec board
               business. Mirrors the hasAdminAuthority gate on visibility. */
            const execGroupId = await this.authentikClient.getGroupPkFromName("ExecutiveBoardMembers");
            const groupInfo = await this.authentikClient.getGroupInfo(execGroupId);
            
            return groupInfo.users;
        }
    }    
    

    static generateCalendarLink(event: HydratedDocument<IEvent> | DocumentJSON<IEvent>): string {
        // Helper to format dates to Google/ICS standard: YYYYMMDDTHHMMSSZ
        const formatToUniversalTime = (date: Date) => {
            return date.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
        };

        const timeChunk = `${formatToUniversalTime(event.startTime)}/${formatToUniversalTime(event.endTime)}`;

        // Link for google calendar.
        const googleLink = new URL("https://calendar.google.com/calendar/render");
        googleLink.searchParams.append("action", "TEMPLATE");
        googleLink.searchParams.append("text", event.eventName);
        googleLink.searchParams.append("dates", timeChunk);
        googleLink.searchParams.append("details", event.eventDescription);
        googleLink.searchParams.append("location", event.location);
        googleLink.searchParams.append("ctz", "America/New_York"); // Time zone

        return googleLink.toString();
    }
}