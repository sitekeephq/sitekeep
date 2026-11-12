import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app/build-app.js";
import { hashPassword } from "../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../src/db/index.js";
import { users } from "../../src/db/schema.js";
import { JobQueue } from "../../src/jobs/queue.js";
import { LocalStorage } from "../../src/core/platform/storage.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const IFC = readFileSync(path.join(here, "../fixtures/sample-wall.ifc"));

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
    put: (u: string, p: unknown) => call("PUT", u, p),
    patch: (u: string, p: unknown) => call("PATCH", u, p),
    del: (u: string) => call("DELETE", u),
    upload: async (url: string, fileList: { name: string; data: Buffer | string }[], fields: Record<string, string> = {}) => {
      const form = new FormData();
      for (const [k, v] of Object.entries(fields)) form.append(k, v);
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

describe("SiteKeep API", () => {
  let admin: ReturnType<typeof api>;
  let murat: ReturnType<typeof api>;
  let semih: ReturnType<typeof api>;
  let projectId: string;
  let rootId: string;
  let wipId: string;
  let designId: string;
  let poyrazId: string;
  let muratId: string;
  let semihId: string;

  it("rejects anonymous requests and bad passwords", async () => {
    expect((await app.inject({ url: "/api/v1/projects" })).statusCode).toBe(401);
    const bad = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "admin@7d.test", password: "wrong" },
    });
    expect(bad.statusCode).toBe(401);
  });

  it("sets up companies, users and a project", async () => {
    admin = api(await login("admin@7d.test"));
    poyrazId = (await admin.post("/companies", { name: "Poyraz İnşaat" })).body.id;
    const cns = (await admin.post("/companies", { name: "CNS" })).body.id;
    muratId = (await admin.post("/users", { email: "murat@poyraz.test", name: "Murat", password: PW, companyId: poyrazId })).body.id;
    semihId = (await admin.post("/users", { email: "semih@cns.test", name: "Semih", password: PW, companyId: cns })).body.id;

    const p = await admin.post("/projects", { code: "ZAVM", name: "Zirve Veri Merkezi" });
    expect(p.status).toBe(200);
    projectId = p.body.id;
    rootId = p.body.rootFolderId;

    const contents = await admin.get(`/projects/${projectId}/folders/${rootId}/contents`);
    expect(contents.body.folders.map((f: { name: string }) => f.name)).toEqual([
      "01-WIP (Çalışmada)",
      "02-SHARED (Paylaşılan)",
      "03-PUBLISHED (Yayınlanan)",
      "04-ARCHIVED (Arşiv)",
    ]);
    wipId = contents.body.folders[0].id;
    designId = (await admin.post(`/projects/${projectId}/folders`, { parentId: wipId, name: "Tasarım" })).body.id;

    expect((await admin.post(`/projects/${projectId}/members`, { email: "murat@poyraz.test" })).status).toBe(200);
    expect((await admin.post(`/projects/${projectId}/members`, { email: "semih@cns.test" })).status).toBe(200);
    murat = api(await login("murat@poyraz.test"));
    semih = api(await login("semih@cns.test"));
  });

  it("hides folders without permission and inherits grants downwards", async () => {
    let c = await murat.get(`/projects/${projectId}/folders/${rootId}/contents`);
    expect(c.body.folders).toEqual([]);
    expect((await murat.get(`/projects/${projectId}/folders/${designId}/contents`)).status).toBe(404);

    // Company-wide view on WIP, edit for Murat on Tasarım.
    const r = await admin.put(`/projects/${projectId}/folders/${wipId}/permissions`, {
      entries: [{ subjectType: "company", subjectId: poyrazId, level: "view" }],
    });
    expect(r.body.results[0].status).toBe("ok");
    await admin.put(`/projects/${projectId}/folders/${designId}/permissions`, {
      entries: [{ subjectType: "user", subjectId: muratId, level: "edit" }],
    });

    c = await murat.get(`/projects/${projectId}/folders/${rootId}/contents`);
    expect(c.body.folders.map((f: { name: string }) => f.name)).toEqual(["01-WIP (Çalışmada)"]);
    const d = await murat.get(`/projects/${projectId}/folders/${designId}`);
    expect(d.body.myLevel).toBe("edit");
    expect(d.body.path.map((f: { name: string }) => f.name)).toEqual(["Proje Dosyaları", "01-WIP (Çalışmada)", "Tasarım"]);

    // Lowering an inherited permission on a subfolder is rejected.
    const low = await admin.put(`/projects/${projectId}/folders/${designId}/permissions`, {
      entries: [{ subjectType: "company", subjectId: poyrazId, level: "upload_only" }],
    });
    expect(low.body.results[0].status).toBe("rejected_lower_than_inherited:view");

    // Only managers may read or change permissions.
    expect((await murat.get(`/projects/${projectId}/folders/${designId}/permissions`)).status).toBe(403);
    const grants = (await admin.get(`/projects/${projectId}/folders/${designId}/permissions`)).body;
    expect(grants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ subjectType: "user", level: "edit", inherited: false, subjectName: "Murat" }),
        expect.objectContaining({ subjectType: "company", level: "view", inherited: true, subjectName: "Poyraz İnşaat" }),
      ]),
    );
  });

  it("enforces the naming standard on upload", async () => {
    const std = await admin.post(`/projects/${projectId}/naming-standards`, {
      name: "ZAVM",
      delimiter: "-",
      fields: [
        { name: "Proje", type: "list", values: [{ code: "ZAVM" }] },
        { name: "Firma", type: "list", values: [{ code: "PAS" }, { code: "CNS" }] },
        { name: "Rol", type: "list", values: [{ code: "A" }, { code: "S" }] },
        { name: "Numara", type: "number", digits: 4 },
      ],
    });
    expect(std.status).toBe(200);
    await admin.patch(`/projects/${projectId}/folders/${wipId}`, { namingStandardId: std.body.id });

    const check = await murat.post(`/projects/${projectId}/naming/validate`, {
      folderId: designId,
      names: ["ZAVM-PAS-S-0001.ifc", "ZAVM-XXX-S-1.pdf"],
    });
    expect(check.body.results.map((r: { ok: boolean }) => r.ok)).toEqual([true, false]);

    const res = await murat.upload(`/projects/${projectId}/folders/${designId}/files`, [
      { name: "ZAVM-PAS-S-0001.ifc", data: IFC },
      { name: "yanlış ad.pdf", data: "x" },
    ]);
    expect(res.status).toBe(200);
    expect(res.body.results.find((r: { name: string }) => r.name === "yanlış ad.pdf").ok).toBe(false);
    expect(res.body.results.find((r: { name: string }) => r.name === "ZAVM-PAS-S-0001.ifc").version).toBe(1);
  });

  it("stores Forma-style naming options (delimiter codes, digit ranges, metadata fields)", async () => {
    const def = {
      name: "Metro Kodlama Sistemi",
      delimiter: "-",
      allowDelimiterInCodes: true,
      fields: [
        { name: "ALAN", type: "list", values: [{ code: "SG1" }, { code: "SKP1-A" }] },
        { name: "Number", type: "number", digits: 3, minDigits: 2, maxDigits: 3 },
        { name: "Revizyon", type: "text", maxLength: 8, inName: false },
      ],
    };
    const ok = await admin.post(`/projects/${projectId}/naming-standards`, def);
    expect(ok.status).toBe(200);
    expect(ok.body.definition).toEqual(def);
    const bad = await admin.post(`/projects/${projectId}/naming-standards`, { ...def, allowDelimiterInCodes: false });
    expect(bad.status).toBe(400);
  });

  it("converts IFC to fragments and serves the model", async () => {
    await jobs.drain();
    const models = await murat.get(`/projects/${projectId}/models`);
    expect(models.body).toHaveLength(1);
    const m = models.body[0];
    expect(m.derivativeStatus).toBe("ready");
    expect(m.ifcSummary).toMatchObject({ schema: "IFC4", projectName: "Ornek Proje", elementCount: 2 });
    expect(m.ifcSummary.byClass).toEqual({ IfcWall: 1, IfcSlab: 1 });
    const frag = await murat.get(`/projects/${projectId}/versions/${m.id}/model`);
    expect(frag.status).toBe(200);
    expect(frag.raw.rawPayload.length).toBeGreaterThan(500);
  });

  it("adds versions, keeps Turkish names and checks download rights", async () => {
    const name = "ZAVM-PAS-A-0002.pdf";
    await murat.upload(`/projects/${projectId}/folders/${designId}/files`, [{ name, data: "v1" }]);
    const v2 = await murat.upload(`/projects/${projectId}/folders/${designId}/files`, [{ name, data: "v2 içerik" }], {
      comment: "Revizyon B",
      attributes: JSON.stringify({ Durum: "S2", Revizyon: "P02" }),
    });
    expect(v2.body.results[0].version).toBe(2);
    const fileId = v2.body.results[0].fileId;
    const file = await murat.get(`/projects/${projectId}/files/${fileId}`);
    expect(file.body.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    expect(file.body.attributes).toEqual({ Durum: "S2", Revizyon: "P02" });
    expect(file.body.latest.comment).toBe("Revizyon B");

    const dl = await murat.get(`/projects/${projectId}/versions/${file.body.versions[1].id}/download`);
    expect(dl.status).toBe(200);
    expect(dl.raw.body).toBe("v1");

    // Semih is a member without folder permissions.
    expect((await semih.get(`/projects/${projectId}/files/${fileId}`)).status).toBe(404);
    expect((await semih.get(`/projects/${projectId}/versions/${file.body.versions[1].id}/download`)).status).toBe(404);
  });

  it("lets upload-only users add files but see only their own", async () => {
    await admin.put(`/projects/${projectId}/folders/${designId}/permissions`, {
      entries: [{ subjectType: "user", subjectId: semihId, level: "upload_only" }],
    });
    const up = await semih.upload(`/projects/${projectId}/folders/${designId}/files`, [
      { name: "ZAVM-CNS-S-0003.pdf", data: "cns" },
    ]);
    expect(up.body.results[0].ok).toBe(true);
    const list = await semih.get(`/projects/${projectId}/folders/${designId}/contents`);
    expect(list.body.files.map((f: { name: string }) => f.name)).toEqual(["ZAVM-CNS-S-0003.pdf"]);
    // Cannot add a version to Murat's file.
    const other = await semih.upload(`/projects/${projectId}/folders/${designId}/files`, [
      { name: "ZAVM-PAS-A-0002.pdf", data: "x" },
    ]);
    expect(other.status).toBe(400);
    expect(other.body.results[0].errors[0]).toContain("yetkiniz yok");
  });

  it("creates issues with a viewpoint, comments and status changes", async () => {
    const models = (await murat.get(`/projects/${projectId}/models`)).body;
    const issue = await murat.post(`/projects/${projectId}/issues`, {
      title: "Duvar döşeme ile çakışıyor",
      priority: "high",
      assigneeUserId: muratId,
      viewpoint: {
        camera: { position: [10, 10, 10], target: [0, 0, 0], projection: "perspective" },
        fileVersionIds: [models[0].id],
        selection: ["3vB2YO$MX4xv5uCqZZG05x"],
        sections: { planes: [{ origin: [0, 1.2, 0], normal: [0, 1, 0] }], box: { min: [-1, 0, -1], max: [4, 3, 2] } },
        measurements: [
          { kind: "length", points: [[0, 0, 0], [3, 0, 4]], value: 5 },
          { kind: "volume", guids: ["3vB2YO$MX4xv5uCqZZG05x"], value: 1.25 },
        ],
      },
      pin: { position: [2.5, 0.1, 1.5], globalId: "3vB2YO$MX4xv5uCqZZG05x" },
    });
    expect(issue.status).toBe(200);
    expect(issue.body.number).toBe(1);
    // Section planes, box and measurements come back with the viewpoint (Kesit / Ölçü).
    const saved = await murat.get(`/projects/${projectId}/issues/${issue.body.id}`);
    expect(saved.body.viewpoint.sections).toEqual({ planes: [{ origin: [0, 1.2, 0], normal: [0, 1, 0] }], box: { min: [-1, 0, -1], max: [4, 3, 2] } });
    expect(saved.body.viewpoint.measurements.map((m: { kind: string }) => m.kind)).toEqual(["length", "volume"]);
    // A malformed measurement is rejected instead of being stored half.
    const bad = await murat.post(`/projects/${projectId}/issues`, {
      title: "Bozuk ölçü",
      viewpoint: { camera: { position: [1, 1, 1], target: [0, 0, 0], projection: "perspective" }, fileVersionIds: [], measurements: [{ kind: "length", points: [[0, 0, 0]], value: 1 }] },
    });
    expect(bad.status).toBe(400);
    expect((await murat.post(`/projects/${projectId}/issues`, { title: "İkinci" })).body.number).toBe(2);

    // A non-member assignee is rejected.
    const outsider = await admin.post("/users", { email: "x@x.test", name: "X", password: PW });
    expect(
      (await murat.post(`/projects/${projectId}/issues`, { title: "t", assigneeUserId: outsider.body.id })).status,
    ).toBe(400);

    await semih.post(`/projects/${projectId}/issues/${issue.body.id}/comments`, { body: "Bakıyorum." });
    expect((await semih.patch(`/projects/${projectId}/issues/${issue.body.id}`, { status: "closed" })).status).toBe(403);
    const closed = await murat.patch(`/projects/${projectId}/issues/${issue.body.id}`, { status: "closed" });
    expect(closed.body.status).toBe("closed");
    const comments = await murat.get(`/projects/${projectId}/issues/${issue.body.id}/comments`);
    expect(comments.body[0]).toMatchObject({ body: "Bakıyorum.", authorName: "Semih" });
    expect((await murat.get(`/projects/${projectId}/issues?status=open`)).body).toHaveLength(1);
  });

  it("copies and moves files while enforcing target-folder rules", async () => {
    const uploaded = await admin.upload(`/projects/${projectId}/folders/${rootId}/files`, [{ name: "aksiyon.txt", data: "örnek" }]);
    const sourceId = uploaded.body.results[0].fileId;
    const copied = await admin.post(`/projects/${projectId}/files/${sourceId}/copy`, {
      folderId: rootId,
      name: "aksiyon-kopya.txt",
    });
    expect(copied.status).toBe(200);
    expect(copied.body).toMatchObject({ name: "aksiyon-kopya.txt", folderId: rootId, currentVersion: 1 });
    expect((await admin.post(`/projects/${projectId}/files/${sourceId}/copy`, { folderId: rootId, name: "aksiyon-kopya.txt" })).status).toBe(409);
    const moved = await admin.patch(`/projects/${projectId}/files/${copied.body.id}`, {
      folderId: designId,
      name: "ZAVM-PAS-A-0099.txt",
    });
    expect(moved.body).toMatchObject({ folderId: designId, name: "ZAVM-PAS-A-0099.txt" });
  });

  it("adds a same-name upload as the next version and stores a file description", async () => {
    const url = `/projects/${projectId}/folders/${rootId}/files`;
    const first = await admin.upload(url, [{ name: "surum.txt", data: "bir" }]);
    const second = await admin.upload(url, [{ name: "surum.txt", data: "iki" }]);
    expect(second.body.results[0]).toMatchObject({ ok: true, fileId: first.body.results[0].fileId, version: 2 });
    const fileId = first.body.results[0].fileId;
    const detail = await admin.get(`/projects/${projectId}/files/${fileId}`);
    expect(detail.body).toMatchObject({ currentVersion: 2, description: null });
    expect(detail.body.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);

    const described = await admin.patch(`/projects/${projectId}/files/${fileId}`, { description: "  Zemin kat revizyonu  " });
    expect(described.body).toMatchObject({ name: "surum.txt", description: "Zemin kat revizyonu", currentVersion: 2 });
    const cleared = await admin.patch(`/projects/${projectId}/files/${fileId}`, { description: "" });
    expect(cleared.body.description).toBeNull();

    const folder = await admin.patch(`/projects/${projectId}/folders/${designId}`, { description: "Mimari teslimler" });
    expect(folder.body).toMatchObject({ id: designId, description: "Mimari teslimler" });
    expect((await admin.get(`/projects/${projectId}/folders/${designId}`)).body.description).toBe("Mimari teslimler");

    // A deleted file does not hold its name: the same name uploads as a new file.
    expect((await admin.del(`/projects/${projectId}/files/${fileId}`)).status).toBe(200);
    const reuploaded = await admin.upload(url, [{ name: "surum.txt", data: "yeni" }]);
    expect(reuploaded.body.results[0]).toMatchObject({ ok: true, version: 1 });
    expect(reuploaded.body.results[0].fileId).not.toBe(fileId);
  });

  it("supports API tokens and records activity", async () => {
    // Murat is not a project admin; by default only project admins may create tokens.
    expect((await murat.post("/auth/tokens", { name: "AECPilot" })).status).toBe(403);
    await admin.put("/admin/settings/mcp", { tokenCreators: "everyone" });
    const t = await murat.post("/auth/tokens", { name: "AECPilot" });
    expect(t.body.scope).toBe("read");
    const res = await app.inject({
      url: `/api/v1/projects/${projectId}/folders/${designId}`,
      headers: { authorization: `Bearer ${t.body.token}` },
    });
    expect(res.statusCode).toBe(200);
    expect((await murat.get(`/projects/${projectId}/activity`)).status).toBe(403);
    const activity = await admin.get(`/projects/${projectId}/activity`);
    const actions = activity.body.map((e: { action: string }) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining(["project.created", "folder.permissions_set", "file.uploaded", "file.version_added", "file.downloaded", "issue.created"]),
    );
  });

  it("lets only a system administrator remove a project from active lists", async () => {
    expect((await murat.del(`/projects/${projectId}`)).status).toBe(403);
    expect((await admin.del(`/projects/${projectId}`)).body).toEqual({ ok: true });
    expect((await admin.get("/projects")).body.map((p: { id: string }) => p.id)).not.toContain(projectId);
    expect((await admin.del(`/projects/${projectId}`)).status).toBe(404);
  });

  it("frees a deleted project's code for a new project", async () => {
    const fresh = await admin.post("/projects", { code: "ZAVM", name: "Zirve Veri Merkezi (yeni)" });
    expect(fresh.status).toBe(200);
    expect(fresh.body.id).not.toBe(projectId);
    const again = await admin.post("/projects", { code: "ZAVM", name: "Üçüncü" });
    expect(again.status).toBe(409);
    expect(again.body.message).toContain("proje kodu zaten kullanılıyor");
    const fromTemplate = await admin.post("/projects/from-template", { code: "ZAVM", name: "x", templateId: "iso19650-temel" });
    expect(fromTemplate.status).toBe(409);
  });
});
