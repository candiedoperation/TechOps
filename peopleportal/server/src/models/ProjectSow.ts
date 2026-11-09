import { Schema, model, Document } from "mongoose";

/**
 * A project's Statement of Work for one semester (T5.2).
 *
 * There is at most one per project per semester: the unique index below makes
 * the database itself refuse a second one, even if two uploads race. To fix a
 * wrong upload, an executive deletes this record and the lead uploads again.
 */
export interface IProjectSow extends Document {
    sowId: string;
    /** Authentik group PK of the project team */
    projectPk: string;
    seasonType: string;
    seasonYear: number;
    /** The name of the file as the uploader had it */
    fileName: string;
    contentType: string;
    s3Key: string;
    sizeBytes: number;
    /** Hex SHA-256 of the file, so Horizon can tell whether it changed */
    sha256: string;
    /** Authentik user PK of the uploader */
    uploadedBy: number;
    /** The uploader's display name when they uploaded, for the web card */
    uploadedByName?: string;
    uploadedAt: Date;
}

const ProjectSowSchema = new Schema<IProjectSow>({
    sowId: { type: String, required: true, unique: true },
    projectPk: { type: String, required: true },
    seasonType: { type: String, required: true },
    seasonYear: { type: Number, required: true },
    fileName: { type: String, required: true },
    contentType: { type: String, required: true },
    s3Key: { type: String, required: true },
    sizeBytes: { type: Number, required: true },
    sha256: { type: String, required: true },
    uploadedBy: { type: Number, required: true },
    uploadedByName: { type: String },
    uploadedAt: { type: Date, required: true, default: () => new Date() },
});

ProjectSowSchema.index(
    { projectPk: 1, seasonType: 1, seasonYear: 1 },
    { unique: true },
);
/* Horizon lists every SOW of one semester. */
ProjectSowSchema.index({ seasonType: 1, seasonYear: 1 });

export const ProjectSow = model<IProjectSow>("ProjectSow", ProjectSowSchema);
