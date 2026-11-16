/**
 * Audit log retention (issue #85, docs/features/AUDIT_LOG.md#retention-and-truncation): deleting the
 * oldest rows without breaking `audit:verify`.
 *
 * The chain can only lose a prefix. The daily job deletes every row up to the last one written
 * before the cutoff (rows from before the chain included) and leaves a checkpoint that says where
 * the chain now starts:
 *
 *   audit_truncation   append-only: cutoff, deleted id range and counts, the hash of the last deleted
 *                      chained row (`removed_head_hash`) and the new first chained row;
 *   audit.truncated    a chained row with the same values, written in the same transaction.
 *
 * `verifyAuditChain` then expects the first chained row to point to `removed_head_hash` of the latest
 * checkpoint (instead of to nothing) and the matching `audit.truncated` row to be in the chain.
 * A head hash recorded outside the server before the truncation stays checkable as long as that row
 * is kept; the truncation itself shows in the chain from then on.
 */
import { and, asc, desc, gt, isNotNull, lt, lte, sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { auditLog, auditPersonal, auditTruncations } from "../db/schema.js";
import { audit } from "../core/platform/audit.js";
import { privacyState } from "../privacy/settings.js";
import { verifyAuditChain } from "./query.js";

export interface TruncateResult {
  truncationId: number;
  before: Date;
  removedRows: number;
  removedPersonal: number;
  removedFromId: number;
  removedToId: number;
  removedHeadHash: string | null;
  newFirstId: number;
  /** Time span of the deleted rows. */
  oldest: Date | null;
  newest: Date | null;
}

/** Rows written before this time are deleted (calendar years before `now`, UTC). */
export function auditLogCutoff(now: Date, years: number): Date {
  const d = new Date(now.getTime());
  const month = d.getUTCMonth();
  d.setUTCFullYear(d.getUTCFullYear() - years);
  // 29 February minus one year is 28 February, not 1 March.
  if (d.getUTCMonth() !== month) d.setUTCDate(0);
  return d;
}

/**
 * Deletes the audit rows older than the retention period (Privacy Centre → Retention → audit log,
 * years; nothing when unlimited) and writes the checkpoint. One transaction that holds the audit lock;
 * the chain must verify before and after, else nothing changes (the error is thrown).
 */
export async function truncateAuditLog(
  db: Db,
  opts: { now?: Date; years?: number | null; by?: { userId?: string | null } } = {},
): Promise<TruncateResult | null> {
  const years = opts.years === undefined ? privacyState().settings.auditLogRetentionYears : opts.years;
  if (!years) return null;
  const before = auditLogCutoff(opts.now ?? new Date(), years);
  // Cheap look first: most days there is nothing to delete.
  const [any] = await db.select({ id: auditLog.id }).from(auditLog).where(lt(auditLog.at, before)).limit(1);
  if (!any) return null;

  return db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    // Same locking as the re-seal (audit/personal.ts): table lock first, then the chain lock.
    await t.execute(sql`LOCK TABLE audit_log IN SHARE ROW EXCLUSIVE MODE`);
    await t.execute(sql`SELECT pg_advisory_xact_lock(hashtext('sitekeep.audit_log'))`);
    const check = await verifyAuditChain(t);
    if (!check.ok) throw new Error(`audit chain is broken at row ${check.broken!.id} (${check.broken!.reason}); retention truncation refused`);
    const head = check.head;
    const [last] = await t
      .select({ id: sql<number | null>`max(${auditLog.id})`.mapWith(Number) })
      .from(auditLog)
      .where(lt(auditLog.at, before));
    let toId = last?.id ? Number(last.id) : null;
    if (!toId) return null;
    // The head always stays (the chain needs a row to continue from).
    if (head && toId >= head.id) toId = head.id - 1;
    const [range] = await t
      .select({
        fromId: sql<number | null>`min(${auditLog.id})`.mapWith(Number),
        n: sql<number>`count(*)`.mapWith(Number),
        oldest: sql<string | null>`min(${auditLog.at})`,
        newest: sql<string | null>`max(${auditLog.at})`,
      })
      .from(auditLog)
      .where(lte(auditLog.id, toId));
    if (!range?.n) return null;
    const [removedHead] = await t
      .select({ hash: auditLog.hash })
      .from(auditLog)
      .where(and(lte(auditLog.id, toId), isNotNull(auditLog.hash)))
      .orderBy(desc(auditLog.id))
      .limit(1);
    const [nextFirst] = await t
      .select({ id: auditLog.id, prevHash: auditLog.prevHash })
      .from(auditLog)
      .where(and(gt(auditLog.id, toId), isNotNull(auditLog.hash)))
      .orderBy(asc(auditLog.id))
      .limit(1);
    if (!nextFirst) return null;
    const removedHeadHash = removedHead?.hash ?? null;
    if (removedHeadHash !== null && nextFirst.prevHash !== removedHeadHash) throw new Error("unexpected audit chain values");

    const personal = await t.delete(auditPersonal).where(lte(auditPersonal.auditId, toId)).returning({ id: auditPersonal.auditId });
    await t.execute(sql`ALTER TABLE audit_log DISABLE TRIGGER audit_log_immutable`);
    await t.delete(auditLog).where(lte(auditLog.id, toId));
    await t.execute(sql`ALTER TABLE audit_log ENABLE TRIGGER audit_log_immutable`);

    const values = {
      userId: opts.by?.userId ?? null,
      before,
      retentionYears: years,
      removedRows: Number(range.n),
      removedPersonal: personal.length,
      removedFromId: Number(range.fromId),
      removedToId: toId,
      removedHeadHash,
      newFirstId: nextFirst.id,
    };
    const [row] = await t.insert(auditTruncations).values(values).returning({ id: auditTruncations.id });
    await audit(t, {
      userId: values.userId,
      action: "audit.truncated",
      targetType: "system",
      details: {
        truncationId: row!.id,
        before: before.toISOString(),
        retentionYears: years,
        removedRows: values.removedRows,
        removedPersonal: values.removedPersonal,
        removedFromId: values.removedFromId,
        removedToId: toId,
        removedHeadHash,
        newFirstId: nextFirst.id,
      },
      client: null,
    });
    const after = await verifyAuditChain(t);
    if (!after.ok) throw new Error(`audit chain does not verify after the truncation (row ${after.broken!.id}, ${after.broken!.reason}); rolled back`);
    return {
      truncationId: row!.id,
      ...values,
      oldest: range.oldest ? new Date(range.oldest) : null,
      newest: range.newest ? new Date(range.newest) : null,
    };
  });
}
