/**
 * The daily retention job (Privacy Centre → Retention; issue #85, docs/features/DATA_SUBJECT_RIGHTS.md#retention).
 * One run, a minute after start and then every 24 hours, does each step on its own (a failing step
 * is logged and does not stop the others):
 *
 *   outbound_log          outbound log rows older than logRetentionDays (default 90)
 *   audit_personal        IP address, user agent, e-mail of audit rows older than auditPersonalRetentionMonths (default 12)
 *   audit_log             audit rows older than auditLogRetentionYears (default unlimited), with a checkpoint (audit/truncate.ts)
 *   trash_files/_folders  recycle bin items deleted more than trashPurgeDays ago (default off)
 *   sessions              browser sessions past their expiry, absolute or idle limit (sign-in security, always)
 *   api_tokens, oauth_tokens, oauth_codes, oauth_refresh_tokens
 *                         expired credentials (always)
 *   invitations           invitations not accepted whose expiry or revocation is more than 30 days ago (always)
 *   personal_exports      personal data export ZIPs older than PERSONAL_EXPORT_KEEP_DAYS (always)
 *
 * Every category that deleted something gets a disposal_log row (the "disposal record", exported as
 * CSV for the KVKK periodic destruction report), and the run writes `retention.completed` to the
 * audit log with the counts.
 */
import { randomUUID } from "node:crypto";
import { and, eq, gte, isNotNull, isNull, lt, max, min, or, type SQL } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";
import { PERSONAL_EXPORT_KEEP_DAYS, type DisposalCategory } from "@sitekeep/shared";
import type { Db } from "../db/index.js";
import { auditPersonal, disposalLog, invitations, jobs, oauthCodes, oauthRefreshTokens, outboundLog, tokens } from "../db/schema.js";
import type { Storage } from "../core/platform/storage.js";
import { audit } from "../core/platform/audit.js";
import { expireAuditPersonal } from "../audit/personal.js";
import { truncateAuditLog } from "../audit/truncate.js";
import { purgeExpiredTrash } from "../modules/documents/trash-retention.js";
import { auditPersonalCutoff, privacyState, refreshPrivacyState } from "./settings.js";
import { cleanupOutboundLog } from "./outbound.js";
import { PERSONAL_EXPORT_JOB, removeExpiredPersonalExports } from "./subject/export.js";
import { endedSessionsWhere, readSignInSecurity } from "../auth/sign-in-security.js";

const DAY = 24 * 60 * 60 * 1000;
/** Expired or revoked invitations stay listed this long (the inviter can still see and resend them). */
export const INVITATION_KEEP_DAYS = 30;

export interface DisposalEntry {
  category: DisposalCategory;
  count: number;
  oldest: Date | null;
  newest: Date | null;
  basis: string;
  method: "delete" | "delete+storage";
  details?: Record<string, unknown>;
}

export interface RetentionResult {
  runId: string;
  entries: DisposalEntry[];
  failed: { category: string; error: string }[];
}

/** min/max of a time column over the rows a step is about to delete. */
async function timeSpan(db: Db, table: PgTable, col: AnyPgColumn, where: SQL | undefined): Promise<{ oldest: Date | null; newest: Date | null }> {
  const [r] = await db.select({ oldest: min(col), newest: max(col) }).from(table).where(where);
  const d = (v: unknown) => (v ? new Date(v as string) : null);
  return { oldest: d(r?.oldest), newest: d(r?.newest) };
}

export async function runRetention(db: Db, storage: Storage, now = new Date()): Promise<RetentionResult> {
  const settings = privacyState().settings;
  const runId = randomUUID();
  const entries: DisposalEntry[] = [];
  const failed: RetentionResult["failed"] = [];
  const step = async (category: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      failed.push({ category, error: e instanceof Error ? e.message.slice(0, 300) : String(e) });
    }
  };
  const add = (e: DisposalEntry) => {
    if (e.count > 0) entries.push(e);
  };

  await step("outbound_log", async () => {
    const cutoff = new Date(now.getTime() - settings.logRetentionDays * DAY);
    const s = await timeSpan(db, outboundLog, outboundLog.at, lt(outboundLog.at, cutoff));
    const count = await cleanupOutboundLog(db, now);
    add({ category: "outbound_log", count, ...s, basis: `logRetentionDays=${settings.logRetentionDays}`, method: "delete" });
  });

  await step("audit_personal", async () => {
    const cutoff = auditPersonalCutoff(now, settings.auditPersonalRetentionMonths);
    const s = await timeSpan(db, auditPersonal, auditPersonal.at, lt(auditPersonal.at, cutoff));
    const count = await expireAuditPersonal(db, now);
    add({ category: "audit_personal", count, ...s, basis: `auditPersonalRetentionMonths=${settings.auditPersonalRetentionMonths}`, method: "delete" });
  });

  await step("audit_log", async () => {
    const r = await truncateAuditLog(db, { now, years: settings.auditLogRetentionYears });
    if (r)
      add({
        category: "audit_log",
        count: r.removedRows,
        oldest: r.oldest,
        newest: r.newest,
        basis: `auditLogRetentionYears=${settings.auditLogRetentionYears}`,
        method: "delete",
        details: {
          truncationId: r.truncationId,
          removedFromId: r.removedFromId,
          removedToId: r.removedToId,
          removedHeadHash: r.removedHeadHash,
          newFirstId: r.newFirstId,
          removedPersonal: r.removedPersonal,
        },
      });
  });

  if (settings.trashPurgeDays)
    await step("trash", async () => {
      const days = settings.trashPurgeDays!;
      const r = await purgeExpiredTrash(db, storage, new Date(now.getTime() - days * DAY), { days });
      const basis = `trashPurgeDays=${days}`;
      add({ category: "trash_files", count: r.files, oldest: r.oldest, newest: r.newest, basis, method: "delete+storage", details: { versions: r.versions, removedObjects: r.removedObjects, skipped: r.skipped } });
      add({ category: "trash_folders", count: r.folders, oldest: r.oldest, newest: r.newest, basis, method: "delete" });
    });

  // Expired credentials: always.
  // Browser sessions also end at the absolute and idle limits (Administration → Sign-in Security, G-4).
  await step("sessions", async () => {
    const where = endedSessionsWhere(await readSignInSecurity(db), now.getTime());
    const s = await timeSpan(db, tokens, tokens.expiresAt, where);
    const rows = await db.delete(tokens).where(where).returning({ id: tokens.id });
    add({ category: "sessions", count: rows.length, ...s, basis: "expired, absolute or idle limit", method: "delete" });
  });
  const tokenKinds: [DisposalCategory, "api" | "oauth"][] = [
    ["api_tokens", "api"],
    ["oauth_tokens", "oauth"],
  ];
  for (const [category, kind] of tokenKinds)
    await step(category, async () => {
      const where = and(eq(tokens.kind, kind), isNotNull(tokens.expiresAt), lt(tokens.expiresAt, now));
      const s = await timeSpan(db, tokens, tokens.expiresAt, where);
      const rows = await db.delete(tokens).where(where).returning({ id: tokens.id });
      add({ category, count: rows.length, ...s, basis: "expired", method: "delete" });
    });
  await step("oauth_codes", async () => {
    const where = lt(oauthCodes.expiresAt, now);
    const s = await timeSpan(db, oauthCodes, oauthCodes.expiresAt, where);
    const rows = await db.delete(oauthCodes).where(where).returning({ id: oauthCodes.id });
    add({ category: "oauth_codes", count: rows.length, ...s, basis: "expired", method: "delete" });
  });
  await step("oauth_refresh_tokens", async () => {
    const where = lt(oauthRefreshTokens.expiresAt, now);
    const s = await timeSpan(db, oauthRefreshTokens, oauthRefreshTokens.expiresAt, where);
    const rows = await db.delete(oauthRefreshTokens).where(where).returning({ id: oauthRefreshTokens.id });
    add({ category: "oauth_refresh_tokens", count: rows.length, ...s, basis: "expired", method: "delete" });
  });
  await step("invitations", async () => {
    const keep = new Date(now.getTime() - INVITATION_KEEP_DAYS * DAY);
    const where = and(isNull(invitations.acceptedAt), or(lt(invitations.expiresAt, keep), lt(invitations.revokedAt, keep)));
    const s = await timeSpan(db, invitations, invitations.expiresAt, where);
    const rows = await db.delete(invitations).where(where).returning({ id: invitations.id });
    add({ category: "invitations", count: rows.length, ...s, basis: `expired or revoked > ${INVITATION_KEEP_DAYS} days`, method: "delete" });
  });
  await step("personal_exports", async () => {
    const before = new Date(now.getTime() - PERSONAL_EXPORT_KEEP_DAYS * DAY);
    const s = await timeSpan(db, jobs, jobs.finishedAt, and(eq(jobs.kind, PERSONAL_EXPORT_JOB), lt(jobs.finishedAt, before)));
    const count = await removeExpiredPersonalExports(db, storage, before);
    add({ category: "personal_exports", count, ...s, basis: `older than ${PERSONAL_EXPORT_KEEP_DAYS} days`, method: "delete+storage" });
  });

  if (entries.length)
    await db.insert(disposalLog).values(
      entries.map((e) => ({ runId, at: now, category: e.category, count: e.count, oldest: e.oldest, newest: e.newest, basis: e.basis, method: e.method, details: e.details ?? null })),
    );
  if (entries.length || failed.length)
    await audit(db, {
      action: "retention.completed",
      targetType: "system",
      details: {
        runId,
        deleted: Object.fromEntries(entries.map((e) => [e.category, e.count])),
        ...(failed.length && { failed: failed.map((f) => f.category) }),
      },
      client: null,
    });
  return { runId, entries, failed };
}

/** Daily retention job (first run a minute after start). Returns a stop function. */
export function startRetention(db: Db, storage: Storage, opts: { log?: (m: string, e?: unknown) => void } = {}): () => void {
  const run = () =>
    void refreshPrivacyState(db)
      .then(() => runRetention(db, storage))
      .then((r) => {
        for (const f of r.failed) opts.log?.(`retention step ${f.category} failed`, f.error);
      })
      .catch((e) => opts.log?.("retention job failed", e));
  const first = setTimeout(run, 60_000);
  const timer = setInterval(run, DAY);
  first.unref?.();
  timer.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}

/** Disposal record rows for the CSV (Privacy Centre → Retention), oldest first. */
export async function disposalRows(db: Db, range: { from?: Date; to?: Date } = {}) {
  return db
    .select()
    .from(disposalLog)
    .where(and(range.from ? gte(disposalLog.at, range.from) : undefined, range.to ? lt(disposalLog.at, range.to) : undefined))
    .orderBy(disposalLog.at, disposalLog.category)
    .limit(100_000);
}
