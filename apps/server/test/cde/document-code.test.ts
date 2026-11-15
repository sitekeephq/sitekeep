/**
 * ISO-3: unique document code per project (docs/features/DOCUMENT_CODES.md).
 * ISO 19650-2 5.1.7 unique container id; ISO 19650-1 12.1 information container identification.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import { buildApp } from "../../src/app/build-app.js";
import { hashPassword } from "../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../src/db/index.js";
import { auditLog, documentCodes, fileVersions, files, folders, reviewFiles, reviews, users } from "../../src/db/schema.js";
import { JobQueue } from "../../src/jobs/queue.js";
import { LocalStorage } from "../../src/core/platform/storage.js";
import { copyApprovedFiles } from "../../src/workflow/review-finalization.js";
import { documentCodeOf, runDocumentCodeBackfill } from "../../src/cde/document-code.js";

let handle: DbHandle;
let app: FastifyInstance;
let jobs: JobQueue;
let dataDir: string;
const PW = "Sifre-1234567";

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "7dcde-code-"));
  handle = await openDb("memory://");
  const storage = new LocalStorage(path.join(dataDir, "storage"));
  jobs = new JobQueue(handle.db, storage);
  app = await buildApp({ db: handle.db, storage, jobs });
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

function api(cookie: string) {
  const call = async (method: string, url: string, payload?: unknown) => {
    const res = await app.inject({ method: method as "GET", url: `/api/v1${url}`, headers: { cookie }, payload: payload as object });
    let body: any = null;
    try {
      body = res.body ? res.json() : null;
    } catch {
      body = res.body;
    }
    return { status: res.statusCode, body };
  };
  return {
    get: (u: string) => call("GET", u),
    post: (u: string, p?: unknown) => call("POST", u, p ?? {}),
    put: (u: string, p: unknown) => call("PUT", u, p),
    patch: (u: string, p: unknown) => call("PATCH", u, p),
    upload: async (url: string, name: string, data: string) => {
      const form = new FormData();
      form.append("file", new Blob([data]), name);
      const req = new Request("http://x", { method: "POST", body: form });
      const res = await app.inject({
        method: "POST",
        url: `/api/v1${url}`,
        headers: { cookie, "content-type": req.headers.get("content-type")! },
        payload: Buffer.from(await req.arrayBuffer()),
      });
      return { status: res.statusCode, body: res.json() };
    },
  };
}
type Api = ReturnType<typeof api>;

const STANDARD = {
  name: "ZAVM",
  delimiter: "-",
  fields: [
    { name: "Proje", type: "list", values: [{ code: "ZAVM" }] },
    { name: "Firma", type: "list", values: [{ code: "PAS" }, { code: "CNS" }] },
    { name: "Rol", type: "list", values: [{ code: "A" }, { code: "S" }] },
    { name: "Numara", type: "number", digits: 4 },
  ],
};

describe("ISO19650-2 5.1.7(a) unique container id: document code derivation", () => {
  it("is the part of the name that parses; none without a match (D-5)", () => {
    const std = { ...STANDARD, allowSuffix: true } as Parameters<typeof documentCodeOf>[0];
    expect(documentCodeOf(std, "ZAVM-PAS-A-0001.pdf")).toBe("ZAVM-PAS-A-0001");
    expect(documentCodeOf(std, "ZAVM-PAS-A-0001-Temel Kazısı.pdf")).toBe("ZAVM-PAS-A-0001");
    expect(documentCodeOf(std, "notes.txt")).toBeNull();
    expect(documentCodeOf(null, "ZAVM-PAS-A-0001.pdf")).toBeNull();
  });
});

describe("ISO19650-2 5.1.7(a) unique container id", () => {
  let admin: Api;
  let member: Api;
  let memberId: string;
  let pid: string;
  let wip: string;
  let shared: string;
  let folderA: string;
  let folderB: string;
  let misc: string;
  let stdId: string;
  const up = (folder: string, name: string, data = "%PDF-1.4 x", who?: Api) =>
    (who ?? admin).upload(`/projects/${pid}/folders/${folder}/files`, name, data);
  const fileIn = async (folder: string, name: string) =>
    (await handle.db.select().from(files).where(and(eq(files.folderId, folder), eq(files.name, name))))[0]!;

  it("registers the code of a new document (ISO19650-2 5.1.7(a) unique container id)", async () => {
    admin = api(await login("admin@7d.test"));
    const u = await admin.post("/users", { email: "uye@7d.test", name: "Üye", password: PW });
    memberId = u.body.id;
    member = api(await login("uye@7d.test"));
    const p = await admin.post("/projects", { code: "DC1", name: "Codes", template: "iso19650" });
    pid = p.body.id;
    expect((await admin.post(`/projects/${pid}/members`, { email: "uye@7d.test" })).status).toBe(200);
    const fs = await handle.db.select().from(folders).where(eq(folders.projectId, pid));
    wip = fs.find((f) => f.state === "wip")!.id;
    shared = fs.find((f) => f.state === "shared")!.id;
    folderA = (await admin.post(`/projects/${pid}/folders`, { parentId: wip, name: "A" })).body.id;
    folderB = (await admin.post(`/projects/${pid}/folders`, { parentId: wip, name: "B" })).body.id;
    misc = (await admin.post(`/projects/${pid}/folders`, { parentId: p.body.rootFolderId, name: "Misc" })).body.id;
    const std = await admin.post(`/projects/${pid}/naming-standards`, STANDARD);
    expect(std.status, JSON.stringify(std.body)).toBe(200);
    stdId = std.body.id;
    expect((await admin.patch(`/projects/${pid}/folders/${wip}`, { namingStandardId: stdId })).status).toBe(200);
    expect((await admin.patch(`/projects/${pid}/folders/${shared}`, { namingStandardId: stdId })).status).toBe(200);
    // The refusals are opt-in per project (D-8).
    expect((await admin.put(`/projects/${pid}/cde/settings`, { enforceTransitions: true })).status).toBe(200);
    for (const f of [wip, shared, misc])
      await admin.put(`/projects/${pid}/folders/${f}/permissions`, { entries: [{ subjectType: "user", subjectId: memberId, level: "edit" }] });

    const r = await up(folderA, "ZAVM-PAS-A-0001.pdf");
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const f = await fileIn(folderA, "ZAVM-PAS-A-0001.pdf");
    expect(f.documentCode).toBe("ZAVM-PAS-A-0001");
    const [row] = await handle.db.select().from(documentCodes).where(eq(documentCodes.projectId, pid));
    expect(row).toMatchObject({ codeNorm: "ZAVM-PAS-A-0001", containerId: f.containerId, firstFileId: f.id });
  });

  it("refuses the code in another folder with the path of the holder (ISO19650-2 5.1.7(a) unique container id)", async () => {
    const r = await up(folderB, "ZAVM-PAS-A-0001.pdf", "%PDF-1.4 y", member);
    expect(r.status).toBe(400);
    expect(r.body.results[0].ok).toBe(false);
    expect(r.body.results[0].conflict).toMatchObject({ kind: "document_code", code: "ZAVM-PAS-A-0001" });
    expect(r.body.results[0].conflict.existingPath).toContain("A / ZAVM-PAS-A-0001.pdf");
    expect(r.body.results[0].errors[0]).toContain("A / ZAVM-PAS-A-0001.pdf");
    // Nothing was stored.
    expect(await handle.db.select().from(files).where(eq(files.folderId, folderB))).toHaveLength(0);
  });

  it("allows a new version and a rendition with another extension (ISO19650-2 5.1.7(a), D-6)", async () => {
    const pdf = await fileIn(folderA, "ZAVM-PAS-A-0001.pdf");
    expect((await up(folderA, "ZAVM-PAS-A-0001.pdf", "%PDF-1.4 v2")).status).toBe(200);
    const dwg = await up(folderA, "ZAVM-PAS-A-0001.dwg", "AC1032");
    expect(dwg.status, JSON.stringify(dwg.body)).toBe(200);
    const rendition = await fileIn(folderA, "ZAVM-PAS-A-0001.dwg");
    expect(rendition.containerId).toBe(pdf.containerId);
    expect(rendition.documentCode).toBe("ZAVM-PAS-A-0001");
    // A rendition elsewhere is another document.
    expect((await up(folderB, "ZAVM-PAS-A-0001.dwg", "AC1032")).status).toBe(400);
  });

  it("lets an approved review copy keep the code (ISO19650-2 5.1.7(a) unique container id)", async () => {
    const src = await fileIn(folderA, "ZAVM-PAS-A-0001.pdf");
    const [version] = await handle.db
      .select()
      .from(fileVersions)
      .where(and(eq(fileVersions.fileId, src.id), eq(fileVersions.version, src.currentVersion)));
    const [me] = await handle.db.select().from(users).where(eq(users.email, "admin@7d.test"));
    const [review] = await handle.db
      .insert(reviews)
      .values({ projectId: pid, number: 1, name: "R1", targetFolderId: shared, createdBy: me!.id })
      .returning();
    await handle.db
      .insert(reviewFiles)
      .values({ reviewId: review!.id, fileId: src.id, fileVersionId: version!.id, sourceFolderId: folderA, finalStatus: "approved" });
    const report = await copyApprovedFiles({ db: handle.db, jobs }, review!, me!.id);
    expect(report).toMatchObject({ approved: 1, copied: 1, failed: 0 });
    const copy = await fileIn(shared, "ZAVM-PAS-A-0001.pdf");
    expect(copy.containerId).toBe(src.containerId);
    expect(copy.documentCode).toBe("ZAVM-PAS-A-0001");
  });

  it("refuses a manual copy that keeps the code (a copy is a new container)", async () => {
    const src = await fileIn(folderA, "ZAVM-PAS-A-0001.pdf");
    const r = await admin.post(`/projects/${pid}/files/${src.id}/copy`, { folderId: folderB });
    expect(r.status).toBe(409);
    expect(r.body.details).toMatchObject({ kind: "document_code", code: "ZAVM-PAS-A-0001" });
    const ok = await admin.post(`/projects/${pid}/files/${src.id}/copy`, { folderId: folderB, name: "ZAVM-PAS-A-0002.pdf" });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.containerId).toBe(ok.body.id);
    expect(ok.body.documentCode).toBe("ZAVM-PAS-A-0002");
  });

  it("checks rename and move (ISO19650-2 5.1.7(a) unique container id)", async () => {
    const two = await fileIn(folderB, "ZAVM-PAS-A-0002.pdf");
    // Rename onto a taken code.
    const taken = await admin.patch(`/projects/${pid}/files/${two.id}`, { name: "ZAVM-PAS-A-0001.pdf" });
    expect(taken.status).toBe(409);
    expect(taken.body.message).toContain("ZAVM-PAS-A-0001");
    // Moving keeps the container, so the code goes along.
    const moved = await admin.patch(`/projects/${pid}/files/${two.id}`, { folderId: folderA });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    // Rename to a free code moves the registration (the old code is free again).
    const renamed = await admin.patch(`/projects/${pid}/files/${two.id}`, { name: "ZAVM-PAS-A-0003.pdf" });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    const rows = await handle.db.select().from(documentCodes).where(eq(documentCodes.projectId, pid));
    expect(rows.map((r) => r.codeNorm).sort()).toEqual(["ZAVM-PAS-A-0001", "ZAVM-PAS-A-0003"]);
    // A file without a code (folder without a standard) gets one when moved under the standard.
    expect((await up(misc, "ZAVM-PAS-A-0001.pdf")).status).toBe(200);
    const loose = await fileIn(misc, "ZAVM-PAS-A-0001.pdf");
    expect(loose.documentCode).toBeNull();
    const into = await admin.patch(`/projects/${pid}/files/${loose.id}`, { folderId: folderB });
    expect(into.status).toBe(409);
    expect(into.body.message).toContain("A / ZAVM-PAS-A-0001.pdf");
  });

  it("locks the name once a copy is in Shared; admins override with a reason (audit cde.override)", async () => {
    const pdf = await fileIn(folderA, "ZAVM-PAS-A-0001.pdf");
    const byMember = await member.patch(`/projects/${pid}/files/${pdf.id}`, { name: "ZAVM-PAS-A-0009.pdf" });
    expect(byMember.status).toBe(403);
    const noReason = await admin.patch(`/projects/${pid}/files/${pdf.id}`, { name: "ZAVM-PAS-A-0009.pdf" });
    expect(noReason.status).toBe(400);
    const ok = await admin.patch(`/projects/${pid}/files/${pdf.id}`, { name: "ZAVM-PAS-A-0009.pdf", reason: "Typo in number" });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.documentCode).toBe("ZAVM-PAS-A-0009");
    const [entry] = await handle.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.projectId, pid), eq(auditLog.action, "cde.override")))
      .orderBy(desc(auditLog.id));
    expect(entry!.details).toMatchObject({ reason: "Typo in number", from: "ZAVM-PAS-A-0001.pdf", to: "ZAVM-PAS-A-0009.pdf" });
    // The container still holds 0001 (its rendition and Shared copy use it).
    const other = await up(folderB, "ZAVM-PAS-A-0001.pdf");
    expect(other.status).toBe(400);
    // Moving without a rename is not locked.
    const dwg = await fileIn(folderA, "ZAVM-PAS-A-0001.dwg");
    expect((await member.patch(`/projects/${pid}/files/${dwg.id}`, { folderId: folderB })).status).toBe(200);
  });

  it("ignores names that match no standard (D-5)", async () => {
    const fs = await admin.post(`/projects/${pid}/folders`, { parentId: misc, name: "Sub" });
    expect((await up(misc, "notes.txt", "a")).status).toBe(200);
    expect((await up(fs.body.id, "notes.txt", "b")).status).toBe(200);
    expect((await up(fs.body.id, "ZAVM-PAS-A-0003.pdf")).status).toBe(200);
    expect((await fileIn(fs.body.id, "ZAVM-PAS-A-0003.pdf")).documentCode).toBeNull();
  });

  it("uses the project's container standard for folders without one", async () => {
    expect((await admin.put(`/projects/${pid}/cde/settings`, { containerStandardId: stdId })).status).toBe(200);
    const r = await up(misc, "ZAVM-PAS-A-0003.pdf");
    expect(r.status).toBe(400);
    expect(r.body.results[0].conflict.code).toBe("ZAVM-PAS-A-0003");
    expect((await admin.put(`/projects/${pid}/cde/settings`, { containerStandardId: null })).status).toBe(200);
  });
});

describe("ISO19650-2 5.1.7(a) unique container id: live data backfill and conflicts list", () => {
  let admin: Api;
  let pid: string;
  let one: string;
  let two: string;

  it("registers existing codes first come by created_at; idempotent (ISO19650-2 5.1.7(a) unique container id)", async () => {
    admin = api(await login("admin@7d.test"));
    const p = await admin.post("/projects", { code: "DC2", name: "Legacy", template: "empty" });
    pid = p.body.id;
    one = (await admin.post(`/projects/${pid}/folders`, { parentId: p.body.rootFolderId, name: "One" })).body.id;
    two = (await admin.post(`/projects/${pid}/folders`, { parentId: p.body.rootFolderId, name: "Two" })).body.id;
    // Files from before the standard: no code, duplicates allowed.
    await admin.upload(`/projects/${pid}/folders/${two}/files`, "ZAVM-PAS-S-0001.pdf", "%PDF b");
    await admin.upload(`/projects/${pid}/folders/${one}/files`, "ZAVM-PAS-S-0001.pdf", "%PDF a");
    await admin.upload(`/projects/${pid}/folders/${one}/files`, "zavm-pas-s-0002.pdf", "%PDF c");
    const [older] = await handle.db.select().from(files).where(and(eq(files.folderId, two), eq(files.name, "ZAVM-PAS-S-0001.pdf")));
    const [newer] = await handle.db.select().from(files).where(and(eq(files.folderId, one), eq(files.name, "ZAVM-PAS-S-0001.pdf")));
    // Make the order explicit.
    await handle.db.update(files).set({ createdAt: new Date("2025-01-01T00:00:00Z") }).where(eq(files.id, older!.id));
    await handle.db.update(files).set({ createdAt: new Date("2025-02-01T00:00:00Z") }).where(eq(files.id, newer!.id));
    const std = await admin.post(`/projects/${pid}/naming-standards`, STANDARD);
    await handle.db.update(folders).set({ namingStandardId: std.body.id }).where(eq(folders.id, p.body.rootFolderId));

    const first = await runDocumentCodeBackfill(handle.db, { batchSize: 1, projectId: pid });
    expect(first).toEqual({ filesCoded: 2, codesRegistered: 1 });
    const [row] = await handle.db.select().from(documentCodes).where(eq(documentCodes.projectId, pid));
    expect(row).toMatchObject({ codeNorm: "ZAVM-PAS-S-0001", containerId: older!.containerId, firstFileId: older!.id });
    expect(await runDocumentCodeBackfill(handle.db, { projectId: pid })).toEqual({ filesCoded: 0, codesRegistered: 0 });
  });

  it("lists the duplicates for project admins; they are not blocked retroactively", async () => {
    const r = await admin.get(`/projects/${pid}/cde/code-conflicts`);
    expect(r.status).toBe(200);
    expect(r.body.conflicts).toHaveLength(1);
    expect(r.body.conflicts[0]).toMatchObject({
      code: "ZAVM-PAS-S-0001",
      holder: { name: "ZAVM-PAS-S-0001.pdf", path: expect.stringContaining("Two / ZAVM-PAS-S-0001.pdf") },
      others: [{ name: "ZAVM-PAS-S-0001.pdf", path: expect.stringContaining("One / ZAVM-PAS-S-0001.pdf") }],
    });
    // The duplicate still takes new versions.
    expect((await admin.upload(`/projects/${pid}/folders/${one}/files`, "ZAVM-PAS-S-0001.pdf", "%PDF a2")).status).toBe(200);
    // Members who are not project admins do not see the list.
    await admin.post("/users", { email: "uye2@7d.test", name: "Üye 2", password: PW });
    await admin.post(`/projects/${pid}/members`, { email: "uye2@7d.test" });
    const member = api(await login("uye2@7d.test"));
    expect((await member.get(`/projects/${pid}/cde/code-conflicts`)).status).toBe(403);
  });
});

describe("ISO19650-2 5.1.7(a) unique container id: enforcement off (D-8), codes registered, never refused", () => {
  let admin: Api;
  let pid: string;
  let wip: string;
  let shared: string;
  let a: string;
  let b: string;
  const up = (folder: string, name: string, data = "%PDF-1.4 x") => admin.upload(`/projects/${pid}/folders/${folder}/files`, name, data);
  const fileIn = async (folder: string, name: string) =>
    (await handle.db.select().from(files).where(and(eq(files.folderId, folder), eq(files.name, name))))[0]!;

  it("stores a duplicate with a warning and lists it (ISO19650-2 5.1.7(a) unique container id)", async () => {
    admin = api(await login("admin@7d.test"));
    const p = await admin.post("/projects", { code: "DC3", name: "Off", template: "iso19650" });
    pid = p.body.id;
    expect((await admin.get(`/projects/${pid}/cde/settings`)).body.enforceTransitions).toBe(false);
    const fs = await handle.db.select().from(folders).where(eq(folders.projectId, pid));
    wip = fs.find((f) => f.state === "wip")!.id;
    shared = fs.find((f) => f.state === "shared")!.id;
    a = (await admin.post(`/projects/${pid}/folders`, { parentId: wip, name: "A" })).body.id;
    b = (await admin.post(`/projects/${pid}/folders`, { parentId: wip, name: "B" })).body.id;
    const std = await admin.post(`/projects/${pid}/naming-standards`, STANDARD);
    await admin.patch(`/projects/${pid}/folders/${p.body.rootFolderId}`, { namingStandardId: std.body.id });

    const first = await up(a, "ZAVM-PAS-A-0001.pdf");
    expect(first.status).toBe(200);
    expect(first.body.results[0].warning).toBeUndefined();
    const holder = await fileIn(a, "ZAVM-PAS-A-0001.pdf");
    const dup = await up(b, "ZAVM-PAS-A-0001.pdf");
    expect(dup.status, JSON.stringify(dup.body)).toBe(200);
    expect(dup.body.results[0].ok).toBe(true);
    expect(dup.body.results[0].warning).toMatchObject({ kind: "document_code", code: "ZAVM-PAS-A-0001" });
    expect(dup.body.results[0].warning.existingPath).toContain("A / ZAVM-PAS-A-0001.pdf");
    const stored = await fileIn(b, "ZAVM-PAS-A-0001.pdf");
    expect(stored.documentCode).toBe("ZAVM-PAS-A-0001");
    expect(stored.containerId).not.toBe(holder.containerId);
    const [row] = await handle.db.select().from(documentCodes).where(eq(documentCodes.projectId, pid));
    expect(row!.containerId).toBe(holder.containerId);
    const list = await admin.get(`/projects/${pid}/cde/code-conflicts`);
    expect(list.body.conflicts).toHaveLength(1);
    expect(list.body.conflicts[0].others[0].fileId).toBe(stored.id);
  });

  it("still joins renditions to their container", async () => {
    const pdf = await fileIn(a, "ZAVM-PAS-A-0001.pdf");
    expect((await up(a, "ZAVM-PAS-A-0001.dwg", "AC1032")).status).toBe(200);
    expect((await fileIn(a, "ZAVM-PAS-A-0001.dwg")).containerId).toBe(pdf.containerId);
  });

  it("allows a copy keeping the code, a rename onto a held code, and renames after Shared", async () => {
    const pdf = await fileIn(a, "ZAVM-PAS-A-0001.pdf");
    const copy = await admin.post(`/projects/${pid}/files/${pdf.id}/copy`, { folderId: shared });
    expect(copy.status, JSON.stringify(copy.body)).toBe(200);
    expect(copy.body.documentCode).toBe("ZAVM-PAS-A-0001");
    expect((await up(b, "ZAVM-PAS-A-0002.pdf")).status).toBe(200);
    const two = await fileIn(b, "ZAVM-PAS-A-0002.pdf");
    const onto = await admin.patch(`/projects/${pid}/files/${two.id}`, { name: "ZAVM-PAS-A-0001.dwg" });
    expect(onto.status, JSON.stringify(onto.body)).toBe(200);
    // The copy sits in Shared: with enforcement on this rename would be locked; off, no reason needed.
    const renamed = await admin.patch(`/projects/${pid}/files/${copy.body.id}`, { name: "ZAVM-PAS-A-0005.pdf" });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    expect(renamed.body.documentCode).toBe("ZAVM-PAS-A-0005");
  });

  it("refuses the same duplicate once enforcement is switched on", async () => {
    expect((await admin.put(`/projects/${pid}/cde/settings`, { enforceTransitions: true })).status).toBe(200);
    const r = await up(b, "ZAVM-PAS-A-0001.txt", "x");
    expect(r.status).toBe(400);
    expect(r.body.results[0].conflict).toMatchObject({ code: "ZAVM-PAS-A-0001" });
  });
});
