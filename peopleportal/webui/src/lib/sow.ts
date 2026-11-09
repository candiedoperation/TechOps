/**
 * Statement of Work upload helpers (T5.2), shared by ProjectSowCard and its
 * tests. Kept out of the component file so React fast refresh keeps working.
 */

/** Sends the file straight to storage, reporting progress from 0 to 100. */
export type StorageUploader = (
    uploadUrl: string,
    fields: Record<string, string>,
    file: File,
    onProgress: (percent: number) => void,
) => Promise<void>;

export const SOW_MAX_BYTES = 15 * 1024 * 1024;
const ALLOWED_EXTENSIONS = [".pdf", ".docx"];

/** Presigned POST upload with progress (fetch cannot report upload progress). */
export const xhrStorageUploader: StorageUploader = (
    uploadUrl,
    fields,
    file,
    onProgress,
) =>
    new Promise((resolve, reject) => {
        const form = new FormData();
        Object.entries(fields).forEach(([k, v]) => form.append(k, v));
        form.append("file", file); /* S3 requires the file last */

        const xhr = new XMLHttpRequest();
        xhr.open("POST", uploadUrl);
        xhr.upload.onprogress = (e) => {
            if (e.lengthComputable)
                onProgress(Math.round((e.loaded / e.total) * 100));
        };
        xhr.onload = () =>
            xhr.status >= 200 && xhr.status < 300
                ? resolve()
                : reject(new Error("The file could not be uploaded to storage"));
        xhr.onerror = () =>
            reject(new Error("The file could not be uploaded to storage"));
        xhr.send(form);
    });

/** Returns a problem with the chosen file, or null when it can be uploaded. */
export function checkSowFile(file: File): string | null {
    const name = file.name.toLowerCase();
    if (!ALLOWED_EXTENSIONS.some((ext) => name.endsWith(ext)))
        return "The SOW must be a PDF or DOCX file.";
    if (file.size === 0) return "That file is empty.";
    if (file.size > SOW_MAX_BYTES) return "The SOW must be 15 MB or smaller.";
    return null;
}
