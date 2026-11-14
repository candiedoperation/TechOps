/**
  People Portal UI
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

import React from "react";
import { DownloadIcon, FileTextIcon, Trash2Icon, UploadIcon } from "lucide-react";
import { PEOPLEPORTAL_SERVER_ENDPOINT } from "@/commons/config";
import { Button } from "../ui/button";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "../ui/card";
import { Progress } from "../ui/progress";
import {
    checkSowFile,
    xhrStorageUploader,
    type StorageUploader,
} from "@/lib/sow";

/** Mirrors APIProjectSowStatus from the server (T5.2). */
export interface ProjectSowStatus {
    sow: {
        sowId: string;
        fileName: string;
        uploadedBy: number;
        uploadedByName: string | null;
        uploadedAt: string;
        downloadUrl: string;
    } | null;
    canUpload: boolean;
    canDelete: boolean;
}

async function readError(res: Response, fallback: string) {
    try {
        const data = await res.json();
        return data?.message || fallback;
    } catch {
        return fallback;
    }
}

/**
 * The project's Statement of Work for the semester (T5.2). Leadership sees an
 * upload button until a SOW exists; after that everyone on the project sees
 * the file name, uploader, date and a download link.
 */
export function ProjectSowCard(props: {
    projectPk: string;
    uploadToStorage?: StorageUploader;
}) {
    const { projectPk, uploadToStorage = xhrStorageUploader } = props;
    const base = `${PEOPLEPORTAL_SERVER_ENDPOINT}/api/projects/${encodeURIComponent(projectPk)}/sow`;

    const [status, setStatus] = React.useState<ProjectSowStatus | null>(null);
    const [loadError, setLoadError] = React.useState<string | null>(null);
    const [uploadError, setUploadError] = React.useState<string | null>(null);
    const [progress, setProgress] = React.useState<number | null>(null);
    const fileInput = React.useRef<HTMLInputElement>(null);

    const refresh = React.useCallback(async () => {
        try {
            const res = await fetch(base, { credentials: "include" });
            if (!res.ok)
                throw new Error(
                    await readError(res, "Could not load the Statement of Work"),
                );
            setStatus(await res.json());
            setLoadError(null);
        } catch (e) {
            setLoadError((e as Error).message);
        }
    }, [base]);

    React.useEffect(() => {
        refresh();
    }, [refresh]);

    const upload = async (file: File) => {
        setUploadError(null);
        const problem = checkSowFile(file);
        if (problem) return setUploadError(problem);

        setProgress(0);
        try {
            const urlRes = await fetch(`${base}/upload-url`, {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ fileName: file.name }),
            });
            if (!urlRes.ok)
                throw new Error(
                    await readError(urlRes, "Could not start the upload"),
                );
            const { uploadUrl, fields } = await urlRes.json();

            await uploadToStorage(uploadUrl, fields, file, setProgress);

            const confirmRes = await fetch(`${base}/confirm`, {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ fileName: file.name }),
            });
            if (!confirmRes.ok)
                throw new Error(
                    await readError(confirmRes, "The upload could not be saved"),
                );
            await refresh();
        } catch (e) {
            setUploadError((e as Error).message);
        } finally {
            setProgress(null);
            if (fileInput.current) fileInput.current.value = "";
        }
    };

    const remove = async () => {
        if (
            !window.confirm(
                "Delete this Statement of Work? The project's leadership will be able to upload a new one.",
            )
        )
            return;
        const res = await fetch(base, {
            method: "DELETE",
            credentials: "include",
        });
        if (!res.ok)
            setUploadError(await readError(res, "Could not delete the SOW"));
        await refresh();
    };

    const sow = status?.sow;
    return (
        <Card className="mt-3" aria-label="Statement of Work">
            <CardHeader>
                <CardTitle className="flex items-center gap-2">
                    <FileTextIcon className="size-5" />
                    Statement of Work
                </CardTitle>
                <CardDescription>
                    The plan your project agreed to this semester. Horizon
                    uses it to track progress.
                </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
                {loadError ? (
                    <p className="text-sm text-destructive">{loadError}</p>
                ) : !status ? (
                    <p className="text-sm text-muted-foreground">Loading…</p>
                ) : sow ? (
                    <div className="flex flex-wrap items-center gap-3">
                        <div className="flex flex-col flex-grow">
                            <span className="font-medium">{sow.fileName}</span>
                            <span className="text-sm text-muted-foreground">
                                Uploaded by{" "}
                                {sow.uploadedByName ?? `user #${sow.uploadedBy}`}{" "}
                                on{" "}
                                {new Date(sow.uploadedAt).toLocaleDateString()}
                            </span>
                        </div>
                        <Button asChild variant="outline">
                            <a href={sow.downloadUrl} rel="noopener noreferrer">
                                <DownloadIcon />
                                Download
                            </a>
                        </Button>
                        {status.canDelete && (
                            <Button variant="destructive" onClick={remove}>
                                <Trash2Icon />
                                Delete
                            </Button>
                        )}
                    </div>
                ) : status.canUpload ? (
                    <div className="flex flex-col gap-2">
                        <p className="text-sm text-muted-foreground">
                            No SOW yet. Upload it once, as a PDF or DOCX up to
                            15 MB. It can't be replaced after upload without
                            asking an executive.
                        </p>
                        <input
                            ref={fileInput}
                            type="file"
                            accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                            className="hidden"
                            data-testid="sow-file-input"
                            onChange={(e) => {
                                const file = e.target.files?.[0];
                                if (file) upload(file);
                            }}
                        />
                        {progress === null ? (
                            <Button
                                className="max-w-max cursor-pointer"
                                onClick={() => fileInput.current?.click()}
                            >
                                <UploadIcon />
                                Upload SOW
                            </Button>
                        ) : (
                            <div className="flex flex-col gap-1">
                                <span className="text-sm">
                                    Uploading… {progress}%
                                </span>
                                <Progress
                                    value={progress}
                                    aria-label="Upload progress"
                                />
                            </div>
                        )}
                    </div>
                ) : (
                    <p className="text-sm text-muted-foreground">
                        No SOW has been uploaded yet. Your project's leadership
                        uploads it.
                    </p>
                )}
                {uploadError && (
                    <p role="alert" className="text-sm text-destructive">
                        {uploadError}
                    </p>
                )}
            </CardContent>
        </Card>
    );
}
