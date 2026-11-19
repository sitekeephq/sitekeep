/**
 * Full project export and restore (docs/features/PROJECT_EXPORT.md): a ZIP with the folder tree,
 * every version of every file with its codes and SHA-256, issues as BCF 3.0, reviews, transmittals,
 * the audit log, members, roles, task teams and folder permissions, a manifest and a checksum list;
 * and the restore of such a package as a new project in another SiteKeep installation.
 */
import type { CloseoutManifestEntry } from "./closeout.js";

/** Version of the package format (manifest.json `schema`); bump when a field changes meaning or is removed. */
export const PROJECT_EXPORT_SCHEMA = "sitekeep.project-export/1";

/**
 * `full`: everything in the project (system administrators); `visible`: what the person who asked
 * can see (folder permissions and the task-team WIP rule, works visibility, the audit log screen).
 */
export type ProjectExportScope = "full" | "visible";

export type ProjectTransferStatus = "queued" | "running" | "done" | "failed" | "expired";

export interface ProjectExportCounts {
  folders: number;
  files: number;
  versions: number;
  bytes: number;
  issues: number;
  reviews: number;
  transmittals: number;
  members: number;
  roles: number;
  auditRows: number;
  /** Versions missing from the storage or not matching their stored SHA-256. */
  problems: number;
}

export interface ProjectExportDto {
  id: string;
  status: ProjectTransferStatus;
  scope: ProjectExportScope;
  requestedBy: { id: string | null; name: string | null };
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  filesTotal: number;
  filesDone: number;
  bytesTotal: number;
  bytesDone: number;
  counts: ProjectExportCounts | null;
  /** Size and SHA-256 of the ZIP itself (done). */
  size: number | null;
  sha256: string | null;
  error: string | null;
  expiresAt: string | null;
}

export interface ProjectExportStateDto {
  /** The scope a new export of the caller would have. */
  scope: ProjectExportScope;
  exports: ProjectExportDto[];
  limits: { maxBytes: number | null; retentionDays: number };
  /** What a new export of the caller would hold (files, versions, bytes). */
  estimate: { files: number; versions: number; bytes: number };
}

/** The restore report: what came in, and what could not be matched in this installation. */
export interface ProjectImportReport {
  source: { projectId: string; code: string; name: string; schema: string; generatedAt: string; scope: ProjectExportScope; generator: string };
  counts: { folders: number; files: number; versions: number; bytes: number; issues: number; members: number; roles: number; grants: number; supersessions: number };
  /** People of the package without an account here (matched by e-mail): not created, listed only. */
  unknownUsers: { email: string; name: string | null }[];
  /** Companies without a match here (by code, then name): memberships and permissions keep no company. */
  unknownCompanies: { name: string; code: string | null }[];
  /** Folder permissions left out because their user, company or role has no match. */
  skippedGrants: number;
  /** Versions listed in the package without their bytes (missing at export time). */
  missingVersions: { path: string | null; fileId: string; version: number }[];
  warnings: string[];
}

export interface ProjectImportDto {
  id: string;
  status: ProjectTransferStatus;
  fileName: string | null;
  requestedBy: { id: string | null; name: string | null };
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** Size and SHA-256 of the uploaded package. */
  size: number | null;
  sha256: string | null;
  /** Code and name the new project gets. */
  code: string;
  name: string | null;
  /** The new project (done). */
  projectId: string | null;
  /** verify = checking every checksum, import = writing the project. */
  phase: "verify" | "import" | null;
  filesTotal: number;
  filesDone: number;
  report: ProjectImportReport | null;
  error: string | null;
}

// ---- Package contents (docs/features/PROJECT_EXPORT.md#format) ----------------------------------

export interface ExportPerson {
  id: string;
  email: string | null;
  name: string | null;
}

/** manifest.json */
export interface ProjectExportManifest {
  schema: typeof PROJECT_EXPORT_SCHEMA;
  generatedAt: string;
  generator: { product: string; version: string };
  project: { id: string; code: string; name: string };
  exportedBy: ExportPerson | null;
  scope: ProjectExportScope;
  counts: ProjectExportCounts;
  /** Paths of the parts of the package. */
  contents: {
    project: string;
    folders: string;
    files: string;
    members: string;
    reviews: string;
    transmittals: string;
    supersessions: string;
    issues: string[];
    auditCsv: string;
    auditJson: string;
  };
  /** Every other entry of the ZIP (all but manifest.json and SHA256SUMS) with its size and SHA-256. */
  checksums: { path: string; size: number; sha256: string }[];
}

/** One version in files.json: the close-out manifest entry plus what a restore needs. */
export interface ExportVersionEntry extends Omit<CloseoutManifestEntry, "cdeState"> {
  /** Effective CDE state of the folder; null when no folder up to the root has one. */
  cdeState: string | null;
  uploadedByEmail: string | null;
  comment: string | null;
  codesSetByEmail: string | null;
  codesSetAt: string | null;
}

/** One file in files.json. */
export interface ExportFileEntry {
  id: string;
  folderId: string;
  folderPath: string;
  name: string;
  description: string | null;
  attributes: Record<string, string>;
  documentCode: string | null;
  containerId: string;
  cdeState: string | null;
  cdeStatus: string | null;
  currentVersion: number;
  createdBy: ExportPerson | null;
  createdAt: string;
  versions: ExportVersionEntry[];
}

export interface ExportFolderEntry {
  id: string;
  parentId: string | null;
  /** Path from the project root (root = ""). */
  path: string;
  name: string;
  description: string | null;
  /** The folder's own state; `cdeState` is the effective one (own or nearest ancestor's). */
  state: string | null;
  cdeState: string | null;
  stateLabel: string | null;
  namingStandardId: string | null;
  ownerTeamId: string | null;
  requireApprovedReview: boolean;
  createdAt: string;
  /** Folder permissions; subjects are ids in members.json (user, company or role). */
  grants: { subjectType: "user" | "company" | "role"; subjectId: string; level: string }[];
}
