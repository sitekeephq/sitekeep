/**
 * ISO 19650-2 §5.8.1 project close-out archive (docs/features/CLOSEOUT_ARCHIVE.md): a ZIP of the
 * project's Published and Archived information with a metadata manifest, the audit log and the
 * chain check, built in the job queue; and the closed (read-only) project.
 */
import type { AuditVerifyDto } from "../core/types.js";

/** Version of manifest.json; bump when a field changes meaning or is removed. */
export const CLOSEOUT_MANIFEST_SCHEMA = "sitekeep.closeout-manifest/1";

export type CloseoutVersions = "latest" | "all";

export interface CloseoutOptions {
  /** Shared information too (default: Published and Archived only). */
  includeShared: boolean;
  /** Every version of each file, or the current one only. */
  versions: CloseoutVersions;
  /** Mark the project as closed (read-only) when the archive is built. */
  closeProject: boolean;
}

export type CloseoutStatus = "queued" | "running" | "done" | "failed" | "expired";

export interface CloseoutArchiveDto {
  id: string;
  status: CloseoutStatus;
  options: CloseoutOptions;
  requestedBy: { id: string | null; name: string | null };
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  filesTotal: number;
  filesDone: number;
  bytesTotal: number;
  bytesDone: number;
  /** Size and SHA-256 of the ZIP itself (done). */
  size: number | null;
  sha256: string | null;
  /** Audit chain check at the time of the archive (done). */
  auditChain: Pick<AuditVerifyDto, "ok" | "checked" | "head" | "broken"> | null;
  /** Versions whose stored bytes were missing or did not match the stored SHA-256 (listed in the manifest). */
  problems: number;
  error: string | null;
  /** The download link stops working after this time and the file is deleted. */
  expiresAt: string | null;
}

export interface CloseoutStateDto {
  closed: boolean;
  closedAt: string | null;
  closedBy: { id: string | null; name: string | null } | null;
  archives: CloseoutArchiveDto[];
  limits: { maxBytes: number | null; retentionDays: number };
  /** What a new archive would hold now (files and bytes), per option. */
  estimate: { latest: CloseoutEstimate; all: CloseoutEstimate; sharedLatest: CloseoutEstimate; sharedAll: CloseoutEstimate };
}

export interface CloseoutEstimate {
  files: number;
  versions: number;
  bytes: number;
}

/** One version in manifest.json (and one row of manifest.csv). */
export interface CloseoutManifestEntry {
  /** Path inside the ZIP. */
  path: string;
  fileId: string;
  versionId: string;
  version: number;
  latest: boolean;
  name: string;
  folderPath: string;
  documentCode: string | null;
  containerId: string;
  revision: string | null;
  suitability: string | null;
  cdeState: string;
  /** returned / superseded / withdrawn, when the file carries one. */
  cdeStatus: string | null;
  size: number;
  /** SHA-256 stored when the version was uploaded. */
  sha256: string;
  /** "ok" = the bytes put in the ZIP hash to the stored value; "mismatch"; "missing" = not in the ZIP. */
  integrity: "ok" | "mismatch" | "missing";
  uploadedBy: string | null;
  uploadedAt: string;
  approvals: CloseoutApproval[];
  /** ISO-12 (cde_supersessions): the versions that replaced this one, and the ones it replaced. */
  supersededBy: CloseoutVersionRef[];
  supersedes: CloseoutVersionRef[];
  /** Check of the file name against the folder's naming standard; null when none applies. */
  naming: { standard: string; ok: boolean; errors: string[] } | null;
}

export interface CloseoutApproval {
  reviewId: string;
  review: string;
  workflow: string | null;
  /** "reviewed": this version went through the review; "result": it is the approved copy the review made. */
  role: "reviewed" | "result";
  outcome: string | null;
  outcomeLabel: string | null;
  decidedAt: string | null;
  steps: { step: number; by: string | null; outcome: string; at: string; comment: string | null }[];
}

export interface CloseoutVersionRef {
  fileId: string;
  versionId: string;
  version: number;
  revision: string | null;
  /** Path inside the ZIP when that version is in the archive too. */
  path: string | null;
}
