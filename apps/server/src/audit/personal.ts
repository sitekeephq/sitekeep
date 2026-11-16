/**
 * Personal part of the audit log (P1-5, docs/features/AUDIT_LOG.md#personal-data): IP address, user
 * agent and e-mail addresses live in audit_personal, outside the hash chain, so they can be deleted
 * without touching a chained row:
 *
 *   expireAuditPersonal   the daily retention job (Privacy Centre → audit log retention, months)
 *   eraseAuditPersonal    one person's personal audit data (for the "anonymise user" request, P1-2)
 *   resealAuditChain      moves personal values out of rows chained before migration 0049: an
 *                         audited maintenance operation that recomputes the chain from the first
 *                         such row and archives every replaced hash (npm run audit:reseal)
 */
import { createHash } from "node:crypto";
import { and, asc, eq, gt, inArray, isNotNull, lt, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { auditLog, auditPersonal, auditResealHashes, auditReseals, users } from "../db/schema.js";
import { audit, auditEmail, auditPersonalHash, splitPersonalDetails } from "../core/platform/audit.js";
import { auditPersonalCutoff, privacyState, refreshPrivacyState } from "../privacy/settings.js";
import { resealArchiveLine, verifyAuditChain } from "./query.js";

const BATCH = 5000;

/** Deletes personal records matching `where`, in batches; returns how many. */
async function deletePersonal(db: Db, where: SQL): Promise<number> {
  let total = 0;
  for (;;) {
    const ids = (await db.select({ id: auditPersonal.auditId }).from(auditPersonal).where(where).limit(BATCH)).map((r) => r.id);
    if (!ids.length) return total;
    await db.delete(auditPersonal).where(inArray(auditPersonal.auditId, ids));
    total += ids.length;
    if (ids.length < BATCH) return total;
  }
}

// ---- Retention --------------------------------------------------------------------------------

/**
 * Deletes the personal part of audit rows older than the retention period and records how many
 * (`audit.personal_expired`, only when something was deleted). The chained rows stay.
 */
export async function expireAuditPersonal(db: Db, now = new Date()): Promise<number> {
  const months = privacyState().settings.auditPersonalRetentionMonths;
  const before = auditPersonalCutoff(now, months);
  const deleted = await deletePersonal(db, lt(auditPersonal.at, before));
  if (deleted)
    await audit(db, {
      action: "audit.personal_expired",
      targetType: "system",
      details: { deleted, before: before.toISOString(), retentionMonths: months },
      client: null,
    });
  return deleted;
}

/** Daily retention job (first run a minute after start). Returns a stop function. */
export function startAuditPersonalRetention(db: Db, opts: { log?: (m: string, e?: unknown) => void } = {}): () => void {
  const run = () =>
    void refreshPrivacyState(db)
      .then(() => expireAuditPersonal(db))
      .catch((e) => opts.log?.("audit personal data retention failed", e));
  const first = setTimeout(run, 60_000);
  const timer = setInterval(run, 24 * 60 * 60 * 1000);
  first.unref?.();
  timer.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}

// ---- Erasure of one person ----------------------------------------------------------------------

/**
 * Deletes one person's personal audit data: the records of rows they wrote and of rows that name
 * their e-mail address (failed logins, invitations). Their chained rows stay under their user id,
 * a pseudonym once the account is anonymised (P1-2). Records `audit.personal_erased` with the count.
 * Rows chained before 0049 and not yet re-sealed keep their in-row values: run a re-seal first.
 */
export async function eraseAuditPersonal(db: Db, subject: { userId: string; email?: string | null }, by: { userId?: string | null } = {}): Promise<number> {
  let email = subject.email ?? null;
  if (email === null) {
    const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, subject.userId));
    email = u?.email ?? null;
  }
  const deleted = await deletePersonal(db, or(eq(auditPersonal.userId, subject.userId), email ? eq(auditPersonal.email, auditEmail(email)) : undefined)!);
  await audit(db, {
    userId: by.userId ?? null,
    action: "audit.personal_erased",
    targetType: "user",
    targetId: subject.userId,
    details: { deleted },
    client: null,
  });
  return deleted;
}

// ---- Re-seal ----------------------------------------------------------------------------------------

export interface ResealResult {
  resealed: boolean;
  resealId: number | null;
  fromId: number | null;
  rowsRewritten: number;
  personalMoved: number;
  oldHead: { id: number; hash: string } | null;
  newHeadHash: string | null;
}

const HEX64 = /^[0-9a-f]{64}$/;

/** Chained rows that still carry personal values in the row itself (written before 0049). */
const inRowPersonal = sql`(${auditLog.ip} IS NOT NULL OR ${auditLog.userAgent} IS NOT NULL OR (jsonb_typeof(${auditLog.details}) = 'object' AND jsonb_typeof(${auditLog.details}->'email') = 'string'))`;

/**
 * Moves the personal values of chained rows written before migration 0049 into audit_personal and
 * recomputes the chain from the first such row, in one transaction that holds the audit lock:
 *
 *   1. the chain must verify as it is (else nothing happens);
 *   2. every chained row from the first one with personal values to the head is archived with its
 *      old prev_hash and hash (audit_reseal_hash), the archive's digest is computed;
 *   3. the personal values move (personal_hash and details.emailHash take their place) and each of
 *      those rows gets its new prev_hash and hash, in id order (the immutable trigger is disabled for
 *      the length of this transaction only);
 *   4. audit_reseal records the old and new head and the digest, and the chained row
 *      `audit.resealed` records the same: it is the checkpoint the new segment starts from;
 *   5. the chain must verify again, or everything is rolled back.
 *
 * An old head hash recorded outside the server stays findable in audit_reseal_hash, and
 * `audit:verify` checks that the archive still gives the digest the checkpoint row holds.
 */
export async function resealAuditChain(db: Db, by: { userId?: string | null } = {}): Promise<ResealResult> {
  return db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    // The table lock first (writers wait before their trigger takes the advisory lock, so the
    // trigger switch below cannot deadlock with them), then the chain lock. Readers carry on.
    await t.execute(sql`LOCK TABLE audit_log IN SHARE ROW EXCLUSIVE MODE`);
    await t.execute(sql`SELECT pg_advisory_xact_lock(hashtext('sitekeep.audit_log'))`);
    const before = await verifyAuditChain(t);
    if (!before.ok) throw new Error(`audit chain is broken at row ${before.broken!.id} (${before.broken!.reason}); re-seal refused`);
    const none: ResealResult = { resealed: false, resealId: null, fromId: null, rowsRewritten: 0, personalMoved: 0, oldHead: null, newHeadHash: null };
    if (!before.head) return none;
    const [start] = await t
      .select({ id: sql<number | null>`min(${auditLog.id})`.mapWith(Number) })
      .from(auditLog)
      .where(and(isNotNull(auditLog.hash), inRowPersonal));
    const fromId = start?.id ? Number(start.id) : null;
    if (!fromId) return none;
    const head = before.head;

    // 2. Archive of the hashes about to change.
    const archive: { rowId: number; oldPrevHash: string | null; oldHash: string }[] = [];
    for (let after = fromId - 1; ; ) {
      const rows = await t
        .select({ rowId: auditLog.id, oldPrevHash: auditLog.prevHash, oldHash: auditLog.hash })
        .from(auditLog)
        .where(and(gt(auditLog.id, after), sql`${auditLog.id} <= ${head.id}`))
        .orderBy(asc(auditLog.id))
        .limit(BATCH);
      for (const r of rows) archive.push({ rowId: r.rowId, oldPrevHash: r.oldPrevHash, oldHash: r.oldHash! });
      if (rows.length < BATCH) break;
      after = rows[rows.length - 1]!.rowId;
    }
    const digest = createHash("sha256");
    for (const r of archive) digest.update(resealArchiveLine(r));
    const archiveDigest = digest.digest("hex");
    const firstPrev = archive[0]!.oldPrevHash;

    await t.execute(sql`ALTER TABLE audit_log DISABLE TRIGGER audit_log_immutable`);
    // 3a. Personal values out of the rows.
    let personalMoved = 0;
    for (let after = fromId - 1; ; ) {
      const rows = await t
        .select({ id: auditLog.id, at: auditLog.at, userId: auditLog.userId, ip: auditLog.ip, userAgent: auditLog.userAgent, details: auditLog.details })
        .from(auditLog)
        .where(and(gt(auditLog.id, after), sql`${auditLog.id} <= ${head.id}`, inRowPersonal))
        .orderBy(asc(auditLog.id))
        .limit(1000);
      if (!rows.length) break;
      const moved = rows.map((r) => {
        const { details, email } = splitPersonalDetails(r.details);
        const p = { ip: r.ip, userAgent: r.userAgent, email };
        return { ...r, details, email, personalHash: auditPersonalHash(p) };
      });
      await t
        .insert(auditPersonal)
        .values(moved.map((m) => ({ auditId: m.id, at: m.at, userId: m.userId, ip: m.ip, userAgent: m.userAgent, email: m.email })));
      const values = sql.join(
        moved.map((m) => sql`(${m.id}::bigint, ${m.details === null ? null : JSON.stringify(m.details)}::jsonb, ${m.personalHash})`),
        sql`, `,
      );
      await t.execute(sql`
        UPDATE audit_log a SET ip = NULL, user_agent = NULL, details = v.details, personal_hash = v.personal_hash
        FROM (VALUES ${values}) AS v(id, details, personal_hash) WHERE a.id = v.id`);
      personalMoved += moved.length;
      after = rows[rows.length - 1]!.id;
    }
    // 3b. The chain from fromId to the old head, recomputed in id order by the database's own hash.
    if (!Number.isSafeInteger(fromId) || !Number.isSafeInteger(head.id) || (firstPrev !== null && !HEX64.test(firstPrev)))
      throw new Error("unexpected audit chain values");
    await t.execute(
      sql.raw(`DO $reseal$
DECLARE p text := ${firstPrev === null ? "NULL" : `'${firstPrev}'`}; r record;
BEGIN
  FOR r IN SELECT id FROM audit_log WHERE id >= ${fromId} AND id <= ${head.id} ORDER BY id LOOP
    UPDATE audit_log a SET prev_hash = p, hash = audit_log_hash(p, a) WHERE a.id = r.id RETURNING a.hash INTO p;
  END LOOP;
END
$reseal$`),
    );
    await t.execute(sql`ALTER TABLE audit_log ENABLE TRIGGER audit_log_immutable`);
    const [newHead] = await t.select({ hash: auditLog.hash }).from(auditLog).where(eq(auditLog.id, head.id));

    // 4. The checkpoint.
    const [seal] = await t
      .insert(auditReseals)
      .values({
        userId: by.userId ?? null,
        fromId,
        oldHeadId: head.id,
        oldHeadHash: head.hash,
        newHeadHash: newHead!.hash!,
        rowsRewritten: archive.length,
        personalMoved,
        archiveDigest,
      })
      .returning({ id: auditReseals.id });
    for (let i = 0; i < archive.length; i += 1000)
      await t.insert(auditResealHashes).values(archive.slice(i, i + 1000).map((r) => ({ resealId: seal!.id, ...r })));
    await audit(t, {
      userId: by.userId ?? null,
      action: "audit.resealed",
      targetType: "system",
      details: {
        resealId: seal!.id,
        fromId,
        oldHead: { id: head.id, hash: head.hash },
        newHeadHash: newHead!.hash,
        rowsRewritten: archive.length,
        personalMoved,
        archiveDigest,
      },
      client: null,
    });

    // 5. Still intact, or nothing happened.
    const after = await verifyAuditChain(t);
    if (!after.ok) throw new Error(`audit chain does not verify after the re-seal (row ${after.broken!.id}, ${after.broken!.reason}); rolled back`);
    return { resealed: true, resealId: seal!.id, fromId, rowsRewritten: archive.length, personalMoved, oldHead: { id: head.id, hash: head.hash }, newHeadHash: newHead!.hash };
  });
}

/** Chained rows that still hold personal values in the row (to be re-sealed). */
export async function chainedRowsWithPersonalData(db: Db): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(auditLog)
    .where(and(isNotNull(auditLog.hash), inRowPersonal));
  return r?.n ?? 0;
}

