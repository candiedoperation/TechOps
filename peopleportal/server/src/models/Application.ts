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

import { Document, Schema, model } from "mongoose";

export enum ApplicationStage {
  APPLIED = 'Applied',
  INTERVIEW = 'Interview',
  REJECTED = 'Rejected',
  POTENTIAL_HIRE = 'Potential Hire',
  HIRED = 'Hired'
}

export interface IApplication extends Document {
  applicantId: Schema.Types.ObjectId;
  teamPk: string;
  rolePreferences: { role: string, subteamPk: string }[]; // Ordered array
  stage: ApplicationStage;
  responses: Record<string, string>;
  appliedAt: Date;
  stageHistory: Array<{
    stage: ApplicationStage;
    changedAt: Date;
    changedBy?: string;
  }>;
  hiredRole?: string;
  hiredSubteamPk?: string;
  appDevInternalPk?: number;
  stars: number;
  notes?: string;
}

const ApplicationSchema = new Schema<IApplication>({
  applicantId: { type: Schema.Types.ObjectId, ref: 'Applicant', required: true, index: true },
  teamPk: { type: String, required: true, index: true },
  rolePreferences: {
    type: [{
      role: { type: String, required: true },
      subteamPk: { type: String, required: true }
    }],
    required: true,
    validate: {
      validator: (v: any[]) => v && v.length > 0,
      message: 'At least one role preference is required'
    }
  },
  stage: {
    type: String,
    enum: Object.values(ApplicationStage),
    default: ApplicationStage.APPLIED,
    required: true,
    index: true
  },
  responses: {
    type: Schema.Types.Mixed,
    required: true,
    default: {}
  },
  appliedAt: { type: Date, default: Date.now, required: true },
  appDevInternalPk: { type: Number, required: false },
  stageHistory: [{
    stage: {
      type: String,
      enum: Object.values(ApplicationStage),
      required: true
    },
    changedAt: { type: Date, default: Date.now },
    changedBy: { type: String }
  }],
  hiredRole: { type: String, required: false },
  hiredSubteamPk: { type: String, required: false },
  stars: { type: Number, required: true, default: 0, min: 0, max: 5 },
  notes: { type: String, required: false, maxlength: 10000 }
}, { timestamps: true });

// Updated indexes for team-level queries
ApplicationSchema.index({ teamPk: 1, stage: 1 });
ApplicationSchema.index({ applicantId: 1, teamPk: 1 }, { unique: true }); // One application per team per applicant

export const Application = model<IApplication>('Application', ApplicationSchema);

