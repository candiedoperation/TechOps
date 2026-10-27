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

import type { Controller } from "tsoa";
import type { GetGroupInfoResponse } from "../../clients/AuthentikClient/models";
import type { ApplicantProfile } from "../../models/Applicant";
import { ApplicationStage } from "../../models/Application";
import path from "path";
import MarkdownIt from "markdown-it";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { s3Client, BUCKET_NAME } from "../../clients/AWSClient/S3Client";
import {
    validateS3FileSignature,
    FILE_SIGNATURES,
} from "../../utils/s3-validation";

/* Shared request/response types, validation, and formatting. Most helpers do not
 * access services; resume signing and PDF verification are the exceptions. */
export type ATSResponse = Pick<Controller, "setStatus" | "setHeader">;

export interface ATSSubteamConfigRequest {
    isRecruiting: boolean;
    roles: string[];
    roleSpecificQuestions: { [role: string]: string[] };
}

// Team-level application request with ordered role preferences
export interface ATSTeamApplicationRequest {
    teamPk: string;
    rolePreferences: { role: string; subteamPk: string }[]; // Ordered array
    profile: ApplicantProfile;
    responses: Record<string, string>;
}

export interface ATSUpdateApplicationStageRequest {
    stage: ApplicationStage;
    interviewLink?: string;
    interviewGuidelines?: string;
    hiredRole?: string;
    hiredSubteamPk?: string;
}

export interface ATSKanbanApplicationCard {
    id: string;
    applicantId: string;
    name: string;
    rolePreferences: { role: string; subteamPk: string }[];
    appliedAt: Date;
    stage: ApplicationStage;

    /**
     * Rating for an Applicant
     * @minimum 0 Minimum Stars is 0
     * @maximum 5 Maximum Stars is 5
     */
    stars: number;
}

export interface ATSApplicationDetails extends ATSKanbanApplicationCard {
    email: string;
    profile: Record<string, string>;
    responses: Record<string, string>;
    stageHistory?: {
        stage: ApplicationStage;
        changedAt: Date;
        changedBy?: string;
    }[];
    hiredRole?: string;
    appDevInternalPk?: number;
    notes?: string;
}

const ALLOWED_RESUME_EXTENSIONS = ["pdf"] as const;
const ALLOWED_CONTENT_TYPES = ["application/pdf"] as const;
const MAX_RESPONSE_LENGTH = 2000;
const MAX_WHY_APPDEV_WORDS = 200;
const MIN_RESPONSE_WORDS = 10;

// One PDF key per applicant. The profile stores this key, not a permanent URL.
export function resumeKeyFor(applicantId: unknown): string {
    return `resumes/${applicantId}.pdf`;
}

export function isApplicantResumeKey(
    applicantId: unknown,
    key: string,
): boolean {
    return (
        path.posix.normalize(key) === resumeKeyFor(applicantId) &&
        !key.includes("..")
    );
}

// This authorizes a temporary storage request; actual download still needs a
// readable object and storage permissions. It does not retrieve the PDF here.
export function createResumeDownloadUrl(key: string): Promise<string> {
    return getSignedUrl(
        s3Client,
        new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key }),
        { expiresIn: 900 },
    );
}

// Verify both ownership and the stored file header; a .pdf filename alone is
// insufficient. Storage failures also fail validation rather than skipping it.
export async function verifyApplicantResume(
    applicantId: unknown,
    key: string,
    response: ATSResponse,
) {
    if (!isApplicantResumeKey(applicantId, key)) {
        response.setStatus(400);
        return { error: "InvalidResumeKey", message: "Invalid resume upload." };
    }

    if (!(await validateS3FileSignature(key, [FILE_SIGNATURES.PDF]))) {
        response.setStatus(400);
        return {
            error: "InvalidFileSignature",
            message: "The uploaded file is not a valid PDF.",
        };
    }
}

export function formatTeamSummary(team: GetGroupInfoResponse) {
    return {
        name: team.name,
        friendlyName: team.attributes.friendlyName,
        description: team.attributes.description,
        seasonText: `${team.attributes.seasonType} ${team.attributes.seasonYear}`,
        pk: team.pk,
    };
}

export function validateResumeUpload(
    fileName: string,
    contentType: string,
    response: ATSResponse,
) {
    // Validate PDF only
    const fileExtension = fileName.split(".").pop()?.toLowerCase();
    if (
        !fileExtension ||
        !ALLOWED_RESUME_EXTENSIONS.includes(fileExtension as any)
    ) {
        response.setStatus(400);
        return {
            error: "InvalidFileType",
            message: `Only PDF resumes are accepted. Allowed types: ${ALLOWED_RESUME_EXTENSIONS.join(", ")}`,
        };
    }

    if (!ALLOWED_CONTENT_TYPES.includes(contentType as any)) {
        response.setStatus(400);
        return {
            error: "InvalidContentType",
            message: "Invalid content type. Only PDF is accepted.",
        };
    }

    // Prevent path traversal
    if (
        fileName.includes("..") ||
        fileName.includes("/") ||
        fileName.includes("\\")
    ) {
        response.setStatus(400);
        return { error: "InvalidFileName", message: "Invalid file name" };
    }
}

export function validateApplicantProfile(
    profile: ApplicantProfile,
    response: ATSResponse,
) {
    if (!profile.resumeUrl || profile.resumeUrl.trim() === "") {
        response.setStatus(400);
        return {
            error: "MissingRequiredField",
            message: "Resume URL is required",
        };
    }

    if (!profile.resumeUrl.toLowerCase().endsWith(".pdf")) {
        response.setStatus(400);
        return {
            error: "InvalidFileType",
            message: "Only PDF resumes are accepted",
        };
    }

    if (!profile.whyAppDev || profile.whyAppDev.trim() === "") {
        response.setStatus(400);
        return {
            error: "MissingRequiredField",
            message: "Please provide 'Why App Dev'",
        };
    }

    if (!profile.instagramFollow || profile.instagramFollow.trim() === "") {
        response.setStatus(400);
        return {
            error: "MissingRequiredField",
            message: "Please confirm Instagram follow",
        };
    }

    if (profile.linkedinUrl && profile.linkedinUrl.trim() !== "") {
        try {
            new URL(profile.linkedinUrl);
        } catch {
            response.setStatus(400);
            return {
                error: "InvalidURL",
                message: "Please provide a valid LinkedIn URL",
            };
        }
    }

    if (profile.githubUrl && profile.githubUrl.trim() !== "") {
        try {
            new URL(profile.githubUrl);
        } catch {
            response.setStatus(400);
            return {
                error: "InvalidURL",
                message: "Please provide a valid GitHub URL",
            };
        }
    }

    const whyAppDevWords = profile.whyAppDev
        .trim()
        .split(/\s+/)
        .filter(Boolean).length;
    if (whyAppDevWords > MAX_WHY_APPDEV_WORDS) {
        response.setStatus(400);
        return {
            error: "WordCountExceeded",
            message: `'Why App Dev' must be ${MAX_WHY_APPDEV_WORDS} words or less`,
        };
    }
}

export function validateApplicationResponses(
    responses: Record<string, string>,
    allQuestions: Set<string>,
    response: ATSResponse,
) {
    for (const question of Array.from(allQuestions)) {
        if (!responses[question] || responses[question].trim() === "") {
            response.setStatus(400);
            return {
                error: "MissingResponse",
                message: `Please answer: ${question}`,
            };
        }

        if (responses[question].length > MAX_RESPONSE_LENGTH) {
            response.setStatus(400);
            return {
                error: "ResponseTooLong",
                message: `Response too long for: ${question}. Maximum ${MAX_RESPONSE_LENGTH} characters.`,
            };
        }

        const wordCount = responses[question]
            .trim()
            .split(/\s+/)
            .filter(Boolean).length;
        if (wordCount < MIN_RESPONSE_WORDS) {
            response.setStatus(400);
            return {
                error: "ResponseTooShort",
                message: `Response too short for: ${question}. Please provide at least ${MIN_RESPONSE_WORDS} words.`,
            };
        }
    }
}

export function validateFeedback(
    stars: number | undefined,
    notes: string | undefined,
    response: ATSResponse,
) {
    if (stars === undefined && !notes) {
        response.setStatus(400);
        return {
            error: "BadRequest",
            message: "Stars or notes must be provided",
        };
    }

    if (
        stars !== undefined &&
        (typeof stars !== "number" || stars < 1 || stars > 5)
    ) {
        response.setStatus(400);
        return {
            error: "BadRequest",
            message: "Stars must be a number between 1 and 5",
        };
    }
}

export function validateFeedbackNotes(notes: string, response: ATSResponse) {
    // Validate Markdown (Empty Check)
    if (!notes.trim()) {
        response.setStatus(400);
        return {
            error: "BadRequest",
            message: "Notes cannot be empty",
        };
    }

    // Validate Markdown Structure (Unclosed Fences)
    const md = new MarkdownIt({ html: false });
    const sentinel = "___MARKDOWN_SENTINEL___";
    const tokens = md.parse(notes + "\n\n" + sentinel, {});

    // If sentinel is trapped inside a code/fence block, the previous block was unclosed
    const isTrapped = tokens.some(
        (token) =>
            (token.type === "fence" || token.type === "code_block") &&
            token.content.includes(sentinel),
    );

    if (isTrapped) {
        response.setStatus(400);
        return {
            error: "BadRequest",
            message: "Invalid Markdown Structure",
        };
    }
}

export function formatFeedbackNote(
    authorName: string,
    notes: string,
    previousNotes: string | undefined,
): string {
    // Format Date: "Jan 22, 2026 at 3:45pm"
    const now = new Date();
    const formattedDate = new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "numeric",
        hour12: true,
    }).format(now);

    const noteHeader = `###### ${authorName}  \n*${formattedDate}*`;
    const existingNotes = previousNotes || "";
    const separator = existingNotes ? "\n\n---\n\n" : "";
    return `${noteHeader}\n\n${notes}${separator}${existingNotes}`;
}

export function validateStageTransition(
    currentStage: ApplicationStage,
    input: ATSUpdateApplicationStageRequest,
    response: ATSResponse,
) {
    const { stage, interviewLink, interviewGuidelines } = input;
    const VALID_TRANSITIONS: Record<string, ApplicationStage[]> = {
        [ApplicationStage.APPLIED]: [
            ApplicationStage.INTERVIEW,
            ApplicationStage.REJECTED,
        ],
        [ApplicationStage.INTERVIEW]: [
            ApplicationStage.POTENTIAL_HIRE,
            ApplicationStage.HIRED,
            ApplicationStage.REJECTED,
        ],
        [ApplicationStage.POTENTIAL_HIRE]: [
            ApplicationStage.HIRED,
            ApplicationStage.REJECTED,
        ],
        [ApplicationStage.HIRED]: [],
        [ApplicationStage.REJECTED]: [],
    };

    const allowed = VALID_TRANSITIONS[currentStage] || [];
    if (!allowed.includes(stage)) {
        response.setStatus(400);
        return {
            error: "BadRequest",
            message: `Invalid transition from ${currentStage} to ${stage}`,
        };
    }

    if (stage === ApplicationStage.INTERVIEW) {
        if (!interviewLink) {
            response.setStatus(400);
            return {
                error: "BadRequest",
                message: "Interview Link is required for Interview stage",
            };
        }

        if (
            !interviewGuidelines ||
            interviewGuidelines.length < 50 ||
            interviewGuidelines.length > 500
        ) {
            response.setStatus(400);
            return {
                error: "BadRequest",
                message:
                    "Interview Guidelines are required (50-500 characters)",
            };
        }
    }
}
