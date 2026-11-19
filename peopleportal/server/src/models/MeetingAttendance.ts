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

/** Whether an attendee is expected at the meeting or merely invited */
export type AttendanceRole = 'required' | 'optional';

/**
 * One row of the attendance relation: links a single person (Authentik user PK)
 * to a single meeting occurrence. Attendance is tracked per occurrence, so a
 * recurring series produces one of these per attendee per week.
 */
export interface IMeetingAttendance extends Document {
    /** MongoDB ObjectId (as string) of the TeamMeeting occurrence */
    meetingId: string;
    teamPk: string;
    /** Mirrors the meeting's seriesId for convenient series-wide queries */
    seriesId: string;
    /** Authentik user PK of the attendee */
    userPk: number;
    role: AttendanceRole;
    /** True once the attendee has been marked present; false until then */
    present: boolean;
    /** Authentik user PK of whoever last set attendance (self or a manager) */
    markedBy: number | null;
    markedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
}

const MeetingAttendanceSchema = new Schema<IMeetingAttendance>({
    meetingId: { type: String, required: true, index: true },
    teamPk:    { type: String, required: true, index: true },
    seriesId:  { type: String, required: true, index: true },
    userPk:    { type: Number, required: true, index: true },
    role:      { type: String, enum: ['required', 'optional'], required: true },
    present:   { type: Boolean, default: false },
    markedBy:  { type: Number, default: null },
    markedAt:  { type: Date, default: null },
}, { timestamps: true });

/* A person can appear at most once on a given meeting occurrence. */
MeetingAttendanceSchema.index({ meetingId: 1, userPk: 1 }, { unique: true });

export const MeetingAttendance = model<IMeetingAttendance>('MeetingAttendance', MeetingAttendanceSchema);
