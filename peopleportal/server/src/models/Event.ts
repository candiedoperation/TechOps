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

export const SupportedMarketingChannels = ["email", "slack", "discord"];
export const SupportedScopes = ["public", "exec", "internal"];

export interface IEvent extends Document {
    eventName: string;
    eventDescription: string;
    creator: number;
    startTime: Date;
    endTime: Date;
    location: string;
    public: boolean;
    scope: string;
    marketingChannels: string[];
}

const EventSchema = new Schema<IEvent>({
    eventName: {
        type: String,
        required: true
    },
    eventDescription: {
        type: String,
        required: true
    },
    creator: {
        type: Number,
        required: true
    },
    startTime: {
        type: Date,
        required: true
    },
    endTime: {
        type: Date,
        required: true
    },
    location: {
        type: String,
        required: true
    },
    scope: {               // "public" | "exec" | "internal"
        type: String,
        required: true,
        validate: {
            validator: scope => SupportedScopes.includes(scope),
            message: `scope must be one of ${SupportedScopes}`
        }
    },
    marketingChannels: {
        type: [String],
        required: true,
        validate: {
            validator: function(channels: string[]) {
                return channels && channels.every(channel => SupportedMarketingChannels.includes(channel));
            },
            message: `marketingChannels must be a string[] with only values from ${SupportedMarketingChannels}`
        }
    },
}, {timestamps: true});

export const Event = model<IEvent>('Event', EventSchema);     