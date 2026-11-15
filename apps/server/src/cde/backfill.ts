/**
 * Backfill of the CDE foundation (migration 0042 runs the same steps once in SQL). Idempotent and
 * bounded: rows are written in batches, a run can be repeated or stopped at any time.
 *
 * 1. Container of approved review copies: a copy belongs to the container of its source, walking
 *    chains (WIP → Shared → Published) to the first source. A copy with several sources takes the
 *    earliest review's; chains are cut after 64 steps (and at cycles).
 * 2. A settings row for every project that has none (enforcement off, D-8).
 *
 * New files get their own container from the database (trigger files_container_default).
 */
import { asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { files, projectCdeSettings, projects, reviewFiles, reviews } from "../db/schema.js";

export interface CdeBackfillReport {
  /** Files whose container was changed to their source's. */
  containersLinked: number;
  /** Projects that got a settings row. */
  settingsCreated: number;
}

const MAX_DEPTH = 64;

export async function runCdeBackfill(db: Db, opts: { batchSize?: number; log?: (line: string) => void } = {}): Promise<CdeBackfillReport> {
  const batchSize = Math.max(1, opts.batchSize ?? 1000);
  const log = opts.log ?? (() => undefined);

  // 1. Source of each copied file: the earliest review that produced it.
  const edges = await db
    .select({ copy: reviewFiles.copiedFileId, source: reviewFiles.fileId })
    .from(reviewFiles)
    .innerJoin(reviews, eq(reviews.id, reviewFiles.reviewId))
    .where(isNotNull(reviewFiles.copiedFileId))
    .orderBy(asc(reviews.createdAt), asc(reviewFiles.id));
  const sourceOf = new Map<string, string>();
  for (const e of edges) if (e.copy && e.copy !== e.source && !sourceOf.has(e.copy)) sourceOf.set(e.copy, e.source);

  const rootOf = (id: string): string => {
    let current = id;
    const seen = new Set([id]);
    for (let depth = 0; depth < MAX_DEPTH; depth++) {
      const next = sourceOf.get(current);
      if (!next || seen.has(next)) break;
      seen.add(next);
      current = next;
    }
    return current;
  };

  const copies = [...sourceOf.keys()];
  let containersLinked = 0;
  for (let i = 0; i < copies.length; i += batchSize) {
    const batch = copies.slice(i, i + batchSize);
    const roots = new Map(batch.map((id) => [id, rootOf(id)]));
    const ids = [...new Set([...batch, ...roots.values()])];
    const rows = await db.select({ id: files.id, containerId: files.containerId }).from(files).where(inArray(files.id, ids));
    const container = new Map(rows.map((r) => [r.id, r.containerId]));
    for (const id of batch) {
      const want = container.get(roots.get(id)!);
      if (!want || !container.has(id) || container.get(id) === want) continue;
      await db.update(files).set({ containerId: want }).where(eq(files.id, id));
      containersLinked++;
    }
    log(`containers: ${Math.min(i + batchSize, copies.length)}/${copies.length}`);
  }

  // 2. Settings rows.
  const missing = await db
    .select({ id: projects.id })
    .from(projects)
    .where(sql`not exists (select 1 from ${projectCdeSettings} s where s.project_id = ${projects.id})`);
  for (let i = 0; i < missing.length; i += batchSize) {
    const batch = missing.slice(i, i + batchSize);
    await db
      .insert(projectCdeSettings)
      .values(batch.map((p) => ({ projectId: p.id, enforceTransitions: false })))
      .onConflictDoNothing();
  }
  log(`settings rows: ${missing.length}`);
  return { containersLinked, settingsCreated: missing.length };
}
