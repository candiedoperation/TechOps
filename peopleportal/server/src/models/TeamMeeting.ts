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

export interface ITeamMeeting extends Document {
    teamPk: string;
    /** Groups all occurrences generated from one create request */
    seriesId: string;
    name: string;
    description: string;
    start: Date;
    end: Date;
    /** Authentik user PK of the person who created the meeting */
    createdBy: number;
    /**
     * When true, every team member sees this meeting on the calendar even if
     * they are not invited. When false, non-managers only see it if they are
     * invited (directly or via a subteam) or the meeting has no invite list
     * at all (assumed general audience).
     */
    visibleToAll: boolean;
    createdAt: Date;
    updatedAt: Date;
}

const TeamMeetingSchema = new Schema<ITeamMeeting>({
    teamPk:      { type: String, required: true, index: true },
    seriesId:    { type: String, required: true, index: true },
    name:        { type: String, required: true },
    description: { type: String, default: '' },
    start:       { type: Date, required: true },
    end:         { type: Date, required: true },
    createdBy:   { type: Number, required: true },
    visibleToAll: { type: Boolean, default: false },
}, { timestamps: true });

export const TeamMeeting = model<ITeamMeeting>('TeamMeeting', TeamMeetingSchema);
