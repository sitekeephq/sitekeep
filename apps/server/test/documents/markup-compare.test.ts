import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq, sql } from "drizzle-orm";
import { buildApp } from "../../src/app/build-app.js";
import { hashPassword } from "../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../src/db/index.js";
import { jobs as jobsTable, users, versionIndexes } from "../../src/db/schema.js";
import { JobQueue } from "../../src/jobs/queue.js";
import { LocalStorage } from "../../src/core/platform/storage.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const IFC_V1 = readFileSync(path.join(here, "../fixtures/sample-wall.ifc"));
const IFC_V2 = readFileSync(path.join(here, "../fixtures/sample-wall-v2.ifc"));
const PDF = "%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n";

const WALL = "3vB2YO$MX4xv5uCqZZG05x";
const SLAB = "1pPHnf7cXCpPsNEnQf8_6B";
const COLUMN = "1Ab2Cd3Ef4Gh5Ij6Kl7Mn8";

let handle: DbHandle;
let app: FastifyInstance;
let jobs: JobQueue;
let dataDir: string;

const PW = "Sifre-1234567";

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "7dcde-test-"));
  handle = await openDb("memory://");
  const storage = new LocalStorage(path.join(dataDir, "storage"));
  jobs = new JobQueue(handle.db, storage);
  app = await buildApp({ db: handle.db, storage, jobs });
  await handle.db
    .insert(users)
    .values({ email: "admin@7d.test", name: "Admin", passwordHash: await hashPassword(PW), isAdmin: true });
});

afterAll(async () => {
  await app.close();
  await handle.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function login(email: string, password = PW): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password } });
  expect(res.statusCode, res.body).toBe(200);
  const cookie = res.cookies.find((c) => c.name === "cde_session");
  return `cde_session=${cookie!.value}`;
}

function api(cookie: string) {
  const call = async (method: string, url: string, payload?: unknown) => {
    const res = await app.inject({
      method: method as "GET",
      url: `/api/v1${url}`,
      headers: { cookie },
      payload: payload as object,
    });
    let body: any = null;
    try {
      body = res.body ? res.json() : null;
    } catch {
      body = res.body;
    }
    return { status: res.statusCode, body, raw: res };
  };
  return {
    get: (u: string) => call("GET", u),
    post: (u: string, p?: unknown) => call("POST", u, p ?? {}),
    patch: (u: string, p: unknown) => call("PATCH", u, p),
    put: (u: string, p: unknown) => call("PUT", u, p),
    del: (u: string) => call("DELETE", u),
    upload: async (url: string, fileList: { name: string; data: Buffer | string }[]) => {
      const form = new FormData();
      for (const f of fileList) form.append("file", new Blob([f.data]), f.name);
      const req = new Request("http://x", { method: "POST", body: form });
      const body = Buffer.from(await req.arrayBuffer());
      const res = await app.inject({
        method: "POST",
        url: `/api/v1${url}`,
        headers: { cookie, "content-type": req.headers.get("content-type")! },
        payload: body,
      });
      return { status: res.statusCode, body: res.json() };
    },
  };
}

const rect = { type: "rect", color: "#d92d20", width: 2, from: [100, 100], to: [200, 160] };

describe("PDF markups, issue links and IFC comparison", () => {
  let admin: ReturnType<typeof api>;
  let murat: ReturnType<typeof api>; // view_download_markup
  let ayse: ReturnType<typeof api>; // view_download_markup
  let semih: ReturnType<typeof api>; // view
  let osman: ReturnType<typeof api>; // member without folder permission
  let projectId: string;
  let folderId: string;
  let pdfVersionId: string;
  let muratMarkupId: string;
  let ayseDraftId: string;
  let issueId: string;

  it("sets up users, a folder with permissions and a PDF", async () => {
    admin = api(await login("admin@7d.test"));
    const ids: Record<string, string> = {};
    for (const [key, name] of [
      ["murat", "Murat"],
      ["ayse", "Ayşe"],
      ["semih", "Semih"],
      ["osman", "Osman"],
    ]) {
      const u = await admin.post("/users", { email: `${key}@7d.test`, name, password: PW });
      expect(u.status).toBe(200);
      ids[key] = u.body.id;
    }
    const p = await admin.post("/projects", { code: "MRK", name: "Markup Projesi" });
    projectId = p.body.id;
    const contents = await admin.get(`/projects/${projectId}/folders/${p.body.rootFolderId}/contents`);
    const wipId = contents.body.folders[0].id;
    folderId = (await admin.post(`/projects/${projectId}/folders`, { parentId: wipId, name: "Paftalar" })).body.id;
    for (const key of ["murat", "ayse", "semih", "osman"])
      expect((await admin.post(`/projects/${projectId}/members`, { email: `${key}@7d.test` })).status).toBe(200);
    const perms = await admin.put(`/projects/${projectId}/folders/${folderId}/permissions`, {
      entries: [
        { subjectType: "user", subjectId: ids.murat, level: "view_download_markup" },
        { subjectType: "user", subjectId: ids.ayse, level: "view_download_markup" },
        { subjectType: "user", subjectId: ids.semih, level: "view" },
      ],
    });
    expect(perms.status).toBe(200);
    murat = api(await login("murat@7d.test"));
    ayse = api(await login("ayse@7d.test"));
    semih = api(await login("semih@7d.test"));
    osman = api(await login("osman@7d.test"));

    const up = await admin.upload(`/projects/${projectId}/folders/${folderId}/files`, [{ name: "A-101 Kat Planı.pdf", data: PDF }]);
    expect(up.status).toBe(200);
    const file = await admin.get(`/projects/${projectId}/files/${up.body.results[0].fileId}`);
    pdfVersionId = file.body.latest.id;
  });

  it("serves content inline with view permission only", async () => {
    const res = await semih.get(`/projects/${projectId}/versions/${pdfVersionId}/content`);
    expect(res.status).toBe(200);
    expect(res.raw.headers["content-type"]).toBe("application/pdf");
    expect(String(res.raw.headers["content-disposition"])).toMatch(/^inline;/);
    expect(res.raw.body).toBe(PDF);
    // The download endpoint still needs download permission.
    expect((await semih.get(`/projects/${projectId}/versions/${pdfVersionId}/download`)).status).toBe(403);
    // Members without folder access do not learn that it exists.
    expect((await osman.get(`/projects/${projectId}/versions/${pdfVersionId}/content`)).status).toBe(404);

    const info = await semih.get(`/projects/${projectId}/versions/${pdfVersionId}/info`);
    expect(info.body).toMatchObject({ fileName: "A-101 Kat Planı.pdf", extension: "pdf", canMarkup: false, canDownload: false });
    expect((await murat.get(`/projects/${projectId}/versions/${pdfVersionId}/info`)).body.canMarkup).toBe(true);
  });

  it("lets markup-level users draw; viewers cannot", async () => {
    const url = `/projects/${projectId}/versions/${pdfVersionId}/markups`;
    expect((await semih.post(url, { page: 1, shapes: [rect] })).status).toBe(403);
    expect((await osman.post(url, { page: 1, shapes: [rect] })).status).toBe(404);
    expect((await murat.post(url, { page: 1, shapes: [{ ...rect, color: "red" }] })).status).toBe(400);
    expect((await murat.post(url, { page: 0, shapes: [rect] })).status).toBe(400);

    const m = await murat.post(url, {
      page: 1,
      shapes: [rect, { type: "text", color: "#1f4e79", width: 1, at: [120, 180], text: "Kapı ölçüsü?", size: 12 }],
    });
    expect(m.status).toBe(200);
    expect(m.body).toMatchObject({ page: 1, published: false, authorName: "Murat" });
    muratMarkupId = m.body.id;

    const pen = { type: "pen", color: "#12b76a", width: 1.5, points: [[10, 10], [20, 25], [30, 12]] };
    const a = await ayse.post(url, { page: 2, shapes: [pen] });
    expect(a.status).toBe(200);
    ayseDraftId = a.body.id;
  });

  it("keeps drafts private until published", async () => {
    const url = `/projects/${projectId}/versions/${pdfVersionId}/markups`;
    expect((await murat.get(url)).body.map((m: { id: string }) => m.id)).toEqual([muratMarkupId]);
    expect((await ayse.get(url)).body.map((m: { id: string }) => m.id)).toEqual([ayseDraftId]);
    expect((await semih.get(url)).body).toEqual([]);

    // Others cannot touch, publish or even see a draft.
    expect((await ayse.post(`/projects/${projectId}/markups/${muratMarkupId}/publish`)).status).toBe(404);
    expect((await ayse.del(`/projects/${projectId}/markups/${muratMarkupId}`)).status).toBe(404);

    const pub = await murat.post(`/projects/${projectId}/markups/${muratMarkupId}/publish`);
    expect(pub.body.published).toBe(true);
    expect((await semih.get(url)).body.map((m: { id: string }) => m.id)).toEqual([muratMarkupId]);
    expect((await ayse.get(url)).body.map((m: { id: string }) => m.id)).toEqual([muratMarkupId, ayseDraftId]);

    // Published, but still only the author edits or deletes it.
    expect((await ayse.patch(`/projects/${projectId}/markups/${muratMarkupId}`, { shapes: [rect] })).status).toBe(403);
    expect((await ayse.del(`/projects/${projectId}/markups/${muratMarkupId}`)).status).toBe(403);
    const moved = await murat.patch(`/projects/${projectId}/markups/${muratMarkupId}`, {
      shapes: [{ ...rect, to: [250, 170] }],
    });
    expect(moved.status).toBe(200);
    expect(moved.body.shapes).toHaveLength(1);
    expect(moved.body.shapes[0].to).toEqual([250, 170]);
  });

  it("creates an issue from a markup and links it", async () => {
    const issue = await murat.post(`/projects/${projectId}/issues`, { title: "Kapı ölçüsü kontrol edilmeli", type: "Tasarım" });
    expect(issue.status).toBe(200);
    issueId = issue.body.id;
    const link = await murat.post(`/projects/${projectId}/issues/${issueId}/links`, { kind: "markup", targetId: muratMarkupId });
    expect(link.status).toBe(200);
    expect(link.body).toMatchObject({ kind: "markup", targetId: muratMarkupId, target: { versionId: pdfVersionId, page: 1 } });
    // Linking twice returns the same link.
    const again = await murat.post(`/projects/${projectId}/issues/${issueId}/links`, { kind: "markup", targetId: muratMarkupId });
    expect(again.body.id).toBe(link.body.id);
    expect(
      (await murat.post(`/projects/${projectId}/issues/${issueId}/links`, { kind: "version", targetId: pdfVersionId })).status,
    ).toBe(200);

    // Someone else's draft is invisible; a viewer cannot change somebody else's issue.
    expect((await murat.post(`/projects/${projectId}/issues/${issueId}/links`, { kind: "markup", targetId: ayseDraftId })).status).toBe(404);
    expect((await semih.post(`/projects/${projectId}/issues/${issueId}/links`, { kind: "version", targetId: pdfVersionId })).status).toBe(403);

    const onPdf = await semih.get(`/projects/${projectId}/versions/${pdfVersionId}/issue-links`);
    expect(onPdf.status).toBe(200);
    expect(onPdf.body).toHaveLength(2);
    expect(onPdf.body[0].issue).toMatchObject({ number: 1, title: "Kapı ölçüsü kontrol edilmeli", status: "open" });

    const ofIssue = await semih.get(`/projects/${projectId}/issues/${issueId}/links`);
    expect(ofIssue.body.map((l: { kind: string }) => l.kind).sort()).toEqual(["markup", "version"]);
    expect(ofIssue.body[0].target.fileName).toBe("A-101 Kat Planı.pdf");
    // Osman cannot see the folder, so he sees no targets.
    expect((await osman.get(`/projects/${projectId}/issues/${issueId}/links`)).body).toEqual([]);

    // Deleting the markup removes its link.
    expect((await murat.del(`/projects/${projectId}/markups/${muratMarkupId}`)).status).toBe(200);
    const after = await murat.get(`/projects/${projectId}/versions/${pdfVersionId}/issue-links`);
    expect(after.body.map((l: { kind: string }) => l.kind)).toEqual(["version"]);
    const issueStill = await murat.get(`/projects/${projectId}/issues/${issueId}`);
    expect(issueStill.status).toBe(200);
  });

  describe("IFC version comparison", () => {
    let v1: string;
    let v2: string;

    it("indexes IFC versions during conversion", async () => {
      const up1 = await admin.upload(`/projects/${projectId}/folders/${folderId}/files`, [{ name: "Model.ifc", data: IFC_V1 }]);
      expect(up1.status).toBe(200);
      await jobs.drain();
      const up2 = await admin.upload(`/projects/${projectId}/folders/${folderId}/files`, [{ name: "Model.ifc", data: IFC_V2 }]);
      expect(up2.body.results[0].version).toBe(2);
      await jobs.drain();
      const file = await admin.get(`/projects/${projectId}/files/${up2.body.results[0].fileId}`);
      [v2, v1] = file.body.versions.map((v: { id: string }) => v.id);
      expect(file.body.versions.every((v: { derivativeStatus: string }) => v.derivativeStatus === "ready")).toBe(true);
      const rows = await handle.db.select().from(versionIndexes);
      expect(rows.map((r) => r.elementCount).sort()).toEqual([2, 2]);
    });

    it("returns added, removed and changed GlobalIds", async () => {
      const res = await semih.get(`/projects/${projectId}/compare?from=${v1}&to=${v2}`);
      expect(res.status, res.body?.message).toBe(200);
      expect(res.body).toMatchObject({
        from: { versionId: v1, version: 1, elementCount: 2 },
        to: { versionId: v2, version: 2, elementCount: 2 },
        added: [COLUMN],
        removed: [SLAB],
        changed: [WALL],
        unchanged: 0,
      });
      expect(res.body.byClass).toEqual({
        IfcColumn: { added: 1, removed: 0, changed: 0, unchanged: 0 },
        IfcSlab: { added: 0, removed: 1, changed: 0, unchanged: 0 },
        IfcWall: { added: 0, removed: 0, changed: 1, unchanged: 0 },
      });
      expect(res.body.elements[SLAB]).toEqual(["IfcSlab", "Doseme-01"]);
      expect(res.body.elements[COLUMN]).toEqual(["IfcColumn", "Kolon-01"]);

      // Same version: nothing changes. Hashes are deterministic.
      const same = await semih.get(`/projects/${projectId}/compare?from=${v1}&to=${v1}`);
      expect(same.body).toMatchObject({ added: [], removed: [], changed: [], unchanged: 2 });
    });

    it("checks permissions and file types", async () => {
      expect((await osman.get(`/projects/${projectId}/compare?from=${v1}&to=${v2}`)).status).toBe(404);
      expect((await semih.get(`/projects/${projectId}/compare?from=${v1}&to=${pdfVersionId}`)).status).toBe(400);
      expect((await semih.get(`/projects/${projectId}/compare?from=${v1}`)).status).toBe(400);
    });

    it("backfills a missing index with a job and answers 409 meanwhile", async () => {
      await handle.db.delete(versionIndexes).where(eq(versionIndexes.versionId, v1));
      const first = await semih.get(`/projects/${projectId}/compare?from=${v1}&to=${v2}`);
      expect(first.status).toBe(409);
      expect(first.body).toMatchObject({ error: "preparing", details: { pending: [v1] } });
      expect(first.body.message).toContain("hazırlanıyor");
      // Asking again does not queue a second job.
      expect((await semih.get(`/projects/${projectId}/compare?from=${v1}&to=${v2}`)).status).toBe(409);
      const queued = await handle.db
        .select()
        .from(jobsTable)
        .where(and(eq(jobsTable.kind, "ifc_index"), eq(jobsTable.status, "queued"), sql`${jobsTable.payload}->>'versionId' = ${v1}`));
      expect(queued).toHaveLength(1);

      await jobs.drain();
      const res = await semih.get(`/projects/${projectId}/compare?from=${v1}&to=${v2}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ added: [COLUMN], removed: [SLAB], changed: [WALL] });
    });
  });
});
