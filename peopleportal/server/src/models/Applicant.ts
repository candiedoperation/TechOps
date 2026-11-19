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

import { Document, Schema, Types, model } from "mongoose";

export interface IApplicant extends Document {
  _id: Types.ObjectId;
  email: string;
  fullName: string;
  profile: Map<string, string>; // Made required with default
  applicationIds: Types.ObjectId[];
  createdAt: Date;
  updatedAt: Date;
}

const ApplicantSchema = new Schema<IApplicant>({
  email: {
    type: String,
    required: true,
    unique: true,
    index: true,
    lowercase: true,
    trim: true,
    validate: {
      validator: (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
      message: 'Invalid email format'
    }
  },
  fullName: { type: String, required: true, trim: true },
  profile: {
    type: Map,
    of: String,
    required: true,
    default: new Map()
  },
  applicationIds: [{ type: Schema.Types.ObjectId, ref: 'Application' }]
}, { timestamps: true });

export const Applicant = model<IApplicant>('Applicant', ApplicantSchema);

export interface ApplicantProfile {
  resumeUrl: string;
  whyAppDev: string;
  instagramFollow: string;
  linkedinUrl?: string;
  githubUrl?: string;
  [key: string]: string | undefined;
}

