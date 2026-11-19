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

export interface ISubteamConfig extends Document {
  subteamPk: string;
  isRecruiting: boolean;
  roles: string[];
  roleSpecificQuestions: Record<string, string[]>; // role -> array of questions
}

const SubteamConfigSchema = new Schema<ISubteamConfig>({
  subteamPk: { type: String, required: true, unique: true, index: true },
  isRecruiting: { type: Boolean, required: true, default: false },
  roles: [{ type: String, required: true }],
  roleSpecificQuestions: {
    type: Schema.Types.Mixed,
    default: {}
  }
}, { timestamps: true });

export const SubteamConfig = model<ISubteamConfig>('SubteamConfig', SubteamConfigSchema);
