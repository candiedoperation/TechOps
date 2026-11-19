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

import mongoose, { Schema, Document } from "mongoose";
import { APICreateTeamRequest } from "../controllers/OrgController";

export enum TeamCreationRequestStatus {
    PENDING = 'PENDING',
    APPROVED = 'APPROVED',
    REJECTED = 'REJECTED'
}

export interface ITeamCreationRequest extends Document {
    requestorPk: number;
    requestorName: string;
    requestorEmail: string;

    /* The payload required to create the team */
    createTeamRequest: APICreateTeamRequest;

    status: TeamCreationRequestStatus;
    createdAt: Date;
}

const TeamCreationRequestSchema: Schema = new Schema({
    requestorPk: { type: Number, required: true },
    requestorName: { type: String, required: true },
    requestorEmail: { type: String, required: true },

    createTeamRequest: {
        friendlyName: { type: String, required: true },
        teamType: { type: String, required: true },
        seasonType: { type: String, required: true },
        seasonYear: { type: Number, required: true },
        teamStartDate: { type: String, required: true },
        teamEndDate: { type: String, required: true },
        description: { type: String, required: true },
        requestorRole: { type: String, required: true }
    },

    status: { type: String, enum: Object.values(TeamCreationRequestStatus), default: TeamCreationRequestStatus.PENDING },
}, { timestamps: true });

/* TTL Index: Expire after 24 hours (86400 seconds) */
TeamCreationRequestSchema.index({ createdAt: 1 }, { expireAfterSeconds: 86400 });

export const TeamCreationRequest = mongoose.model<ITeamCreationRequest>("TeamCreationRequest", TeamCreationRequestSchema);
