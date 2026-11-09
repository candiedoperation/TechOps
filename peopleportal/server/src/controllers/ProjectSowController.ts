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

import crypto, { randomUUID } from "crypto";
import * as express from "express";
import {
    Body,
    Controller,
    Delete,
    Get,
    Path,
    Post,
    Query,
    Request,
    Route,
    Security,
    SuccessResponse,
    Tags,
} from "tsoa";
import {
    DeleteObjectCommand,
    GetObjectCommand,
    HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { s3Client, BUCKET_NAME } from "../clients/AWSClient/S3Client";
import { AuthentikClient } from "../clients/AuthentikClient";
import { SeasonType, TeamType } from "../clients/AuthentikClient/models";
import { executiveAuthVerify } from "../auth";
import { IProjectSow, ProjectSow } from "../models/ProjectSow";
import { CustomValidationError, ResourceAccessError } from "../utils/errors";
import { getS3ObjectBytes } from "../utils/s3-validation";
import {
    SOW_DOWNLOAD_URL_TTL_SECONDS,
    SOW_MAX_BYTES,
    SOW_UPLOAD_URL_TTL_SECONDS,
    SowTeamInfo,
    isProjectLeadership,
    isProjectMember,
    matchesSignature,
    sowFileTypeFor,
    sowS3Key,
} from "../utils/sow";

export interface APISowUploadUrlRequest {
    /** The file's name on the uploader's computer, e.g. "sow-fall-2026.pdf" */
    fileName: string;
}

export interface APISowUploadUrlResponse {
    /** POST the file here as multipart/form-data with `fields` first */
    uploadUrl: string;
    fields: Record<string, string>;
    key: string;
    contentType: string;
    maxBytes: number;
}

export interface APISowConfirmRequest {
    /** The same file name sent to upload-url */
    fileName: string;
}

export interface APIProjectSow {
    sowId: string;
    projectPk: string;
    seasonType: string;
    seasonYear: number;
    fileName: string;
    contentType: string;
    sha256: string;
    sizeBytes: number;
    uploadedBy: number;
    uploadedByName: string | null;
    uploadedAt: Date;
}

export interface APIProjectSowWithUrl extends APIProjectSow {
    /** Presigned download link, valid for 15 minutes */
    downloadUrl: string;
}

export interface APIProjectSowStatus {
    /** null when no SOW has been uploaded for the project's semester yet */
    sow: APIProjectSowWithUrl | null;
    /** The caller may upload (leadership or exec, and none exists yet) */
    canUpload: boolean;
    /** The caller may delete (exec only, and one exists) */
    canDelete: boolean;
}

/**
 * The S3 calls the SOW endpoints make, gathered in one place so tests can
 * swap in an in-memory store instead of talking to AWS.
 */
export interface SowStorage {
    presignUpload(
        key: string,
        contentType: string,
    ): Promise<{ url: string; fields: Record<string, string> }>;
    /** Size of a stored object, or null when it does not exist */
    sizeOf(key: string): Promise<number | null>;
    read(key: string): Promise<Uint8Array | null>;
    presignDownload(key: string, fileName: string): Promise<string>;
    remove(key: string): Promise<void>;
}

export const s3SowStorage: SowStorage = {
    async presignUpload(key, contentType) {
        /* Presigned POST (not PUT) so S3 itself enforces the size limit and
           content type, exactly as the resume upload does. */
        const { url, fields } = await createPresignedPost(s3Client, {
            Bucket: BUCKET_NAME,
            Key: key,
            Conditions: [
                ["content-length-range", 1, SOW_MAX_BYTES],
                { "content-type": contentType },
            ],
            Fields: { "content-type": contentType },
            Expires: SOW_UPLOAD_URL_TTL_SECONDS,
        });
        return { url, fields };
    },
    async sizeOf(key) {
        try {
            const head = await s3Client.send(
                new HeadObjectCommand({ Bucket: BUCKET_NAME, Key: key }),
            );
            return head.ContentLength ?? 0;
        } catch {
            return null;
        }
    },
    read: getS3ObjectBytes,
    presignDownload(key, fileName) {
        return getSignedUrl(
            s3Client,
            new GetObjectCommand({
                Bucket: BUCKET_NAME,
                Key: key,
                ResponseContentDisposition: `attachment; filename="${fileName.replace(/["\\\r\n]/g, "_")}"`,
            }),
            { expiresIn: SOW_DOWNLOAD_URL_TTL_SECONDS },
        );
    },
    async remove(key) {
        await s3Client.send(
            new DeleteObjectCommand({ Bucket: BUCKET_NAME, Key: key }),
        );
    },
};

/** The project facts the SOW rules need, read from Authentik. */
export interface SowProject {
    team: SowTeamInfo;
    seasonType: string;
    seasonYear: number;
}

const MONGO_DUPLICATE_KEY = 11000;
const MAX_FILE_NAME_LENGTH = 255;

export function toAPIProjectSow(sow: IProjectSow): APIProjectSow {
    return {
        sowId: sow.sowId,
        projectPk: sow.projectPk,
        seasonType: sow.seasonType,
        seasonYear: sow.seasonYear,
        fileName: sow.fileName,
        contentType: sow.contentType,
        sha256: sow.sha256,
        sizeBytes: sow.sizeBytes,
        uploadedBy: sow.uploadedBy,
        uploadedByName: sow.uploadedByName ?? null,
        uploadedAt: sow.uploadedAt,
    };
}

/**
 * Statement of Work upload and download for project teams (T5.2).
 *
 * A project's Leadership subteam uploads the semester's SOW once. Any project
 * member can read it. Only executives can delete it, which is how a wrong file
 * gets replaced. Horizon reads every SOW through HorizonSowController.
 */
@Route("/api/projects")
@Tags("Project Statement of Work")
export class ProjectSowController extends Controller {
    /* Overridable in tests. */
    storage: SowStorage = s3SowStorage;
    authentikClient = new AuthentikClient();

    /** Executive Board member or superuser. */
    async isExecutive(req: express.Request): Promise<boolean> {
        if (req.session.authorizedUser?.is_superuser) return true;
        try {
            /* OIDC is already verified by @Security("oidc"). */
            return await executiveAuthVerify(req, [], true);
        } catch {
            return false;
        }
    }

    /** Loads a project team and its semester; 404 for anything else. */
    async loadProject(projectPk: string): Promise<SowProject> {
        let info: any;
        try {
            info = await this.authentikClient.getGroupInfo(projectPk);
        } catch {
            throw new ResourceAccessError(404, "Project not found");
        }
        const attrs = info?.attributes ?? {};
        if (
            attrs.teamType !== TeamType.PROJECT ||
            info.parentPk ||
            attrs.flaggedForDeletion
        ) {
            throw new ResourceAccessError(404, "Project not found");
        }
        return {
            team: info,
            seasonType: String(attrs.seasonType),
            seasonYear: Number(attrs.seasonYear),
        };
    }

    private async canUpload(req: express.Request, project: SowProject) {
        const userPk = Number(req.session.authorizedUser!.pk);
        return (
            isProjectLeadership(project.team, userPk) ||
            (await this.isExecutive(req))
        );
    }

    private async requireUploader(req: express.Request, project: SowProject) {
        if (!(await this.canUpload(req, project))) {
            throw new ResourceAccessError(
                403,
                "Only the project's Leadership subteam or an executive can upload the SOW",
            );
        }
    }

    private findSow(projectPk: string, project: SowProject) {
        return ProjectSow.findOne({
            projectPk,
            seasonType: project.seasonType,
            seasonYear: project.seasonYear,
        }).exec();
    }

    private checkFileName(fileName: unknown) {
        const name = typeof fileName === "string" ? fileName.trim() : "";
        if (!name || name.length > MAX_FILE_NAME_LENGTH) {
            throw new CustomValidationError(400, "A file name is required");
        }
        const fileType = sowFileTypeFor(name);
        if (!fileType) {
            throw new CustomValidationError(
                400,
                "The SOW must be a PDF or DOCX file",
            );
        }
        return { name, fileType };
    }

    /**
     * Step 1 of an upload: returns a short-lived link the browser uploads the
     * file to directly. Refused with 409 when the semester already has a SOW.
     */
    @Post("{projectPk}/sow/upload-url")
    @Security("oidc")
    @SuccessResponse(200, "OK")
    public async getSowUploadUrl(
        @Request() req: express.Request,
        @Path() projectPk: string,
        @Body() body: APISowUploadUrlRequest,
    ): Promise<APISowUploadUrlResponse> {
        const project = await this.loadProject(projectPk);
        await this.requireUploader(req, project);
        const { fileType } = this.checkFileName(body?.fileName);

        if (await this.findSow(projectPk, project)) {
            throw new CustomValidationError(
                409,
                "This project already has a SOW for this semester. Ask an executive to delete it first.",
            );
        }

        const key = sowS3Key(
            project.seasonYear,
            project.seasonType,
            projectPk,
            fileType.extension,
        );
        const { url, fields } = await this.storage.presignUpload(
            key,
            fileType.contentType,
        );
        return {
            uploadUrl: url,
            fields,
            key,
            contentType: fileType.contentType,
            maxBytes: SOW_MAX_BYTES,
        };
    }

    /**
     * Step 2 of an upload: checks the file really is a PDF or DOCX (by its
     * first bytes, not its name), fingerprints it with SHA-256 and saves it.
     * A file that fails a check is deleted from storage.
     */
    @Post("{projectPk}/sow/confirm")
    @Security("oidc")
    @SuccessResponse(201, "Created")
    public async confirmSowUpload(
        @Request() req: express.Request,
        @Path() projectPk: string,
        @Body() body: APISowConfirmRequest,
    ): Promise<APIProjectSow> {
        const project = await this.loadProject(projectPk);
        await this.requireUploader(req, project);
        const { name, fileType } = this.checkFileName(body?.fileName);

        if (await this.findSow(projectPk, project)) {
            throw new CustomValidationError(
                409,
                "This project already has a SOW for this semester",
            );
        }

        const key = sowS3Key(
            project.seasonYear,
            project.seasonType,
            projectPk,
            fileType.extension,
        );
        const reject = async (message: string): Promise<never> => {
            await this.storage.remove(key).catch(() => undefined);
            throw new CustomValidationError(400, message);
        };

        const size = await this.storage.sizeOf(key);
        if (size === null) {
            throw new CustomValidationError(
                400,
                "No uploaded file was found. Upload the file before confirming.",
            );
        }
        if (size <= 0 || size > SOW_MAX_BYTES) {
            await reject("The SOW must be between 1 byte and 15 MB");
        }

        const bytes = await this.storage.read(key);
        if (!bytes || !matchesSignature(bytes, fileType.signature)) {
            await reject(
                `The file is not a real ${fileType.extension.toUpperCase()} file`,
            );
        }

        const sha256 = crypto
            .createHash("sha256")
            .update(bytes!)
            .digest("hex");

        try {
            const sow = await ProjectSow.create({
                sowId: randomUUID(),
                projectPk,
                seasonType: project.seasonType,
                seasonYear: project.seasonYear,
                fileName: name,
                contentType: fileType.contentType,
                s3Key: key,
                sizeBytes: bytes!.length,
                sha256,
                uploadedBy: Number(req.session.authorizedUser!.pk),
                uploadedByName: req.session.authorizedUser!.name,
                uploadedAt: new Date(),
            });
            this.setStatus(201);
            return toAPIProjectSow(sow);
        } catch (e: any) {
            /* Two confirms raced: the unique index let only one through. */
            if (e?.code === MONGO_DUPLICATE_KEY) {
                throw new CustomValidationError(
                    409,
                    "This project already has a SOW for this semester",
                );
            }
            throw e;
        }
    }

    /**
     * The project's SOW for its semester with a 15-minute download link, plus
     * what the caller may do with it. Any project member or executive.
     */
    @Get("{projectPk}/sow")
    @Security("oidc")
    @SuccessResponse(200, "OK")
    public async getProjectSow(
        @Request() req: express.Request,
        @Path() projectPk: string,
    ): Promise<APIProjectSowStatus> {
        const project = await this.loadProject(projectPk);
        const userPk = Number(req.session.authorizedUser!.pk);
        const executive = await this.isExecutive(req);
        if (!executive && !isProjectMember(project.team, userPk)) {
            throw new ResourceAccessError(
                403,
                "Only project members can view the SOW",
            );
        }

        const sow = await this.findSow(projectPk, project);
        const leadership = isProjectLeadership(project.team, userPk);
        return {
            sow: sow
                ? {
                      ...toAPIProjectSow(sow),
                      downloadUrl: await this.storage.presignDownload(
                          sow.s3Key,
                          sow.fileName,
                      ),
                  }
                : null,
            canUpload: !sow && (leadership || executive),
            canDelete: !!sow && executive,
        };
    }

    /** Deletes the semester's SOW so a corrected one can be uploaded. Executives only. */
    @Delete("{projectPk}/sow")
    @Security("oidc")
    @SuccessResponse(204, "Deleted")
    public async deleteProjectSow(
        @Request() req: express.Request,
        @Path() projectPk: string,
    ): Promise<void> {
        if (!(await this.isExecutive(req))) {
            throw new ResourceAccessError(
                403,
                "Only executives can delete a SOW",
            );
        }
        const project = await this.loadProject(projectPk);
        const sow = await this.findSow(projectPk, project);
        if (!sow) throw new ResourceAccessError(404, "No SOW to delete");

        await ProjectSow.deleteOne({ _id: sow._id }).exec();
        await this.storage.remove(sow.s3Key).catch(() => undefined);
        this.setStatus(204);
    }
}

/**
 * Machine-to-machine endpoint for the Horizon pipeline (T5.2, read by T5.3).
 * Authenticated with the Horizon service token, never a user session.
 */
@Route("/api/horizon")
@Tags("Horizon")
export class HorizonSowController extends Controller {
    storage: SowStorage = s3SowStorage;

    /** Every SOW uploaded for one semester, each with a 15-minute download link. */
    @Get("sows")
    @Security("horizon")
    @SuccessResponse(200, "OK")
    public async listSemesterSows(
        @Query() seasonType: SeasonType,
        /** @isInt */ @Query() seasonYear: number,
    ): Promise<APIProjectSowWithUrl[]> {
        const sows = await ProjectSow.find({ seasonType, seasonYear })
            .sort({ projectPk: 1 })
            .exec();
        return Promise.all(
            sows.map(async (sow) => ({
                ...toAPIProjectSow(sow),
                downloadUrl: await this.storage.presignDownload(
                    sow.s3Key,
                    sow.fileName,
                ),
            })),
        );
    }
}
