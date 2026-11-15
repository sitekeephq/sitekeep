/**
 * ISO-3: unique document code per project (ISO 19650-2 §5.1.7, docs/features/DOCUMENT_CODES.md).
 *
 * - The code of a file is the part of its name (without extension) that parses against a naming
 *   standard: the folder's own (or an ancestor's), else the project's container standard
 *   (project_cde_settings.container_standard_id). A name that parses against no standard has no
 *   code and is not checked (D-5).
 * - A code (upper-cased: `code_norm`) belongs to one information container per project
 *   (document_codes). The container that uses it first registers it.
 * - The same container may use it again: a new version, a move, an approved review copy, and a
 *   rendition (same code, other extension, in the same folder as a file of the container: D-6).
 * - Any other container gets 409 with the path of the document that holds the code. A manual
 *   copy is a new container, so a copy that keeps the code is refused.
 * - Once a container has a file in a Shared (or later) folder, its coded files are not renamed;
 *   project administrators may, with a reason (audit "cde.override").
 * - The refusals (409 and the rename lock) apply only when the project enforces the ISO rules
 *   (project_cde_settings.enforce_transitions, opt-in per project: D-8). Otherwise codes are
 *   still derived and registered, renditions join their container, and a duplicate is stored
 *   with a warning in the upload result and listed as a conflict.
 * - Live data: `runDocumentCodeBackfill` registers existing codes first-come by created_at. Files
 *   that duplicate a code are not blocked retroactively (they keep their versions and moves) and
 *   are listed by `listCodeConflicts`.
 */
import { and, asc, eq, gt, inArray, isNotNull, isNull, or, type SQL } from "drizzle-orm";
import { nameFields, parseName, splitExtension, type NamingStandard, type Principal } from "@sitekeep/shared";
import type { Db } from "../db/index.js";
import { documentCodes, files, folders, namingStandards, projectCdeSettings } from "../db/schema.js";
import { FolderTree, hiddenByWipRule } from "../core/security/access.js";
import { folderPath } from "../core/security/roles.js";
import { audit } from "../core/platform/audit.js";
import { badRequest, conflict, forbidden } from "../core/platform/http.js";
import { msg } from "../i18n/index.js";
import type { DocumentCodeCheck } from "./guards.js";
import { cdeStateOf } from "./state.js";

/** Details of a 409 for a code held by another container (sent to the client). */
export interface DocumentCodeConflictDetails {
  kind: "document_code";
  code: string;
  /** Path of the document that holds the code ("Project / 01-WIP / A-001.pdf"). */
  existingPath: string;
  existingFileId: string | null;
}

/** Upper-cased code: the key of document_codes. */
export function normalizeDocumentCode(code: string): string {
  return code.trim().toUpperCase();
}

/**
 * The document code a name gives under a standard, or null when the name does not parse. With
 * `allowSuffix`, the free text after the last field is not part of the code.
 */
export function documentCodeOf(standard: NamingStandard | null, name: string): string | null {
  if (!standard) return null;
  const values = parseName(standard, name);
  if (!values) return null;
  const base = splitExtension(name.trim()).base;
  const joined = nameFields(standard)
    .map((f) => values[f.name] ?? "")
    .join(standard.delimiter);
  const code = joined && base.startsWith(joined) ? joined : base;
  return code.trim() || null;
}

/** Naming standards of a project by id, plus the container standard id. */
interface StandardSource {
  byId: Map<string, NamingStandard>;
  containerStandardId: string | null;
  /** project_cde_settings.enforce_transitions: refusals apply only when on (D-8). */
  enforce: boolean;
}

async function loadStandards(db: Db, projectId: string): Promise<StandardSource> {
  const rows = await db
    .select({ id: namingStandards.id, definition: namingStandards.definition })
    .from(namingStandards)
    .where(eq(namingStandards.projectId, projectId));
  const [settings] = await db
    .select({ id: projectCdeSettings.containerStandardId, enforce: projectCdeSettings.enforceTransitions })
    .from(projectCdeSettings)
    .where(eq(projectCdeSettings.projectId, projectId));
  return {
    byId: new Map(rows.map((r) => [r.id, r.definition as NamingStandard])),
    containerStandardId: settings?.id ?? null,
    enforce: settings?.enforce ?? false,
  };
}

function standardOf(tree: FolderTree, src: StandardSource, folderId: string): NamingStandard | null {
  const sid = (tree.byId.has(folderId) ? tree.namingStandardId(folderId) : null) ?? src.containerStandardId;
  return sid ? (src.byId.get(sid) ?? null) : null;
}

/** "Project / Folder / name.pdf". */
function pathOf(tree: FolderTree, f: { folderId: string; name: string }): string {
  const folder = tree.byId.has(f.folderId) ? folderPath(tree, f.folderId) : "…";
  return `${folder} / ${f.name}`;
}

type CodeRow = typeof documentCodes.$inferSelect;
type FileLite = { id: string; folderId: string; name: string; containerId: string; documentCode: string | null; deletedAt: Date | null };

const fileLite = {
  id: files.id,
  folderId: files.folderId,
  name: files.name,
  containerId: files.containerId,
  documentCode: files.documentCode,
  deletedAt: files.deletedAt,
};

async function codeRow(db: Db, projectId: string, norm: string): Promise<CodeRow | undefined> {
  const [row] = await db
    .select()
    .from(documentCodes)
    .where(and(eq(documentCodes.projectId, projectId), eq(documentCodes.codeNorm, norm)));
  return row;
}

/** Files of a container (live and in the trash), except `exceptId`. */
async function containerFiles(db: Db, containerId: string, exceptId?: string | null): Promise<FileLite[]> {
  const rows = await db.select(fileLite).from(files).where(eq(files.containerId, containerId));
  return rows.filter((r) => r.id !== exceptId);
}

const sameCode = (f: FileLite, norm: string) => !!f.documentCode && normalizeDocumentCode(f.documentCode) === norm;

/**
 * A new file `name` in `folderId` is a rendition of the container when a live file of the
 * container with the same code sits in the same folder with another extension (D-6).
 */
function isRendition(members: FileLite[], folderId: string, name: string, norm: string): boolean {
  const ext = splitExtension(name).extension.toLowerCase();
  return members.some(
    (m) => !m.deletedAt && m.folderId === folderId && sameCode(m, norm) && splitExtension(m.name).extension.toLowerCase() !== ext,
  );
}

async function conflictDetails(db: Db, tree: FolderTree, row: CodeRow, code: string, principal?: Principal): Promise<DocumentCodeConflictDetails> {
  const members = await containerFiles(db, row.containerId);
  const norm = row.codeNorm;
  const pick =
    members.find((m) => m.id === row.firstFileId && !m.deletedAt) ??
    members.find((m) => !m.deletedAt && sameCode(m, norm)) ??
    members.find((m) => !m.deletedAt) ??
    members[0];
  if (pick && hiddenByWipRule(tree, principal, pick.folderId)) return { kind: "document_code", code, existingPath: "…", existingFileId: null };
  const existingPath = pick ? pathOf(tree, pick) : code;
  return { kind: "document_code", code, existingPath, existingFileId: pick?.id ?? null };
}

async function conflictError(db: Db, tree: FolderTree, row: CodeRow, code: string, principal?: Principal): Promise<Error> {
  const details = await conflictDetails(db, tree, row, code, principal);
  return conflict(msg("cde:documentCode.taken", { code, path: details.existingPath }), details);
}

/** True when the container holding the row has no file at all any more (purged): the code is free. */
async function orphaned(db: Db, row: CodeRow, exceptId?: string | null): Promise<boolean> {
  return (await containerFiles(db, row.containerId, exceptId)).length === 0;
}

/**
 * Rename lock: a coded file whose container has a copy in a Shared (or later) folder keeps its
 * name; a project administrator may rename it with a reason (audit "cde.override").
 */
async function checkRename(
  db: Db,
  tree: FolderTree,
  input: DocumentCodeCheck & { reason?: string | null },
  current: FileLite,
  oldCode: string | null,
  newCode: string | null,
): Promise<void> {
  if (!oldCode || input.name === current.name) return;
  const members = [current, ...(await containerFiles(db, current.containerId, current.id))].filter((m) => !m.deletedAt);
  const shared = members.find((m) => {
    const state = cdeStateOf(tree, m.folderId);
    return state !== null && state !== "wip";
  });
  if (!shared) return;
  const access = input.access;
  if (!access?.isProjectAdmin) throw forbidden(msg("cde:documentCode.renameLocked", { path: pathOf(tree, shared) }));
  const reason = input.reason?.trim();
  if (!reason) throw badRequest(msg("cde:documentCode.renameReasonRequired"));
  await audit(db, {
    projectId: input.projectId,
    userId: access.user.id,
    action: "cde.override",
    targetType: "file",
    targetId: current.id,
    details: { rule: "document_code.rename_after_shared", from: current.name, to: input.name, fromCode: oldCode, toCode: newCode, reason },
  });
}

/** The guard behind `checkDocumentCode` (cde/guards.ts). */
export async function checkDocumentCodeImpl(db: Db, input: DocumentCodeCheck): Promise<{ documentCode: string | null }> {
  const tree = input.tree ?? (await FolderTree.load(db, input.projectId));
  const standards = await loadStandards(db, input.projectId);
  const code = documentCodeOf(standardOf(tree, standards, input.folderId), input.name);

  let current: FileLite | undefined;
  if (input.fileId) [current] = await db.select(fileLite).from(files).where(eq(files.id, input.fileId));
  if (current && input.source === "move" && standards.enforce) {
    const oldCode = current.documentCode ?? documentCodeOf(standardOf(tree, standards, current.folderId), current.name);
    await checkRename(db, tree, input as DocumentCodeCheck & { reason?: string | null }, current, oldCode, code);
  }
  if (!code) return { documentCode: null };
  const norm = normalizeDocumentCode(code);
  const containerId = input.containerId ?? current?.containerId ?? null;
  const row = await codeRow(db, input.projectId, norm);
  // Enforcement off (D-8): codes are still derived and registered, a duplicate is only recorded
  // (files.document_code) and listed as a conflict, never refused.
  const refuse = async (held: CodeRow): Promise<void> => {
    if (standards.enforce) throw await conflictError(db, tree, held, code, input.access?.principal);
  };

  if (!containerId) {
    // A new container (new file, manual copy): free code, rendition, or refused.
    if (!row) return { documentCode: code };
    if (input.source !== "copy" && isRendition(await containerFiles(db, row.containerId), input.folderId, input.name, norm))
      return { documentCode: code };
    if (await orphaned(db, row)) return { documentCode: code };
    await refuse(row);
    return { documentCode: code };
  }

  if (!row) {
    await db.insert(documentCodes).values({ projectId: input.projectId, codeNorm: norm, containerId, firstFileId: input.fileId ?? null }).onConflictDoNothing();
    const now = await codeRow(db, input.projectId, norm);
    if (now && now.containerId !== containerId) await refuse(now);
  } else if (row.containerId !== containerId) {
    // Live data: a container that already used the code before the register keeps working.
    const own = await containerFiles(db, containerId, null);
    if (!own.some((m) => sameCode(m, norm))) {
      if (!(await orphaned(db, row))) await refuse(row);
      else
        await db
          .update(documentCodes)
          .set({ containerId, firstFileId: input.fileId ?? null, createdAt: new Date() })
          .where(and(eq(documentCodes.projectId, input.projectId), eq(documentCodes.codeNorm, norm)));
    }
  }

  // A rename that changes the code frees the old one when no other file of the container uses it.
  if (current && current.documentCode) {
    const oldNorm = normalizeDocumentCode(current.documentCode);
    if (oldNorm !== norm) await releaseIfUnused(db, input.projectId, current.containerId, oldNorm, current.id);
  }
  return { documentCode: code };
}

async function releaseIfUnused(db: Db, projectId: string, containerId: string, norm: string, exceptId: string): Promise<void> {
  const others = await containerFiles(db, containerId, exceptId);
  if (others.some((m) => sameCode(m, norm))) return;
  await db
    .delete(documentCodes)
    .where(and(eq(documentCodes.projectId, projectId), eq(documentCodes.codeNorm, norm), eq(documentCodes.containerId, containerId)));
}

/**
 * Registers the code of a file just inserted as a new container (addVersion, manual copy), in
 * the caller's transaction. A rendition joins the container that holds the code (its
 * container_id changes); a code held by another container is refused (409, rolling the insert
 * back) when the project enforces the rules, and only recorded otherwise. Returns the file as
 * stored.
 */
export async function registerNewFileCode<F extends { id: string; projectId: string; folderId: string; name: string; containerId: string; documentCode: string | null }>(
  db: Db,
  file: F,
  source: DocumentCodeCheck["source"],
  /** The caller: a holder in a WIP folder closed to them is not named (ISO-5). */
  principal?: Principal,
): Promise<F> {
  if (!file.documentCode) return file;
  const norm = normalizeDocumentCode(file.documentCode);
  await db
    .insert(documentCodes)
    .values({ projectId: file.projectId, codeNorm: norm, containerId: file.containerId, firstFileId: file.id })
    .onConflictDoNothing();
  const row = await codeRow(db, file.projectId, norm);
  if (!row || row.containerId === file.containerId) return file;
  if (source !== "copy" && isRendition(await containerFiles(db, row.containerId, file.id), file.folderId, file.name, norm)) {
    const [joined] = await db.update(files).set({ containerId: row.containerId }).where(eq(files.id, file.id)).returning();
    return { ...file, containerId: joined!.containerId };
  }
  if (await orphaned(db, row, file.id)) {
    await db
      .update(documentCodes)
      .set({ containerId: file.containerId, firstFileId: file.id, createdAt: new Date() })
      .where(and(eq(documentCodes.projectId, file.projectId), eq(documentCodes.codeNorm, norm)));
    return file;
  }
  const [settings] = await db
    .select({ enforce: projectCdeSettings.enforceTransitions })
    .from(projectCdeSettings)
    .where(eq(projectCdeSettings.projectId, file.projectId));
  if (!settings?.enforce) return file;
  throw await conflictError(db, await FolderTree.load(db, file.projectId), row, file.documentCode, principal);
}

/**
 * A non-blocking warning for a stored file whose code is registered to another document (the
 * project does not enforce the rules, or the file is a duplicate from before ISO-3); null when
 * the code is its own or it has none. Shown per file in the upload results.
 */
export async function documentCodeWarning(
  db: Db,
  file: { projectId: string; containerId: string; documentCode: string | null },
  /** The caller: a holder in a WIP folder closed to them is not named (ISO-5). */
  principal?: Principal,
): Promise<DocumentCodeConflictDetails | null> {
  if (!file.documentCode) return null;
  const row = await codeRow(db, file.projectId, normalizeDocumentCode(file.documentCode));
  if (!row || row.containerId === file.containerId) return null;
  return conflictDetails(db, await FolderTree.load(db, file.projectId), row, file.documentCode, principal);
}

// ---- Live data ----------------------------------------------------------------------------------

export interface DocumentCodeBackfillReport {
  /** Files that got a document code. */
  filesCoded: number;
  /** Codes registered. */
  codesRegistered: number;
}

/**
 * Codes the existing files and registers them, first come (created_at) first served. Idempotent
 * and batched: only live files without a code are read, in projects that have a naming
 * standard; a code that is already registered is left with its container (the file is then a
 * conflict, listed by `listCodeConflicts`).
 */
export async function runDocumentCodeBackfill(
  db: Db,
  opts: { batchSize?: number; log?: (line: string) => void; projectId?: string } = {},
): Promise<DocumentCodeBackfillReport> {
  const batchSize = Math.max(1, opts.batchSize ?? 1000);
  const log = opts.log ?? (() => undefined);
  const withFolders = await db
    .selectDistinct({ id: folders.projectId })
    .from(folders)
    .where(and(isNotNull(folders.namingStandardId), isNull(folders.deletedAt)));
  const withContainer = await db
    .select({ id: projectCdeSettings.projectId })
    .from(projectCdeSettings)
    .where(isNotNull(projectCdeSettings.containerStandardId));
  let projectIds = [...new Set([...withFolders, ...withContainer].map((p) => p.id))];
  if (opts.projectId) projectIds = projectIds.filter((id) => id === opts.projectId);

  const report: DocumentCodeBackfillReport = { filesCoded: 0, codesRegistered: 0 };
  for (const projectId of projectIds) {
    const tree = await FolderTree.load(db, projectId);
    const standards = await loadStandards(db, projectId);
    let cursor: { createdAt: Date; id: string } | null = null;
    for (;;) {
      const base = and(eq(files.projectId, projectId), isNull(files.deletedAt), isNull(files.documentCode));
      const where: SQL | undefined = cursor
        ? and(base, or(gt(files.createdAt, cursor.createdAt), and(eq(files.createdAt, cursor.createdAt), gt(files.id, cursor.id))))
        : base;
      const batch: { id: string; folderId: string; name: string; containerId: string; createdAt: Date }[] = await db
        .select({ id: files.id, folderId: files.folderId, name: files.name, containerId: files.containerId, createdAt: files.createdAt })
        .from(files)
        .where(where)
        .orderBy(asc(files.createdAt), asc(files.id))
        .limit(batchSize);
      if (!batch.length) break;
      cursor = { createdAt: batch[batch.length - 1]!.createdAt, id: batch[batch.length - 1]!.id };
      const coded = batch
        .map((f) => ({ ...f, code: documentCodeOf(standardOf(tree, standards, f.folderId), f.name) }))
        .filter((f): f is typeof f & { code: string } => !!f.code);
      for (const f of coded) {
        await db.update(files).set({ documentCode: f.code }).where(eq(files.id, f.id));
        const inserted = await db
          .insert(documentCodes)
          .values({ projectId, codeNorm: normalizeDocumentCode(f.code), containerId: f.containerId, firstFileId: f.id, createdAt: f.createdAt })
          .onConflictDoNothing()
          .returning({ code: documentCodes.codeNorm });
        report.filesCoded++;
        report.codesRegistered += inserted.length;
      }
      if (batch.length < batchSize) break;
    }
    log(`document codes: project ${projectId}`);
  }
  log(`document codes: ${report.filesCoded} files coded, ${report.codesRegistered} codes registered`);
  return report;
}

/** Runs the backfill at server start; a failure is logged, never fatal. */
export async function backfillDocumentCodesAtStart(db: Db, log: (line: string, err?: unknown) => void): Promise<void> {
  try {
    const r = await runDocumentCodeBackfill(db);
    if (r.filesCoded) log(`document codes: ${r.filesCoded} files coded, ${r.codesRegistered} codes registered`);
  } catch (err) {
    log("document code backfill failed", err);
  }
}

// ---- Conflicts list -----------------------------------------------------------------------------

export interface CodeConflictFile {
  fileId: string;
  name: string;
  path: string;
  folderId: string;
  containerId: string;
  createdAt: string;
}

export interface CodeConflict {
  code: string;
  /** The document that holds the code (null when its container has no live file). */
  holder: CodeConflictFile | null;
  /** Live files with the code that belong to other containers. */
  others: CodeConflictFile[];
}

/** Live files whose code is registered to another container (duplicates from before ISO-3). */
export async function listCodeConflicts(db: Db, projectId: string, principal?: Principal): Promise<CodeConflict[]> {
  const coded = await db
    .select({ ...fileLite, createdAt: files.createdAt })
    .from(files)
    .where(and(eq(files.projectId, projectId), isNull(files.deletedAt), isNotNull(files.documentCode)))
    .orderBy(asc(files.createdAt), asc(files.id));
  if (!coded.length) return [];
  const byNorm = new Map<string, typeof coded>();
  for (const f of coded) {
    const norm = normalizeDocumentCode(f.documentCode!);
    const list = byNorm.get(norm) ?? [];
    list.push(f);
    byNorm.set(norm, list);
  }
  const candidates = [...byNorm.entries()].filter(([, list]) => new Set(list.map((f) => f.containerId)).size > 1);
  const norms = candidates.map(([n]) => n);
  const rows: CodeRow[] = [];
  for (let i = 0; i < norms.length; i += 500)
    rows.push(
      ...(await db
        .select()
        .from(documentCodes)
        .where(and(eq(documentCodes.projectId, projectId), inArray(documentCodes.codeNorm, norms.slice(i, i + 500))))),
    );
  const registered = new Map(rows.map((r) => [r.codeNorm, r]));
  const tree = await FolderTree.load(db, projectId);
  const dto = (f: (typeof coded)[number]): CodeConflictFile => ({
    fileId: f.id,
    name: f.name,
    path: pathOf(tree, f),
    folderId: f.folderId,
    containerId: f.containerId,
    createdAt: f.createdAt.toISOString(),
  });
  const out: CodeConflict[] = [];
  for (const [norm, all] of candidates) {
    // ISO-5: files in a task team's WIP closed to the caller (admin_sees_wip off) are left out.
    const list = all.filter((f) => !hiddenByWipRule(tree, principal, f.folderId));
    if (!list.length) continue;
    const row = registered.get(norm);
    const holderContainer = row?.containerId ?? list[0]!.containerId;
    const others = list.filter((f) => f.containerId !== holderContainer);
    if (!others.length) continue;
    const holders = list.filter((f) => f.containerId === holderContainer);
    const holder = holders.find((f) => f.id === row?.firstFileId) ?? holders[0] ?? null;
    out.push({ code: holder?.documentCode ?? others[0]!.documentCode!, holder: holder ? dto(holder) : null, others: others.map(dto) });
  }
  return out.sort((a, b) => a.code.localeCompare(b.code));
}
