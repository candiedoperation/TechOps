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

const MAX_TITLE_LENGTH = 150;
const MIN_REVIEW_LENGTH = 50;
const MAX_REVIEW_LENGTH = 2000;


export interface IUserReview extends Document {
  userId: number;
  creatorId: number;
  teamId: string;   // The review will be regarding the user's work under this team
  rating: number;
  title: string;
  content: string;
  createdAt: Date;
  updatedAt: Date;
}

const userReviewSchema = new Schema<IUserReview>({
  userId: {
    type: Number,
    required: true,
    index: true,
  },
  creatorId: {
    type: Number,
    required: true,
  },
  teamId: {
    type: String,
    required: true,
  },
  rating: {
    type: Number,
    required: true,
    validate: {
        validator: (rating: number) => rating >= 1 && rating <= 5 && Number.isInteger(rating * 10),
        message: "Rating must be between 1 and 5, and can only have up to 1 decimal place."
    }
  },
  title: {
    type: String,
    required: true,
    validate: {
        validator: (title: string) => title.length > 0 && title.length <= MAX_TITLE_LENGTH,
        message: `Title must be non-empty and a maximum of ${MAX_TITLE_LENGTH} characters long.`
    }
  },
  content: {
    type: String,
    required: true,
    validate: {
        validator: (content: string) => content.length > MIN_REVIEW_LENGTH && content.length <= MAX_REVIEW_LENGTH,
        message: `Content must be between ${MIN_REVIEW_LENGTH} and ${MAX_REVIEW_LENGTH} characters long.`
    }
  },
}, { timestamps: true });

export const UserReview = model<IUserReview>('UserReview', userReviewSchema);