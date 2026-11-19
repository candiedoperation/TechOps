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

import { Schema, model, Document } from 'mongoose';
import { AttendanceRole } from './MeetingAttendance';

/**
 * Invites an entire subteam to a meeting occurrence *by reference*: membership
 * is resolved against Authentik at read/check-in time, so people who join or
 * leave the subteam later are automatically included or excluded. Individual
 * cross-subteam invitees live in MeetingAttendance instead.
 */
export interface IMeetingSubteamAttendance extends Document {
    /** MongoDB ObjectId (as string) of the TeamMeeting occurrence */
    meetingId: string;
    teamPk: string;
    /** Mirrors the meeting's seriesId for convenient series-wide queries */
    seriesId: string;
    /** Authentik group PK of the invited subteam */
    subteamPk: string;
    role: AttendanceRole;
    createdAt: Date;
    updatedAt: Date;
}

const MeetingSubteamAttendanceSchema = new Schema<IMeetingSubteamAttendance>({
    meetingId: { type: String, required: true, index: true },
    teamPk:    { type: String, required: true, index: true },
    seriesId:  { type: String, required: true, index: true },
    subteamPk: { type: String, required: true, index: true },
    role:      { type: String, enum: ['required', 'optional'], required: true },
}, { timestamps: true });

/* A subteam can appear at most once on a given meeting occurrence. */
MeetingSubteamAttendanceSchema.index({ meetingId: 1, subteamPk: 1 }, { unique: true });

export const MeetingSubteamAttendance = model<IMeetingSubteamAttendance>('MeetingSubteamAttendance', MeetingSubteamAttendanceSchema);
