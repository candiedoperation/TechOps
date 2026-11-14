/**
 * Rules for project Statements of Work (T5.2), kept free of database and S3
 * calls so they can be unit tested on their own.
 */
import { FILE_SIGNATURES } from "./s3-validation";

export const SOW_MAX_BYTES = 15 * 1024 * 1024;

/** How long upload and download links stay valid. */
export const SOW_UPLOAD_URL_TTL_SECONDS = 10 * 60;
export const SOW_DOWNLOAD_URL_TTL_SECONDS = 15 * 60;

export const PDF_CONTENT_TYPE = "application/pdf";
export const DOCX_CONTENT_TYPE =
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export type SowExtension = "pdf" | "docx";

export interface SowFileType {
    extension: SowExtension;
    contentType: string;
    /** First bytes of every genuine file of this type, as hex. */
    signature: string;
}

/**
 * The only two formats a SOW may be. A DOCX is a zip archive, so it starts
 * with the zip signature "PK\x03\x04".
 */
export const SOW_FILE_TYPES: Record<SowExtension, SowFileType> = {
    pdf: {
        extension: "pdf",
        contentType: PDF_CONTENT_TYPE,
        signature: FILE_SIGNATURES.PDF,
    },
    docx: {
        extension: "docx",
        contentType: DOCX_CONTENT_TYPE,
        signature: FILE_SIGNATURES.ZIP,
    },
};

/** Finds the SOW file type for a file name, or null when it is not allowed. */
export function sowFileTypeFor(fileName: string): SowFileType | null {
    const dot = fileName.lastIndexOf(".");
    if (dot < 0) return null;
    const extension = fileName.slice(dot + 1).toLowerCase();
    return extension === "pdf" || extension === "docx"
        ? SOW_FILE_TYPES[extension]
        : null;
}

/** Where a SOW is stored: sows/{seasonYear}-{seasonType}/{projectPk}.{ext} */
export function sowS3Key(
    seasonYear: number,
    seasonType: string,
    projectPk: string,
    extension: SowExtension,
): string {
    return `sows/${seasonYear}-${seasonType}/${projectPk}.${extension}`;
}

/** True when the first bytes of a file match the expected signature. */
export function matchesSignature(
    firstBytes: Uint8Array,
    signatureHex: string,
): boolean {
    const header = Buffer.from(firstBytes).toString("hex");
    return header.startsWith(signatureHex.toLowerCase());
}

/** The subset of an Authentik team that the SOW permission rules read. */
export interface SowTeamInfo {
    users?: Array<{ pk: string | number }>;
    subteams?: Array<{
        name?: string;
        users?: Array<{ pk: string | number }>;
        attributes?: { friendlyName?: string; flaggedForDeletion?: boolean };
    }>;
}

/**
 * New project teams get a subteam named "Leadership" (TEAM_TYPE_CONFIGS).
 * Older teams named it "<Project>Lead", which the web app already shows as
 * "Project Leadership", so both spellings count.
 */
export function isLeadershipSubteamName(name: string): boolean {
    const n = name.trim().toLowerCase();
    return n === "leadership" || n.endsWith("lead");
}

const hasUser = (
    users: Array<{ pk: string | number }> | undefined,
    userPk: number,
) => (users ?? []).some((u) => Number(u.pk) === userPk);

const liveSubteams = (team: SowTeamInfo) =>
    (team.subteams ?? []).filter((s) => !s.attributes?.flaggedForDeletion);

/**
 * Is the user part of the project's leadership? That is a Team Owner (the
 * root team's own members, where the creating Project Lead is stored) or a
 * member of the Leadership subteam. Matches T3.1's project_lead rule.
 */
export function isProjectLeadership(
    team: SowTeamInfo,
    userPk: number,
): boolean {
    return (
        hasUser(team.users, userPk) ||
        liveSubteams(team).some(
            (s) =>
                isLeadershipSubteamName(
                    s.attributes?.friendlyName ?? s.name ?? "",
                ) && hasUser(s.users, userPk),
        )
    );
}

/** Is the user on the project at all (the team itself or any subteam)? */
export function isProjectMember(team: SowTeamInfo, userPk: number): boolean {
    return (
        hasUser(team.users, userPk) ||
        liveSubteams(team).some((s) => hasUser(s.users, userPk))
    );
}
