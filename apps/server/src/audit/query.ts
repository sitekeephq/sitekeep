/**
 * Reading the audit log (docs/features/AUDIT_LOG.md): filters, cursor pages, CSV rows and the
 * hash-chain check. The log itself is written by core/platform/audit.ts and kept append-only and
 * chained by the database (migration 0043_audit_chain).
 */
import { and, asc, count, desc, eq, gt, gte, inArray, isNotNull, like, lt, min, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { AuditEntryDto, AuditVerifyDto } from "@sitekeep/shared";
import type { Db } from "../db/index.js";
import { auditLog, fileVersions, files, folders, projects } from "../db/schema.js";
import { userNames } from "../core/security/access.js";
import { badRequest } from "../core/platform/http.js";
import { msg } from "../i18n/index.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** "2026-11-15" or a full ISO time; a bare date as `to` covers that whole day. */
function parseTime(v: string | undefined, end: boolean): Date | undefined {
  if (!v) return undefined;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(v);
  const d = new Date(dateOnly ? `${v}T00:00:00Z` : v);
  if (Number.isNaN(d.getTime())) throw badRequest(msg("audit:errors.invalidTime", { value: v }));
  return dateOnly && end ? new Date(d.getTime() + DAY_MS) : d;
}

export const auditQuery = z.object({
  from: z.string().trim().max(40).optional(),
  to: z.string().trim().max(40).optional(),
  /** Exact action ("file.viewed") or a prefix ending in ".*" ("file.*"). */
  action: z.string().trim().max(100).optional(),
  userId: z.string().uuid().optional(),
  targetType: z.string().trim().max(60).optional(),
  targetId: z.string().trim().max(200).optional(),
  projectId: z.string().uuid().optional(),
  cursor: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  /** CSV column names' language (a download link cannot send Accept-Language). */
  lang: z.string().max(10).optional(),
});
export type AuditQuery = z.infer<typeof auditQuery>;

/** Conditions of a query; `projectId` (when given) wins over the query's own. */
export function auditWhere(q: AuditQuery, scope: { projectId?: string } = {}): SQL | undefined {
  const from = parseTime(q.from, false);
  const to = parseTime(q.to, true);
  const projectId = scope.projectId ?? q.projectId;
  const action = q.action || undefined;
  return and(
    projectId ? eq(auditLog.projectId, projectId) : undefined,
    from ? gte(auditLog.at, from) : undefined,
    to ? lt(auditLog.at, to) : undefined,
    action ? (action.endsWith(".*") ? like(auditLog.action, `${action.slice(0, -1).replace(/[%_\\]/g, "\\$&")}%`) : eq(auditLog.action, action)) : undefined,
    q.userId ? eq(auditLog.userId, q.userId) : undefined,
    q.targetType ? eq(auditLog.targetType, q.targetType) : undefined,
    q.targetId ? eq(auditLog.targetId, q.targetId) : undefined,
  );
}

type AuditRow = typeof auditLog.$inferSelect;

/** One page, newest first; rows below `cursor` (an id). */
export async function auditPage(db: Db, where: SQL | undefined, limit: number, cursor?: number): Promise<{ rows: AuditRow[]; nextCursor: number | null }> {
  const rows = await db
    .select()
    .from(auditLog)
    .where(and(where, cursor ? lt(auditLog.id, cursor) : undefined))
    .orderBy(desc(auditLog.id))
    .limit(limit + 1);
  const more = rows.length > limit;
  if (more) rows.pop();
  return { rows, nextCursor: more ? rows[rows.length - 1]!.id : null };
}

/** Every row of a query, newest first, in pages (CSV export). */
export async function* auditRows(db: Db, where: SQL | undefined, pageSize = 1000): AsyncGenerator<AuditRow[]> {
  let cursor: number | undefined;
  for (;;) {
    const page = await auditPage(db, where, pageSize, cursor);
    if (page.rows.length) yield page.rows;
    if (page.nextCursor === null) return;
    cursor = page.nextCursor;
  }
}

/** Rows as DTOs with user, file / folder and project names; the client only when `client`. */
export async function toAuditDtos(db: Db, rows: AuditRow[], opts: { client: boolean; projectCodes?: boolean }): Promise<AuditEntryDto[]> {
  const names = await userNames(db, rows.map((r) => r.userId));
  const ids = (type: string) => [...new Set(rows.filter((r) => r.targetType === type && r.targetId && isUuidLike(r.targetId)).map((r) => r.targetId!))];
  const fileIds = ids("file");
  const folderIds = ids("folder");
  const targetNames = new Map<string, string>();
  if (fileIds.length)
    for (const f of await db.select({ id: files.id, name: files.name }).from(files).where(inArray(files.id, fileIds))) targetNames.set(`file:${f.id}`, f.name);
  if (folderIds.length)
    for (const f of await db.select({ id: folders.id, name: folders.name }).from(folders).where(inArray(folders.id, folderIds))) targetNames.set(`folder:${f.id}`, f.name);
  const codes = new Map<string, string>();
  const pids = [...new Set(rows.map((r) => r.projectId).filter((x): x is string => !!x))];
  if (opts.projectCodes && pids.length)
    for (const p of await db.select({ id: projects.id, code: projects.code }).from(projects).where(inArray(projects.id, pids))) codes.set(p.id, p.code);
  return rows.map((r) => ({
    id: r.id,
    projectId: r.projectId,
    userId: r.userId,
    ...(r.userId && names.has(r.userId) && { userName: names.get(r.userId) }),
    action: r.action,
    targetType: r.targetType,
    targetId: r.targetId,
    details: r.details,
    at: r.at.toISOString(),
    hash: r.hash,
    ...(opts.client && { ip: r.ip, userAgent: r.userAgent }),
    ...(r.targetId && targetNames.has(`${r.targetType}:${r.targetId}`) && { targetName: targetNames.get(`${r.targetType}:${r.targetId}`) }),
    ...(r.projectId && codes.has(r.projectId) && { projectCode: codes.get(r.projectId) }),
  }));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuidLike(v: string): boolean {
  return UUID.test(v);
}

/** Conditions for one file's history: rows about the file and about its versions. */
export async function fileHistoryWhere(db: Db, projectId: string, fileId: string): Promise<SQL | undefined> {
  const versions = await db.select({ id: fileVersions.id }).from(fileVersions).where(eq(fileVersions.fileId, fileId));
  return and(
    eq(auditLog.projectId, projectId),
    or(
      and(eq(auditLog.targetType, "file"), eq(auditLog.targetId, fileId)),
      versions.length ? and(eq(auditLog.targetType, "file_version"), inArray(auditLog.targetId, versions.map((v) => v.id))) : undefined,
    ),
  );
}

// ---- Hash chain --------------------------------------------------------------------------------

/**
 * Walks the chain from its first row (the genesis row of 0043) in id order: every chained row must
 * have a hash, point to the previous row's hash and hash to what the database recomputes from its
 * fields. Reports the first row that does not.
 */
export async function verifyAuditChain(db: Db, batchSize = 2000): Promise<AuditVerifyDto> {
  const [start] = await db.select({ first: min(auditLog.id) }).from(auditLog).where(isNotNull(auditLog.hash));
  const first = start?.first ?? null;
  const [legacy] = await db
    .select({ n: count() })
    .from(auditLog)
    .where(first === null ? undefined : lt(auditLog.id, first));
  const legacyRows = Number(legacy?.n ?? 0);
  if (first === null) return { ok: true, checked: 0, legacyRows, head: null, broken: null };

  let expectedPrev: string | null = null;
  let checked = 0;
  let head: AuditVerifyDto["head"] = null;
  let after = first - 1;
  for (;;) {
    const rows = await db
      .select({
        id: auditLog.id,
        prevHash: auditLog.prevHash,
        hash: auditLog.hash,
        at: auditLog.at,
        // Recomputed by the same function as the insert trigger, from the row as stored now.
        computed: sql<string>`audit_log_hash(${auditLog.prevHash}, "audit_log")`,
      })
      .from(auditLog)
      .where(gt(auditLog.id, after))
      .orderBy(asc(auditLog.id))
      .limit(batchSize);
    for (const r of rows) {
      const broken = (reason: NonNullable<AuditVerifyDto["broken"]>["reason"]): AuditVerifyDto => ({ ok: false, checked, legacyRows, head, broken: { id: r.id, reason } });
      if (!r.hash) return broken("missing_hash");
      if (r.prevHash !== expectedPrev) return broken("prev_mismatch");
      if (r.computed !== r.hash) return broken("hash_mismatch");
      expectedPrev = r.hash;
      checked++;
      head = { id: r.id, hash: r.hash, at: r.at.toISOString() };
      after = r.id;
    }
    if (rows.length < batchSize) break;
  }
  return { ok: true, checked, legacyRows, head, broken: null };
}
