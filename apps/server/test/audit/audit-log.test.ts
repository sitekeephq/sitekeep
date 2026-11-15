/**
 * ISO-4 immutable audit log (docs/features/AUDIT_LOG.md): the hash chain and its trigger
 * (migration 0043_audit_chain), tamper detection, the client of the request (D-9), view
 * deduplication, file moves and state transitions, the project / file / system API, CSV export
 * and permissions. Runs on PGlite (the test database); the same SQL runs on PostgreSQL.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, asc, eq, sql } from "drizzle-orm";
import type { AuditEntryDto, AuditPageDto, AuditVerifyDto } from "@sitekeep/shared";
import { buildApp } from "../../src/app/build-app.js";
import { hashPassword } from "../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../src/db/index.js";
import * as schema from "../../src/db/schema.js";
import { auditLog, folders, users } from "../../src/db/schema.js";
import type { Db } from "../../src/db/index.js";
import { JobQueue } from "../../src/jobs/queue.js";
import { LocalStorage } from "../../src/core/platform/storage.js";
import { audit } from "../../src/core/platform/audit.js";
import { recordTransition, recordView, VIEW_DEDUPE_MS } from "../../src/cde/events.js";
import { verifyAuditChain } from "../../src/audit/query.js";

let handle: DbHandle;
let app: FastifyInstance;
let dataDir: string;
const PW = "Sifre-1234567";
const UA = "Mozilla/5.0 (AuditTest)";

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "7dcde-audit-"));
  handle = await openDb("memory://");
  const storage = new LocalStorage(path.join(dataDir, "storage"));
  app = await buildApp({ db: handle.db, storage, jobs: new JobQueue(handle.db, storage) });
  await handle.db.insert(users).values({ email: "admin@7d.test", name: "Admin", passwordHash: await hashPassword(PW), isAdmin: true });
});

afterAll(async () => {
  await app.close();
  await handle.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function login(email: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PW } });
  expect(res.statusCode, res.body).toBe(200);
  return `cde_session=${res.cookies.find((c) => c.name === "cde_session")!.value}`;
}

function api(cookie: string, ip = "203.0.113.7") {
  const call = async (method: string, url: string, payload?: unknown) => {
    const res = await app.inject({
      method: method as "GET",
      url: `/api/v1${url}`,
      headers: { cookie, "user-agent": UA },
      remoteAddress: ip,
      payload: payload as object,
    });
    let body: any = null;
    try {
      body = res.body ? res.json() : null;
    } catch {
      body = res.body;
    }
    return { status: res.statusCode, body, headers: res.headers, text: res.body };
  };
  return {
    get: (u: string) => call("GET", u),
    post: (u: string, p?: unknown) => call("POST", u, p ?? {}),
    put: (u: string, p: unknown) => call("PUT", u, p),
    patch: (u: string, p: unknown) => call("PATCH", u, p),
    del: (u: string) => call("DELETE", u),
    upload: async (url: string, name: string, data: string) => {
      const form = new FormData();
      form.append("file", new Blob([data]), name);
      const req = new Request("http://x", { method: "POST", body: form });
      const res = await app.inject({
        method: "POST",
        url: `/api/v1${url}`,
        headers: { cookie, "user-agent": UA, "content-type": req.headers.get("content-type")! },
        remoteAddress: ip,
        payload: Buffer.from(await req.arrayBuffer()),
      });
      return { status: res.statusCode, body: res.json() };
    },
  };
}
type Api = ReturnType<typeof api>;

const q = (text: string) => handle.db.execute(sql.raw(text));
const rowsOf = (pid: string, action: string) =>
  handle.db.select().from(auditLog).where(and(eq(auditLog.projectId, pid), eq(auditLog.action, action))).orderBy(asc(auditLog.id));

describe("ISO19650-2 5.1.7(d) audit: hash chain (migration 0043)", () => {
  it("starts the chain with a genesis row and chains every new row", async () => {
    const [genesis] = await handle.db.select().from(auditLog).where(eq(auditLog.action, "audit.chain_started"));
    expect(genesis!.prevHash).toBeNull();
    expect(genesis!.hash).toMatch(/^[0-9a-f]{64}$/);
    await audit(handle.db, { action: "test.one", details: { b: 1, a: [1, 2] } });
    await audit(handle.db, { action: "test.two" });
    const rows = await handle.db.select().from(auditLog).orderBy(asc(auditLog.id));
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.id).toBeGreaterThan(rows[i - 1]!.id);
      expect(rows[i]!.prevHash).toBe(rows[i - 1]!.hash);
    }
    const v = await verifyAuditChain(handle.db);
    expect(v).toMatchObject({ ok: true, broken: null, legacyRows: 0 });
    expect(v.checked).toBe(rows.length);
    expect(v.head).toMatchObject({ id: rows.at(-1)!.id, hash: rows.at(-1)!.hash });
  });

  it("ignores a hash or id the writer sends: the trigger sets them", async () => {
    await q(`insert into audit_log (id, action, prev_hash, hash) values (999999, 'test.forged', 'x', 'y')`);
    const [row] = await handle.db.select().from(auditLog).where(eq(auditLog.action, "test.forged"));
    expect(row!.id).not.toBe(999999);
    expect(row!.hash).not.toBe("y");
    expect((await verifyAuditChain(handle.db)).ok).toBe(true);
  });

  it("refuses UPDATE, DELETE and TRUNCATE", async () => {
    for (const statement of [`update audit_log set action = 'x'`, `delete from audit_log`, `truncate audit_log`]) {
      const err = (await q(statement).catch((e: unknown) => e)) as { cause?: Error } | undefined;
      expect(String(err?.cause?.message), statement).toMatch(/audit_log is append-only/);
    }
    expect((await verifyAuditChain(handle.db)).ok).toBe(true);
  });

  it("finds a changed, a removed and an unchained row once the triggers are bypassed", async () => {
    // A database of its own: this test breaks the chain on purpose.
    const own = await openDb("memory://");
    try {
      const db = own.db;
      for (const n of [1, 2, 3, 4]) await audit(db, { action: `t.${n}`, details: { n } });
      const ids = (await db.select({ id: auditLog.id }).from(auditLog).orderBy(asc(auditLog.id))).map((r) => r.id);
      expect((await verifyAuditChain(db)).ok).toBe(true);
      const run = (s: string) => db.execute(sql.raw(s));

      await run(`alter table audit_log disable trigger audit_log_immutable`);
      await run(`update audit_log set details = '{"n": 99}' where id = ${ids[2]}`);
      expect(await verifyAuditChain(db)).toMatchObject({ ok: false, checked: 2, broken: { id: ids[2], reason: "hash_mismatch" } });
      await run(`update audit_log set details = '{"n": 2}' where id = ${ids[2]}`);
      expect((await verifyAuditChain(db)).ok).toBe(true);

      await run(`delete from audit_log where id = ${ids[3]}`);
      expect(await verifyAuditChain(db)).toMatchObject({ ok: false, broken: { id: ids[4], reason: "prev_mismatch" } });
      await run(`alter table audit_log enable trigger audit_log_immutable`);

      const db2 = (await openDb("memory://"));
      try {
        await audit(db2.db, { action: "t.ok" });
        await db2.db.execute(sql.raw(`alter table audit_log disable trigger audit_log_chain`));
        await db2.db.execute(sql.raw(`insert into audit_log (id, action) values (1000, 'sneaked')`));
        expect(await verifyAuditChain(db2.db)).toMatchObject({ ok: false, broken: { id: 1000, reason: "missing_hash" } });
      } finally {
        await db2.close();
      }
    } finally {
      await own.close();
    }
  });

  it("upgrades a database with older rows: they stay unchained, the chain starts after them", async () => {
    const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../drizzle");
    const before = mkdtempSync(path.join(os.tmpdir(), "7dcde-mig43-"));
    cpSync(MIGRATIONS, before, { recursive: true });
    const journalPath = path.join(before, "meta/_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { idx: number }[] };
    journal.entries = journal.entries.filter((e) => e.idx < 43);
    writeFileSync(journalPath, JSON.stringify(journal));
    const client = new PGlite();
    try {
      const db = drizzle(client, { schema }) as unknown as Db;
      await migrate(drizzle(client, { schema }), { migrationsFolder: before });
      await client.query(`insert into audit_log (action) values ('old.one'), ('old.two')`);
      await migrate(drizzle(client, { schema }), { migrationsFolder: MIGRATIONS });
      const rows = await db.select().from(auditLog).orderBy(asc(auditLog.id));
      expect(rows.map((r) => [r.action, r.hash === null])).toEqual([
        ["old.one", true],
        ["old.two", true],
        ["audit.chain_started", false],
      ]);
      await audit(db, { action: "new.one" });
      expect(await verifyAuditChain(db)).toMatchObject({ ok: true, checked: 2, legacyRows: 2 });
      // The report refresh keeps its insert stamp; the update / delete stamps are gone.
      const triggers = await client.query<{ tgname: string }>(
        `select tgname from pg_trigger where tgrelid = 'audit_log'::regclass and not tgisinternal order by tgname`,
      );
      expect(triggers.rows.map((t) => t.tgname)).toEqual(["audit_log_chain", "audit_log_immutable", "audit_log_no_truncate", "report_stamp_insert"]);
    } finally {
      await client.close();
      rmSync(before, { recursive: true, force: true });
    }
  });

  it("serialises concurrent writers into one chain", async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) => audit(handle.db, { action: "test.parallel", details: { i } })));
    expect((await verifyAuditChain(handle.db)).ok).toBe(true);
  });
});

describe("ISO19650-2 5.1.7(d) audit: events with the client of the request (D-9)", () => {
  let admin: Api;
  let pid: string;
  let rootId: string;
  let wip: string;
  let shared: string;
  let fileId: string;
  let versionId: string;

  it("stores IP and user agent on rows written during a request", async () => {
    admin = api(await login("admin@7d.test"));
    const p = await admin.post("/projects", { code: "AUD1", name: "Audit", template: "iso19650" });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    pid = p.body.id;
    rootId = p.body.rootFolderId;
    const fs = await handle.db.select().from(folders).where(eq(folders.projectId, pid));
    wip = fs.find((f) => f.state === "wip")!.id;
    shared = fs.find((f) => f.state === "shared")!.id;
    const up = await admin.upload(`/projects/${pid}/folders/${wip}/files`, "plan.txt", "hello");
    expect(up.status, JSON.stringify(up.body)).toBe(200);
    fileId = up.body.results[0].fileId;
    versionId = (await admin.get(`/projects/${pid}/files/${fileId}`)).body.latest.id;
    const [row] = await rowsOf(pid, "file.uploaded");
    expect(row).toMatchObject({ ip: "203.0.113.7", userAgent: UA, targetId: fileId });
    expect(row!.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("records a view once per user, version and 15 minutes", async () => {
    expect(versionId).toBeTruthy();
    const r1 = await admin.get(`/projects/${pid}/versions/${versionId}/preview`);
    expect(r1.status, JSON.stringify(r1.body)).toBe(200);
    await admin.get(`/projects/${pid}/versions/${versionId}/preview`);
    let views = await rowsOf(pid, "file.viewed");
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ targetType: "file", targetId: fileId, ip: "203.0.113.7", userAgent: UA, details: { versionId, kind: "preview" } });

    // The same person after the window is a new row.
    const [adminRow] = await handle.db.select().from(users).where(eq(users.email, "admin@7d.test"));
    await recordView(handle.db, { projectId: pid, userId: adminRow!.id, fileId, versionId, kind: "pdf" });
    expect(await rowsOf(pid, "file.viewed")).toHaveLength(1);
    const later = Date.now() + VIEW_DEDUPE_MS + 1000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(later);
    try {
      await recordView(handle.db, { projectId: pid, userId: adminRow!.id, fileId, versionId, kind: "pdf" });
    } finally {
      clock.mockRestore();
    }
    views = await rowsOf(pid, "file.viewed");
    expect(views).toHaveLength(2);
    expect(views[1]!.ip).toBeNull(); // no request: no client
  });

  it("records file.moved and a cde.transition when the state changes", async () => {
    const r = await admin.patch(`/projects/${pid}/files/${fileId}`, { folderId: shared });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const [moved] = await rowsOf(pid, "file.moved");
    expect(moved).toMatchObject({ targetId: fileId, details: { fromFolderId: wip, toFolderId: shared }, ip: "203.0.113.7" });
    const [tr] = await rowsOf(pid, "cde.transition");
    expect(tr).toMatchObject({ targetId: fileId, details: { fromState: "wip", toState: "shared", mode: "direct" }, userAgent: UA });

    // Same state, no transition row.
    await recordTransition(handle.db, { projectId: pid, userId: null, fileId, fromFolderId: shared, toFolderId: shared, fromState: "shared", toState: "shared", mode: "direct" });
    expect(await rowsOf(pid, "cde.transition")).toHaveLength(1);
  });

  it("records downloads, deletes, restores and permission changes with the client", async () => {
    const d = await admin.get(`/projects/${pid}/versions/${versionId}/download`);
    expect(d.status).toBe(200);
    await admin.post("/users", { email: "uye@7d.test", name: "Üye", password: PW });
    const [member] = await handle.db.select().from(users).where(eq(users.email, "uye@7d.test"));
    expect((await admin.post(`/projects/${pid}/members`, { email: "uye@7d.test" })).status).toBe(200);
    const perm = await admin.put(`/projects/${pid}/folders/${shared}/permissions`, {
      mode: "add",
      entries: [{ subjectType: "user", subjectId: member!.id, level: "view" }],
    });
    expect(perm.status, JSON.stringify(perm.body)).toBe(200);
    expect((await admin.del(`/projects/${pid}/files/${fileId}`)).status).toBe(200);
    expect((await admin.post(`/projects/${pid}/trash/files/${fileId}/restore`)).status).toBeLessThan(300);
    for (const action of ["file.downloaded", "folder.permissions_set", "file.deleted", "file.restored", "member.added"]) {
      const [row] = await rowsOf(pid, action);
      expect(row, action).toMatchObject({ ip: "203.0.113.7", userAgent: UA });
    }
  });
});

describe("ISO19650-2 5.1.7(d) audit: API, CSV and permissions", () => {
  let admin: Api;
  let member: Api;
  let outsider: Api;
  let pid: string;
  let fileId: string;
  let memberId: string;

  it("lists the project log with filters and cursor pages (project administrators)", async () => {
    admin = api(await login("admin@7d.test"));
    member = api(await login("uye@7d.test"), "198.51.100.2");
    await admin.post("/users", { email: "dis@7d.test", name: "Dış", password: PW });
    outsider = api(await login("dis@7d.test"));
    const [p] = (await admin.get("/projects")).body.filter((x: { code: string }) => x.code === "AUD1");
    pid = p.id;
    const [m] = await handle.db.select().from(users).where(eq(users.email, "uye@7d.test"));
    memberId = m!.id;
    const [moved] = await rowsOf(pid, "file.moved");
    fileId = moved!.targetId!;

    const all = await admin.get(`/projects/${pid}/audit?limit=500`);
    expect(all.status).toBe(200);
    const body = all.body as AuditPageDto;
    expect(body.nextCursor).toBeNull();
    expect(body.entries.every((e) => e.projectId === pid)).toBe(true);
    const ids = body.entries.map((e) => e.id);
    expect([...ids].sort((a, b) => b - a)).toEqual(ids);
    expect(body.entries.find((e) => e.action === "file.uploaded")).toMatchObject({ ip: "203.0.113.7", userAgent: UA, userName: "Admin", targetName: "plan.txt" });

    // Pages of two, walked with the cursor, give the same rows.
    const walked: number[] = [];
    let cursor: number | null = null;
    do {
      const page: AuditPageDto = (await admin.get(`/projects/${pid}/audit?limit=2${cursor ? `&cursor=${cursor}` : ""}`)).body;
      expect(page.entries.length).toBeLessThanOrEqual(2);
      walked.push(...page.entries.map((e) => e.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(walked).toEqual(ids);

    const only = async (query: string) => ((await admin.get(`/projects/${pid}/audit?${query}`)).body as AuditPageDto).entries;
    expect((await only("action=file.moved")).map((e) => e.action)).toEqual(["file.moved"]);
    expect(new Set((await only("action=file.*")).map((e) => e.action.split(".")[0]))).toEqual(new Set(["file"]));
    expect((await only(`targetType=file&targetId=${fileId}`)).every((e) => e.targetId === fileId)).toBe(true);
    expect(await only(`userId=${memberId}`)).toEqual([]);
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    expect(await only(`from=${tomorrow}`)).toEqual([]);
    expect((await only(`to=${tomorrow}`)).length).toBe(ids.length);
    expect((await admin.get(`/projects/${pid}/audit?from=yesterday`)).status).toBe(400);
  });

  it("keeps /activity working", async () => {
    const r = await admin.get(`/projects/${pid}/activity`);
    expect(r.status).toBe(200);
    expect((r.body as AuditEntryDto[]).length).toBeGreaterThan(0);
  });

  it("exports CSV with the same filters and records the export", async () => {
    const r = await admin.get(`/projects/${pid}/audit.csv?action=file.*`);
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/text\/csv/);
    expect(String(r.headers["content-disposition"])).toMatch(/attachment; filename="audit-AUD1-\d{4}-\d{2}-\d{2}\.csv"/);
    const lines = r.text.replace(/^﻿/, "").trim().split("\r\n");
    // Column names in the reader's language (Turkish by default; en in audit.json).
    expect(lines[0]).toBe("No.;Zaman (UTC);Proje;Kullanıcı;İşlem;Hedef Türü;Hedef Kimliği;Hedef;IP Adresi;Tarayıcı Bilgisi;Ayrıntılar;Özet (Hash)");
    const actions = lines.slice(1).map((l) => l.split(";")[4]);
    expect(actions.length).toBeGreaterThan(3);
    expect(actions.every((a) => a!.startsWith("file."))).toBe(true);
    expect(lines.some((l) => l.includes("203.0.113.7") && l.includes("AUD1"))).toBe(true);
    const [exported] = await rowsOf(pid, "audit.exported");
    expect(exported).toMatchObject({ details: { query: { action: "file.*" } } });
    const en = await admin.get(`/projects/${pid}/audit.csv?action=file.moved&lang=en`);
    expect(en.text.replace(/^\uFEFF/, "").split("\r\n")[0]).toBe("No.;Time (UTC);Project;User;Action;Target Type;Target ID;Target;IP Address;User Agent;Details;Hash");
  });

  it("refuses the project log to members and hides it from outsiders", async () => {
    expect((await member.get(`/projects/${pid}/audit`)).status).toBe(403);
    expect((await member.get(`/projects/${pid}/audit.csv`)).status).toBe(403);
    expect((await outsider.get(`/projects/${pid}/audit`)).status).toBe(404);
  });

  it("shows a file's history to people who may view it, without the client unless admin", async () => {
    const mine = await admin.get(`/projects/${pid}/files/${fileId}/history`);
    expect(mine.status).toBe(200);
    const entries = (mine.body as AuditPageDto).entries;
    expect(entries.map((e) => e.action)).toEqual(expect.arrayContaining(["file.uploaded", "file.viewed", "file.moved", "cde.transition", "file.downloaded"]));
    expect(entries.every((e) => e.targetId === fileId)).toBe(true);
    expect(entries[0]!.ip).toBeDefined();

    // The member got "view" on the Shared folder (where the file is now).
    const theirs = await member.get(`/projects/${pid}/files/${fileId}/history?limit=3`);
    expect(theirs.status, JSON.stringify(theirs.body)).toBe(200);
    expect((theirs.body as AuditPageDto).entries).toHaveLength(3);
    expect((theirs.body as AuditPageDto).nextCursor).not.toBeNull();
    expect((theirs.body as AuditPageDto).entries.every((e) => e.ip === undefined && e.userAgent === undefined)).toBe(true);
    expect((await outsider.get(`/projects/${pid}/files/${fileId}/history`)).status).toBe(404);
  });

  it("gives system administrators the whole log, CSV and the chain check", async () => {
    const r = await admin.get(`/admin/audit?projectId=${pid}&limit=5`);
    expect(r.status).toBe(200);
    expect((r.body as AuditPageDto).entries.every((e) => e.projectId === pid && e.projectCode === "AUD1")).toBe(true);
    const sys = (await admin.get(`/admin/audit?action=audit.chain_started`)).body as AuditPageDto;
    expect(sys.entries).toHaveLength(1);
    const csv = await admin.get(`/admin/audit.csv?targetType=system`);
    expect(csv.status).toBe(200);
    expect(csv.text).toContain("audit.chain_started");
    const v = await admin.get(`/admin/audit/verify`);
    expect(v.status).toBe(200);
    expect(v.body as AuditVerifyDto).toMatchObject({ ok: true, broken: null });

    for (const u of ["/admin/audit", "/admin/audit.csv", "/admin/audit/verify"]) expect((await member.get(u)).status, u).toBe(403);
  });
});
