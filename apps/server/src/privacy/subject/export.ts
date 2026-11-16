/**
 * Personal data export of one user (P1-1, right of access and portability: GDPR Art. 15/20, KVKK
 * m.11; docs/features/DATA_SUBJECT_RIGHTS.md#export). Built in the job queue (kind
 * "personal_data_export"), stored as a ZIP for PERSONAL_EXPORT_KEEP_DAYS days and then deleted by the
 * retention job. Each section is in the ZIP twice: `json/<section>.json` and `csv/<section>.csv`.
 *
 * Never in the export: password hash, token hashes and other secrets, other people's personal data
 * beyond what a row the person wrote names (e.g. the project of a membership).
 */
import type { Readable } from "node:stream";
import { and, asc, desc, eq, gt, inArray, lt, or, sql, type SQL } from "drizzle-orm";
import { ZipFile } from "yazl";
import { PERSONAL_EXPORT_KEEP_DAYS, type PersonalDataExportDto } from "@sitekeep/shared";
import type { Db } from "../../db/index.js";
import {
  auditLog,
  auditPersonal,
  companies,
  fileVersions,
  files,
  invitations,
  issueComments,
  issues,
  jobs,
  memberRoles,
  oauthClients,
  oauthConsents,
  outboundLog,
  privacyNoticeAcceptances,
  projectMembers,
  projectRoles,
  projects,
  reviews,
  tokens,
  users,
  workEvents,
  workReceipts,
  workTypes,
  workflowActions,
  workflowInstances,
  works,
} from "../../db/schema.js";
import type { Storage } from "../../core/platform/storage.js";
import { audit, auditEmail } from "../../core/platform/audit.js";
import { toCsv } from "../../docintel/export.js";
import { DEFAULT_LANGUAGE, tFor } from "../../i18n/index.js";

export const PERSONAL_EXPORT_JOB = "personal_data_export";
const DAY = 24 * 60 * 60 * 1000;
/** File contents (optional): at most this many files and bytes; the rest is listed in files.csv only. */
export const EXPORT_FILE_LIMIT = { count: 2000, bytes: 2 * 1024 ** 3 };

export interface PersonalExportPayload {
  subjectId: string;
  requestedBy: string;
  includeFiles: boolean;
  /** Requested by the person themselves (My account). */
  self?: boolean;
  /** Set when built. */
  resultKey?: string;
  size?: number;
  sections?: Record<string, number>;
}

type Row = Record<string, unknown>;

/** Preference keys that hold secrets (2FA and the like) never leave the server. */
const SECRET_PREF = /secret|totp|recovery|otp|token|hash/i;

function plain(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  return v;
}

function normalise(rows: Row[]): Row[] {
  return rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, plain(v)])));
}

/** CSV of rows: union of their keys as columns; objects and arrays as JSON. */
export function rowsToCsv(rows: Row[]): string {
  const header: string[] = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!header.includes(k)) header.push(k);
  const cell = (v: unknown): string | number =>
    v === null || v === undefined ? "" : typeof v === "number" ? v : typeof v === "object" ? JSON.stringify(v) : String(v);
  return toCsv(header, rows.map((r) => header.map((h) => cell(r[h]))));
}

/** Every section of the export (also used by tests). */
export async function collectPersonalData(db: Db, subjectId: string): Promise<Record<string, Row[]>> {
  const [u] = await db.select().from(users).where(eq(users.id, subjectId));
  if (!u) throw new Error(`user ${subjectId} not found`);
  const email = auditEmail(u.email);
  const prefs = Object.fromEntries(Object.entries(u.prefs ?? {}).filter(([k]) => !SECRET_PREF.test(k)));
  const out: Record<string, Row[]> = {};
  out.profile = [{ id: u.id, email: u.email, name: u.name, isAdmin: u.isAdmin, disabled: u.disabled, pending: u.pending, companyId: u.companyId, createdAt: u.createdAt, prefs }];
  out.company = u.companyId ? await db.select().from(companies).where(eq(companies.id, u.companyId)) : [];

  const roleRows = await db
    .select({ projectId: memberRoles.projectId, role: projectRoles.name, kind: projectRoles.kind })
    .from(memberRoles)
    .innerJoin(projectRoles, eq(projectRoles.id, memberRoles.roleId))
    .where(eq(memberRoles.userId, subjectId));
  const memberships = await db
    .select({
      projectId: projectMembers.projectId,
      projectCode: projects.code,
      projectName: projects.name,
      companyId: projectMembers.companyId,
      isProjectAdmin: projectMembers.isProjectAdmin,
      addedAt: projectMembers.addedAt,
    })
    .from(projectMembers)
    .innerJoin(projects, eq(projects.id, projectMembers.projectId))
    .where(eq(projectMembers.userId, subjectId))
    .orderBy(asc(projects.code));
  out.memberships = memberships.map((m) => ({
    ...m,
    roles: roleRows.filter((r) => r.projectId === m.projectId && r.kind !== "task_team").map((r) => r.role),
    taskTeams: roleRows.filter((r) => r.projectId === m.projectId && r.kind === "task_team").map((r) => r.role),
  }));

  out.issues = (
    await db
      .select({
        id: issues.id,
        projectCode: projects.code,
        number: issues.number,
        title: issues.title,
        description: issues.description,
        status: issues.status,
        priority: issues.priority,
        createdAt: issues.createdAt,
        updatedAt: issues.updatedAt,
        createdBy: issues.createdBy,
        assigneeUserId: issues.assigneeUserId,
        modifiedBy: issues.modifiedBy,
      })
      .from(issues)
      .innerJoin(projects, eq(projects.id, issues.projectId))
      .where(or(eq(issues.createdBy, subjectId), eq(issues.assigneeUserId, subjectId), eq(issues.modifiedBy, subjectId)))
      .orderBy(asc(issues.createdAt))
  ).map(({ createdBy, assigneeUserId, modifiedBy, ...r }) => ({
    ...r,
    relation: [createdBy === subjectId && "author", assigneeUserId === subjectId && "assignee", modifiedBy === subjectId && "last_editor"].filter(Boolean).join(","),
  }));
  out.issue_comments = await db
    .select({ id: issueComments.id, issueId: issueComments.issueId, issueNumber: issues.number, projectCode: projects.code, body: issueComments.body, createdAt: issueComments.createdAt, modifiedAt: issueComments.modifiedAt })
    .from(issueComments)
    .innerJoin(issues, eq(issues.id, issueComments.issueId))
    .innerJoin(projects, eq(projects.id, issues.projectId))
    .where(eq(issueComments.authorId, subjectId))
    .orderBy(asc(issueComments.createdAt));

  out.works = (
    await db
      .select({
        id: works.id,
        projectCode: projects.code,
        type: workTypes.name,
        category: workTypes.category,
        number: works.number,
        title: works.title,
        status: works.status,
        createdAt: works.createdAt,
        sentAt: works.sentAt,
        closedAt: works.closedAt,
        createdBy: works.createdBy,
        assigneeUserId: works.assigneeUserId,
      })
      .from(works)
      .innerJoin(projects, eq(projects.id, works.projectId))
      .innerJoin(workTypes, eq(workTypes.id, works.typeId))
      .where(or(eq(works.createdBy, subjectId), eq(works.assigneeUserId, subjectId)))
      .orderBy(asc(works.createdAt))
  ).map(({ createdBy, assigneeUserId, ...r }) => ({
    ...r,
    relation: [createdBy === subjectId && "author", assigneeUserId === subjectId && "assignee"].filter(Boolean).join(","),
  }));
  out.work_events = await db
    .select({ workId: workEvents.workId, workNumber: works.number, kind: workEvents.kind, message: workEvents.message, at: workEvents.at })
    .from(workEvents)
    .innerJoin(works, eq(works.id, workEvents.workId))
    .where(eq(workEvents.userId, subjectId))
    .orderBy(asc(workEvents.at));
  out.work_receipts = await db
    .select({ workId: workReceipts.workId, workNumber: works.number, companyId: workReceipts.companyId, receivedAt: workReceipts.receivedAt })
    .from(workReceipts)
    .innerJoin(works, eq(works.id, workReceipts.workId))
    .where(eq(workReceipts.receivedBy, subjectId));

  out.reviews = await db
    .select({ id: reviews.id, projectCode: projects.code, number: reviews.number, code: reviews.code, name: reviews.name, note: reviews.note, createdAt: reviews.createdAt })
    .from(reviews)
    .innerJoin(projects, eq(projects.id, reviews.projectId))
    .where(eq(reviews.createdBy, subjectId))
    .orderBy(asc(reviews.createdAt));
  out.review_steps = await db
    .select({
      instanceId: workflowActions.instanceId,
      subjectType: workflowInstances.subjectType,
      subjectId: workflowInstances.subjectId,
      projectCode: projects.code,
      stepIndex: workflowActions.stepIndex,
      kind: workflowActions.kind,
      outcome: workflowActions.outcome,
      comment: workflowActions.comment,
      at: workflowActions.at,
    })
    .from(workflowActions)
    .innerJoin(workflowInstances, eq(workflowInstances.id, workflowActions.instanceId))
    .innerJoin(projects, eq(projects.id, workflowInstances.projectId))
    .where(eq(workflowActions.userId, subjectId))
    .orderBy(asc(workflowActions.at));

  out.invitations = await db
    .select({
      id: invitations.id,
      email: invitations.email,
      projectId: invitations.projectId,
      invitedBy: invitations.invitedBy,
      createdAt: invitations.createdAt,
      expiresAt: invitations.expiresAt,
      acceptedAt: invitations.acceptedAt,
      revokedAt: invitations.revokedAt,
    })
    .from(invitations)
    .where(eq(invitations.userId, subjectId));

  // Audit rows the person wrote or that name them (failed sign-ins), with the personal part kept.
  const audits: Row[] = [];
  const personalIds = new Set(
    (
      await db
        .select({ id: auditPersonal.auditId })
        .from(auditPersonal)
        .where(or(eq(auditPersonal.userId, subjectId), eq(auditPersonal.email, email)))
    ).map((r) => r.id),
  );
  const auditWhere: SQL = or(eq(auditLog.userId, subjectId), personalIds.size ? inArray(auditLog.id, [...personalIds]) : undefined)!;
  for (let after = 0; ; ) {
    const page = await db
      .select({
        id: auditLog.id,
        at: auditLog.at,
        projectId: auditLog.projectId,
        action: auditLog.action,
        targetType: auditLog.targetType,
        targetId: auditLog.targetId,
        details: auditLog.details,
        hash: auditLog.hash,
        rowIp: auditLog.ip,
        rowUserAgent: auditLog.userAgent,
        ip: auditPersonal.ip,
        userAgent: auditPersonal.userAgent,
        email: auditPersonal.email,
      })
      .from(auditLog)
      .leftJoin(auditPersonal, eq(auditPersonal.auditId, auditLog.id))
      .where(and(gt(auditLog.id, after), auditWhere))
      .orderBy(asc(auditLog.id))
      .limit(5000);
    for (const { rowIp, rowUserAgent, ...r } of page) audits.push({ ...r, ip: r.ip ?? rowIp, userAgent: r.userAgent ?? rowUserAgent });
    if (page.length < 5000) break;
    after = page[page.length - 1]!.id;
  }
  out.audit_log = audits;

  out.outbound_log = await db
    .select({ at: outboundLog.at, purpose: outboundLog.purpose, connection: outboundLog.connection, host: outboundLog.host, method: outboundLog.method, blocked: outboundLog.blocked, status: outboundLog.status, projectId: outboundLog.projectId, details: outboundLog.details })
    .from(outboundLog)
    .where(eq(outboundLog.userId, subjectId))
    .orderBy(asc(outboundLog.at));

  // Keys without their values (only hashes are stored anyway, and those stay out too).
  out.access_keys = await db
    .select({
      id: tokens.id,
      kind: tokens.kind,
      name: tokens.name,
      scope: tokens.scope,
      projectIds: tokens.projectIds,
      oauthClient: oauthClients.name,
      oauthScopes: tokens.oauthScopes,
      createdAt: tokens.createdAt,
      expiresAt: tokens.expiresAt,
      lastUsedAt: tokens.lastUsedAt,
    })
    .from(tokens)
    .leftJoin(oauthClients, eq(oauthClients.id, tokens.oauthClientId))
    .where(eq(tokens.userId, subjectId))
    .orderBy(asc(tokens.createdAt));
  out.oauth_consents = await db
    .select({ client: oauthClients.name, scopes: oauthConsents.scopes, createdAt: oauthConsents.createdAt, lastUsedAt: oauthConsents.lastUsedAt })
    .from(oauthConsents)
    .innerJoin(oauthClients, eq(oauthClients.id, oauthConsents.clientId))
    .where(eq(oauthConsents.userId, subjectId));
  // Privacy notice versions the person accepted on the sign-in or invitation page (docs/features/PRIVACY_NOTICE.md).
  out.privacy_notice = await db
    .select({ version: privacyNoticeAcceptances.version, acceptedAt: privacyNoticeAcceptances.acceptedAt, via: privacyNoticeAcceptances.via })
    .from(privacyNoticeAcceptances)
    .where(eq(privacyNoticeAcceptances.userId, subjectId))
    .orderBy(asc(privacyNoticeAcceptances.version));

  out.files = await db
    .select({
      fileId: files.id,
      versionId: fileVersions.id,
      projectCode: projects.code,
      folderId: files.folderId,
      name: files.name,
      version: fileVersions.version,
      revisionCode: fileVersions.revisionCode,
      size: fileVersions.size,
      sha256: fileVersions.sha256,
      uploadedAt: fileVersions.uploadedAt,
      comment: fileVersions.comment,
      deletedAt: files.deletedAt,
      storageKey: fileVersions.storageKey,
    })
    .from(fileVersions)
    .innerJoin(files, eq(files.id, fileVersions.fileId))
    .innerJoin(projects, eq(projects.id, files.projectId))
    .where(eq(fileVersions.uploadedBy, subjectId))
    .orderBy(asc(fileVersions.uploadedAt));

  for (const k of Object.keys(out)) out[k] = normalise(out[k]!);
  return out;
}

const safeName = (s: string) => s.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").slice(0, 150);

/** Builds the ZIP of a queued export, stores it and records `user.data_exported`. */
export async function runPersonalExportJob(db: Db, storage: Storage, job: typeof jobs.$inferSelect): Promise<void> {
  const p = job.payload as unknown as PersonalExportPayload;
  const data = await collectPersonalData(db, p.subjectId);
  const t = tFor(DEFAULT_LANGUAGE);
  const zip = new ZipFile();
  const fileRows = data.files ?? [];
  const sections: Record<string, number> = {};
  for (const [name, rows] of Object.entries(data)) {
    // storageKey is internal: listed rows go without it.
    const shown = name === "files" ? rows.map(({ storageKey: _k, ...r }) => r) : rows;
    sections[name] = shown.length;
    zip.addBuffer(Buffer.from(JSON.stringify(shown, null, 2), "utf8"), `json/${name}.json`);
    zip.addBuffer(Buffer.from(rowsToCsv(shown), "utf8"), `csv/${name}.csv`);
  }
  let filesIncluded = 0;
  let bytes = 0;
  if (p.includeFiles)
    for (const f of fileRows) {
      const size = Number(f.size ?? 0);
      if (filesIncluded >= EXPORT_FILE_LIMIT.count || bytes + size > EXPORT_FILE_LIMIT.bytes) break;
      const key = String(f.storageKey);
      zip.addReadStreamLazy(`files/${safeName(String(f.projectCode))}/${safeName(String(f.fileId).slice(0, 8))}-v${f.version}-${safeName(String(f.name))}`, (cb) => {
        try {
          cb(null, storage.get(key));
        } catch (e) {
          cb(e as Error, undefined as unknown as Readable);
        }
      });
      filesIncluded++;
      bytes += size;
    }
  const readme = t("privacy:export.readme", {
    date: new Date().toISOString(),
    sections: Object.entries(sections)
      .map(([k, n]) => `- ${k}: ${n}`)
      .join("\n"),
    files: p.includeFiles ? t("privacy:export.filesIncluded", { count: filesIncluded, total: fileRows.length }) : t("privacy:export.filesListed"),
    days: PERSONAL_EXPORT_KEEP_DAYS,
  });
  zip.addBuffer(Buffer.from(readme, "utf8"), "README.txt");
  zip.end();
  const stored = await storage.put(zip.outputStream as unknown as Readable, "exports/personal");
  const size = await storage.size(stored.key);
  await db
    .update(jobs)
    .set({ payload: { ...p, resultKey: stored.key, size, sections } as unknown as Record<string, unknown> })
    .where(eq(jobs.id, job.id));
  await audit(db, {
    userId: p.requestedBy,
    action: "user.data_exported",
    targetType: "user",
    targetId: p.subjectId,
    details: { exportId: job.id, includeFiles: p.includeFiles, filesIncluded, size, self: !!p.self, sections },
    client: null,
  });
}

export function toExportDto(j: typeof jobs.$inferSelect): PersonalDataExportDto {
  const p = j.payload as unknown as PersonalExportPayload;
  return {
    id: j.id,
    userId: p.subjectId,
    status: j.status,
    requestedAt: j.createdAt.toISOString(),
    finishedAt: j.finishedAt?.toISOString() ?? null,
    size: p.size ?? null,
    includeFiles: !!p.includeFiles,
    expiresAt: j.finishedAt ? new Date(j.finishedAt.getTime() + PERSONAL_EXPORT_KEEP_DAYS * DAY).toISOString() : null,
    error: j.status === "failed" ? j.error : null,
  };
}

/** The person's exports, newest first. */
export async function listPersonalExports(db: Db, subjectId: string): Promise<PersonalDataExportDto[]> {
  const rows = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.kind, PERSONAL_EXPORT_JOB), sql`${jobs.payload}->>'subjectId' = ${subjectId}`))
    .orderBy(desc(jobs.createdAt))
    .limit(20);
  return rows.map(toExportDto);
}

export async function getPersonalExport(db: Db, id: string) {
  const [row] = await db.select().from(jobs).where(and(eq(jobs.id, id), eq(jobs.kind, PERSONAL_EXPORT_JOB)));
  return row ?? null;
}

/** Deletes exports (ZIP and job row) finished before `before`, or all of one person's; returns how many. */
export async function removeExpiredPersonalExports(db: Db, storage: Storage, before: Date | null, subjectId?: string): Promise<number> {
  const rows = await db
    .select()
    .from(jobs)
    .where(
      and(
        eq(jobs.kind, PERSONAL_EXPORT_JOB),
        before ? lt(jobs.finishedAt, before) : undefined,
        subjectId ? sql`${jobs.payload}->>'subjectId' = ${subjectId}` : undefined,
      ),
    );
  for (const r of rows) {
    const key = (r.payload as unknown as PersonalExportPayload).resultKey;
    if (key) await storage.remove(key).catch(() => undefined);
  }
  if (rows.length) await db.delete(jobs).where(inArray(jobs.id, rows.map((r) => r.id)));
  return rows.length;
}
