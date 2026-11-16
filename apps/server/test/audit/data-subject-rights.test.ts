/**
 * Data subject rights and retention (issue #85 P1-1…P1-3 and "Saklama süreleri";
 * docs/features/DATA_SUBJECT_RIGHTS.md): personal data export (job queue, ZIP), e-mail correction,
 * anonymisation, the daily retention job with its disposal record, and the verifiable truncation of
 * the audit log (docs/features/AUDIT_LOG.md#retention-and-truncation). Runs on PGlite.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { asc, eq, sql } from "drizzle-orm";
import type { PersonalDataExportDto, PrivacySummaryDto } from "@sitekeep/shared";
import { buildApp } from "../../src/app/build-app.js";
import { hashPassword } from "../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../src/db/index.js";
import {
  auditLog,
  auditPersonal,
  auditTruncations,
  disposalLog,
  fileVersions,
  files,
  folders,
  issueComments,
  issues,
  outboundLog,
  projects,
  tokens,
  users,
} from "../../src/db/schema.js";
import { JobQueue } from "../../src/jobs/queue.js";
import { LocalStorage } from "../../src/core/platform/storage.js";
import { audit, auditEmailHash } from "../../src/core/platform/audit.js";
import { verifyAuditChain } from "../../src/audit/query.js";
import { auditLogCutoff, truncateAuditLog } from "../../src/audit/truncate.js";
import { loadPrivacyState } from "../../src/privacy/settings.js";
import { runRetention } from "../../src/privacy/retention.js";

const PW = "Sifre-1234567";
const UA = "Mozilla/5.0 (DsrTest)";
const IP = "203.0.113.20";
const DAY = 86_400_000;

let handle: DbHandle;
let app: FastifyInstance;
let jobs: JobQueue;
let storage: LocalStorage;
let dataDir: string;
let adminCookie: string;
let adminId: string;
let personId: string;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "7dcde-dsr-"));
  handle = await openDb("memory://");
  storage = new LocalStorage(path.join(dataDir, "storage"));
  jobs = new JobQueue(handle.db, storage);
  app = await buildApp({ db: handle.db, storage, jobs, secretKey: randomBytes(32) });
  [{ id: adminId }] = await handle.db
    .insert(users)
    .values({ email: "admin@dsr.test", name: "Admin", passwordHash: await hashPassword(PW), isAdmin: true })
    .returning({ id: users.id });
  [{ id: personId }] = await handle.db
    .insert(users)
    .values({ email: "ayse@dsr.test", name: "Ayşe Yılmaz", passwordHash: await hashPassword(PW), prefs: { language: "tr" } })
    .returning({ id: users.id });
  await handle.db.insert(users).values({ email: "other@dsr.test", name: "Other", passwordHash: await hashPassword(PW) });
  adminCookie = await login("admin@dsr.test");
});

afterAll(async () => {
  await app.close();
  await handle.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function call(method: "GET" | "PUT" | "POST", url: string, opts: { cookie?: string; payload?: unknown } = {}) {
  const res = await app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { ...(opts.cookie && { cookie: opts.cookie }), "user-agent": UA },
    remoteAddress: IP,
    payload: opts.payload as object,
  });
  let body: any = null;
  try {
    body = res.body ? res.json() : null;
  } catch {
    body = res.body;
  }
  return { status: res.statusCode, body, raw: res.rawPayload, headers: res.headers };
}

async function login(email: string, password = PW): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password }, headers: { "user-agent": UA }, remoteAddress: IP });
  if (res.statusCode !== 200) return "";
  return `cde_session=${res.cookies.find((c) => c.name === "cde_session")!.value}`;
}

const lastRow = async (action: string) => (await handle.db.select().from(auditLog).where(eq(auditLog.action, action)).orderBy(asc(auditLog.id))).at(-1);

/** A project with an issue the person wrote, a comment imported from BCF under their address and a file they uploaded. */
async function seedProject() {
  const [p] = await handle.db.insert(projects).values({ code: "DSR", name: "DSR project", createdBy: adminId }).returning();
  const [root] = await handle.db.insert(folders).values({ projectId: p!.id, name: "root" }).returning();
  const [issue] = await handle.db.insert(issues).values({ projectId: p!.id, number: 1, title: "Crack in slab", createdBy: personId }).returning();
  await handle.db.insert(issueComments).values({ issueId: issue!.id, authorId: adminId, body: "imported", importedAuthor: "Ayse@dsr.test" });
  const obj = await storage.putBytes(Buffer.from("drawing"), `projects/${p!.id}/files`);
  const [f] = await handle.db.insert(files).values({ projectId: p!.id, folderId: root!.id, name: "A-101.pdf", createdBy: personId }).returning();
  await handle.db.insert(fileVersions).values({ fileId: f!.id, version: 1, storageKey: obj.key, size: obj.size, sha256: obj.sha256, uploadedBy: personId });
  await handle.db.insert(outboundLog).values({ purpose: "eposta", connection: "smtp", host: "mail.example", method: "SMTP", local: false, userId: personId });
  return { project: p!, root: root!, file: f! };
}

describe("data subject rights (issue #85 P1-1…P1-3)", () => {
  let seeded: Awaited<ReturnType<typeof seedProject>>;
  let personCookie: string;

  it("P1-1 exports one person's data as a ZIP of JSON and CSV, built in the job queue and audited", async () => {
    seeded = await seedProject();
    personCookie = await login("ayse@dsr.test");
    expect(personCookie).not.toBe("");
    // A failed sign-in for their address: its personal part is theirs too.
    expect(await login("ayse@dsr.test", "wrong-password-9")).toBe("");

    // Only system administrators export someone else's data.
    expect((await call("POST", `/admin/users/${personId}/data-exports`, { cookie: personCookie })).status).toBe(403);
    const req = await call("POST", `/admin/users/${personId}/data-exports`, { cookie: adminCookie, payload: { includeFiles: true } });
    expect(req.status, JSON.stringify(req.body)).toBe(200);
    expect(req.body).toMatchObject({ userId: personId, status: "queued", includeFiles: true });
    // One at a time.
    expect((await call("POST", `/admin/users/${personId}/data-exports`, { cookie: adminCookie })).status).toBe(409);
    await jobs.drain();
    const list = (await call("GET", `/admin/users/${personId}/data-exports`, { cookie: adminCookie })).body as PersonalDataExportDto[];
    expect(list[0]).toMatchObject({ id: req.body.id, status: "done" });
    expect(list[0]!.size).toBeGreaterThan(0);
    expect(list[0]!.expiresAt).not.toBeNull();

    const dl = await call("GET", `/admin/data-exports/${req.body.id}/download`, { cookie: adminCookie });
    expect(dl.status).toBe(200);
    expect(dl.headers["content-type"]).toContain("application/zip");
    const zip = await JSZip.loadAsync(dl.raw);
    const names = Object.keys(zip.files);
    for (const section of ["profile", "company", "memberships", "issues", "issue_comments", "works", "review_steps", "audit_log", "outbound_log", "access_keys", "files"]) {
      expect(names).toContain(`json/${section}.json`);
      expect(names).toContain(`csv/${section}.csv`);
    }
    expect(names).toContain("README.txt");
    expect(names.some((n) => n.startsWith("files/DSR/") && n.endsWith("A-101.pdf"))).toBe(true);
    const json = async (n: string) => JSON.parse(await zip.file(`json/${n}.json`)!.async("string"));
    const profile = (await json("profile"))[0];
    expect(profile).toMatchObject({ id: personId, email: "ayse@dsr.test", name: "Ayşe Yılmaz" });
    expect(JSON.stringify(profile)).not.toContain("scrypt");
    expect((await json("issues"))[0]).toMatchObject({ title: "Crack in slab", relation: "author", projectCode: "DSR" });
    const audits = await json("audit_log");
    expect(audits.some((a: any) => a.action === "auth.login" && a.ip === IP && a.userAgent === UA)).toBe(true);
    expect(audits.some((a: any) => a.action === "auth.login_failed" && a.email === "ayse@dsr.test")).toBe(true);
    expect((await json("outbound_log")).length).toBe(1);
    const keys = await json("access_keys");
    expect(keys.some((k: any) => k.kind === "session")).toBe(true);
    expect(JSON.stringify(keys)).not.toMatch(/tokenHash|token_hash/);
    const filesJson = await json("files");
    expect(filesJson[0]).toMatchObject({ name: "A-101.pdf", version: 1 });
    expect(filesJson[0].storageKey).toBeUndefined();
    const csv = await zip.file("csv/issues.csv")!.async("string");
    expect(csv).toContain("Crack in slab");

    expect(await lastRow("user.data_exported")).toMatchObject({ userId: adminId, targetType: "user", targetId: personId });
    expect(await lastRow("user.data_export_downloaded")).toMatchObject({ userId: adminId, targetId: personId });
    expect((await verifyAuditChain(handle.db)).ok).toBe(true);
  });

  it("P1-1 (P2) lets the person export their own data from My account, never someone else's", async () => {
    const r = await call("POST", "/me/data-exports", { cookie: personCookie, payload: {} });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    await jobs.drain();
    const mine = (await call("GET", "/me/data-exports", { cookie: personCookie })).body as PersonalDataExportDto[];
    expect(mine.find((e) => e.id === r.body.id)).toMatchObject({ status: "done", includeFiles: false });
    expect((await call("GET", `/me/data-exports/${r.body.id}/download`, { cookie: personCookie })).status).toBe(200);
    const otherCookie = await login("other@dsr.test");
    expect((await call("GET", `/me/data-exports/${r.body.id}/download`, { cookie: otherCookie })).status).toBe(404);
    expect(await lastRow("user.data_exported")).toMatchObject({ userId: personId, targetId: personId, details: { self: true } });
  });

  it("P1-3 corrects a user's e-mail: unique, sessions end, audited with the address outside the chain", async () => {
    expect((await call("PUT", `/admin/users/${personId}/email`, { cookie: adminCookie, payload: { email: "other@dsr.test" } })).status).toBe(409);
    expect((await call("PUT", `/admin/users/${personId}/email`, { cookie: adminCookie, payload: { email: "not-an-address" } })).status).toBe(400);
    expect((await call("PUT", `/admin/users/${personId}/email`, { cookie: personCookie, payload: { email: "x@dsr.test" } })).status).toBe(403);
    const r = await call("PUT", `/admin/users/${personId}/email`, { cookie: adminCookie, payload: { email: "Ayse.Yilmaz@dsr.test" } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ id: personId, email: "ayse.yilmaz@dsr.test" });
    // The old session ended; the new address signs in.
    expect((await call("GET", "/auth/me", { cookie: personCookie })).status).toBe(401);
    expect(await login("ayse@dsr.test")).toBe("");
    personCookie = await login("ayse.yilmaz@dsr.test");
    expect(personCookie).not.toBe("");
    const row = (await lastRow("user.email_changed"))!;
    expect(row).toMatchObject({ userId: adminId, targetId: personId, details: { emailHash: auditEmailHash("ayse.yilmaz@dsr.test"), previousEmailHash: auditEmailHash("ayse@dsr.test") } });
    expect(JSON.stringify(row.details)).not.toContain("@dsr.test");
    const [p] = await handle.db.select().from(auditPersonal).where(eq(auditPersonal.auditId, row.id));
    expect(p).toMatchObject({ email: "ayse.yilmaz@dsr.test" });
  });

  it("P1-2 anonymises a user: two-step confirmation, pseudonym, credentials and personal records gone, history kept", async () => {
    const tokensBefore = await handle.db.select().from(tokens).where(eq(tokens.userId, personId));
    expect(tokensBefore.length).toBeGreaterThan(0);
    // The confirmation must be the account's address; nobody anonymises themselves.
    expect((await call("POST", `/admin/users/${personId}/anonymise`, { cookie: adminCookie, payload: { confirmEmail: "wrong@dsr.test" } })).status).toBe(400);
    expect((await call("POST", `/admin/users/${adminId}/anonymise`, { cookie: adminCookie, payload: { confirmEmail: "admin@dsr.test" } })).status).toBe(400);
    expect((await call("POST", `/admin/users/${personId}/anonymise`, { cookie: personCookie, payload: { confirmEmail: "ayse.yilmaz@dsr.test" } })).status).toBe(403);

    const r = await call("POST", `/admin/users/${personId}/anonymise`, { cookie: adminCookie, payload: { confirmEmail: "AYSE.YILMAZ@dsr.test" } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const short = personId.slice(0, 8);
    expect(r.body.name).toBe(`Silinmiş kullanıcı #${short}`);
    const [u] = await handle.db.select().from(users).where(eq(users.id, personId));
    expect(u).toMatchObject({ name: `Silinmiş kullanıcı #${short}`, email: `deleted-${personId}@anonymised.invalid`, disabled: true, isAdmin: false, prefs: {} });
    expect(u!.passwordHash).not.toContain("scrypt");
    expect(await login("ayse.yilmaz@dsr.test")).toBe("");
    expect((await call("GET", "/auth/me", { cookie: personCookie })).status).toBe(401);
    expect(await handle.db.select().from(tokens).where(eq(tokens.userId, personId))).toEqual([]);
    // Personal records: audit personal part, outbound log user, imported BCF author, exports.
    expect(await handle.db.select().from(auditPersonal).where(eq(auditPersonal.userId, personId))).toEqual([]);
    expect(await handle.db.select().from(auditPersonal).where(eq(auditPersonal.email, "ayse@dsr.test"))).toEqual([]);
    expect(await handle.db.select().from(outboundLog).where(eq(outboundLog.userId, personId))).toEqual([]);
    const [c] = await handle.db.select().from(issueComments);
    expect(c!.importedAuthor).toBeNull();
    expect((await call("GET", `/admin/users/${personId}/data-exports`, { cookie: adminCookie })).body).toEqual([]);
    // History stays under the pseudonym; files are untouched.
    const [issue] = await handle.db.select().from(issues).where(eq(issues.createdBy, personId));
    expect(issue).toBeDefined();
    expect(await handle.db.select().from(fileVersions).where(eq(fileVersions.uploadedBy, personId))).toHaveLength(1);
    expect((await handle.db.select().from(auditLog).where(eq(auditLog.userId, personId))).length).toBeGreaterThan(0);
    const row = (await lastRow("user.anonymised"))!;
    expect(row).toMatchObject({ userId: adminId, targetId: personId });
    expect(JSON.stringify(row.details)).not.toMatch(/Ayşe|ayse/i);
    expect(await lastRow("audit.personal_erased")).toMatchObject({ targetId: personId });
    // Irreversible and once only; no further exports or e-mail changes.
    expect((await call("POST", `/admin/users/${personId}/anonymise`, { cookie: adminCookie, payload: { confirmEmail: u!.email } })).status).toBe(409);
    expect((await call("PUT", `/admin/users/${personId}/email`, { cookie: adminCookie, payload: { email: "back@dsr.test" } })).status).toBe(409);
    expect((await verifyAuditChain(handle.db)).ok).toBe(true);
  });
});

describe("retention (issue #85, Privacy Centre → Retention)", () => {
  it("offers recycle bin purge (default off; 30/90/180/365 days) and audit log retention (default unlimited; at least 1 year)", async () => {
    const s = (await call("GET", "/admin/privacy", { cookie: adminCookie })).body as PrivacySummaryDto;
    expect(s.settings).toMatchObject({ trashPurgeDays: null, auditLogRetentionYears: null });
    expect((await call("PUT", "/admin/privacy/settings", { cookie: adminCookie, payload: { trashPurgeDays: 45 } })).status).toBe(400);
    expect((await call("PUT", "/admin/privacy/settings", { cookie: adminCookie, payload: { auditLogRetentionYears: 0 } })).status).toBe(400);
    const r = await call("PUT", "/admin/privacy/settings", { cookie: adminCookie, payload: { trashPurgeDays: 30 } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((r.body as PrivacySummaryDto).settings).toMatchObject({ trashPurgeDays: 30, auditLogRetentionYears: null });
  });

  it("the daily job purges the bin, removes expired credentials, writes counts to the audit log and the disposal record", async () => {
    await loadPrivacyState(handle.db);
    const [p] = await handle.db.select().from(projects).where(eq(projects.code, "DSR"));
    const [root] = await handle.db.select().from(folders).where(eq(folders.projectId, p!.id));
    const old = new Date(Date.now() - 40 * DAY);
    const [gone] = await handle.db.insert(folders).values({ projectId: p!.id, parentId: root!.id, name: "Old", deletedAt: old }).returning();
    const obj = await storage.putBytes(Buffer.from("old"), `projects/${p!.id}/files`);
    const [f] = await handle.db.insert(files).values({ projectId: p!.id, folderId: gone!.id, name: "old.txt", deletedAt: old }).returning();
    await handle.db.insert(fileVersions).values({ fileId: f!.id, version: 1, storageKey: obj.key, size: obj.size, sha256: obj.sha256 });
    // Deleted yesterday: stays.
    const [recent] = await handle.db.insert(files).values({ projectId: p!.id, folderId: root!.id, name: "recent.txt", deletedAt: new Date(Date.now() - DAY) }).returning();
    const [otherUser] = await handle.db.select().from(users).where(eq(users.email, "other@dsr.test"));
    await handle.db.insert(tokens).values({ userId: otherUser!.id, kind: "session", tokenHash: "expired-session", expiresAt: new Date(Date.now() - DAY) });
    await handle.db.insert(tokens).values({ userId: otherUser!.id, kind: "api", tokenHash: "expired-api", expiresAt: new Date(Date.now() - DAY) });

    const r = await runRetention(handle.db, storage);
    expect(r.failed).toEqual([]);
    const count = (c: string) => r.entries.find((e) => e.category === c)?.count ?? 0;
    expect(count("trash_files")).toBe(1);
    expect(count("trash_folders")).toBe(1);
    expect(count("sessions")).toBeGreaterThanOrEqual(1);
    expect(count("api_tokens")).toBe(1);
    expect(await handle.db.select().from(files).where(eq(files.id, f!.id))).toEqual([]);
    expect(await handle.db.select().from(folders).where(eq(folders.id, gone!.id))).toEqual([]);
    expect(await handle.db.select().from(files).where(eq(files.id, recent!.id))).toHaveLength(1);
    expect(await handle.db.select().from(tokens).where(eq(tokens.tokenHash, "expired-api"))).toEqual([]);

    const done = (await lastRow("retention.completed"))!;
    expect(done.details).toMatchObject({ runId: r.runId, deleted: { trash_files: 1, trash_folders: 1, api_tokens: 1 } });
    expect(await lastRow("trash.auto_purged")).toMatchObject({ projectId: p!.id, details: { files: 1, folders: 1, trashPurgeDays: 30 } });
    const disposals = await handle.db.select().from(disposalLog).where(eq(disposalLog.runId, r.runId));
    expect(disposals.map((d) => d.category).sort()).toEqual(r.entries.map((e) => e.category).sort());
    expect(disposals.find((d) => d.category === "trash_files")).toMatchObject({ count: 1, basis: "trashPurgeDays=30", method: "delete+storage" });

    // The disposal record as CSV (KVKK periodic destruction), and it is append-only.
    const csv = await call("GET", "/admin/privacy/disposals.csv?lang=en", { cookie: adminCookie });
    expect(csv.status).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(String(csv.body)).toContain("Recycle bin: files deleted for good");
    expect(String(csv.body)).toContain("trashPurgeDays=30");
    await expect(handle.db.delete(disposalLog)).rejects.toThrow();

    // A second run has nothing to do and writes nothing.
    const again = await runRetention(handle.db, storage);
    expect(again.entries.filter((e) => e.category.startsWith("trash"))).toEqual([]);
  });

});

describe("ISO19650-2 5.1.7(d) audit: retention truncation with a verifiable checkpoint (migration 0054)", () => {
  it("truncates the audit log after its retention period and `audit:verify` still passes from the checkpoint", async () => {
    expect(await truncateAuditLog(handle.db, { years: null })).toBeNull();
    const firstBefore = (await handle.db.select({ id: auditLog.id }).from(auditLog).orderBy(asc(auditLog.id)).limit(1))[0]!.id;
    // Rows written before T, then rows after it.
    await new Promise((r) => setTimeout(r, 20));
    const T = new Date();
    await new Promise((r) => setTimeout(r, 20));
    await audit(handle.db, { action: "test.after_cutoff", client: { ip: "198.51.100.7", userAgent: "x" } });
    const keep = (await lastRow("test.after_cutoff"))!;
    const now = new Date(Date.UTC(T.getUTCFullYear() + 1, T.getUTCMonth(), T.getUTCDate(), T.getUTCHours(), T.getUTCMinutes(), T.getUTCSeconds(), T.getUTCMilliseconds()));
    expect(auditLogCutoff(now, 1).getTime()).toBe(T.getTime());

    const r = (await truncateAuditLog(handle.db, { now, years: 1 }))!;
    expect(r).not.toBeNull();
    expect(r.removedFromId).toBe(firstBefore);
    expect(r.newFirstId).toBe(keep.id);
    expect(r.removedHeadHash).toBe(keep.prevHash);
    expect(r.removedPersonal).toBeGreaterThan(0);
    const remaining = await handle.db.select().from(auditLog).orderBy(asc(auditLog.id));
    expect(remaining[0]!.id).toBe(keep.id);
    expect(remaining.at(-1)).toMatchObject({ action: "audit.truncated", details: { truncationId: r.truncationId, removedHeadHash: r.removedHeadHash, newFirstId: keep.id } });
    expect((await handle.db.select().from(auditPersonal).where(sql`${auditPersonal.auditId} < ${keep.id}`)).length).toBe(0);
    const v = await verifyAuditChain(handle.db);
    expect(v).toMatchObject({ ok: true, broken: null, legacyRows: 0, truncated: { id: r.truncationId, newFirstId: keep.id, removedHeadHash: r.removedHeadHash } });

    // The checkpoint is append-only; removing one more row (triggers off) is caught.
    await expect(handle.db.delete(auditTruncations)).rejects.toThrow();
    await handle.db.delete(auditPersonal).where(eq(auditPersonal.auditId, keep.id));
    await handle.db.execute(sql`ALTER TABLE audit_log DISABLE TRIGGER audit_log_immutable`);
    await handle.db.delete(auditLog).where(eq(auditLog.id, keep.id));
    await handle.db.execute(sql`ALTER TABLE audit_log ENABLE TRIGGER audit_log_immutable`);
    const broken = await verifyAuditChain(handle.db);
    expect(broken.ok).toBe(false);
    expect(broken.broken!.reason).toBe("prev_mismatch");
  });

  it("refuses to truncate a broken chain, and a forged checkpoint without its chained row is a truncation_mismatch", async () => {
    await expect(truncateAuditLog(handle.db, { now: new Date(Date.now() + 3 * 365 * DAY), years: 1 })).rejects.toThrow(/broken/);
    // Forge: a checkpoint that claims the current first row, with no audit.truncated row behind it.
    const [first] = await handle.db.select().from(auditLog).orderBy(asc(auditLog.id)).limit(1);
    await handle.db.insert(auditTruncations).values({
      before: new Date(),
      retentionYears: 1,
      removedRows: 1,
      removedPersonal: 0,
      removedFromId: 1,
      removedToId: first!.id - 1,
      removedHeadHash: first!.prevHash,
      newFirstId: first!.id,
    });
    expect((await verifyAuditChain(handle.db)).broken).toMatchObject({ id: first!.id, reason: "truncation_mismatch" });
  });
});
