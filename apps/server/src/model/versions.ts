/** Model versions a caller may see and their element indexes (used by 4D, 5D and other model features). */
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import {
  can,
  splitExtension,
} from "@sitekeep/shared";
import type { FolderTree, ProjectAccess } from "../core/security/access.js";
import type { Db } from "../db/index.js";
import { fileVersions, files, versionIndexes } from "../db/schema.js";
import { HttpError, badRequest, notFound } from "../core/platform/http.js";
import { msg } from "../i18n/index.js";
import type { JobQueue } from "../jobs/queue.js";
import { loadIndexFile } from "../jobs/version-index.js";
import { ModelIndex } from "../model/model-index.js";
import { ensureIndexJob, ensureUpgradeJob, preparing } from "../model/service.js";
import type { Storage } from "../core/platform/storage.js";

export interface SimDeps {
  db: Db;
  storage: Storage;
  /** With a queue, a missing or old index is queued and 409 "preparing" thrown. */
  queue?: JobQueue;
}

export interface ModelVersionRef {
  versionId: string;
  fileId: string;
  fileName: string;
  version: number;
  folderId: string;
  derivativeStatus: string;
}


export function canViewFolder(tree: FolderTree, a: ProjectAccess, folderId: string): boolean {
  return tree.byId.has(folderId) && can(tree.permission(a.principal, folderId).level, "view");
}

export const versionCols = {
  versionId: fileVersions.id,
  fileId: files.id,
  fileName: files.name,
  version: fileVersions.version,
  folderId: files.folderId,
  derivativeStatus: fileVersions.derivativeStatus,
};

/** A version of an IFC file of the project that the caller can see (404 otherwise). */
export async function visibleVersion(db: Db, a: ProjectAccess, tree: FolderTree, versionId: string): Promise<ModelVersionRef> {
  const [v] = await db
    .select(versionCols)
    .from(fileVersions)
    .innerJoin(files, eq(files.id, fileVersions.fileId))
    .where(and(eq(fileVersions.id, versionId), eq(files.projectId, a.project.id), isNull(files.deletedAt)));
  if (!v || !canViewFolder(tree, a, v.folderId)) throw notFound(msg("sim:entities.modelVersion"));
  if (splitExtension(v.fileName).extension.toLowerCase() !== "ifc") throw badRequest(msg("sim:errors.notIfc", { name: v.fileName }));
  return v;
}

/** Newest version of each given file (deleted files skipped). */
export async function newestVersions(db: Db, projectId: string, fileIds: string[]): Promise<Map<string, ModelVersionRef>> {
  const out = new Map<string, ModelVersionRef>();
  if (!fileIds.length) return out;
  const rows = await db
    .select(versionCols)
    .from(fileVersions)
    .innerJoin(files, eq(files.id, fileVersions.fileId))
    .where(and(inArray(files.id, [...new Set(fileIds)]), eq(files.projectId, projectId), isNull(files.deletedAt)))
    .orderBy(desc(fileVersions.version));
  for (const r of rows) if (!out.has(r.fileId)) out.set(r.fileId, r);
  return out;
}

/** An IFC file of the project the caller can see. */
export async function visibleIfcFile(db: Db, a: ProjectAccess, tree: FolderTree, fileId: string): Promise<{ id: string; name: string }> {
  const [f] = await db
    .select({ id: files.id, name: files.name, folderId: files.folderId })
    .from(files)
    .where(and(eq(files.id, fileId), eq(files.projectId, a.project.id), isNull(files.deletedAt)));
  if (!f || !canViewFolder(tree, a, f.folderId)) throw notFound(msg("sim:entities.model"));
  if (splitExtension(f.name).extension.toLowerCase() !== "ifc") throw badRequest(msg("sim:errors.notIfc", { name: f.name }));
  return f;
}

/**
 * The detailed element index of a version. Without a queue a missing index returns null; with a
 * queue the index job is queued (or upgraded) and 409 "preparing" is thrown for the client to poll.
 */
export async function detailedIndex(deps: SimDeps, v: ModelVersionRef): Promise<ModelIndex | null> {
  const [row] = await deps.db.select().from(versionIndexes).where(eq(versionIndexes.versionId, v.versionId));
  if (!row) {
    if (!deps.queue) return null;
    await ensureIndexJob(deps.db, deps.queue, v.versionId, v.derivativeStatus, false);
    throw preparing([v.versionId]);
  }
  const index = ModelIndex.of(await loadIndexFile(deps.storage, v.versionId, row.storageKey));
  if (index.detailed || !deps.queue) return index;
  const upgrading = await ensureUpgradeJob(deps.db, deps.queue, v.versionId, row.createdAt);
  if (!upgrading) throw new HttpError(422, "index_failed", msg("sim:errors.indexUpgradeFailed"));
  throw new HttpError(409, "preparing", msg("sim:errors.indexUpgrading"), { pending: [v.versionId] });
}

/** Newest version of a programme (its activities are the rule targets). */
