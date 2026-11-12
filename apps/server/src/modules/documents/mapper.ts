import path from "node:path";
import { splitExtension, type FileDto, type FileVersionDto } from "@sitekeep/shared";
import { fileVersions, files } from "../../db/schema.js";

type FileRow = typeof files.$inferSelect;
type VersionRow = typeof fileVersions.$inferSelect;

export function cleanFileName(raw: string): string {
  const base = path.basename(raw.replace(/\\/g, "/")).trim();
  if (!base || base === "." || base === ".." || /[<>:"|?*\x00-\x1f]/.test(base)) return "";
  return base.normalize("NFC");
}

export function toVersionDto(v: VersionRow, names: Map<string, string>): FileVersionDto {
  return {
    id: v.id,
    fileId: v.fileId,
    version: v.version,
    size: v.size,
    sha256: v.sha256,
    uploadedBy: v.uploadedBy ?? "",
    uploadedByName: v.uploadedBy ? names.get(v.uploadedBy) : undefined,
    uploadedAt: v.uploadedAt.toISOString(),
    comment: v.comment,
    derivativeStatus: v.derivativeStatus,
    derivativeError: v.derivativeError,
    ifcSummary: v.ifcSummary,
  };
}

export function toFileDto(f: FileRow, v: VersionRow, names: Map<string, string>): FileDto {
  return {
    id: f.id,
    folderId: f.folderId,
    name: f.name,
    description: f.description ?? null,
    extension: splitExtension(f.name).extension.toLowerCase(),
    currentVersion: f.currentVersion,
    attributes: f.attributes,
    createdAt: f.createdAt.toISOString(),
    createdBy: f.createdBy ?? "",
    latest: toVersionDto(v, names),
  };
}
