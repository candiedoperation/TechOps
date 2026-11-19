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

import { Document, model, Schema } from "mongoose";

export interface ITeamRecruitingStatus extends Document {
  teamPk: string;
  isRecruiting: boolean;
  recruitingSubteamPks: string[];
}

const TeamRecruitingStatusSchema = new Schema<ITeamRecruitingStatus>({
  teamPk: { type: String, required: true, unique: true, index: true },
  isRecruiting: { type: Boolean, required: true, default: false },
  recruitingSubteamPks: [{ type: String, required: true }]
}, { timestamps: true });

export const TeamRecruitingStatus = model<ITeamRecruitingStatus>('TeamRecruitingStatus', TeamRecruitingStatusSchema);
