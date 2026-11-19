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

import { randomUUID } from "crypto";
import * as express from "express";
import {
    Body,
    Controller,
    Delete,
    Get,
    Patch,
    Path,
    Post,
    Query,
    Request,
    Route,
    Security,
    SuccessResponse,
    Tags,
} from "tsoa";
import { TeamMeeting } from "../models/TeamMeeting";
import { MeetingAttendance, AttendanceRole } from "../models/MeetingAttendance";
import { MeetingSubteamAttendance } from "../models/MeetingSubteamAttendance";
import { AuthentikClient } from "../clients/AuthentikClient";
import { BindleController } from "./BindleController";
import { executiveAuthVerify } from "../auth";
import { CustomValidationError, ResourceAccessError } from "../utils/errors";

/** Which occurrences of a recurring series a mutation applies to */
type MeetingScope = "this" | "following" | "all";

interface APITeamMeetingCreateRequest {
    name: string;
    description?: string;
    start: Date;
    end: Date;
    /** When true, the meeting repeats weekly through the team's end date */
    recurring?: boolean;
    /** Authentik user PKs expected to attend */
    requiredAttendees?: number[];
    /** Authentik user PKs invited but not required */
    optionalAttendees?: number[];
    /** Authentik group PKs of subteams expected to attend (stored by reference) */
    requiredSubteams?: string[];
    /** Authentik group PKs of subteams invited but not required */
    optionalSubteams?: string[];
    /** When true the meeting is visible to everyone, invited or not */
    visibleToAll?: boolean;
}

/** A selectable team member for the attendee picker */
export interface APIMeetingRosterMember {
    pk: number;
    name: string;
    username: string;
    email: string;
}

export interface APIMeetingAttendee {
    userPk: number;
    name: string;
    role: AttendanceRole;
    present: boolean;
    markedBy: number | null;
    markedAt: Date | null;
    /**
     * True when the person has their own MeetingAttendance row (individually
     * added or already checked in). False for people included only because
     * their subteam is invited — those rows are materialized on first mark.
     */
    explicit: boolean;
    /** Display name of the invited subteam this person attends through, if any */
    viaSubteam: string | null;
}

/** A subteam invited to a meeting, by reference */
export interface APIMeetingSubteamRef {
    subteamPk: string;
    name: string;
    role: AttendanceRole;
}

export interface APIMeetingAttendanceResponse {
    /** Authentik user PK of the requester (so the UI can find "me") */
    viewerPk: number;
    /** True when the requester may mark anyone present */
    canManage: boolean;
    attendees: APIMeetingAttendee[];
    /** Subteams invited by reference; their members appear in `attendees` */
    subteams: APIMeetingSubteamRef[];
}

/** A meeting the requester is an attendee of, plus their own attendance. */
export interface APIMyAttendanceItem extends APITeamMeetingResponse {
    role: AttendanceRole;
    present: boolean;
}

interface APIMarkAttendanceRequest {
    present: boolean;
}

interface APIAddAttendeeRequest {
    userPk: number;
    role?: AttendanceRole;
}

interface APIAddSubteamRequest {
    /** Authentik group PK of the subteam to invite */
    subteamPk: string;
    role?: AttendanceRole;
}

interface APITeamMeetingUpdateRequest {
    name?: string;
    description?: string;
    start?: Date;
    end?: Date;
    /** When provided, toggles whether uninvited members can see the meeting */
    visibleToAll?: boolean;
    /** Defaults to "this" when omitted */
    scope?: MeetingScope;
}

export interface APITeamMeetingResponse {
    _id: string;
    teamPk: string;
    seriesId: string;
    recurring: boolean;
    name: string;
    description: string;
    start: Date;
    end: Date;
    createdBy: number;
    /** Whether uninvited team members can see this meeting on the calendar */
    visibleToAll: boolean;
    createdAt: Date;
    updatedAt: Date;
}

/** Generates weekly occurrence start/end pairs from `start`/`end` through `until` (inclusive). */
function generateWeeklyOccurrences(start: Date, end: Date, until: Date): Array<{ start: Date; end: Date }> {
    const occurrences: Array<{ start: Date; end: Date }> = [];
    const cursorStart = new Date(start);
    const cursorEnd = new Date(end);

    /* Compare on date only so an occurrence on the `until` day is included */
    const untilEnd = new Date(until);
    untilEnd.setHours(23, 59, 59, 999);

    while (cursorStart.getTime() <= untilEnd.getTime()) {
        occurrences.push({ start: new Date(cursorStart), end: new Date(cursorEnd) });
        /* setDate preserves wall-clock time across DST boundaries */
        cursorStart.setDate(cursorStart.getDate() + 7);
        cursorEnd.setDate(cursorEnd.getDate() + 7);
    }

    return occurrences;
}


@Route("/api/org/teams")
export class MeetingsController extends Controller {
    private readonly authentikClient = new AuthentikClient();

    /**
     * Per-request memo of Authentik group lookups (tsoa constructs a fresh
     * controller per request). Roster, subteam directory, and the manager check
     * all need the same group tree; without this each would re-fan-out 1+N
     * sequential Authentik calls.
     */
    private readonly groupInfoCache = new Map<string, ReturnType<AuthentikClient["getGroupInfo"]>>();

    private getGroupInfoCached(groupPk: string) {
        let pending = this.groupInfoCache.get(groupPk);
        if (!pending) {
            pending = this.authentikClient.getGroupInfo(groupPk);
            this.groupInfoCache.set(groupPk, pending);
        }
        return pending;
    }

    /**
     * Flattens a team into its full member roster: the team's own users (owners)
     * plus everyone in its subteams, de-duplicated by Authentik user PK.
     */
    private async getTeamRoster(teamId: string): Promise<Map<number, APIMeetingRosterMember>> {
        const teamInfo = await this.getGroupInfoCached(teamId);
        const members = new Map<number, APIMeetingRosterMember>();
        /* Authentik user PKs arrive as strings here but are numeric everywhere
           attendance is stored (matching authorizedUser.pk); normalize to number. */
        const add = (u: { pk: string | number; name: string; username: string; email: string } | undefined) => {
            if (!u) return;
            const pk = Number(u.pk);
            if (!members.has(pk)) {
                members.set(pk, { pk, name: u.name, username: u.username, email: u.email });
            }
        };
        teamInfo.users.forEach(add);
        teamInfo.subteams?.forEach((subteam: any) => (subteam.users ?? []).forEach(add));
        return members;
    }

    /**
     * The team's subteams keyed by group PK, each with its current member PKs.
     * Subteam invites store only this PK, so membership resolved here always
     * reflects the subteam's present composition.
     */
    private async getSubteamDirectory(teamId: string): Promise<Map<string, { pk: string; name: string; memberPks: Set<number> }>> {
        const teamInfo = await this.getGroupInfoCached(teamId);
        const directory = new Map<string, { pk: string; name: string; memberPks: Set<number> }>();
        for (const subteam of (teamInfo.subteams ?? []) as any[]) {
            if (subteam.attributes?.flaggedForDeletion) continue;
            directory.set(String(subteam.pk), {
                pk:        String(subteam.pk),
                name:      subteam.attributes?.friendlyName ?? subteam.name,
                memberPks: new Set((subteam.users ?? []).map((u: any) => Number(u.pk))),
            });
        }
        return directory;
    }

    /**
     * The visibility predicate for a single meeting, mirroring the list filter:
     * visible-to-all, uninvited (general audience), directly invited, member of
     * an invited subteam, or a meeting manager. Ordered cheapest-first.
     */
    private async canViewMeeting(
        req: express.Request,
        teamId: string,
        meeting: { _id: unknown; visibleToAll?: boolean },
    ): Promise<boolean> {
        if (meeting.visibleToAll) return true;

        const meetingId = String(meeting._id);
        const viewerPk = req.session.authorizedUser!.pk;
        const [inviteCount, ownRow, subteamInvites] = await Promise.all([
            MeetingAttendance.countDocuments({ meetingId }),
            MeetingAttendance.findOne({ meetingId, userPk: viewerPk }).select("_id").lean(),
            MeetingSubteamAttendance.find({ meetingId }).select("subteamPk").lean(),
        ]);
        if (ownRow) return true;
        if (inviteCount === 0 && subteamInvites.length === 0) return true;
        if (subteamInvites.length > 0) {
            const directory = await this.getSubteamDirectory(teamId);
            if (subteamInvites.some((invite) => directory.get(invite.subteamPk)?.memberPks.has(viewerPk))) {
                return true;
            }
        }
        return this.canManageMeetings(req, teamId);
    }

    /**
     * Resolves the role a person holds on a meeting through subteam invites:
     * "required" if any invited subteam they belong to is required, "optional"
     * if only optional ones cover them, null when no invite covers them.
     */
    private resolveSubteamRole(
        invites: Array<{ subteamPk: string; role: AttendanceRole }>,
        directory: Map<string, { memberPks: Set<number> }>,
        userPk: number,
    ): AttendanceRole | null {
        const covering = invites.filter((invite) => directory.get(invite.subteamPk)?.memberPks.has(userPk));
        if (covering.length === 0) return null;
        return covering.some((invite) => invite.role === "required") ? "required" : "optional";
    }

    /**
     * Whether the requesting user may manage attendance for everyone on the team
     * (Team Owner, holder of the `corp:meetingsmgmt` bindle, or a superuser).
     * Used by endpoints that allow either a manager or the attendee themselves.
     */
    private async canManageMeetings(req: express.Request, teamId: string): Promise<boolean> {
        const user = req.session.authorizedUser!;
        if (user.is_superuser) return true;

        /* Executive Board members manage every team, mirroring the override the
           bindle auth layer applies to create/edit/delete. OIDC is already
           verified by @Security("oidc"), so skip the redundant check. */
        try {
            if (await executiveAuthVerify(req, [], true)) return true;
        } catch { /* not an executive — fall through to owner/bindle checks */ }

        const teamInfo = await this.getGroupInfoCached(teamId);

        /* Owner check mirrors the bindle auth layer: ownership lives on the root team. */
        let authoritativeTeam = teamInfo;
        if (teamInfo.parentPk) {
            authoritativeTeam = await this.getGroupInfoCached(teamInfo.parentPk);
        }
        if (authoritativeTeam.attributes.peoplePortalCreation && new Set(user.groups).has(authoritativeTeam.name)) {
            return true;
        }

        const effective = BindleController.getEffectivePermissionSet(teamInfo, user.groups);
        return effective.has("corp:meetingsmgmt");
    }

    /**
     * Returns meetings scheduled for a team, ordered by start time. When `from`
     * and/or `to` are supplied, only occurrences starting within that range are
     * returned (used to load a single visible week).
     *
     * Meeting managers see everything. Everyone else sees a meeting only when
     * it is marked visible to all, has no invite list at all (assumed general
     * audience), or they are invited — directly or through one of their subteams.
     *
     * @param teamId Authentik group PK of the team
     * @param from   ISO datetime; include occurrences starting at or after this
     * @param to     ISO datetime; include occurrences starting before this
     */
    @Get("{teamId}/meetings")
    @Tags("Team Meetings")
    @SuccessResponse(200)
    @Security("oidc")
    async getTeamMeetings(
        @Request() req: express.Request,
        @Path() teamId: string,
        @Query() from?: Date,
        @Query() to?: Date,
    ): Promise<APITeamMeetingResponse[]> {
        const filter: Record<string, unknown> = { teamPk: teamId };
        if (from || to) {
            const range: Record<string, Date> = {};
            if (from) range.$gte = from;
            if (to) range.$lt = to;
            filter.start = range;
        }

        let meetings = await TeamMeeting
            .find(filter)
            .sort({ start: 1 })
            .lean()
            .exec();

        if (meetings.length > 0 && !(await this.canManageMeetings(req, teamId))) {
            const viewerPk = req.session.authorizedUser!.pk;
            const ids = meetings.map((m) => String(m._id));
            const [invitedIds, viewerRows, subteamInvites] = await Promise.all([
                MeetingAttendance.distinct("meetingId", { meetingId: { $in: ids } }),
                MeetingAttendance.find({ meetingId: { $in: ids }, userPk: viewerPk }).select("meetingId").lean(),
                MeetingSubteamAttendance.find({ meetingId: { $in: ids } }).select("meetingId subteamPk").lean(),
            ]);

            /* A meeting with any invite (person or subteam) is targeted, not general. */
            const hasInvites = new Set<string>(invitedIds as string[]);
            subteamInvites.forEach((invite) => hasInvites.add(invite.meetingId));

            const invitedDirectly = new Set(viewerRows.map((row) => row.meetingId));
            const directory = await this.getSubteamDirectory(teamId);
            const mySubteams = new Set(
                [...directory.values()].filter((s) => s.memberPks.has(viewerPk)).map((s) => s.pk),
            );
            const invitedViaSubteam = new Set(
                subteamInvites.filter((invite) => mySubteams.has(invite.subteamPk)).map((invite) => invite.meetingId),
            );

            meetings = meetings.filter((m) => {
                const id = String(m._id);
                return m.visibleToAll
                    || !hasInvites.has(id)
                    || invitedDirectly.has(id)
                    || invitedViaSubteam.has(id);
            });
        }

        /* `recurring` is derived, never stored: a series is recurring when more
           than one occurrence shares its seriesId. The visible week may hold only
           one occurrence of a series, so the count is resolved across all of them. */
        const seriesIds = [...new Set(meetings.map((m) => m.seriesId))];
        const counts = await TeamMeeting.aggregate<{ _id: string; count: number }>([
            { $match: { seriesId: { $in: seriesIds } } },
            { $group: { _id: "$seriesId", count: { $sum: 1 } } },
        ]);
        const seriesSize = new Map(counts.map((c) => [c._id, c.count]));

        return meetings.map((m) => ({
            ...m,
            recurring: (seriesSize.get(m.seriesId) ?? 1) > 1,
        })) as any as APITeamMeetingResponse[];
    }

    /**
     * Creates a new meeting for the given team.
     * Requires the requesting user to be a Team Owner or hold the
     * `corp:meetingsmgmt` bindle for the team.
     *
     * @param teamId Authentik group PK of the team
     * @param body   Meeting details
     */
    @Post("{teamId}/meetings")
    @Tags("Team Meetings")
    @SuccessResponse(201)
    @Security("bindles", ["corp:meetingsmgmt"])
    async createTeamMeeting(
        @Request() req: express.Request,
        @Path() teamId: string,
        @Body() body: APITeamMeetingCreateRequest,
    ): Promise<APITeamMeetingResponse[]> {
        const start = new Date(body.start);
        const end = new Date(body.end);
        if (start.getTime() >= end.getTime()) {
            throw new CustomValidationError(400, "Meeting start time must be before end time");
        }

        let occurrences: Array<{ start: Date; end: Date }>;
        if (body.recurring) {
            /* Recurring meetings repeat weekly through the team's end date */
            const teamInfo = await this.getGroupInfoCached(teamId);
            const teamEndDate = teamInfo.attributes.teamEndDate;
            if (!teamEndDate) {
                throw new CustomValidationError(400, "Team has no end date set; cannot create a recurring meeting");
            }
            const until = new Date(`${teamEndDate}T23:59:59`);
            if (until.getTime() < start.getTime()) {
                throw new CustomValidationError(400, "Team end date is before the meeting start");
            }
            occurrences = generateWeeklyOccurrences(start, end, until);
        } else {
            occurrences = [{ start, end }];
        }

        const seriesId = randomUUID();
        const docs = occurrences.map((occurrence) => ({
            teamPk:       teamId,
            seriesId,
            name:         body.name,
            description:  body.description ?? "",
            start:        occurrence.start,
            end:          occurrence.end,
            createdBy:    req.session.authorizedUser!.pk,
            visibleToAll: body.visibleToAll ?? false,
        }));

        const created = await TeamMeeting.insertMany(docs);

        /* Attendees are stored per occurrence: each created meeting gets its own
           copy of the required/optional roster. A person listed as both required
           and optional is kept as required. */
        const required = new Set(body.requiredAttendees ?? []);
        const optional = new Set((body.optionalAttendees ?? []).filter((pk) => !required.has(pk)));
        const roster: Array<{ userPk: number; role: AttendanceRole }> = [
            ...[...required].map((userPk) => ({ userPk, role: "required" as const })),
            ...[...optional].map((userPk) => ({ userPk, role: "optional" as const })),
        ];

        if (roster.length > 0) {
            const attendanceDocs = created.flatMap((meeting) =>
                roster.map((entry) => ({
                    meetingId: String(meeting._id),
                    teamPk:    teamId,
                    seriesId,
                    userPk:    entry.userPk,
                    role:      entry.role,
                    present:   false,
                })),
            );
            await MeetingAttendance.insertMany(attendanceDocs);
        }

        /* Subteam invites are stored by group PK only — membership is resolved
           at read time so the invite follows the subteam as it grows/shrinks.
           Unknown PKs are dropped; a subteam listed as both is kept required. */
        if ((body.requiredSubteams?.length ?? 0) > 0 || (body.optionalSubteams?.length ?? 0) > 0) {
            const directory = await this.getSubteamDirectory(teamId);
            const requiredSubs = new Set((body.requiredSubteams ?? []).filter((pk) => directory.has(pk)));
            const optionalSubs = new Set((body.optionalSubteams ?? []).filter((pk) => directory.has(pk) && !requiredSubs.has(pk)));
            const subteamRoster: Array<{ subteamPk: string; role: AttendanceRole }> = [
                ...[...requiredSubs].map((subteamPk) => ({ subteamPk, role: "required" as const })),
                ...[...optionalSubs].map((subteamPk) => ({ subteamPk, role: "optional" as const })),
            ];
            if (subteamRoster.length > 0) {
                const subteamDocs = created.flatMap((meeting) =>
                    subteamRoster.map((entry) => ({
                        meetingId: String(meeting._id),
                        teamPk:    teamId,
                        seriesId,
                        subteamPk: entry.subteamPk,
                        role:      entry.role,
                    })),
                );
                await MeetingSubteamAttendance.insertMany(subteamDocs);
            }
        }

        /* Derived for the response only — every doc just created shares one series. */
        const recurring = created.length > 1;

        this.setStatus(201);
        return created.map((doc) => ({ ...doc.toObject(), _id: doc._id.toString(), recurring }) as APITeamMeetingResponse);
    }

    /**
     * Updates an existing team meeting. Only the fields provided in the
     * request body are changed.
     * Requires the requesting user to be a Team Owner or hold the
     * `corp:meetingsmgmt` bindle for the team.
     *
     * @param teamId    Authentik group PK of the team
     * @param meetingId MongoDB ObjectId of the meeting
     * @param body      Fields to update
     */
    @Patch("{teamId}/meetings/{meetingId}")
    @Tags("Team Meetings")
    @SuccessResponse(200)
    @Security("bindles", ["corp:meetingsmgmt"])
    async updateTeamMeeting(
        @Path() teamId: string,
        @Path() meetingId: string,
        @Body() body: APITeamMeetingUpdateRequest,
    ): Promise<APITeamMeetingResponse[]> {
        const target = await TeamMeeting.findOne({ _id: meetingId, teamPk: teamId });
        if (!target) throw new CustomValidationError(404, "Meeting not found");

        const newStart = body.start !== undefined ? new Date(body.start) : undefined;
        const newEnd   = body.end   !== undefined ? new Date(body.end)   : undefined;

        const effectiveStart = newStart ?? target.start;
        const effectiveEnd   = newEnd   ?? target.end;
        if (effectiveStart.getTime() >= effectiveEnd.getTime()) {
            throw new CustomValidationError(400, "Meeting start time must be before end time");
        }

        /* A time edit moves/resizes the clicked occurrence; for "following"/"all"
           the same start-of-day shift and duration are applied to each sibling so
           they keep their own dates. Omitted fields fall back to the target's
           current values, so a start-only or end-only edit still resizes correctly. */
        const targetNewStart = newStart ?? target.start;
        const targetNewEnd   = newEnd   ?? target.end;
        const startDelta = targetNewStart.getTime() - target.start.getTime();
        const duration   = targetNewEnd.getTime() - targetNewStart.getTime();
        const timeChanged = newStart !== undefined || newEnd !== undefined;

        /* Editing never reassigns seriesId. A "this"-scope edit therefore keeps the
           occurrence linked to its series (standard calendar behavior: it can still
           be swept by a later "following"/"all" edit) rather than detaching it. */
        const scope: MeetingScope = body.scope ?? "this";
        const filter: Record<string, unknown> = { seriesId: target.seriesId, teamPk: teamId };
        if (scope === "this") {
            filter._id = target._id;
        } else if (scope === "following") {
            filter.start = { $gte: target.start };
        }

        const occurrences = await TeamMeeting.find(filter);
        for (const occurrence of occurrences) {
            if (body.name         !== undefined) occurrence.name         = body.name;
            if (body.description  !== undefined) occurrence.description  = body.description;
            if (body.visibleToAll !== undefined) occurrence.visibleToAll = body.visibleToAll;
            if (timeChanged) {
                occurrence.start = new Date(occurrence.start.getTime() + startDelta);
                occurrence.end   = new Date(occurrence.start.getTime() + duration);
            }
            await occurrence.save();
        }

        /* Series membership is unchanged by an edit, so a single count suffices. */
        const recurring = await TeamMeeting.countDocuments({ seriesId: target.seriesId }) > 1;
        return occurrences.map((occurrence) => ({ ...occurrence.toObject(), _id: occurrence._id.toString(), recurring }) as APITeamMeetingResponse);
    }

    /**
     * Permanently deletes a team meeting.
     * Requires the requesting user to be a Team Owner or hold the
     * `corp:meetingsmgmt` bindle for the team.
     *
     * @param teamId    Authentik group PK of the team
     * @param meetingId MongoDB ObjectId of the meeting
     * @param scope     Which occurrences to remove (defaults to "this")
     */
    @Delete("{teamId}/meetings/{meetingId}")
    @Tags("Team Meetings")
    @SuccessResponse(204)
    @Security("bindles", ["corp:meetingsmgmt"])
    async deleteTeamMeeting(
        @Path() teamId: string,
        @Path() meetingId: string,
        @Query() scope?: MeetingScope,
    ): Promise<void> {
        const target = await TeamMeeting.findOne({ _id: meetingId, teamPk: teamId });
        if (!target) throw new CustomValidationError(404, "Meeting not found");

        const effectiveScope: MeetingScope = scope ?? "this";
        const filter: Record<string, unknown> = { seriesId: target.seriesId, teamPk: teamId };
        if (effectiveScope === "this") {
            filter._id = target._id;
        } else if (effectiveScope === "following") {
            filter.start = { $gte: target.start };
        }

        /* Drop attendance for exactly the occurrences being removed. */
        const doomed = await TeamMeeting.find(filter).select("_id").lean();
        const doomedIds = doomed.map((m) => m._id.toString());
        await TeamMeeting.deleteMany(filter);
        if (doomedIds.length > 0) {
            await MeetingAttendance.deleteMany({ meetingId: { $in: doomedIds } });
            await MeetingSubteamAttendance.deleteMany({ meetingId: { $in: doomedIds } });
        }
    }

    /**
     * Returns the team's full member roster for the attendee picker.
     *
     * @param teamId Authentik group PK of the team
     */
    @Get("{teamId}/meetings/roster")
    @Tags("Team Meetings")
    @SuccessResponse(200)
    @Security("oidc")
    async getMeetingRoster(
        @Request() req: express.Request,
        @Path() teamId: string,
    ): Promise<APIMeetingRosterMember[]> {
        const roster = await this.getTeamRoster(teamId);

        /* @Security("oidc") only proves the caller is signed in. Without this
           check any authenticated user could read name/username/email for every
           member of any team by walking teamId, so the roster is restricted to
           the team's own members and to meeting managers. */
        const viewerPk = req.session.authorizedUser!.pk;
        if (!roster.has(viewerPk) && !(await this.canManageMeetings(req, teamId))) {
            throw new ResourceAccessError(403, "You must be a member of this team to view its roster.");
        }

        return [...roster.values()].sort((a, b) => a.name.localeCompare(b.name));
    }

    /**
     * Reports whether the requesting user may manage this team's meetings
     * (create/edit/delete meetings and manage anyone's attendance). Lets the UI
     * hide management controls for users who lack the `corp:meetingsmgmt` bindle.
     *
     * @param teamId Authentik group PK of the team
     */
    @Get("{teamId}/meetings/capabilities")
    @Tags("Team Meetings")
    @SuccessResponse(200)
    @Security("oidc")
    async getMeetingCapabilities(
        @Request() req: express.Request,
        @Path() teamId: string,
    ): Promise<{ canManageMeetings: boolean }> {
        return { canManageMeetings: await this.canManageMeetings(req, teamId) };
    }

    /**
     * Returns the meetings the requesting user is an attendee of, with their own
     * attendance status — their personal list of attendances. Optionally bounded
     * to a date range by occurrence start time.
     *
     * @param teamId Authentik group PK of the team
     * @param from   ISO datetime; include occurrences starting at or after this
     * @param to     ISO datetime; include occurrences starting before this
     */
    @Get("{teamId}/meetings/mine")
    @Tags("Team Meetings")
    @SuccessResponse(200)
    @Security("oidc")
    async getMyAttendance(
        @Request() req: express.Request,
        @Path() teamId: string,
        @Query() from?: Date,
        @Query() to?: Date,
    ): Promise<APIMyAttendanceItem[]> {
        const viewerPk = req.session.authorizedUser!.pk;
        const records = await MeetingAttendance.find({ teamPk: teamId, userPk: viewerPk }).lean();
        const byMeeting = new Map(records.map((r) => [r.meetingId, r] as const));

        /* Meetings the viewer attends through a subteam invite, without an own
           row yet: resolved live against current subteam membership. */
        const directory = await this.getSubteamDirectory(teamId);
        const mySubteamPks = [...directory.values()].filter((s) => s.memberPks.has(viewerPk)).map((s) => s.pk);
        const subteamRole = new Map<string, AttendanceRole>();
        if (mySubteamPks.length > 0) {
            const invites = await MeetingSubteamAttendance
                .find({ teamPk: teamId, subteamPk: { $in: mySubteamPks } })
                .lean();
            for (const invite of invites) {
                const current = subteamRole.get(invite.meetingId);
                if (current !== "required") subteamRole.set(invite.meetingId, invite.role);
            }
        }

        const meetingIds = [...new Set([...byMeeting.keys(), ...subteamRole.keys()])];
        if (meetingIds.length === 0) return [];

        const filter: Record<string, unknown> = { _id: { $in: meetingIds }, teamPk: teamId };
        if (from || to) {
            const range: Record<string, Date> = {};
            if (from) range.$gte = from;
            if (to) range.$lt = to;
            filter.start = range;
        }

        const meetings = await TeamMeeting.find(filter).sort({ start: 1 }).lean();
        const seriesIds = [...new Set(meetings.map((m) => m.seriesId))];
        const counts = await TeamMeeting.aggregate<{ _id: string; count: number }>([
            { $match: { seriesId: { $in: seriesIds } } },
            { $group: { _id: "$seriesId", count: { $sum: 1 } } },
        ]);
        const seriesSize = new Map(counts.map((c) => [c._id, c.count]));

        return meetings.map((m) => {
            const record = byMeeting.get(String(m._id));
            return {
                ...m,
                recurring: (seriesSize.get(m.seriesId) ?? 1) > 1,
                role: record?.role ?? subteamRole.get(String(m._id)) ?? "optional",
                present: record?.present ?? false,
            };
        }) as any as APIMyAttendanceItem[];
    }

    /**
     * Returns a single meeting occurrence by id. Available to any authenticated
     * user so the check-in and detail pages can show what they are checking in to.
     *
     * @param teamId    Authentik group PK of the team
     * @param meetingId MongoDB ObjectId of the meeting occurrence
     */
    @Get("{teamId}/meetings/{meetingId}")
    @Tags("Team Meetings")
    @SuccessResponse(200)
    @Security("oidc")
    async getTeamMeeting(
        @Request() req: express.Request,
        @Path() teamId: string,
        @Path() meetingId: string,
    ): Promise<APITeamMeetingResponse> {
        const meeting = await TeamMeeting.findOne({ _id: meetingId, teamPk: teamId }).lean();
        if (!meeting) throw new CustomValidationError(404, "Meeting not found");
        /* Same predicate as the calendar list; 404 (not 403) so an uninvited
           member can't even confirm a hidden meeting exists. */
        if (!(await this.canViewMeeting(req, teamId, meeting))) {
            throw new CustomValidationError(404, "Meeting not found");
        }
        const recurring = await TeamMeeting.countDocuments({ seriesId: meeting.seriesId }) > 1;
        return { ...meeting, recurring } as any as APITeamMeetingResponse;
    }

    /**
     * Self check-in for the requesting user, intended for the QR-code flow: the
     * signed-in person who scans the meeting's code marks themselves present.
     * A team member not yet on the sheet is added (as optional) and marked
     * present. Only ever affects the caller's own row, and only within the
     * meeting's check-in window.
     *
     * @param teamId    Authentik group PK of the team
     * @param meetingId MongoDB ObjectId of the meeting occurrence
     */
    @Post("{teamId}/meetings/{meetingId}/checkin")
    @Tags("Team Meetings")
    @SuccessResponse(200)
    @Security("oidc")
    async checkInToMeeting(
        @Request() req: express.Request,
        @Path() teamId: string,
        @Path() meetingId: string,
    ): Promise<APIMeetingAttendee> {
        const meeting = await TeamMeeting.findOne({ _id: meetingId, teamPk: teamId }).lean();
        if (!meeting) throw new CustomValidationError(404, "Meeting not found");

        /* Check-in is open for the whole calendar day of the meeting, so a code
           can't be scanned on a different day but timing within the day is lenient. */
        const now = Date.now();
        const opensAt = new Date(meeting.start); opensAt.setHours(0, 0, 0, 0);
        const closesAt = new Date(meeting.end); closesAt.setHours(23, 59, 59, 999);
        if (now < opensAt.getTime()) throw new CustomValidationError(400, "Check-in for this meeting is not open yet");
        if (now > closesAt.getTime()) throw new CustomValidationError(400, "Check-in for this meeting has closed");

        const viewerPk = req.session.authorizedUser!.pk;
        const roster = await this.getTeamRoster(teamId);

        /* Outsiders may not self-add. Pre-listed attendees are always allowed. */
        const existing = await MeetingAttendance.findOne({ meetingId, teamPk: teamId, userPk: viewerPk });
        if (!existing && !roster.has(viewerPk)) {
            throw new CustomValidationError(403, "You are not a member of this team");
        }

        /* First check-in of a subteam invitee materializes their row with the
           subteam's role; anyone else lands as "optional". */
        let insertRole: AttendanceRole = "optional";
        if (!existing) {
            const invites = await MeetingSubteamAttendance.find({ meetingId, teamPk: teamId }).lean();
            if (invites.length > 0) {
                const directory = await this.getSubteamDirectory(teamId);
                insertRole = this.resolveSubteamRole(invites, directory, viewerPk) ?? "optional";
            }
        }

        /* Atomic upsert so a fast re-scan/refresh can't trip the unique
           (meetingId, userPk) index with a duplicate-key error. `role` is only
           set on insert, preserving a manager-assigned "required" role. */
        const record = await MeetingAttendance.findOneAndUpdate(
            { meetingId, teamPk: teamId, userPk: viewerPk },
            {
                $setOnInsert: { seriesId: meeting.seriesId, role: insertRole },
                $set: { present: true, markedBy: viewerPk, markedAt: new Date() },
            },
            { new: true, upsert: true, setDefaultsOnInsert: true },
        );
        if (!record) throw new CustomValidationError(500, "Failed to record attendance");

        return {
            userPk:     record.userPk,
            name:       roster.get(record.userPk)?.name ?? `User ${record.userPk}`,
            role:       record.role,
            present:    record.present,
            markedBy:   record.markedBy ?? null,
            markedAt:   record.markedAt ?? null,
            explicit:   true,
            viaSubteam: null,
        };
    }

    /**
     * Returns the attendance sheet for a single meeting occurrence: every invited
     * attendee with their role and present flag. Restricted to meeting
     * managers (Team Owner, executive, or the `corp:meetingsmgmt` bindle) — the
     * sheet is not visible to ordinary attendees.
     *
     * @param teamId    Authentik group PK of the team
     * @param meetingId MongoDB ObjectId of the meeting occurrence
     */
    @Get("{teamId}/meetings/{meetingId}/attendance")
    @Tags("Team Meetings")
    @SuccessResponse(200)
    @Security("bindles", ["corp:meetingsmgmt"])
    async getMeetingAttendance(
        @Request() req: express.Request,
        @Path() teamId: string,
        @Path() meetingId: string,
    ): Promise<APIMeetingAttendanceResponse> {
        const meeting = await TeamMeeting.findOne({ _id: meetingId, teamPk: teamId }).lean();
        if (!meeting) throw new CustomValidationError(404, "Meeting not found");

        const [records, invites] = await Promise.all([
            MeetingAttendance.find({ meetingId, teamPk: teamId }).lean(),
            MeetingSubteamAttendance.find({ meetingId, teamPk: teamId }).lean(),
        ]);
        const roster = await this.getTeamRoster(teamId);
        const directory = await this.getSubteamDirectory(teamId);

        /* Attribute each covered person to one invited subteam for display;
           required invites win so the label matches the effective role. */
        const viaSubteam = new Map<number, string>();
        const sortedInvites = [...invites].sort((a, b) => (a.role === b.role ? 0 : a.role === "required" ? -1 : 1));
        for (const invite of sortedInvites) {
            const subteam = directory.get(invite.subteamPk);
            if (!subteam) continue;
            subteam.memberPks.forEach((pk) => { if (!viaSubteam.has(pk)) viaSubteam.set(pk, subteam.name); });
        }

        const attendees: APIMeetingAttendee[] = records.map((r) => ({
            userPk:     r.userPk,
            name:       roster.get(r.userPk)?.name ?? `User ${r.userPk}`,
            role:       r.role,
            present:    r.present,
            markedBy:   r.markedBy ?? null,
            markedAt:   r.markedAt ?? null,
            explicit:   true,
            viaSubteam: viaSubteam.get(r.userPk) ?? null,
        }));

        /* Members covered by a subteam invite but without their own row yet:
           resolved fresh from the subteam's current membership. */
        const explicitPks = new Set(records.map((r) => r.userPk));
        for (const [pk, subteamName] of viaSubteam) {
            if (explicitPks.has(pk)) continue;
            attendees.push({
                userPk:     pk,
                name:       roster.get(pk)?.name ?? `User ${pk}`,
                role:       this.resolveSubteamRole(invites, directory, pk)!,
                present:    false,
                markedBy:   null,
                markedAt:   null,
                explicit:   false,
                viaSubteam: subteamName,
            });
        }

        attendees.sort((a, b) => (a.role === b.role ? a.name.localeCompare(b.name) : a.role === "required" ? -1 : 1));

        /* Reaching here means the bindle gate passed, so the viewer always manages. */
        return {
            viewerPk:  req.session.authorizedUser!.pk,
            canManage: true,
            attendees,
            subteams:  invites.map((invite) => ({
                subteamPk: invite.subteamPk,
                name:      directory.get(invite.subteamPk)?.name ?? invite.subteamPk,
                role:      invite.role,
            })),
        };
    }

    /**
     * Adds a person to a meeting occurrence's attendance sheet.
     * Requires Team Owner or the `corp:meetingsmgmt` bindle.
     *
     * @param teamId    Authentik group PK of the team
     * @param meetingId MongoDB ObjectId of the meeting occurrence
     * @param body      The attendee to add and their role (defaults to required)
     */
    @Post("{teamId}/meetings/{meetingId}/attendance")
    @Tags("Team Meetings")
    @SuccessResponse(201)
    @Security("bindles", ["corp:meetingsmgmt"])
    async addMeetingAttendee(
        @Path() teamId: string,
        @Path() meetingId: string,
        @Body() body: APIAddAttendeeRequest,
    ): Promise<APIMeetingAttendee> {
        const meeting = await TeamMeeting.findOne({ _id: meetingId, teamPk: teamId }).lean();
        if (!meeting) throw new CustomValidationError(404, "Meeting not found");

        const role: AttendanceRole = body.role === "optional" ? "optional" : "required";
        try {
            await MeetingAttendance.create({
                meetingId,
                teamPk:   teamId,
                seriesId: meeting.seriesId,
                userPk:   body.userPk,
                role,
                present:  false,
            });
        } catch (e: any) {
            /* The unique (meetingId, userPk) index is the real duplicate guard —
               a pre-check would race with concurrent adds/check-ins. */
            if (e?.code === 11000) throw new CustomValidationError(409, "Person is already an attendee");
            throw e;
        }

        const roster = await this.getTeamRoster(teamId);
        this.setStatus(201);
        return {
            userPk:     body.userPk,
            name:       roster.get(body.userPk)?.name ?? `User ${body.userPk}`,
            role,
            present:    false,
            markedBy:   null,
            markedAt:   null,
            explicit:   true,
            viaSubteam: null,
        };
    }

    /**
     * Invites an entire subteam to a meeting occurrence, by reference: whoever
     * is in the subteam when attendance is read or marked counts as invited,
     * so the invite tracks the subteam as it grows or shrinks.
     * Requires Team Owner or the `corp:meetingsmgmt` bindle.
     *
     * @param teamId    Authentik group PK of the team
     * @param meetingId MongoDB ObjectId of the meeting occurrence
     * @param body      The subteam to invite and its role (defaults to required)
     */
    @Post("{teamId}/meetings/{meetingId}/attendance/subteams")
    @Tags("Team Meetings")
    @SuccessResponse(201)
    @Security("bindles", ["corp:meetingsmgmt"])
    async addMeetingSubteam(
        @Path() teamId: string,
        @Path() meetingId: string,
        @Body() body: APIAddSubteamRequest,
    ): Promise<APIMeetingSubteamRef> {
        const meeting = await TeamMeeting.findOne({ _id: meetingId, teamPk: teamId }).lean();
        if (!meeting) throw new CustomValidationError(404, "Meeting not found");

        const directory = await this.getSubteamDirectory(teamId);
        const subteam = directory.get(body.subteamPk);
        if (!subteam) throw new CustomValidationError(400, "Not a subteam of this team");

        const role: AttendanceRole = body.role === "optional" ? "optional" : "required";
        try {
            await MeetingSubteamAttendance.create({
                meetingId,
                teamPk:    teamId,
                seriesId:  meeting.seriesId,
                subteamPk: body.subteamPk,
                role,
            });
        } catch (e: any) {
            /* The unique (meetingId, subteamPk) index is the real duplicate guard. */
            if (e?.code === 11000) throw new CustomValidationError(409, "Subteam is already invited");
            throw e;
        }

        this.setStatus(201);
        return { subteamPk: body.subteamPk, name: subteam.name, role };
    }

    /**
     * Removes a subteam invite from a meeting occurrence. Attendance rows
     * already materialized for its members (e.g. by check-in) are kept.
     * Requires Team Owner or the `corp:meetingsmgmt` bindle.
     *
     * @param teamId    Authentik group PK of the team
     * @param meetingId MongoDB ObjectId of the meeting occurrence
     * @param subteamPk Authentik group PK of the subteam to uninvite
     */
    @Delete("{teamId}/meetings/{meetingId}/attendance/subteams/{subteamPk}")
    @Tags("Team Meetings")
    @SuccessResponse(204)
    @Security("bindles", ["corp:meetingsmgmt"])
    async removeMeetingSubteam(
        @Path() teamId: string,
        @Path() meetingId: string,
        @Path() subteamPk: string,
    ): Promise<void> {
        const result = await MeetingSubteamAttendance.deleteOne({ meetingId, teamPk: teamId, subteamPk });
        if (result.deletedCount === 0) throw new CustomValidationError(404, "Subteam is not invited to this meeting");
    }

    /**
     * Sets an attendee's present flag for a meeting occurrence.
     * Restricted to meeting managers (Team Owner, executive, or the
     * `corp:meetingsmgmt` bindle); attendees cannot mark their own attendance.
     *
     * @param teamId    Authentik group PK of the team
     * @param meetingId MongoDB ObjectId of the meeting occurrence
     * @param userPk    Authentik user PK of the attendee to mark
     * @param body      The new present flag
     */
    @Patch("{teamId}/meetings/{meetingId}/attendance/{userPk}")
    @Tags("Team Meetings")
    @SuccessResponse(200)
    @Security("bindles", ["corp:meetingsmgmt"])
    async markAttendance(
        @Request() req: express.Request,
        @Path() teamId: string,
        @Path() meetingId: string,
        @Path() userPk: number,
        @Body() body: APIMarkAttendanceRequest,
    ): Promise<APIMeetingAttendee> {
        if (typeof body.present !== "boolean") {
            throw new CustomValidationError(400, "Invalid attendance value");
        }

        const viewerPk = req.session.authorizedUser!.pk;
        const markUpdate = { present: body.present, markedBy: viewerPk, markedAt: new Date() };
        let record = await MeetingAttendance.findOneAndUpdate(
            { meetingId, teamPk: teamId, userPk },
            { $set: markUpdate },
            { new: true },
        );
        if (!record) {
            /* Subteam invitees have no row until first marked — materialize one
               with the role their subteam invite grants. Atomic upsert: the
               person may check themselves in concurrently, and a plain save()
               would trip the unique (meetingId, userPk) index. */
            const meeting = await TeamMeeting.findOne({ _id: meetingId, teamPk: teamId }).lean();
            if (!meeting) throw new CustomValidationError(404, "Meeting not found");
            const invites = await MeetingSubteamAttendance.find({ meetingId, teamPk: teamId }).lean();
            const directory = invites.length > 0 ? await this.getSubteamDirectory(teamId) : new Map();
            const role = this.resolveSubteamRole(invites, directory, userPk);
            if (!role) throw new CustomValidationError(404, "This person is not an attendee of the meeting");
            record = await MeetingAttendance.findOneAndUpdate(
                { meetingId, teamPk: teamId, userPk },
                {
                    $setOnInsert: { seriesId: meeting.seriesId, role },
                    $set: markUpdate,
                },
                { new: true, upsert: true, setDefaultsOnInsert: true },
            );
        }
        if (!record) throw new CustomValidationError(500, "Failed to record attendance");

        const roster = await this.getTeamRoster(teamId);
        return {
            userPk:     record.userPk,
            name:       roster.get(record.userPk)?.name ?? `User ${record.userPk}`,
            role:       record.role,
            present:    record.present,
            markedBy:   record.markedBy ?? null,
            markedAt:   record.markedAt ?? null,
            explicit:   true,
            viaSubteam: null,
        };
    }

    /**
     * Removes a person from a meeting occurrence's attendance sheet.
     * Requires Team Owner or the `corp:meetingsmgmt` bindle.
     *
     * @param teamId    Authentik group PK of the team
     * @param meetingId MongoDB ObjectId of the meeting occurrence
     * @param userPk    Authentik user PK of the attendee to remove
     */
    @Delete("{teamId}/meetings/{meetingId}/attendance/{userPk}")
    @Tags("Team Meetings")
    @SuccessResponse(204)
    @Security("bindles", ["corp:meetingsmgmt"])
    async removeMeetingAttendee(
        @Path() teamId: string,
        @Path() meetingId: string,
        @Path() userPk: number,
    ): Promise<void> {
        const result = await MeetingAttendance.deleteOne({ meetingId, teamPk: teamId, userPk });
        if (result.deletedCount === 0) throw new CustomValidationError(404, "Attendee not found");
    }
}
