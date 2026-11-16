/**
 * Reading the audit log (docs/features/AUDIT_LOG.md): filters, cursor pages, CSV rows and the
 * hash-chain check. The log itself is written by core/platform/audit.ts and kept append-only and
 * chained by the database (migration 0043_audit_chain).
 */
import { createHash } from "node:crypto";
import { and, asc, count, desc, eq, gt, gte, inArray, isNotNull, like, lt, min, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { AuditEntryDto, AuditVerifyDto, Principal } from "@sitekeep/shared";
import type { Db } from "../db/index.js";
import { auditLog, auditPersonal, auditResealHashes, auditTruncations, fileVersions, files, folders, projects } from "../db/schema.js";
import { auditPersonalHash, auditPersonalKey } from "../core/platform/audit.js";
import { auditPersonalCutoff } from "../privacy/settings.js";
import { hiddenByWipRule, userNames, type FolderTree } from "../core/security/access.js";
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
export async function toAuditDtos(
  db: Db,
  rows: AuditRow[],
  opts: {
    client: boolean;
    projectCodes?: boolean;
    /** Name rows about a user (security log) with the user's name. */
    userTargets?: boolean;
    /**
     * ISO-5: the reader of a project's log. A row about a file or folder in a task team's WIP
     * closed to them (team-only policy with admin_sees_wip off) keeps its place in the log but
     * not its target name or details.
     */
    viewer?: { tree: FolderTree; principal: Principal };
  },
): Promise<AuditEntryDto[]> {
  const ids = (type: string) => [...new Set(rows.filter((r) => r.targetType === type && r.targetId && isUuidLike(r.targetId)).map((r) => r.targetId!))];
  const names = await userNames(db, [...rows.map((r) => r.userId), ...(opts.userTargets ? ids("user") : [])]);
  const fileIds = ids("file");
  const folderIds = ids("folder");
  const targetNames = new Map<string, string>();
  if (opts.userTargets) for (const id of ids("user")) if (names.has(id)) targetNames.set(`user:${id}`, names.get(id)!);
  /** Folder of each file / folder / version target, for the WIP rule. */
  const targetFolder = new Map<string, string>();
  if (fileIds.length)
    for (const f of await db.select({ id: files.id, name: files.name, folderId: files.folderId }).from(files).where(inArray(files.id, fileIds))) {
      targetNames.set(`file:${f.id}`, f.name);
      targetFolder.set(`file:${f.id}`, f.folderId);
    }
  if (folderIds.length)
    for (const f of await db.select({ id: folders.id, name: folders.name }).from(folders).where(inArray(folders.id, folderIds))) {
      targetNames.set(`folder:${f.id}`, f.name);
      targetFolder.set(`folder:${f.id}`, f.id);
    }
  // Files and folders named inside details (zip items, moves, copies): their folders too.
  const refs = new Map<number, { files: string[]; folders: string[] }>();
  if (opts.viewer)
    for (const r of rows) if (r.details) refs.set(r.id, detailRefs(r.details));
  const detailFileIds = [...new Set([...refs.values()].flatMap((x) => x.files))].filter((id) => !targetFolder.has(`file:${id}`));
  for (let i = 0; i < detailFileIds.length; i += 500)
    for (const f of await db.select({ id: files.id, folderId: files.folderId }).from(files).where(inArray(files.id, detailFileIds.slice(i, i + 500))))
      targetFolder.set(`file:${f.id}`, f.folderId);
  const versionIds = opts.viewer ? ids("file_version") : [];
  if (versionIds.length)
    for (const v of await db
      .select({ id: fileVersions.id, folderId: files.folderId })
      .from(fileVersions)
      .innerJoin(files, eq(files.id, fileVersions.fileId))
      .where(inArray(fileVersions.id, versionIds)))
      targetFolder.set(`file_version:${v.id}`, v.folderId);
  const hidden = (r: AuditRow) => {
    if (!opts.viewer) return false;
    const { tree, principal } = opts.viewer;
    const folderIds = [
      r.targetId ? targetFolder.get(`${r.targetType}:${r.targetId}`) : undefined,
      ...(refs.get(r.id)?.files ?? []).map((id) => targetFolder.get(`file:${id}`)),
      ...(refs.get(r.id)?.folders ?? []),
    ];
    return folderIds.some((id) => !!id && hiddenByWipRule(tree, principal, id));
  };
  const codes = new Map<string, string>();
  const pids = [...new Set(rows.map((r) => r.projectId).filter((x): x is string => !!x))];
  if (opts.projectCodes && pids.length)
    for (const p of await db.select({ id: projects.id, code: projects.code }).from(projects).where(inArray(projects.id, pids))) codes.set(p.id, p.code);
  // Personal part (P1-5): from audit_personal; rows chained before 0049 and not re-sealed still
  // hold theirs in the row itself.
  const personal = new Map<number, { ip: string | null; userAgent: string | null; email: string | null }>();
  if (opts.client && rows.length)
    for (const p of await db
      .select({ auditId: auditPersonal.auditId, ip: auditPersonal.ip, userAgent: auditPersonal.userAgent, email: auditPersonal.email })
      .from(auditPersonal)
      .where(inArray(auditPersonal.auditId, rows.map((r) => r.id))))
      personal.set(p.auditId, p);
  const cutoff = auditPersonalCutoff();
  const clientOf = (r: AuditRow): Pick<AuditEntryDto, "ip" | "userAgent" | "personalRemoved"> => {
    const p = personal.get(r.id);
    if (p) return { ip: p.ip, userAgent: p.userAgent };
    if (r.personalHash) return { ip: null, userAgent: null, personalRemoved: r.at < cutoff ? "retention" : "erased" };
    return { ip: r.ip, userAgent: r.userAgent };
  };
  return rows.map((r) => {
    const withheld = hidden(r);
    const targetName = targetNames.get(`${r.targetType}:${r.targetId}`);
    const email = personal.get(r.id)?.email;
    return {
      id: r.id,
      projectId: r.projectId,
      userId: r.userId,
      ...(r.userId && names.has(r.userId) && { userName: names.get(r.userId) }),
      action: r.action,
      targetType: r.targetType,
      targetId: r.targetId,
      // An administrator reading the log sees the e-mail address while it is kept.
      details: withheld ? { withheld: "task_team_wip" } : email ? { ...(r.details ?? {}), email } : r.details,
      at: r.at.toISOString(),
      hash: r.hash,
      ...(opts.client && clientOf(r)),
      ...(r.targetId && targetName !== undefined && !withheld && { targetName }),
      ...(r.projectId && codes.has(r.projectId) && { projectCode: codes.get(r.projectId) }),
    };
  });
}

const FILE_KEYS = new Set(["fileId", "fileIds", "copiedFileId", "sourceFileId"]);
const FOLDER_KEYS = new Set(["folderId", "folderIds", "parentId", "fromFolderId", "toFolderId", "sourceFolderId", "targetFolderId"]);

/** File and folder ids named anywhere in a row's details (keys in FILE_KEYS / FOLDER_KEYS). */
function detailRefs(details: unknown): { files: string[]; folders: string[] } {
  const out = { files: [] as string[], folders: [] as string[] };
  const walk = (v: unknown, depth: number) => {
    if (depth > 4 || !v || typeof v !== "object") return;
    if (Array.isArray(v)) return v.slice(0, 1000).forEach((x) => walk(x, depth + 1));
    for (const [k, x] of Object.entries(v)) {
      const list = Array.isArray(x) ? x : [x];
      const into = FILE_KEYS.has(k) ? out.files : FOLDER_KEYS.has(k) ? out.folders : null;
      if (into) for (const id of list) if (typeof id === "string" && isUuidLike(id)) into.push(id);
      if (typeof x === "object") walk(x, depth + 1);
    }
  };
  walk(details, 0);
  return out;
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
 *
 * P1-5: a row's personal record (audit_personal) must belong to a row with personal_hash and, when
 * the installation's key is at hand, hash to it; a deleted personal record is fine (retention,
 * erasure). The archive of every re-seal (audit.resealed rows) must still give the digest the row
 * recorded.
 *
 * Retention (audit/truncate.ts): after a truncation the first chained row points to the last deleted
 * row's hash. That is accepted only when the latest audit_truncation checkpoint names this row and
 * that hash, and the chained `audit.truncated` row of the checkpoint (with the same values) follows;
 * `truncation_mismatch` otherwise.
 */
export async function verifyAuditChain(db: Db, batchSize = 2000, opts: { personalKey?: Buffer | null } = {}): Promise<AuditVerifyDto> {
  const key = opts.personalKey === undefined ? auditPersonalKey() : opts.personalKey;
  const [start] = await db.select({ first: min(auditLog.id) }).from(auditLog).where(isNotNull(auditLog.hash));
  const first = start?.first ?? null;
  const [legacy] = await db
    .select({ n: count() })
    .from(auditLog)
    .where(first === null ? undefined : lt(auditLog.id, first));
  const legacyRows = Number(legacy?.n ?? 0);
  let personalChecked: number | null = key ? 0 : null;
  if (first === null) return { ok: true, checked: 0, legacyRows, head: null, personalChecked, broken: null };

  const [trunc] = await db.select().from(auditTruncations).orderBy(desc(auditTruncations.id)).limit(1);
  const truncation = trunc && Number(trunc.newFirstId) === Number(first) ? trunc : null;
  const truncated: AuditVerifyDto["truncated"] = truncation
    ? { id: truncation.id, before: truncation.before.toISOString(), removedHeadHash: truncation.removedHeadHash, newFirstId: truncation.newFirstId }
    : null;
  let truncationConfirmed = !truncation;
  let expectedPrev: string | null = truncation?.removedHeadHash ?? null;
  let checked = 0;
  let head: AuditVerifyDto["head"] = null;
  let after = first - 1;
  const reseals: { id: number; details: Record<string, unknown> | null }[] = [];
  const broken = (id: number, reason: NonNullable<AuditVerifyDto["broken"]>["reason"]): AuditVerifyDto => ({
    ok: false,
    checked,
    legacyRows,
    head,
    personalChecked,
    broken: { id, reason },
    truncated,
  });
  for (;;) {
    const rows = await db
      .select({
        id: auditLog.id,
        prevHash: auditLog.prevHash,
        hash: auditLog.hash,
        at: auditLog.at,
        action: auditLog.action,
        details: auditLog.details,
        personalHash: auditLog.personalHash,
        // Recomputed by the same function as the insert trigger, from the row as stored now.
        computed: sql<string>`audit_log_hash(${auditLog.prevHash}, "audit_log")`,
        pAuditId: auditPersonal.auditId,
        pIp: auditPersonal.ip,
        pUserAgent: auditPersonal.userAgent,
        pEmail: auditPersonal.email,
      })
      .from(auditLog)
      .leftJoin(auditPersonal, eq(auditPersonal.auditId, auditLog.id))
      .where(gt(auditLog.id, after))
      .orderBy(asc(auditLog.id))
      .limit(batchSize);
    for (const r of rows) {
      if (!r.hash) return broken(r.id, "missing_hash");
      if (r.prevHash !== expectedPrev) return broken(r.id, "prev_mismatch");
      if (r.computed !== r.hash) return broken(r.id, "hash_mismatch");
      if (r.pAuditId !== null) {
        if (!r.personalHash) return broken(r.id, "personal_mismatch");
        if (key) {
          if (auditPersonalHash({ ip: r.pIp, userAgent: r.pUserAgent, email: r.pEmail }, key) !== r.personalHash) return broken(r.id, "personal_mismatch");
          personalChecked = (personalChecked ?? 0) + 1;
        }
      }
      if (r.action === "audit.resealed") reseals.push({ id: r.id, details: r.details });
      if (truncation && r.action === "audit.truncated" && Number(r.details?.truncationId) === truncation.id) {
        if ((r.details?.removedHeadHash ?? null) !== truncation.removedHeadHash || Number(r.details?.newFirstId) !== Number(truncation.newFirstId))
          return broken(r.id, "truncation_mismatch");
        truncationConfirmed = true;
      }
      expectedPrev = r.hash;
      checked++;
      head = { id: r.id, hash: r.hash, at: r.at.toISOString() };
      after = r.id;
    }
    if (rows.length < batchSize) break;
  }
  if (!truncationConfirmed) return broken(Number(first), "truncation_mismatch");
  for (const s of reseals) {
    const resealId = Number(s.details?.resealId);
    if (!Number.isSafeInteger(resealId) || (await resealArchiveDigest(db, resealId)) !== s.details?.archiveDigest) return broken(s.id, "reseal_archive_mismatch");
  }
  return { ok: true, checked, legacyRows, head, personalChecked, broken: null, truncated };
}

/** One line per archived row, in id order: "id:old_prev_hash:old_hash\n". */
export const resealArchiveLine = (r: { rowId: number; oldPrevHash: string | null; oldHash: string }) => `${r.rowId}:${r.oldPrevHash ?? ""}:${r.oldHash}\n`;

/** sha256 of a re-seal's archive of old hashes, as stored. */
export async function resealArchiveDigest(db: Db, resealId: number, batchSize = 5000): Promise<string> {
  const digest = createHash("sha256");
  let after = -1;
  for (;;) {
    const rows = await db
      .select({ rowId: auditResealHashes.rowId, oldPrevHash: auditResealHashes.oldPrevHash, oldHash: auditResealHashes.oldHash })
      .from(auditResealHashes)
      .where(and(eq(auditResealHashes.resealId, resealId), gt(auditResealHashes.rowId, after)))
      .orderBy(asc(auditResealHashes.rowId))
      .limit(batchSize);
    for (const r of rows) digest.update(resealArchiveLine(r));
    if (rows.length < batchSize) break;
    after = rows[rows.length - 1]!.rowId;
  }
  return digest.digest("hex");
}
