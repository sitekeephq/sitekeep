/**
 * Yönetim → Sistem Durumu → failed background jobs: what failed (grouped by kind and error), where, and the
 * administrators' "Retry" / "Clear". Retrying reuses the per-project "convert failed models again" logic
 * (files/model-backfill.ts); only kinds that are safe to repeat (jobs/errors.ts RETRYABLE_JOB_KINDS) are queued.
 */
import { and, count, desc, eq, inArray, max, sql, type SQL } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { fileVersions, files, jobs, projects } from "../db/schema.js";
import type {
  FailedJobDto,
  FailedJobGroupDto,
  FailedJobPageDto,
  FailedJobRetryResultDto,
  FailedJobSelector,
} from "@sitekeep/shared";
import type { JobQueue } from "../jobs/queue.js";
import { RETRYABLE_JOB_KINDS } from "../jobs/errors.js";
import { modelFormatFor } from "../files/model-formats.js";
import { queueVersionConversion } from "../files/model-backfill.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const failedWhere = (sel?: { kind?: string; error?: string }): SQL => {
  const parts: SQL[] = [eq(jobs.status, "failed")];
  if (sel?.kind !== undefined) parts.push(eq(jobs.kind, sel.kind));
  if (sel?.error !== undefined) parts.push(sql`coalesce(${jobs.error}, '') = ${sel.error}`);
  return and(...parts)!;
};

export async function failedJobGroups(db: Db): Promise<FailedJobGroupDto[]> {
  const rows = await db
    .select({ kind: jobs.kind, error: sql<string>`coalesce(${jobs.error}, '')`, n: count(), last: max(jobs.finishedAt) })
    .from(jobs)
    .where(eq(jobs.status, "failed"))
    .groupBy(jobs.kind, sql`coalesce(${jobs.error}, '')`)
    .orderBy(desc(max(jobs.finishedAt)));
  return rows.map((r) => ({
    kind: r.kind,
    error: r.error,
    count: Number(r.n),
    lastFinishedAt: r.last ? new Date(r.last).toISOString() : null,
    retryable: RETRYABLE_JOB_KINDS.has(r.kind),
  }));
}

/** Project of a job: through its version, else a projectId in the payload, else (Connect) its Autodesk connection. */
async function projectsOf(db: Db, rows: (typeof jobs.$inferSelect)[], viaVersion: Map<string, string>) {
  const wanted = new Map<string, string>(); // job id -> project id
  const connectionJobs = new Map<string, string>(); // job id -> connection id
  for (const j of rows) {
    const v = typeof j.payload.versionId === "string" ? viaVersion.get(j.payload.versionId) : undefined;
    const direct = typeof j.payload.projectId === "string" && UUID.test(j.payload.projectId) ? j.payload.projectId : undefined;
    const pid = v ?? direct;
    if (pid) wanted.set(j.id, pid);
    else if (typeof j.payload.connectionId === "string" && UUID.test(j.payload.connectionId)) connectionJobs.set(j.id, j.payload.connectionId);
  }
  if (connectionJobs.size) {
    // The connection table belongs to the Connect module: absent when it is not installed.
    try {
      const res = await db.execute(sql`select id, project_id from autodesk_connections where id in (${sql.join([...new Set(connectionJobs.values())].map((c) => sql`${c}::uuid`), sql`, `)})`);
      const raw = res as unknown as { rows?: { id: string; project_id: string }[] } | { id: string; project_id: string }[];
      const byConn = new Map((Array.isArray(raw) ? raw : (raw.rows ?? [])).map((r) => [r.id, r.project_id] as const));
      for (const [jobId, conn] of connectionJobs) {
        const pid = byConn.get(conn);
        if (pid) wanted.set(jobId, pid);
      }
    } catch {
      /* no module, no project column */
    }
  }
  const ids = [...new Set(wanted.values())];
  const found = ids.length ? await db.select({ id: projects.id, code: projects.code, name: projects.name }).from(projects).where(inArray(projects.id, ids)) : [];
  const byId = new Map(found.map((p) => [p.id, p]));
  return new Map([...wanted].flatMap(([jobId, pid]) => (byId.has(pid) ? [[jobId, byId.get(pid)!] as const] : [])));
}

export async function failedJobPage(db: Db, q: { kind?: string; error?: string; page: number; pageSize: number }): Promise<FailedJobPageDto> {
  const where = failedWhere(q);
  const [{ n } = { n: 0 }] = await db.select({ n: count() }).from(jobs).where(where);
  const rows = await db
    .select()
    .from(jobs)
    .where(where)
    .orderBy(desc(jobs.finishedAt), desc(jobs.createdAt))
    .limit(q.pageSize)
    .offset((q.page - 1) * q.pageSize);
  const versionIds = [...new Set(rows.map((j) => j.payload.versionId).filter((v): v is string => typeof v === "string" && UUID.test(v)))];
  const versions = versionIds.length
    ? await db
        .select({ versionId: fileVersions.id, version: fileVersions.version, fileId: files.id, name: files.name, projectId: files.projectId })
        .from(fileVersions)
        .innerJoin(files, eq(files.id, fileVersions.fileId))
        .where(inArray(fileVersions.id, versionIds))
    : [];
  const byVersion = new Map(versions.map((v) => [v.versionId, v]));
  const projectOf = await projectsOf(db, rows, new Map(versions.map((v) => [v.versionId, v.projectId])));
  const items: FailedJobDto[] = rows.map((j) => {
    const v = typeof j.payload.versionId === "string" ? byVersion.get(j.payload.versionId) : undefined;
    return {
      id: j.id,
      kind: j.kind,
      error: j.error ?? "",
      attempts: j.attempts,
      createdAt: j.createdAt.toISOString(),
      finishedAt: j.finishedAt?.toISOString() ?? null,
      project: projectOf.get(j.id) ?? null,
      file: v ? { id: v.fileId, name: v.name, versionId: v.versionId, version: v.version } : null,
      retryable: RETRYABLE_JOB_KINDS.has(j.kind),
    };
  });
  return { total: Number(n), page: q.page, pageSize: q.pageSize, items };
}

/** Failed jobs an action covers (at most `limit`), by id or by group. */
async function selected(db: Db, sel: FailedJobSelector, limit = 2000) {
  const where = "ids" in sel ? and(eq(jobs.status, "failed"), inArray(jobs.id, sel.ids.slice(0, limit))) : failedWhere(sel);
  return db.select().from(jobs).where(where).orderBy(desc(jobs.finishedAt)).limit(limit);
}

/**
 * "Retry": ifc_to_frag goes through the same conversion logic as "convert failed models again" (the version's
 * status is claimed first, so it cannot be queued twice) and its old record is removed once the new job exists;
 * the other repeatable kinds go back to the queue as new. Skipped: kinds that are not safe to repeat, versions or
 * files that are gone, a model that is no longer failed (someone retried already) or a job already waiting.
 */
export async function retryFailedJobs(db: Db, queue: JobQueue, sel: FailedJobSelector): Promise<FailedJobRetryResultDto & { ids: string[] }> {
  const rows = await selected(db, sel);
  const done: string[] = [];
  let skipped = 0;
  for (const j of rows) {
    if (await retryOne(db, queue, j)) done.push(j.id);
    else skipped++;
  }
  return { queued: done.length, skipped, ids: done };
}

async function activeFor(db: Db, kinds: string[], key: "versionId" | "connectionId", value: string): Promise<boolean> {
  const [a] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(inArray(jobs.kind, kinds), inArray(jobs.status, ["queued", "running"]), sql`${jobs.payload}->>${key} = ${value}`))
    .limit(1);
  return !!a;
}

async function retryOne(db: Db, queue: JobQueue, j: typeof jobs.$inferSelect): Promise<boolean> {
  if (!RETRYABLE_JOB_KINDS.has(j.kind)) return false;
  if (j.kind === "autodesk_sync") {
    const conn = String(j.payload.connectionId ?? "");
    if (!UUID.test(conn) || (await activeFor(db, ["autodesk_sync"], "connectionId", conn))) return false;
    return queue.requeueFailed(j.id);
  }
  const versionId = String(j.payload.versionId ?? "");
  if (!UUID.test(versionId)) return false;
  const [row] = await db
    .select({ id: fileVersions.id, derivativeStatus: fileVersions.derivativeStatus, name: files.name, deletedAt: files.deletedAt })
    .from(fileVersions)
    .innerJoin(files, eq(files.id, fileVersions.fileId))
    .where(eq(fileVersions.id, versionId));
  if (!row || row.deletedAt) return false;
  if (await activeFor(db, ["ifc_to_frag", "ifc_index"], "versionId", versionId)) return false;
  if (j.kind === "ifc_index") return queue.requeueFailed(j.id);
  // ifc_to_frag: only a version that is still failed (a retried or replaced one is already handled).
  if (row.derivativeStatus !== "failed") return false;
  if (modelFormatFor(row.name)) {
    if (await queueVersionConversion(db, queue, { id: row.id, derivativeStatus: "failed" }, row.name)) return false;
  } else {
    const [claimed] = await db
      .update(fileVersions)
      .set({ derivativeStatus: "pending", derivativeError: null })
      .where(and(eq(fileVersions.id, versionId), eq(fileVersions.derivativeStatus, "failed")))
      .returning({ id: fileVersions.id });
    if (!claimed) return false;
    await queue.enqueue("ifc_to_frag", { versionId });
  }
  await db.delete(jobs).where(and(eq(jobs.id, j.id), eq(jobs.status, "failed")));
  return true;
}

/** "Clear": deletes the failed job records (nothing else: files and their status stay). */
export async function clearFailedJobs(db: Db, sel: FailedJobSelector): Promise<{ deleted: number; ids: string[] }> {
  const rows = await selected(db, sel);
  if (!rows.length) return { deleted: 0, ids: [] };
  const ids = rows.map((r) => r.id);
  const gone = await db.delete(jobs).where(and(eq(jobs.status, "failed"), inArray(jobs.id, ids))).returning({ id: jobs.id });
  return { deleted: gone.length, ids };
}
