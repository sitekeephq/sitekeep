/**
 * Start-up work for model formats a module converts (docs/features/MODEL_FORMATS.md):
 *
 * - `queueModelBackfill`: versions of model files that have no viewer derivative because no module converted their format when they were
 * uploaded (an .rvt stored before Connect 0.5.0, or before the licence turned Connect on). At start-up they are
 * queued once: status "pending" + an ifc_to_frag job each; the queue converts them one at a time, the current
 * version of each file first, so every file opens before its history is done. Running it again finds nothing new:
 *   only status "none" is picked up.
 * - `queueModelReconversion`: versions converted by another converter version than the one installed now (a new
 *   rvt-rs) are converted again, and failed versions are retried, once per converter version (`file_versions.converter`).
 *
 * `queueVersionConversion` / `queueFailedConversions` are the administrators' "Convert again" (files.ts).
 */
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { fileVersions, files, jobs as jobRows } from "../db/schema.js";
import type { JobQueue } from "../jobs/queue.js";
import { converterVersion, isModelFile, modelFormatExtensions, modelFormatFor } from "./model-formats.js";

/** Queues the conversion of every version a module that is on can convert now; returns how many. */
export async function queueModelBackfill(db: Db, jobs: JobQueue): Promise<number> {
  const extensions = modelFormatExtensions();
  if (!extensions.length) return 0;
  const rows = await db
    .select({ id: fileVersions.id, name: files.name, version: fileVersions.version, current: files.currentVersion })
    .from(fileVersions)
    .innerJoin(files, eq(files.id, fileVersions.fileId))
    .where(
      and(
        eq(fileVersions.derivativeStatus, "none"),
        isNull(files.deletedAt),
        or(...extensions.map((ext) => sql`lower(${files.name}) like ${`%.${ext}`}`)),
      ),
    );
  rows.sort(currentFirst);
  let queued = 0;
  for (const r of rows) {
    if (!isModelFile(r.name)) continue;
    // Claimed first (none → pending), so two servers starting together do not both queue it.
    const [claimed] = await db
      .update(fileVersions)
      .set({ derivativeStatus: "pending", derivativeError: null })
      .where(and(eq(fileVersions.id, r.id), eq(fileVersions.derivativeStatus, "none")))
      .returning({ id: fileVersions.id });
    if (!claimed) continue;
    // Background: a new upload or an administrator's "Convert again" goes first (JobQueue.runNext).
    await jobs.enqueue("ifc_to_frag", { versionId: r.id, background: true });
    queued++;
  }
  return queued;
}

/** Current versions first (the queue runs jobs in the order they were added), then older ones, newest first. */
function currentFirst(a: { version: number; current: number }, b: { version: number; current: number }): number {
  return Number(b.version === b.current) - Number(a.version === a.current) || b.version - a.version;
}

/** Versions in these model statuses of not deleted files of the given extensions (lower case), optionally in one project. */
function moduleFormatVersions(db: Db, extensions: string[], statuses: ("ready" | "failed")[], projectId?: string) {
  return db
    .select({
      id: fileVersions.id,
      name: files.name,
      version: fileVersions.version,
      current: files.currentVersion,
      status: fileVersions.derivativeStatus,
      converter: fileVersions.converter,
    })
    .from(fileVersions)
    .innerJoin(files, eq(files.id, fileVersions.fileId))
    .where(
      and(
        isNull(files.deletedAt),
        inArray(fileVersions.derivativeStatus, statuses),
        projectId ? eq(files.projectId, projectId) : undefined,
        or(...extensions.map((ext) => sql`lower(${files.name}) like ${`%.${ext}`}`)),
      ),
    );
}

/**
 * Converts again, once, what the converter installed now has not done yet: a ready model built by another converter
 * version (or before the converter was recorded) is rebuilt in place, a
 * failed version is retried. The version is claimed by writing the installed converter first, so a restart or a
 * second server does not queue it again, and a version that fails again waits for the next converter version.
 * Formats whose module does not report its converter (`ModelFormat.version`) are left alone. Returns how many.
 */
export async function queueModelReconversion(db: Db, jobs: JobQueue): Promise<number> {
  const extensions = modelFormatExtensions();
  if (!extensions.length) return 0;
  const installed = new Map<string, string | null>();
  const rows = (await moduleFormatVersions(db, extensions, ["ready", "failed"])).sort(currentFirst);
  let queued = 0;
  for (const r of rows) {
    const format = modelFormatFor(r.name);
    if (!format) continue;
    if (!installed.has(format.label)) installed.set(format.label, await converterVersion(format));
    const current = installed.get(format.label);
    if (!current) continue;
    // Versions converted before the converter was recorded have none: converted once more (a ready model then
    // keeps its IFC for download too).
    if (r.converter === current) continue;
    const [claimed] = await db
      .update(fileVersions)
      .set({ converter: current, ...(r.status === "failed" && { derivativeStatus: "pending" as const, derivativeError: null }) })
      .where(
        and(
          eq(fileVersions.id, r.id),
          eq(fileVersions.derivativeStatus, r.status),
          r.converter === null ? isNull(fileVersions.converter) : eq(fileVersions.converter, r.converter),
        ),
      )
      .returning({ id: fileVersions.id });
    if (!claimed) continue;
    await jobs.enqueue("ifc_to_frag", { versionId: r.id, reconvert: true, background: true });
    queued++;
  }
  return queued;
}

/** Why a version cannot be converted again now. */
export type ConversionRefusal = "notConvertible" | "busy";

/**
 * "Convert again" for one version of a file a module converts (an administrator's action): a ready model is rebuilt
 * in place, any other version is queued like a new upload. Refused for other files and while a conversion runs.
 */
export async function queueVersionConversion(
  db: Db,
  jobs: JobQueue,
  version: { id: string; derivativeStatus: string },
  fileName: string,
): Promise<ConversionRefusal | null> {
  if (!modelFormatFor(fileName)) return "notConvertible";
  if (version.derivativeStatus === "pending" || version.derivativeStatus === "processing") return "busy";
  const [active] = await db
    .select({ id: jobRows.id })
    .from(jobRows)
    .where(
      and(
        inArray(jobRows.kind, ["ifc_to_frag", "ifc_index"]),
        inArray(jobRows.status, ["queued", "running"]),
        sql`${jobRows.payload}->>'versionId' = ${version.id}`,
      ),
    )
    .limit(1);
  if (active) return "busy";
  if (version.derivativeStatus !== "ready") {
    const [claimed] = await db
      .update(fileVersions)
      .set({ derivativeStatus: "pending", derivativeError: null })
      .where(and(eq(fileVersions.id, version.id), eq(fileVersions.derivativeStatus, version.derivativeStatus as "failed" | "none")))
      .returning({ id: fileVersions.id });
    if (!claimed) return "busy";
  }
  await jobs.enqueue("ifc_to_frag", { versionId: version.id, reconvert: true });
  return null;
}

/** "Convert failed models again" for a project (an administrator's action): every failed version, current ones first. */
export async function queueFailedConversions(db: Db, jobs: JobQueue, projectId: string): Promise<number> {
  const extensions = modelFormatExtensions();
  if (!extensions.length) return 0;
  const rows = (await moduleFormatVersions(db, extensions, ["failed"], projectId)).sort(currentFirst);
  let queued = 0;
  for (const r of rows) if (isModelFile(r.name) && !(await queueVersionConversion(db, jobs, { id: r.id, derivativeStatus: "failed" }, r.name))) queued++;
  return queued;
}
