/**
 * ISO 19650 CDE guards (docs/features/CDE_STATES.md): the single place where the write paths ask
 * "may this happen?". Every write path calls them once:
 *
 *   checkUpload        addVersion (upload route, OpenCDE completion, modules), manual copy,
 *                      approved review copy, OpenCDE upload page (before any byte is sent)
 *   checkMove          moving a file to another folder (PATCH /files/:id)
 *   checkCodes         addVersion and the approved review copy: suitability / revision codes
 *   checkDocumentCode  addVersion, manual copy, rename / move, review copy: unique document code
 *
 * Foundation: they allow everything and change nothing, so behaviour is unchanged. The
 * follow-up work fills them in place: transitions (ISO-1: checkUpload, checkMove), codes (ISO-2:
 * checkCodes), unique codes (ISO-3: checkDocumentCode), task teams (ISO-5). A guard refuses by
 * throwing an HttpError (core/platform/http.ts) with a `cde:` message.
 *
 * `db` may be a transaction handle: addVersion calls checkCodes and checkDocumentCode inside its
 * transaction, so a registration they make is rolled back with the version.
 */
import type { CdeState } from "@sitekeep/shared";
import type { FolderTree, ProjectAccess } from "../core/security/access.js";
import type { Db } from "../db/index.js";

/** Which write path is asking. */
export type CdeWriteSource =
  /** Upload route of the Documents page (new file or new version). */
  | "upload"
  /** OpenCDE Documents API / upload page. */
  | "opencde"
  /** Moving or renaming a file (PATCH /files/:id). */
  | "move"
  /** "Copy to" on a file: a new document. */
  | "copy"
  /** Copy of an approved version into the review's target folder (system). */
  | "review_copy"
  /** A module or another core path calling addVersion without saying which. */
  | "other";

interface GuardBase {
  projectId: string;
  /** The caller; null for system work (review copy on approval). */
  access: ProjectAccess | null;
  /** The project's folder tree when the caller has it (saves a load). */
  tree?: FolderTree;
  source: CdeWriteSource;
  /** Language of the caller, for messages. */
  lang?: string;
}

export interface UploadCheck extends GuardBase {
  folderId: string;
  name: string;
  /** The file that gets a new version; null or missing: a new document. */
  existingFileId?: string | null;
}

/** May a document be written into `folderId` (a new file, or a new version of `existingFileId`)? */
export async function checkUpload(_db: Db, _input: UploadCheck): Promise<void> {
  // ISO-1: transition `null → state` (new document) or the folder's own state (new version).
}

export interface MoveCheck extends GuardBase {
  fileId: string;
  fromFolderId: string;
  toFolderId: string;
  /** Reason given by the person (transitions that require one). */
  reason?: string | null;
}

/** May a file be moved from one folder to another? (A state change is a transition.) */
export async function checkMove(_db: Db, _input: MoveCheck): Promise<void> {
  // ISO-1: transition `from folder state → to folder state` with mode `direct`.
}

/** Suitability and revision codes of a version (D-1). */
export interface CdeCodes {
  suitabilityCode: string | null;
  revisionCode: string | null;
}

export interface CodesCheck extends GuardBase {
  folderId: string;
  /** The file that gets a new version; null: a new document. */
  fileId: string | null;
  /** Codes asked for (null or missing: none given). */
  requested: Partial<CdeCodes>;
  /** Codes of the file's current version, when there is one. */
  previous?: CdeCodes | null;
  /** State of the target folder. */
  state?: CdeState | null;
}

/** Checks (and normalises) the codes of a new version; the result is stored on the version. */
export async function checkCodes(_db: Db, input: CodesCheck): Promise<CdeCodes> {
  // ISO-2: profile of the project (iso_uk_na / legacy_r / custom), state rules, revision order.
  return {
    suitabilityCode: input.requested.suitabilityCode ?? null,
    revisionCode: input.requested.revisionCode ?? null,
  };
}

export interface DocumentCodeCheck extends GuardBase {
  folderId: string;
  /** The name the file will have. */
  name: string;
  /** The file being written; null: a new file. */
  fileId: string | null;
  /** Container the file belongs to (or will belong to); null: a new container. */
  containerId: string | null;
}

/**
 * The unique document code of a file (D-5, D-6), or null when the name gives none. Refuses a
 * code that belongs to another container. The result is stored in files.document_code.
 */
export async function checkDocumentCode(db: Db, input: DocumentCodeCheck): Promise<{ documentCode: string | null }> {
  return (await import("./document-code.js")).checkDocumentCodeImpl(db, input);
}
