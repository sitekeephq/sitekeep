/**
 * Loading element indexes for "Modele sor" and the detailed comparison, with the index jobs that
 * create or upgrade them (versions indexed before format 2 get a background re-index).
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { splitExtension } from "@sitekeep/shared";
import type { Db } from "../db/index.js";
import { jobs, versionIndexes, type fileVersions } from "../db/schema.js";
import { HttpError, badRequest } from "../core/platform/http.js";
import { GEOMETRY_REVISION, derivativeCircleSegments, derivativeRevision, type JobQueue } from "../jobs/queue.js";
import { loadIndexFile, MODEL_INDEX_FORMAT } from "../jobs/version-index.js";
import type { Storage } from "../core/platform/storage.js";
import { loadVersion, requireView } from "../modules/documents/files.js";
import { ModelIndex } from "./model-index.js";
import { msg, type Msg } from "../i18n/index.js";

type User = Parameters<typeof loadVersion>[3];
export type LoadedVersion = Awaited<ReturnType<typeof loadVersion>>;

/** A visible IFC version (404 when hidden, 400 when not IFC). */
export async function ifcVersion(db: Db, pid: string, vid: string, user: User): Promise<LoadedVersion> {
  const v = await loadVersion(db, pid, vid, user);
  requireView(v.tree, v.a, v.file);
  if (splitExtension(v.file.name).extension.toLowerCase() !== "ifc")
    throw badRequest(msg("model:errors.notIfc", { name: v.file.name }));
  return v;
}

const forVersion = (versionId: string) => sql`${jobs.payload}->>'versionId' = ${versionId}`;

/**
 * Makes sure an index for the version is on its way. New versions get one with their viewer
 * conversion; older versions (before comparison existed) get a backfill job.
 */
export async function ensureIndexJob(db: Db, queue: JobQueue, versionId: string, derivativeStatus: string, rebuild: boolean): Promise<void> {
  const active = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(inArray(jobs.kind, ["ifc_to_frag", "ifc_index"]), inArray(jobs.status, ["queued", "running"]), forVersion(versionId)))
    .limit(1);
  if (active.length || derivativeStatus === "pending" || derivativeStatus === "processing") return;
  const [last] = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.kind, "ifc_index"), forVersion(versionId)))
    .orderBy(desc(jobs.createdAt))
    .limit(1);
  if (last?.status === "failed" && !rebuild)
    throw new HttpError(422, "index_failed", msg("model:errors.indexFailed", { detail: last.error ?? msg("model:errors.unknownError") }), {
      versionId,
    });
  await queue.enqueue("ifc_index", { versionId });
}

/**
 * Upgrades an old-format index in the background. Returns false when an upgrade already ran (or
 * failed) after the index was written, so a model that cannot be upgraded is not re-queued forever.
 */
export async function ensureUpgradeJob(db: Db, queue: JobQueue, versionId: string, indexCreatedAt: Date): Promise<boolean> {
  const active = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(inArray(jobs.kind, ["ifc_to_frag", "ifc_index"]), inArray(jobs.status, ["queued", "running"]), forVersion(versionId)))
    .limit(1);
  if (active.length) return true;
  const [last] = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.kind, "ifc_index"), forVersion(versionId)))
    .orderBy(desc(jobs.createdAt))
    .limit(1);
  if (last && last.createdAt > indexCreatedAt) return false;
  await queue.enqueue("ifc_index", { versionId, upgrade: true });
  return true;
}

/**
 * Rebuilds a viewer derivative built with coarser curves or an older conversion (GEOMETRY_REVISION)
 * than the queue uses now, in place (the
 * current file is served until the new one replaces it). Queued at most once: not while a
 * conversion for the version is active, and not again after an upgrade of it failed.
 */
export async function ensureGeometryUpgrade(db: Db, queue: JobQueue, version: typeof fileVersions.$inferSelect): Promise<boolean> {
  if (version.derivativeStatus !== "ready" || !version.derivativeKey) return false;
  const current =
    derivativeCircleSegments(version.ifcSummary) >= queue.circleSegments && derivativeRevision(version.ifcSummary) >= GEOMETRY_REVISION;
  if (current) return false;
  const [last] = await db
    .select({ status: jobs.status, payload: jobs.payload })
    .from(jobs)
    .where(and(inArray(jobs.kind, ["ifc_to_frag", "ifc_index"]), forVersion(version.id)))
    .orderBy(desc(jobs.createdAt))
    .limit(1);
  if (last && (last.status === "queued" || last.status === "running")) return true;
  if (last?.status === "failed" && (last.payload as { upgrade?: boolean }).upgrade) return false;
  await queue.enqueue("ifc_to_frag", { versionId: version.id, upgrade: true });
  return true;
}

export interface IndexDeps {
  db: Db;
  storage: Storage;
  queue: JobQueue;
}

/**
 * The element index of a version. Missing → a job is queued and 409 "preparing" is thrown (the
 * client polls). `detail`: an old-format index is upgraded the same way.
 */
export async function versionModelIndex(
  deps: IndexDeps,
  v: LoadedVersion,
  opts: { detail: boolean; rebuild?: boolean },
): Promise<{ index: ModelIndex; upgrading: boolean }> {
  const [row] = await deps.db.select().from(versionIndexes).where(eq(versionIndexes.versionId, v.version.id));
  if (!row) {
    await ensureIndexJob(deps.db, deps.queue, v.version.id, v.version.derivativeStatus, !!opts.rebuild);
    throw preparing([v.version.id]);
  }
  const file = await loadIndexFile(deps.storage, v.version.id, row.storageKey);
  const index = ModelIndex.of(file);
  if (index.detailed) return { index, upgrading: false };
  const upgrading = await ensureUpgradeJob(deps.db, deps.queue, v.version.id, row.createdAt);
  if (opts.detail) {
    if (!upgrading)
      throw new HttpError(422, "index_failed", msg("model:errors.indexUpgradeFailed"), {
        versionId: v.version.id,
      });
    throw preparing([v.version.id], msg("model:errors.indexUpgrading"));
  }
  return { index, upgrading };
}

/**
 * Quantities need the openings read from the geometry (OPENINGS_FORMAT). An index written before
 * that is rebuilt once; true while that runs. False when it cannot (the rebuild already ran or
 * failed): the inventory then falls back to the model's own gross − net.
 */
export async function ensureOpeningsIndex(db: Db, queue: JobQueue, versionId: string, index: ModelIndex): Promise<boolean> {
  if (index.hasOpenings) return false;
  const [row] = await db.select({ createdAt: versionIndexes.createdAt }).from(versionIndexes).where(eq(versionIndexes.versionId, versionId));
  return !!row && (await ensureUpgradeJob(db, queue, versionId, row.createdAt));
}

export function preparing(pending: string[], message: Msg | string = msg("model:errors.indexPreparing")): HttpError {
  return new HttpError(409, "preparing", message, { pending });
}

/** Index of a version for report datasets (no request user; access checked by the caller). */
export async function indexForVersionId(db: Db, storage: Storage, versionId: string): Promise<ModelIndex | null> {
  const [row] = await db.select().from(versionIndexes).where(eq(versionIndexes.versionId, versionId));
  if (!row) return null;
  return ModelIndex.of(await loadIndexFile(storage, versionId, row.storageKey));
}

export { MODEL_INDEX_FORMAT };
