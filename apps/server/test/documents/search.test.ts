/**
 * Document search (issue #191, docs/features/DOCUMENT_SEARCH.md): the query language, every filter,
 * folder scope, permission scoping in SQL (names, excerpts and counts), sorting and paging, the
 * recycle bin and saved searches with sharing.
 *
 * Runs on PGlite; SEARCH_TEST_DATABASE_URL=postgres://… runs the same against an empty PostgreSQL
 * database (with the pg_trgm indexes of migration 0061).
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { buildApp } from "../../src/app/build-app.js";
import { hashPassword } from "../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../src/db/index.js";
import {
  fileVersions,
  files,
  reviewFiles,
  reviews,
  users,
  versionTexts,
  wopiLocks,
  workflowInstances,
} from "../../src/db/schema.js";
import { JobQueue } from "../../src/jobs/queue.js";
import { LocalStorage } from "../../src/core/platform/storage.js";
import { contentPlan, dayStart } from "../../src/modules/documents/search.js";
import { cdeToolDefinitions } from "@sitekeep/cde-tools";

let handle: DbHandle;
let app: FastifyInstance;
let dataDir: string;
const PW = "Sifre-1234567";

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "sk-search-"));
  handle = await openDb(process.env.SEARCH_TEST_DATABASE_URL || "memory://");
  const storage = new LocalStorage(path.join(dataDir, "storage"));
  app = await buildApp({ db: handle.db, storage, jobs: new JobQueue(handle.db, storage) });
  await handle.db
    .insert(users)
    .values({ email: "admin@search.test", name: "Admin", passwordHash: await hashPassword(PW), isAdmin: true });
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
    del: (u: string) => call("DELETE", u),
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
      return res.json();
    },
  };
}

type Api = ReturnType<typeof api>;

describe("Document search", () => {
  let admin: Api, murat: Api, semih: Api, ayse: Api, pm: Api;
  let pid = "";
  const ids: Record<string, string> = {};
  const folder: Record<string, string> = {};
  const P = () => `/projects/${pid}`;
  const search = async (who: Api, qs: Record<string, string>) => {
    const r = await who.get(`${P()}/search?${new URLSearchParams(qs)}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body as { results: any[]; total: number; truncated: boolean; terms: string[] };
  };
  const names = async (who: Api, qs: Record<string, string>) => (await search(who, qs)).results.map((x) => x.name).sort();

  /** Uploads a file and sets what a test needs straight in the database. */
  async function file(
    key: string,
    folderId: string,
    name: string,
    o: {
      text?: string;
      source?: string;
      attributes?: Record<string, string>;
      suitability?: string;
      revision?: string;
      uploadedBy?: string;
      uploadedAt?: string;
      versions?: number;
      size?: number;
    } = {},
  ) {
    let fileId = "";
    for (let v = 1; v <= (o.versions ?? 1); v++) {
      const up = await admin.upload(`${P()}/folders/${folderId}/files`, name, `${name} v${v}`);
      fileId = up.results[0].fileId;
      expect(fileId, JSON.stringify(up)).toBeTruthy();
    }
    ids[key] = fileId;
    const db = handle.db;
    if (o.attributes) await db.update(files).set({ attributes: o.attributes }).where(eq(files.id, fileId));
    const [f] = await db.select().from(files).where(eq(files.id, fileId));
    const [v] = await db.select().from(fileVersions).where(eq(fileVersions.fileId, fileId)).orderBy(fileVersions.version);
    const all = await db.select().from(fileVersions).where(eq(fileVersions.fileId, fileId));
    const current = all.find((x) => x.version === f!.currentVersion)!;
    void v;
    await db
      .update(fileVersions)
      .set({
        ...(o.suitability && { suitabilityCode: o.suitability }),
        ...(o.revision && { revisionCode: o.revision }),
        ...(o.uploadedBy && { uploadedBy: o.uploadedBy }),
        ...(o.size && { size: o.size }),
        ...(o.uploadedAt && { uploadedAt: new Date(o.uploadedAt) }),
      })
      .where(eq(fileVersions.id, current.id));
    if (o.text)
      await db
        .insert(versionTexts)
        .values({ versionId: current.id, projectId: pid, source: o.source ?? "text", content: o.text })
        .onConflictDoUpdate({ target: versionTexts.versionId, set: { content: o.text, source: o.source ?? "text" } });
    return current.id;
  }

  let muratId = "", semihId = "", ayseId = "", poyraz = "", kuzey = "";
  const versionOf: Record<string, string> = {};

  it("sets up a project with folders in each ISO state, people and files", async () => {
    admin = api(await login("admin@search.test"));
    poyraz = (await admin.post("/companies", { name: "Poyraz İnşaat" })).body.id;
    kuzey = (await admin.post("/companies", { name: "Kuzey Müşavirlik" })).body.id;
    muratId = (await admin.post("/users", { email: "murat@s.test", name: "Murat", password: PW, companyId: poyraz })).body.id;
    semihId = (await admin.post("/users", { email: "semih@s.test", name: "Semih", password: PW, companyId: kuzey })).body.id;
    ayseId = (await admin.post("/users", { email: "ayse@s.test", name: "Ayşe", password: PW, companyId: kuzey })).body.id;
    await admin.post("/users", { email: "pm@s.test", name: "Proje Yöneticisi", password: PW, companyId: poyraz });
    const p = await admin.post("/projects", { code: "SRCH", name: "Arama Projesi" });
    pid = p.body.id;
    for (const email of ["murat@s.test", "semih@s.test", "ayse@s.test"]) expect((await admin.post(`${P()}/members`, { email })).status).toBe(200);
    await admin.post(`${P()}/members`, { email: "pm@s.test", isProjectAdmin: true });

    const root = (await admin.get(`${P()}/folders/${p.body.rootFolderId}/contents`)).body;
    for (const f of root.folders) if (f.state) folder[f.state] = f.id;
    expect(Object.keys(folder).sort()).toEqual(["archived", "published", "shared", "wip"]);
    folder.design = (await admin.post(`${P()}/folders`, { parentId: folder.wip, name: "Tasarım" })).body.id;
    folder.sub = (await admin.post(`${P()}/folders`, { parentId: folder.design, name: "Alt" })).body.id;
    folder.secret = (await admin.post(`${P()}/folders`, { parentId: folder.wip, name: "Gizli" })).body.id;

    // Murat edits Tasarım and sees Shared; Semih sees Shared and Published; Ayşe may only upload to Tasarım.
    await admin.put(`${P()}/folders/${folder.design}/permissions`, {
      entries: [
        { subjectType: "user", subjectId: muratId, level: "edit" },
        { subjectType: "user", subjectId: ayseId, level: "upload_only" },
      ],
    });
    await admin.put(`${P()}/folders/${folder.shared}/permissions`, {
      entries: [
        { subjectType: "user", subjectId: muratId, level: "view" },
        { subjectType: "user", subjectId: semihId, level: "view" },
      ],
    });
    await admin.put(`${P()}/folders/${folder.published}/permissions`, {
      entries: [{ subjectType: "user", subjectId: semihId, level: "view" }],
    });

    versionOf.doc = await file("doc", folder.design, "DOC-01-A Kolon detay.pdf", {
      text: "Kapak sayfası\n\f\nİkinci sayfada istasyon <b>kolon</b> donatısı\n\f\nÜçüncü",
      source: "pdf",
      attributes: { Disiplin: "STATİK" },
      suitability: "S1",
      revision: "P01.01",
      uploadedAt: "2026-03-10T09:00:00Z",
      size: 5000,
    });
    versionOf.report = await file("report", folder.sub, "Kiriş raporu.docx", {
      text: '<w:p><w:r><w:t xml:space="preserve">Zemin etüdü</w:t></w:r></w:p> istasyon binası kat planı',
      source: "office",
      uploadedAt: "2026-04-01T09:00:00Z",
      size: 300,
    });
    versionOf.secret = await file("secret", folder.secret, "Gizli istasyon notu.txt", {
      text: "istasyon kolon gizli bilgi",
      attributes: { Disiplin: "STATİK" },
      uploadedAt: "2026-04-02T09:00:00Z",
    });
    versionOf.plan = await file("plan", folder.shared, "Mimari plan.dwg", {
      attributes: { Disiplin: "MİMARİ" },
      suitability: "S2",
      revision: "P01.02",
      uploadedBy: muratId,
      uploadedAt: "2026-05-05T09:00:00Z",
      size: 90000,
    });
    versionOf.approved = await file("approved", folder.published, "Onaylı istasyon.pdf", {
      suitability: "A1",
      revision: "C01",
      uploadedAt: "2026-06-01T09:00:00Z",
      size: 1200,
    });
    versionOf.old = await file("old", folder.shared, "Eski taslak.txt", {
      text: "istasyon taslak",
      uploadedAt: "2025-01-10T09:00:00Z",
      versions: 3,
      size: 10,
    });
    versionOf.archived = await file("archived", folder.archived, "Arşiv kolon.pdf", { uploadedAt: "2024-01-01T09:00:00Z" });

    murat = api(await login("murat@s.test"));
    semih = api(await login("semih@s.test"));
    ayse = api(await login("ayse@s.test"));
    pm = api(await login("pm@s.test"));
  });

  it("parses AND / OR / NOT, parentheses, wildcards, phrases and split codes", async () => {
    expect(await names(murat, { q: "istasyon" })).toEqual(["DOC-01-A Kolon detay.pdf", "Eski taslak.txt", "Kiriş raporu.docx"]);
    expect(await names(murat, { q: "istasyon NOT taslak" })).toEqual(["DOC-01-A Kolon detay.pdf", "Kiriş raporu.docx"]);
    expect(await names(murat, { q: "kolon OR zemin" })).toEqual(["DOC-01-A Kolon detay.pdf", "Kiriş raporu.docx"]);
    expect(await names(murat, { q: "istasyon AND (kolon OR mimari)" })).toEqual(["DOC-01-A Kolon detay.pdf"]);
    expect(await names(murat, { q: '"zemin etüdü"' })).toEqual(["Kiriş raporu.docx"]);
    expect(await names(murat, { q: '"etüdü zemin"' })).toEqual([]);
    expect(await names(murat, { q: "ista*on binas*" })).toEqual(["Kiriş raporu.docx"]);
    expect(await names(murat, { q: "DOC-01-A" })).toEqual(["DOC-01-A Kolon detay.pdf"]);
    expect(await names(murat, { q: "doc 01" })).toEqual(["DOC-01-A Kolon detay.pdf"]);
    // Turkish I folding as before: "KİRİŞ", "kırış" find "Kiriş raporu".
    expect(await names(murat, { q: "KIRIŞ" })).toEqual(["Kiriş raporu.docx"]);
    // Attribute values are searched too.
    expect(await names(murat, { q: "mimari" })).toEqual(["Mimari plan.dwg"]);
    expect(await names(murat, { q: "statik" })).toEqual(["DOC-01-A Kolon detay.pdf"]);
    // In the text a word must start with the term; a leading * finds it inside words.
    expect(await names(murat, { q: "donatı" })).toEqual(["DOC-01-A Kolon detay.pdf"]);
    expect(await names(murat, { q: "onatı" })).toEqual([]);
    expect(await names(murat, { q: "*onatı" })).toEqual(["DOC-01-A Kolon detay.pdf"]);
    // A key name alone is not a match (only values).
    expect(await names(murat, { q: "disiplin" })).toEqual([]);
  });

  it("returns clean excerpts, the PDF page, match places and highlight terms", async () => {
    const r = await search(murat, { q: "kolon" });
    const doc = r.results.find((x) => x.id === ids.doc)!;
    expect(doc.matchedIn).toEqual(["name", "content"]);
    expect(doc.page).toBe(2);
    expect(doc.snippet).toContain("istasyon kolon donatısı");
    expect(doc.snippet).not.toMatch(/[<>]/);
    expect(r.terms).toEqual(["kolon"]);

    const office = (await search(murat, { q: "etüdü" })).results[0];
    expect(office.matchedIn).toEqual(["content"]);
    expect(office.page).toBeUndefined();
    expect(office.snippet).toBe("Zemin etüdü istasyon binası kat planı");

    const attr = (await search(murat, { q: "statik" })).results[0];
    expect(attr.matchedIn).toEqual(["attribute"]);
    expect(attr.snippet).toBeUndefined();

    // content=0: names and attributes only.
    expect(await names(murat, { q: "etüdü", content: "0" })).toEqual([]);
    expect(await names(murat, { q: "kolon", content: "0" })).toEqual(["DOC-01-A Kolon detay.pdf"]);
  });

  it("ranks name matches above attribute and content matches", async () => {
    const r = await search(admin, { q: "kolon" });
    const order = r.results.map((x) => x.name);
    expect(order.slice(0, 2).sort()).toEqual(["Arşiv kolon.pdf", "DOC-01-A Kolon detay.pdf"]);
    expect(order[order.length - 1]).toBe("Gizli istasyon notu.txt");
  });

  it("filters by type, attribute, ISO state, codes, uploader, company, dates, version, review and lock", async () => {
    expect(await names(admin, { ext: "pdf" })).toEqual(["Arşiv kolon.pdf", "DOC-01-A Kolon detay.pdf", "Onaylı istasyon.pdf"]);
    expect(await names(admin, { ext: "dwg,docx" })).toEqual(["Kiriş raporu.docx", "Mimari plan.dwg"]);
    expect(await names(admin, { "attr.Disiplin": "statik" })).toEqual(["DOC-01-A Kolon detay.pdf", "Gizli istasyon notu.txt"]);
    expect(await names(admin, { state: "shared" })).toEqual(["Eski taslak.txt", "Mimari plan.dwg"]);
    expect(await names(admin, { state: "published,archived" })).toEqual(["Arşiv kolon.pdf", "Onaylı istasyon.pdf"]);
    expect(await names(admin, { state: "wip", q: "istasyon" })).toEqual(["DOC-01-A Kolon detay.pdf", "Gizli istasyon notu.txt", "Kiriş raporu.docx"]);
    expect(await names(admin, { suitability: "s2,A1" })).toEqual(["Mimari plan.dwg", "Onaylı istasyon.pdf"]);
    expect(await names(admin, { revision: "P01*" })).toEqual(["DOC-01-A Kolon detay.pdf", "Mimari plan.dwg"]);
    expect(await names(admin, { revision: "p01.02" })).toEqual(["Mimari plan.dwg"]);
    expect(await names(admin, { uploadedBy: muratId })).toEqual(["Mimari plan.dwg"]);
    expect(await names(admin, { company: poyraz })).toEqual(["Mimari plan.dwg"]);
    expect(await names(admin, { company: kuzey })).toEqual([]);
    expect(await names(admin, { updatedFrom: "2026-04-01", updatedTo: "2026-05-31" })).toEqual([
      "Gizli istasyon notu.txt",
      "Kiriş raporu.docx",
      "Mimari plan.dwg",
    ]);
    expect(await names(admin, { updatedTo: "2025-12-31" })).toEqual(["Arşiv kolon.pdf", "Eski taslak.txt"]);
    // "Eski taslak" has an old current version but its earlier versions were added recently.
    const today = new Date().toISOString().slice(0, 10);
    expect(await names(admin, { addedFrom: today, state: "shared" })).toEqual(["Eski taslak.txt"]);
    expect(await names(admin, { addedTo: "2026-05-05", state: "shared" })).toEqual(["Eski taslak.txt", "Mimari plan.dwg"]);
    expect(await names(admin, { version: "3" })).toEqual(["Eski taslak.txt"]);
    expect(await names(admin, { version: "2-5" })).toEqual(["Eski taslak.txt"]);

    // Review outcome: the latest decision on the current version.
    const [review] = await handle.db
      .insert(reviews)
      .values({ projectId: pid, number: 1, name: "İnceleme 1", createdBy: muratId })
      .returning();
    await handle.db.insert(workflowInstances).values({
      projectId: pid,
      kind: "review" as any,
      template: {} as any,
      subjectType: "review",
      subjectId: review!.id,
      status: "completed" as any,
      startedBy: muratId,
    });
    await handle.db.insert(reviewFiles).values([
      { reviewId: review!.id, fileId: ids.approved!, fileVersionId: versionOf.approved!, sourceFolderId: folder.published!, finalStatus: "approved", decidedAt: new Date() },
      { reviewId: review!.id, fileId: ids.plan!, fileVersionId: versionOf.plan!, sourceFolderId: folder.shared!, finalStatus: "revise_resubmit", decidedAt: new Date() },
    ]);
    const [running] = await handle.db
      .insert(reviews)
      .values({ projectId: pid, number: 2, name: "İnceleme 2", createdBy: muratId })
      .returning();
    await handle.db.insert(workflowInstances).values({
      projectId: pid,
      kind: "review" as any,
      template: {} as any,
      subjectType: "review",
      subjectId: running!.id,
      status: "running" as any,
      startedBy: muratId,
    });
    await handle.db.insert(reviewFiles).values({ reviewId: running!.id, fileId: ids.doc!, fileVersionId: versionOf.doc!, sourceFolderId: folder.design! });
    expect(await names(admin, { review: "approved" })).toEqual(["Onaylı istasyon.pdf"]);
    expect(await names(admin, { review: "approved,revise_resubmit" })).toEqual(["Mimari plan.dwg", "Onaylı istasyon.pdf"]);
    expect(await names(admin, { review: "pending" })).toEqual(["DOC-01-A Kolon detay.pdf"]);
    expect(await names(admin, { review: "none", state: "shared" })).toEqual(["Eski taslak.txt"]);

    await handle.db.insert(wopiLocks).values([
      { fileId: ids.report!, lockId: "L1", userId: muratId, expiresAt: new Date(Date.now() + 600_000) },
      { fileId: ids.plan!, lockId: "L2", userId: muratId, expiresAt: new Date(Date.now() - 600_000) },
    ]);
    expect(await names(admin, { locked: "1" })).toEqual(["Kiriş raporu.docx"]);

    // Filters combine with the query and with each other.
    expect(await names(admin, { q: "istasyon", ext: "pdf", state: "published" })).toEqual(["Onaylı istasyon.pdf"]);
  });

  it("rejects bad filter values", async () => {
    expect((await murat.get(`${P()}/search?version=abc`)).status).toBe(400);
    expect((await murat.get(`${P()}/search?updatedFrom=2026-13-45x`)).status).toBe(400);
    expect((await murat.get(`${P()}/search?q=${"x".repeat(201)}`)).status).toBe(400);
  });

  it("scopes to a folder with or without subfolders, or to selected folders", async () => {
    expect(await names(murat, { folderId: folder.design! })).toEqual(["DOC-01-A Kolon detay.pdf", "Kiriş raporu.docx"]);
    expect(await names(murat, { folderId: folder.design!, subfolders: "0" })).toEqual(["DOC-01-A Kolon detay.pdf"]);
    expect(await names(murat, { folderIds: `${folder.sub},${folder.shared}` })).toEqual(["Eski taslak.txt", "Kiriş raporu.docx", "Mimari plan.dwg"]);
    // A selected folder the caller cannot see is skipped (no error, nothing from it).
    expect(await names(murat, { folderIds: `${folder.secret},${folder.sub}`, q: "istasyon" })).toEqual(["Kiriş raporu.docx"]);
    expect(await names(murat, { folderIds: folder.secret! })).toEqual([]);
    // A single folder the caller cannot see: 404, as before.
    expect((await murat.get(`${P()}/search?folderId=${folder.secret}`)).status).toBe(404);
  });

  it("never shows names, excerpts or counts from folders the caller cannot read", async () => {
    // Murat: the "Gizli" folder's file matches "gizli" in its name and content, but is not his to see.
    const hidden = await search(murat, { q: "gizli" });
    expect(hidden).toMatchObject({ results: [], total: 0, truncated: false });
    const all = await search(murat, { q: "istasyon", limit: "1" });
    expect(all.total).toBe(3);
    expect(all.truncated).toBe(true);
    expect(JSON.stringify((await search(murat, { q: "istasyon" })).results)).not.toContain("gizli");
    // Semih sees Shared and Published only; filters cannot widen that.
    expect(await names(semih, { q: "istasyon" })).toEqual(["Eski taslak.txt", "Onaylı istasyon.pdf"]);
    expect(await names(semih, { "attr.Disiplin": "statik" })).toEqual([]);
    expect(await names(semih, { state: "wip" })).toEqual([]);
    expect((await search(semih, { q: "kolon" })).total).toBe(0);
    // Upload-only: Ayşe sees only what she uploaded herself.
    expect(await names(ayse, {})).toEqual([]);
    await ayse.upload(`${P()}/folders/${folder.design}/files`, "Ayşe istasyon.txt", "x");
    expect(await names(ayse, { q: "istasyon" })).toEqual(["Ayşe istasyon.txt"]);
    expect((await search(murat, { q: "ayşe" })).total).toBe(1);
  });

  it("sorts by relevance, name, date and size, with paging", async () => {
    const order = async (qs: Record<string, string>) => (await search(admin, { state: "shared,published", ...qs })).results.map((x) => x.name);
    expect(await order({})).toEqual(["Eski taslak.txt", "Mimari plan.dwg", "Onaylı istasyon.pdf"]);
    expect(await order({ sort: "name", dir: "desc" })).toEqual(["Onaylı istasyon.pdf", "Mimari plan.dwg", "Eski taslak.txt"]);
    expect(await order({ sort: "date" })).toEqual(["Onaylı istasyon.pdf", "Mimari plan.dwg", "Eski taslak.txt"]);
    expect(await order({ sort: "date", dir: "asc" })).toEqual(["Eski taslak.txt", "Mimari plan.dwg", "Onaylı istasyon.pdf"]);
    expect(await order({ sort: "size" })).toEqual(["Mimari plan.dwg", "Onaylı istasyon.pdf", "Eski taslak.txt"]);
    const page2 = await search(admin, { state: "shared,published", sort: "name", limit: "2", offset: "2" });
    expect(page2).toMatchObject({ total: 3, truncated: false });
    expect(page2.results.map((x) => x.name)).toEqual(["Onaylı istasyon.pdf"]);
    const page1 = await search(admin, { state: "shared,published", sort: "name", limit: "2" });
    expect(page1).toMatchObject({ total: 3, truncated: true });
    expect((await search(admin, { state: "shared", offset: "10" })).results).toEqual([]);
  });

  it("searches the recycle bin for project administrators", async () => {
    expect((await murat.del(`${P()}/files/${ids.doc}`)).status).toBe(200);
    expect(await names(murat, { q: "kolon" })).toEqual([]);
    expect((await murat.get(`${P()}/search?trash=1&q=kolon`)).status).toBe(403);
    const bin = await search(pm, { trash: "1", q: "kolon" });
    expect(bin.results.map((x) => x.name)).toEqual(["DOC-01-A Kolon detay.pdf"]);
    expect(bin.results[0].deletedAt).toBeTruthy();
    expect(bin.results[0].folderPath).toContain("Tasarım");
    await pm.post(`${P()}/trash/files/${ids.doc}/restore`);
    expect((await search(pm, { trash: "1", q: "kolon" })).total).toBe(0);
  });

  it("keeps saved searches personal until a project administrator shares them", async () => {
    const mine = await murat.post(`${P()}/saved-searches`, { name: "İstasyon PDF", params: { q: "istasyon", ext: ["pdf"], offset: 50, bogus: 1 } });
    expect(mine.status).toBe(200);
    expect(mine.body).toMatchObject({ name: "İstasyon PDF", mine: true, shares: [], params: { q: "istasyon", ext: ["pdf"] } });
    expect(mine.body.params.offset).toBeUndefined();
    expect((await murat.post(`${P()}/saved-searches`, { name: " ", params: {} })).status).toBe(400);

    expect((await murat.get(`${P()}/saved-searches`)).body.map((s: any) => s.name)).toEqual(["İstasyon PDF"]);
    expect((await semih.get(`${P()}/saved-searches`)).body).toEqual([]);
    // Others cannot read, change or share it; Murat cannot share at all (not a project administrator).
    expect((await semih.patch(`${P()}/saved-searches/${mine.body.id}`, { name: "x" })).status).toBe(404);
    expect((await semih.del(`${P()}/saved-searches/${mine.body.id}`)).status).toBe(404);
    expect((await murat.put(`${P()}/saved-searches/${mine.body.id}/shares`, { shares: [{ subjectType: "project", subjectId: pid }] })).status).toBe(403);
    const renamed = await murat.patch(`${P()}/saved-searches/${mine.body.id}`, { name: "İstasyon PDF'leri", params: { q: "istasyon", sort: "date" } });
    expect(renamed.body).toMatchObject({ name: "İstasyon PDF'leri", params: { q: "istasyon", sort: "date" } });

    // The project manager saves a search over Gizli + Shared and shares it with the Kuzey company.
    const team = await pm.post(`${P()}/saved-searches`, {
      name: "Ekip: istasyon",
      params: { q: "istasyon", folderIds: [folder.secret, folder.shared] },
    });
    expect((await pm.put(`${P()}/saved-searches/${team.body.id}/shares`, { shares: [{ subjectType: "user", subjectId: "00000000-0000-4000-8000-000000000000" }] })).status).toBe(400);
    const outsider = (await admin.post("/companies", { name: "Dış Firma" })).body.id;
    expect((await pm.put(`${P()}/saved-searches/${team.body.id}/shares`, { shares: [{ subjectType: "company", subjectId: outsider }] })).status).toBe(400);
    const shared = await pm.put(`${P()}/saved-searches/${team.body.id}/shares`, { shares: [{ subjectType: "company", subjectId: kuzey }] });
    expect(shared.status).toBe(200);
    expect(shared.body.shares).toEqual([{ subjectType: "company", subjectId: kuzey, subjectName: "Kuzey Müşavirlik" }]);

    // Semih and Ayşe (Kuzey) get it, without the share list; Murat (Poyraz) does not.
    const semihList = (await semih.get(`${P()}/saved-searches`)).body;
    expect(semihList).toEqual([expect.objectContaining({ name: "Ekip: istasyon", mine: false, shares: [], ownerName: "Proje Yöneticisi" })]);
    expect((await ayse.get(`${P()}/saved-searches`)).body.map((s: any) => s.name)).toEqual(["Ekip: istasyon"]);
    expect((await murat.get(`${P()}/saved-searches`)).body.map((s: any) => s.name)).toEqual(["İstasyon PDF'leri"]);
    expect((await semih.del(`${P()}/saved-searches/${team.body.id}`)).status).toBe(403);

    // Running it shows what the runner may see: nothing from Gizli for Semih, everything for the PM.
    const qs = (p: any) => ({ q: p.q, folderIds: p.folderIds.join(",") });
    const params = semihList[0].params;
    expect(await names(semih, qs(params))).toEqual(["Eski taslak.txt"]);
    expect(await names(pm, qs(params))).toEqual(["Eski taslak.txt", "Gizli istasyon notu.txt"]);

    // Shared with the whole project: Murat sees it too.
    await pm.put(`${P()}/saved-searches/${team.body.id}/shares`, { shares: [{ subjectType: "project", subjectId: pid }] });
    expect((await murat.get(`${P()}/saved-searches`)).body.map((s: any) => s.name).sort()).toEqual(["Ekip: istasyon", "İstasyon PDF'leri"]);
    // Unshared: gone for others.
    await pm.put(`${P()}/saved-searches/${team.body.id}/shares`, { shares: [] });
    expect((await semih.get(`${P()}/saved-searches`)).body).toEqual([]);
    expect((await murat.del(`${P()}/saved-searches/${mine.body.id}`)).status).toBe(200);
    expect((await murat.get(`${P()}/saved-searches`)).body).toEqual([]);
  });

  it("offers the search with filters as the cde_documents_search tool (MCP), under the caller's permissions", async () => {
    const cookie = await login("semih@s.test");
    const call = async (method: string, url: string) => {
      const res = await app.inject({ method: method as "GET", url: `/api/v1${url}`, headers: { cookie } });
      if (res.statusCode >= 400) throw new Error(res.body);
      return res.json();
    };
    const tool = cdeToolDefinitions(call as never).find((x) => x.name === "cde_documents_search")!;
    const out = (await tool.run({ projectId: pid, q: "istasyon", states: ["published"], content: true, limit: 25, offset: 0 })) as any;
    expect(out).toMatchObject({ total: 1, more: false, results: [{ name: "Onaylı istasyon.pdf", matchedIn: ["name"], suitability: "A1" }] });
    const hidden = (await tool.run({ projectId: pid, q: "gizli", content: true, limit: 25, offset: 0 })) as any;
    expect(hidden).toEqual({ total: 0, more: false, results: [] });
  });

  it("plans content matching: word prefixes by the full-text index, the rest exactly", () => {
    expect(contentPlan("istasyon")).toEqual({ prefix: "istasyon", check: "none" });
    expect(contentPlan("Rapor*")).toEqual({ prefix: "rapor", check: "none" });
    expect(contentPlan("ista*on")).toEqual({ prefix: "ista", check: "lexeme" });
    expect(contentPlan("zemin etüdü")).toEqual({ prefix: "zemin", check: "like" });
    expect(contentPlan("*tasyon")).toEqual({ prefix: null, check: "like" });
  });

  it("reads day boundaries in the reporting time zone", () => {
    expect(dayStart("2026-03-10", "Europe/Istanbul").toISOString()).toBe("2026-03-09T21:00:00.000Z");
    expect(dayStart("2026-03-10", "UTC").toISOString()).toBe("2026-03-10T00:00:00.000Z");
  });
});
