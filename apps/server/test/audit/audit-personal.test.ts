/**
 * P1-5 personal data in the audit log (docs/features/AUDIT_LOG.md#personal-data, migration
 * 0049_audit_personal): IP address, user agent and e-mail live in audit_personal, outside the
 * chain; the chained row keeps a keyed hash. Retention, erasure of one person, the migration of
 * existing rows and the re-seal of rows chained before it, each followed by the chain check.
 * Runs on PGlite (the test database); the same SQL runs on PostgreSQL.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, asc, eq, sql } from "drizzle-orm";
import type { AuditPageDto, AuditVerifyDto, PrivacySummaryDto } from "@sitekeep/shared";
import { buildApp } from "../../src/app/build-app.js";
import { hashPassword } from "../../src/core/security/auth.js";
import { openDb, type Db, type DbHandle } from "../../src/db/index.js";
import * as schema from "../../src/db/schema.js";
import { auditLog, auditPersonal, auditResealHashes, auditReseals, users } from "../../src/db/schema.js";
import { JobQueue } from "../../src/jobs/queue.js";
import { LocalStorage } from "../../src/core/platform/storage.js";
import { audit, auditEmailHash, setAuditPersonalKey } from "../../src/core/platform/audit.js";
import { verifyAuditChain } from "../../src/audit/query.js";
import { chainedRowsWithPersonalData, eraseAuditPersonal, expireAuditPersonal, resealAuditChain } from "../../src/audit/personal.js";
import { loadPrivacyState } from "../../src/privacy/settings.js";

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../drizzle");
const PW = "Sifre-1234567";
const UA = "Mozilla/5.0 (PersonalTest)";
const IP = "203.0.113.9";

let handle: DbHandle;
let app: FastifyInstance;
let dataDir: string;
let adminCookie: string;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "7dcde-audit-personal-"));
  handle = await openDb("memory://");
  const storage = new LocalStorage(path.join(dataDir, "storage"));
  app = await buildApp({ db: handle.db, storage, jobs: new JobQueue(handle.db, storage), secretKey: randomBytes(32) });
  await handle.db.insert(users).values({ email: "admin@7d.test", name: "Admin", passwordHash: await hashPassword(PW), isAdmin: true });
  await handle.db.insert(users).values({ email: "kisi@7d.test", name: "Kişi", passwordHash: await hashPassword(PW) });
  adminCookie = await login("admin@7d.test");
});

afterAll(async () => {
  await app.close();
  await handle.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function call(method: "GET" | "PUT" | "POST", url: string, opts: { cookie?: string; payload?: unknown; ip?: string } = {}) {
  const res = await app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { ...(opts.cookie && { cookie: opts.cookie }), "user-agent": UA },
    remoteAddress: opts.ip ?? IP,
    payload: opts.payload as object,
  });
  let body: any = null;
  try {
    body = res.body ? res.json() : null;
  } catch {
    body = res.body;
  }
  return { status: res.statusCode, body, text: res.body };
}

async function login(email: string, password = PW, ip = IP): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password }, headers: { "user-agent": UA }, remoteAddress: ip });
  if (res.statusCode !== 200) return "";
  return `cde_session=${res.cookies.find((c) => c.name === "cde_session")!.value}`;
}

const lastRow = async (action: string) => {
  const rows = await handle.db.select().from(auditLog).where(eq(auditLog.action, action)).orderBy(asc(auditLog.id));
  return rows.at(-1)!;
};
const personalOf = async (id: number) => (await handle.db.select().from(auditPersonal).where(eq(auditPersonal.auditId, id)))[0];
const userId = async (email: string) => (await handle.db.select({ id: users.id }).from(users).where(eq(users.email, email)))[0]!.id;

describe("ISO19650-2 5.1.7(d) audit: personal data outside the chain (migration 0049)", () => {
  it("writes the client of new rows to audit_personal; the chained row keeps only its keyed hash", async () => {
    const row = await lastRow("auth.login");
    expect(row).toMatchObject({ ip: null, userAgent: null });
    expect(row.personalHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await personalOf(row.id)).toMatchObject({ ip: IP, userAgent: UA, email: null, userId: row.userId });
    // Background work: no client, no personal record, no hash.
    await audit(handle.db, { action: "test.background" });
    const bg = await lastRow("test.background");
    expect(bg.personalHash).toBeNull();
    expect(await personalOf(bg.id)).toBeUndefined();

    const v = await verifyAuditChain(handle.db);
    expect(v).toMatchObject({ ok: true, broken: null });
    expect(v.personalChecked).toBeGreaterThan(0);
    // The API shows the client from audit_personal.
    const page = (await call("GET", `/admin/audit?action=auth.login`, { cookie: adminCookie })).body as AuditPageDto;
    expect(page.entries[0]).toMatchObject({ ip: IP, userAgent: UA });
    expect(page.entries[0]!.personalRemoved).toBeUndefined();
  });

  it("stores the hash of the e-mail of a failed login, and the account when it is known", async () => {
    expect(await login("nobody@7d.test", "wrong-password-1")).toBe("");
    expect(await login("NOBODY@7d.test", "wrong-password-2")).toBe("");
    const unknown = (await handle.db.select().from(auditLog).where(eq(auditLog.action, "auth.login_failed")).orderBy(asc(auditLog.id))).slice(-2);
    for (const r of unknown) {
      expect(r.userId).toBeNull();
      expect(r.details).toEqual({ emailHash: auditEmailHash("nobody@7d.test") });
      expect(JSON.stringify(r)).not.toContain("nobody@");
      expect(await personalOf(r.id)).toMatchObject({ email: "nobody@7d.test", ip: IP });
    }
    // Same address, same hash: repeated attempts stay visible after the address is gone.
    expect(unknown[0]!.details).toEqual(unknown[1]!.details);

    expect(await login("kisi@7d.test", "wrong-password-3")).toBe("");
    const known = await lastRow("auth.login_failed");
    expect(known.userId).toBe(await userId("kisi@7d.test"));
    expect(known.details).toEqual({ emailHash: auditEmailHash("kisi@7d.test") });

    // Administrators see the address in the log while it is kept.
    const page = (await call("GET", `/admin/audit?action=auth.login_failed&limit=1`, { cookie: adminCookie })).body as AuditPageDto;
    expect(page.entries[0]!.details).toMatchObject({ email: "kisi@7d.test", emailHash: auditEmailHash("kisi@7d.test") });
    expect((await verifyAuditChain(handle.db)).ok).toBe(true);
  });

  it("finds a changed personal record", async () => {
    const row = await lastRow("auth.login");
    await handle.db.update(auditPersonal).set({ ip: "192.0.2.66" }).where(eq(auditPersonal.auditId, row.id));
    expect(await verifyAuditChain(handle.db)).toMatchObject({ ok: false, broken: { id: row.id, reason: "personal_mismatch" } });
    // Without the installation's key only the link is checked.
    expect(await verifyAuditChain(handle.db, 2000, { personalKey: null })).toMatchObject({ ok: true, personalChecked: null });
    await handle.db.update(auditPersonal).set({ ip: IP }).where(eq(auditPersonal.auditId, row.id));
    expect((await verifyAuditChain(handle.db)).ok).toBe(true);
  });

  it("erases one person's personal audit data and keeps their rows", async () => {
    const kisi = await userId("kisi@7d.test");
    const cookie = await login("kisi@7d.test");
    expect(cookie).not.toBe("");
    // A row another person wrote that names their address (an invitation, say).
    await audit(handle.db, { userId: await userId("admin@7d.test"), action: "test.invited", details: { email: "Kisi@7d.test" }, client: { ip: "198.51.100.1", userAgent: "admin-browser" } });
    const invited = await lastRow("test.invited");
    const theirs = await handle.db.select().from(auditPersonal).where(eq(auditPersonal.userId, kisi));
    expect(theirs.length).toBeGreaterThanOrEqual(2);
    const rowsBefore = (await handle.db.select({ id: auditLog.id }).from(auditLog)).length;

    const deleted = await eraseAuditPersonal(handle.db, { userId: kisi }, { userId: await userId("admin@7d.test") });
    expect(deleted).toBe(theirs.length + 1);
    expect(await handle.db.select().from(auditPersonal).where(eq(auditPersonal.userId, kisi))).toEqual([]);
    expect(await handle.db.select().from(auditPersonal).where(eq(auditPersonal.email, "kisi@7d.test"))).toEqual([]);
    expect(await personalOf(invited.id)).toBeUndefined();
    // Other people's records stay; every row stays, plus the record of the erasure.
    const others = await handle.db.select().from(auditPersonal).where(eq(auditPersonal.ip, IP));
    expect(others.length).toBeGreaterThan(0);
    expect((await handle.db.select({ id: auditLog.id }).from(auditLog)).length).toBe(rowsBefore + 1);
    expect(await lastRow("audit.personal_erased")).toMatchObject({ targetType: "user", targetId: kisi, details: { deleted }, personalHash: null });
    expect((await verifyAuditChain(handle.db)).ok).toBe(true);

    const page = (await call("GET", `/admin/audit?userId=${kisi}&action=auth.login`, { cookie: adminCookie })).body as AuditPageDto;
    expect(page.entries[0]).toMatchObject({ ip: null, userAgent: null, personalRemoved: "erased" });
  });

  it("sets the retention in the Privacy Centre within bounds (default 12 months)", async () => {
    const before = (await call("GET", "/admin/privacy", { cookie: adminCookie })).body as PrivacySummaryDto;
    expect(before.settings.auditPersonalRetentionMonths).toBe(12);
    expect((await call("PUT", "/admin/privacy/settings", { cookie: adminCookie, payload: { auditPersonalRetentionMonths: 0 } })).status).toBe(400);
    expect((await call("PUT", "/admin/privacy/settings", { cookie: adminCookie, payload: { auditPersonalRetentionMonths: 121 } })).status).toBe(400);
    const r = await call("PUT", "/admin/privacy/settings", { cookie: adminCookie, payload: { auditPersonalRetentionMonths: 6 } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((r.body as PrivacySummaryDto).settings.auditPersonalRetentionMonths).toBe(6);
    expect(await lastRow("settings.privacy_updated")).toMatchObject({ details: { auditPersonalRetentionMonths: 6 } });
  });

  it("deletes expired personal records daily, records the count and the chain still verifies", async () => {
    await loadPrivacyState(handle.db);
    const kept = await handle.db.select().from(auditPersonal);
    expect(kept.length).toBeGreaterThan(0);
    // Nothing is older than six months yet.
    expect(await expireAuditPersonal(handle.db)).toBe(0);
    expect(await handle.db.select().from(auditLog).where(eq(auditLog.action, "audit.personal_expired"))).toEqual([]);

    const later = new Date(Date.now() + 200 * 86_400_000);
    expect(await expireAuditPersonal(handle.db, later)).toBe(kept.length);
    expect(await handle.db.select().from(auditPersonal)).toEqual([]);
    const rec = await lastRow("audit.personal_expired");
    expect(rec).toMatchObject({ targetType: "system", personalHash: null, details: { deleted: kept.length, retentionMonths: 6 } });
    const v = (await call("GET", "/admin/audit/verify", { cookie: adminCookie })).body as AuditVerifyDto;
    expect(v).toMatchObject({ ok: true, broken: null });

    // Screen and CSV: "deleted (retention)" once the period has passed.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(later);
    try {
      // A session of that day (the earlier one has expired by then); its own login row keeps its client.
      const cookie = await login("admin@7d.test");
      const page = (await call("GET", `/admin/audit?action=auth.login&limit=2`, { cookie })).body as AuditPageDto;
      expect(page.entries[0]).toMatchObject({ ip: IP, userAgent: UA });
      expect(page.entries[1]).toMatchObject({ ip: null, userAgent: null, personalRemoved: "retention" });
      const csv = await call("GET", `/admin/audit.csv?action=auth.login_failed&lang=en`, { cookie });
      expect(csv.status).toBe(200);
      expect(csv.text).toContain("deleted (retention);deleted (retention)");
      const tr = await call("GET", `/admin/audit.csv?action=auth.login_failed&lang=tr`, { cookie });
      expect(tr.text).toContain("silindi (saklama süresi)");
    } finally {
      vi.useRealTimers();
    }
  });
});

/** A PGlite database migrated up to (not including) migration `idx`. */
async function databaseBefore(idx: number): Promise<{ client: PGlite; db: Db; dir: string; finish(): Promise<void> }> {
  const dir = mkdtempSync(path.join(os.tmpdir(), `7dcde-mig${idx}-`));
  cpSync(MIGRATIONS, dir, { recursive: true });
  const journalPath = path.join(dir, "meta/_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { idx: number }[] };
  journal.entries = journal.entries.filter((e) => e.idx < idx);
  writeFileSync(journalPath, JSON.stringify(journal));
  const client = new PGlite();
  await migrate(drizzle(client, { schema }), { migrationsFolder: dir });
  return {
    client,
    dir,
    db: drizzle(client, { schema }) as unknown as Db,
    finish: () => migrate(drizzle(client, { schema }), { migrationsFolder: MIGRATIONS }),
  };
}

describe("ISO19650-2 5.1.7(d) audit: existing rows and the re-seal (migration 0049)", () => {
  it("moves the personal values of rows from before the chain, in batches, and leaves chained rows as they are", async () => {
    const before43 = await databaseBefore(43);
    try {
      const { client, db } = before43;
      // 6 001 rows from before the chain (more than one batch), some with a client and an e-mail.
      await client.query(`insert into audit_log (action, ip, user_agent, details)
        select 'old.row', case when g % 2 = 0 then '10.0.0.' || (g % 250) end, case when g % 3 = 0 then 'ua-' || g end,
               case when g % 1000 = 0 then jsonb_build_object('email', 'Old' || g || '@7d.test', 'n', g) else jsonb_build_object('n', g) end
        from generate_series(1, 6000) g`);
      await client.query(`insert into audit_log (action, details) values ('old.array', '["email"]')`);
      // Up to 0048: the chain starts, then rows chained with the client in the row (as written before 0049).
      const dir48 = path.join(before43.dir, "..", path.basename(before43.dir) + "-48");
      cpSync(MIGRATIONS, dir48, { recursive: true });
      const journalPath = path.join(dir48, "meta/_journal.json");
      const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { idx: number }[] };
      journal.entries = journal.entries.filter((e) => e.idx < 49);
      writeFileSync(journalPath, JSON.stringify(journal));
      await migrate(drizzle(client, { schema }), { migrationsFolder: dir48 });
      rmSync(dir48, { recursive: true, force: true });
      await client.query(`insert into audit_log (action, ip, user_agent) values ('chained.client', '192.0.2.1', 'ua-chained')`);
      await client.query(`insert into audit_log (action, details) values ('auth.login_failed', '{"email": "Who@7d.test"}')`);
      await client.query(`insert into audit_log (action, details) values ('chained.plain', '{"n": 1}')`);
      const headBefore = (await client.query<{ hash: string }>(`select hash from audit_log order by id desc limit 1`)).rows[0]!.hash;

      const started = Date.now();
      await before43.finish();
      expect(Date.now() - started).toBeLessThan(20_000);

      const legacy = await db.select().from(auditLog).where(eq(auditLog.action, "old.row")).orderBy(asc(auditLog.id));
      expect(legacy).toHaveLength(6000);
      expect(legacy.every((r) => r.ip === null && r.userAgent === null && r.hash === null && !("email" in (r.details ?? {})))).toBe(true);
      const moved = await db.select().from(auditPersonal);
      // Rows with an IP (every 2nd), a user agent (every 3rd) or an e-mail (every 1000th, all even).
      expect(moved).toHaveLength(3000 + 2000 - 1000);
      const withEmail = moved.filter((m) => m.email);
      expect(withEmail).toHaveLength(6);
      expect(withEmail[0]!.email).toBe("old1000@7d.test");
      expect(legacy[999]!.details).toEqual({ n: 1000 });
      const [arr] = await db.select().from(auditLog).where(eq(auditLog.action, "old.array"));
      expect(arr!.details).toEqual(["email"]);

      // Chained rows untouched: same values, same head, the chain verifies.
      const [chained] = await db.select().from(auditLog).where(eq(auditLog.action, "chained.client"));
      expect(chained).toMatchObject({ ip: "192.0.2.1", userAgent: "ua-chained", personalHash: null });
      expect(await chainedRowsWithPersonalData(db)).toBe(2);
      const [split] = await db.select().from(auditLog).where(eq(auditLog.action, "audit.personal_split"));
      expect(split!.prevHash).toBe(headBefore);
      expect(split!.details).toEqual({ migration: "0049_audit_personal", legacyRowsMoved: 4000, chainedRowsWithPersonalData: 2 });
      expect(await verifyAuditChain(db)).toMatchObject({ ok: true, legacyRows: 6001, broken: null });
    } finally {
      await before43.client.close();
      rmSync(before43.dir, { recursive: true, force: true });
    }
  });

  it("re-seals rows chained before 0049: personal values out, old hashes archived, a checkpoint row, chain intact", async () => {
    const before49 = await databaseBefore(49);
    try {
      const { client, db } = before49;
      for (let i = 0; i < 30; i++)
        await client.query(`insert into audit_log (action, ip, user_agent, details) values ($1, $2, $3, $4)`, [
          i % 3 === 0 ? "chained.plain" : "chained.client",
          i % 3 === 0 ? null : `192.0.2.${i}`,
          i % 3 === 0 ? null : "ua",
          i === 5 ? { email: "Old@7d.test" } : { i },
        ]);
      await before49.finish();
      const oldHead = (await verifyAuditChain(db)).head!;
      const firstPersonal = (await db.select().from(auditLog).where(eq(auditLog.action, "chained.client")).orderBy(asc(auditLog.id)))[0]!;
      setAuditPersonalKey(randomBytes(32));

      const r = await resealAuditChain(db);
      expect(r).toMatchObject({ resealed: true, fromId: firstPersonal.id, personalMoved: 20, oldHead: { id: oldHead.id, hash: oldHead.hash } });
      expect(await chainedRowsWithPersonalData(db)).toBe(0);
      const rows = await db.select().from(auditLog).where(sql`${auditLog.action} like 'chained.%'`).orderBy(asc(auditLog.id));
      expect(rows.every((x) => x.ip === null && x.userAgent === null)).toBe(true);
      const withEmail = rows.find((x) => x.details && "emailHash" in x.details)!;
      expect(withEmail.details).toEqual({ emailHash: auditEmailHash("old@7d.test") });
      expect((await db.select().from(auditPersonal).where(eq(auditPersonal.auditId, withEmail.id)))[0]).toMatchObject({ email: "old@7d.test", ip: "192.0.2.5" });

      // The old head hash is findable in the archive; the checkpoint row records both heads.
      const [archived] = await db.select().from(auditResealHashes).where(eq(auditResealHashes.oldHash, oldHead.hash));
      expect(archived).toMatchObject({ resealId: r.resealId, rowId: oldHead.id });
      const [seal] = await db.select().from(auditReseals);
      expect(seal).toMatchObject({ oldHeadHash: oldHead.hash, newHeadHash: r.newHeadHash, rowsRewritten: r.rowsRewritten });
      const [checkpoint] = await db.select().from(auditLog).where(eq(auditLog.action, "audit.resealed"));
      expect(checkpoint!.prevHash).toBe(r.newHeadHash);
      expect(checkpoint!.details).toMatchObject({ resealId: r.resealId, oldHead: { id: oldHead.id, hash: oldHead.hash }, archiveDigest: seal!.archiveDigest });
      expect(await verifyAuditChain(db)).toMatchObject({ ok: true, broken: null, personalChecked: 20 });

      // A second run has nothing to do; the archive is append-only and a changed archive is found.
      expect(await resealAuditChain(db)).toMatchObject({ resealed: false });
      const refused = (await client.query(`delete from audit_reseal_hash`).catch((e: unknown) => e)) as Error;
      expect(String(refused.message)).toMatch(/audit_reseal_hash is append-only/);
      await client.query(`alter table audit_reseal_hash disable trigger audit_reseal_hash_immutable`);
      await client.query(`update audit_reseal_hash set old_hash = repeat('0', 64) where row_id = ${oldHead.id}`);
      expect(await verifyAuditChain(db)).toMatchObject({ ok: false, broken: { id: checkpoint!.id, reason: "reseal_archive_mismatch" } });
    } finally {
      await before49.client.close();
      rmSync(before49.dir, { recursive: true, force: true });
    }
  });

  it("refuses to re-seal a broken chain and changes nothing", async () => {
    const own = await openDb("memory://");
    try {
      await audit(own.db, { action: "t.one", client: { ip: "192.0.2.1", userAgent: "ua" } });
      await own.db.execute(sql`alter table audit_log disable trigger audit_log_immutable`);
      await own.db.execute(sql`update audit_log set ip = '192.0.2.99' where action = 't.one'`);
      await own.db.execute(sql`alter table audit_log enable trigger audit_log_immutable`);
      await expect(resealAuditChain(own.db)).rejects.toThrow(/re-seal refused/);
      expect(await own.db.select().from(auditReseals)).toEqual([]);
      const [row] = await own.db.select().from(auditLog).where(and(eq(auditLog.action, "t.one")));
      expect(row!.ip).toBe("192.0.2.99");
    } finally {
      await own.close();
    }
  });
});
