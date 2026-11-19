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

export interface IInvite extends Document {
  inviteName: string;
  inviteEmail: string;
  roleTitle: string;
  teamName: string;
  teamPk: string;
  subteamPk: string;
  inviterPk: number;
  expiresAt: Date;
}

const inviteSchema = new Schema<IInvite>({
  inviteName: {
    type: String,
    required: true,
    minlength: [2, 'Name must be at least 2 characters'],
    maxlength: [60, 'Name must be at most 60 characters'],
    match: [/^[A-Za-z .'-]+$/, "Invalid name. Use only letters, spaces, apostrophes, periods, and hyphens."]
  },
  inviteEmail: {
    type: String,
    required: true,
    match: [/^\S+@\S+\.\S+$/, 'Please enter a valid email'],
  },
  roleTitle: {
    type: String,
    required: true,
  },
  teamName: {
    type: String,
    required: true,
  },
  teamPk: {
    type: String,
    required: true,
  },
  subteamPk: {
    type: String,
    required: true,
  },
  inviterPk: {
    type: Number,
    required: true,
  },
  expiresAt: {
    type: Date,
    required: true,
    index: { expires: 0 }
  }
}, { timestamps: true });

export const Invite = model<IInvite>('Invite', inviteSchema);
