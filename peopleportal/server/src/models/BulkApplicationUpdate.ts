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

import { Document, model, Schema, Types } from "mongoose";
import { ApplicationStage } from "./Application";

export enum BulkApplicationUpdateStatus {
    QUEUED = "queued",
    PROCESSING = "processing",
    COMPLETED = "completed",
    COMPLETED_WITH_ERRORS = "completed_with_errors",
}

export enum BulkApplicationRecipientStatus {
    PENDING = "pending",
    PROCESSING = "processing",
    SENT = "sent",
    FAILED = "failed",
    VALIDATION_FAILED = "validation_failed",
}

export type BulkApplicationFailurePhase = "stage" | "email" | "queue";

export interface IBulkApplicationUpdateJob extends Document {
    teamPk: string;
    teamName: string;
    targetStage: ApplicationStage;
    interviewLink?: string;
    interviewGuidelines?: string;
    requestedByName: string;
    requestedByEmail: string;
    requestedByUsername: string;
    status: BulkApplicationUpdateStatus;
    createdAt: Date;
    updatedAt: Date;
}

export interface IBulkApplicationUpdateRecipient extends Document {
    jobId: Types.ObjectId;
    teamPk: string;
    applicationId: string;
    applicantId?: string;
    applicantName?: string;
    email?: string;
    previousStage?: ApplicationStage;
    targetStage: ApplicationStage;
    status: BulkApplicationRecipientStatus;
    failurePhase?: BulkApplicationFailurePhase | undefined;
    error?: string | undefined;
    attempts: number;
    stageChangedAt?: Date;
    sentAt?: Date;
    createdAt: Date;
    updatedAt: Date;
}

const BulkApplicationUpdateJobSchema =
    new Schema<IBulkApplicationUpdateJob>(
        {
            teamPk: { type: String, required: true, index: true },
            teamName: { type: String, required: true },
            targetStage: {
                type: String,
                enum: Object.values(ApplicationStage),
                required: true,
            },
            interviewLink: { type: String },
            interviewGuidelines: { type: String },
            requestedByName: { type: String, required: true },
            requestedByEmail: { type: String, required: true },
            requestedByUsername: { type: String, required: true },
            status: {
                type: String,
                enum: Object.values(BulkApplicationUpdateStatus),
                required: true,
                default: BulkApplicationUpdateStatus.QUEUED,
            },
        },
        { timestamps: true },
    );

const BulkApplicationUpdateRecipientSchema =
    new Schema<IBulkApplicationUpdateRecipient>(
        {
            jobId: {
                type: Schema.Types.ObjectId,
                ref: "BulkApplicationUpdateJob",
                required: true,
            },
            teamPk: { type: String, required: true },
            applicationId: { type: String, required: true },
            applicantId: { type: String },
            applicantName: { type: String },
            email: { type: String },
            previousStage: {
                type: String,
                enum: Object.values(ApplicationStage),
            },
            targetStage: {
                type: String,
                enum: Object.values(ApplicationStage),
                required: true,
            },
            status: {
                type: String,
                enum: Object.values(BulkApplicationRecipientStatus),
                required: true,
            },
            failurePhase: {
                type: String,
                enum: ["stage", "email", "queue"],
            },
            error: { type: String },
            attempts: { type: Number, required: true, default: 0 },
            stageChangedAt: { type: Date },
            sentAt: { type: Date },
        },
        { timestamps: true },
    );

BulkApplicationUpdateRecipientSchema.index(
    { jobId: 1, applicationId: 1 },
    { unique: true },
);
BulkApplicationUpdateRecipientSchema.index({
    teamPk: 1,
    applicationId: 1,
    createdAt: -1,
});

export const BulkApplicationUpdateJob =
    model<IBulkApplicationUpdateJob>(
        "BulkApplicationUpdateJob",
        BulkApplicationUpdateJobSchema,
    );

export const BulkApplicationUpdateRecipient =
    model<IBulkApplicationUpdateRecipient>(
        "BulkApplicationUpdateRecipient",
        BulkApplicationUpdateRecipientSchema,
    );
