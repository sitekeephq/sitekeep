/**
 * Recycle bin auto-purge (Privacy Centre → Retention, docs/features/DATA_SUBJECT_RIGHTS.md#retention):
 * files and folders deleted more than `trashPurgeDays` ago are deleted for good, as a system
 * administrator's permanent delete would (purgeFiles), by the daily retention job. Off by default.
 *
 * An item still referenced elsewhere (e.g. a version pinned in a review) cannot be deleted and stays
 * in the bin; it is counted as skipped and tried again the next day.
 */
import { and, inArray, isNotNull, lt, notExists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "../../db/index.js";
import { files, folders } from "../../db/schema.js";
import type { Storage } from "../../core/platform/storage.js";
import { audit } from "../../core/platform/audit.js";
import { purgeFiles } from "./trash.js";

export interface TrashPurgeResult {
  files: number;
  versions: number;
  folders: number;
  removedObjects: number;
  skipped: number;
  /** Time span of the deletion times of what was purged. */
  oldest: Date | null;
  newest: Date | null;
}

const span = (r: TrashPurgeResult, at: Date | null) => {
  if (!at) return;
  if (!r.oldest || at < r.oldest) r.oldest = at;
  if (!r.newest || at > r.newest) r.newest = at;
};

export async function purgeExpiredTrash(db: Db, storage: Storage, before: Date, opts: { days?: number } = {}): Promise<TrashPurgeResult> {
  const r: TrashPurgeResult = { files: 0, versions: 0, folders: 0, removedObjects: 0, skipped: 0, oldest: null, newest: null };
  const perProject = new Map<string, { files: string[]; folders: string[] }>();
  const note = (projectId: string, kind: "files" | "folders", name: string) => {
    const p = perProject.get(projectId) ?? { files: [], folders: [] };
    p[kind].push(name);
    perProject.set(projectId, p);
  };

  // Files, a file at a time (one blocked file must not keep the others).
  const expired = await db
    .select({ id: files.id, name: files.name, projectId: files.projectId, deletedAt: files.deletedAt })
    .from(files)
    .where(and(isNotNull(files.deletedAt), lt(files.deletedAt, before)));
  for (const f of expired) {
    try {
      const done = await purgeFiles(db, storage, [f.id]);
      r.files++;
      r.versions += done.versions;
      r.removedObjects += done.removedObjects;
      span(r, f.deletedAt);
      note(f.projectId, "files", f.name);
    } catch {
      r.skipped++;
    }
  }

  // Folders, leaves first: an expired deleted folder with no files and no sub-folders left.
  const child = alias(folders, "child");
  const blocked = new Set<string>();
  for (let round = 0; round < 1000; round++) {
    const leaves = (
      await db
        .select({ id: folders.id, name: folders.name, projectId: folders.projectId, deletedAt: folders.deletedAt })
        .from(folders)
        .where(
          and(
            isNotNull(folders.deletedAt),
            lt(folders.deletedAt, before),
            notExists(db.select({ x: sql`1` }).from(child).where(sql`${child.parentId} = ${folders.id}`)),
            notExists(db.select({ x: sql`1` }).from(files).where(sql`${files.folderId} = ${folders.id}`)),
          ),
        )
    ).filter((f) => !blocked.has(f.id));
    if (!leaves.length) break;
    for (const f of leaves) {
      try {
        await db.delete(folders).where(inArray(folders.id, [f.id]));
        r.folders++;
        span(r, f.deletedAt);
        note(f.projectId, "folders", f.name);
      } catch {
        blocked.add(f.id);
        r.skipped++;
      }
    }
  }

  // The project's own trail: what the retention rule removed from its bin.
  for (const [projectId, p] of perProject)
    await audit(db, {
      projectId,
      action: "trash.auto_purged",
      targetType: "project",
      targetId: projectId,
      details: {
        before: before.toISOString(),
        ...(opts.days !== undefined && { trashPurgeDays: opts.days }),
        files: p.files.length,
        folders: p.folders.length,
        names: [...p.files, ...p.folders].slice(0, 100),
      },
      client: null,
    });
  return r;
}
