import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq, inArray } from "drizzle-orm";
import yauzl from "yauzl";
import { buildApp } from "../../src/app/build-app.js";
import { hashPassword } from "../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../src/db/index.js";
import { fileVersions, users } from "../../src/db/schema.js";
import { JobQueue } from "../../src/jobs/queue.js";
import { LocalStorage } from "../../src/core/platform/storage.js";

let handle: DbHandle;
let app: FastifyInstance;
let dataDir: string;
let storage: LocalStorage;

const PW = "Sifre-1234567";

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "7dcde-docs-"));
  handle = await openDb("memory://");
  storage = new LocalStorage(path.join(dataDir, "storage"));
  const jobs = new JobQueue(handle.db, storage);
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
    zip: async (pid: string, payload: unknown) => {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${pid}/download-zip`,
        headers: { cookie },
        payload: payload as object,
      });
      return { status: res.statusCode, headers: res.headers, entries: res.statusCode === 200 ? await readZip(res.rawPayload) : {} };
    },
  };
}

/** Entry name → content, read with yauzl (same author as yazl, independent reader). */
function readZip(buf: Buffer): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true, decodeStrings: true }, (err, zip) => {
      if (err || !zip) return reject(err);
      const out: Record<string, string> = {};
      zip.on("entry", (entry: yauzl.Entry) => {
        zip.openReadStream(entry, (e, stream) => {
          if (e || !stream) return reject(e);
          const chunks: Buffer[] = [];
          stream.on("data", (c: Buffer) => chunks.push(c));
          stream.on("end", () => {
            out[entry.fileName] = Buffer.concat(chunks).toString("utf8");
            zip.readEntry();
          });
        });
      });
      zip.on("end", () => resolve(out));
      zip.on("error", reject);
      zip.readEntry();
    });
  });
}

describe("Docs depth: attributes, search, zip, recycle bin", () => {
  let admin: ReturnType<typeof api>;
  let murat: ReturnType<typeof api>;
  let semih: ReturnType<typeof api>;
  let pm: ReturnType<typeof api>;
  let pid: string;
  let wipId: string;
  let designId: string;
  let altId: string;
  let muratId: string;
  let semihId: string;
  let durumId: string;
  const fileIds: Record<string, string> = {};
  const P = () => `/projects/${pid}`;

  it("sets up a project with users and folders", async () => {
    admin = api(await login("admin@7d.test"));
    const poyraz = (await admin.post("/companies", { name: "Poyraz İnşaat" })).body.id;
    muratId = (await admin.post("/users", { email: "murat@p.test", name: "Murat", password: PW, companyId: poyraz })).body.id;
    semihId = (await admin.post("/users", { email: "semih@c.test", name: "Semih", password: PW })).body.id;
    await admin.post("/users", { email: "pm@p.test", name: "Proje Yöneticisi", password: PW });
    const p = await admin.post("/projects", { code: "ZAVM", name: "Zirve Veri Merkezi" });
    pid = p.body.id;
    const contents = await admin.get(`${P()}/folders/${p.body.rootFolderId}/contents`);
    wipId = contents.body.folders[0].id;
    designId = (await admin.post(`${P()}/folders`, { parentId: wipId, name: "Tasarım" })).body.id;
    altId = (await admin.post(`${P()}/folders`, { parentId: designId, name: "Alt" })).body.id;
    for (const email of ["murat@p.test", "semih@c.test"]) await admin.post(`${P()}/members`, { email });
    await admin.post(`${P()}/members`, { email: "pm@p.test", isProjectAdmin: true });
    await admin.put(`${P()}/folders/${wipId}/permissions`, {
      entries: [{ subjectType: "user", subjectId: muratId, level: "edit" }],
    });
    murat = api(await login("murat@p.test"));
    semih = api(await login("semih@c.test"));
    pm = api(await login("pm@p.test"));
  });

  it("manages attribute definitions (project admins only)", async () => {
    const durum = await admin.post(`${P()}/attribute-definitions`, {
      name: "Durum",
      type: "list",
      options: ["S0", "S1", "S2"],
      required: true,
    });
    expect(durum.status).toBe(200);
    durumId = durum.body.id;
    expect(durum.body).toMatchObject({ name: "Durum", type: "list", options: ["S0", "S1", "S2"], required: true });
    const teslim = await pm.post(`${P()}/attribute-definitions`, { name: "Teslim tarihi", type: "date" });
    expect(teslim.status).toBe(200);
    const not = await admin.post(`${P()}/attribute-definitions`, { name: "Not", type: "text" });

    expect((await murat.post(`${P()}/attribute-definitions`, { name: "X", type: "text" })).status).toBe(403);
    const empty = await admin.post(`${P()}/attribute-definitions`, { name: "Boş", type: "list", options: [] });
    expect(empty.status).toBe(400);
    expect(empty.body.message).toContain("en az bir seçenek");
    expect((await admin.post(`${P()}/attribute-definitions`, { name: "Durum", type: "text" })).status).toBe(409);

    // Bind Durum to WIP (inherits down), Teslim tarihi to Tasarım.
    expect((await murat.put(`${P()}/folders/${altId}/attribute-bindings`, { definitionIds: [durumId] })).status).toBe(403);
    await admin.put(`${P()}/folders/${wipId}/attribute-bindings`, { definitionIds: [durumId] });
    await admin.post(`${P()}/folders/${designId}/attribute-bindings/${teslim.body.id}`);
    await admin.post(`${P()}/folders/${designId}/attribute-bindings/${not.body.id}`);
    await admin.del(`${P()}/folders/${designId}/attribute-bindings/${not.body.id}`);

    const eff = await murat.get(`${P()}/folders/${altId}/attribute-definitions`);
    expect(eff.status).toBe(200);
    expect(eff.body.map((d: { name: string }) => d.name)).toEqual(["Durum", "Teslim tarihi"]);
    expect(eff.body[0]).toMatchObject({ boundFolderId: wipId, inherited: true });
    const own = await murat.get(`${P()}/folders/${designId}/attribute-definitions`);
    expect(own.body.find((d: { name: string }) => d.name === "Teslim tarihi")).toMatchObject({ inherited: false });
    expect((await murat.get(`${P()}/folders/${wipId}/attribute-definitions`)).body.map((d: { name: string }) => d.name)).toEqual([
      "Durum",
    ]);
    // Semih has no access to the folders.
    expect((await semih.get(`${P()}/folders/${altId}/attribute-definitions`)).status).toBe(404);
  });

  it("rejects uploads with missing required or invalid attribute values", async () => {
    const url = `${P()}/folders/${altId}/files`;
    const missing = await murat.upload(url, [{ name: "KİRİŞ-detay.pdf", data: "v1" }]);
    expect(missing.status).toBe(400);
    expect(missing.body.results[0].errors.join(" ")).toContain('"Durum" zorunlu');

    const badList = await murat.upload(url, [{ name: "KİRİŞ-detay.pdf", data: "v1" }], {
      attributes: JSON.stringify({ Durum: "S9" }),
    });
    expect(badList.body.results[0].ok).toBe(false);
    expect(badList.body.results[0].errors.join(" ")).toContain("geçerli bir seçenek değil");

    const badDate = await murat.upload(url, [{ name: "KİRİŞ-detay.pdf", data: "v1" }], {
      attributes: JSON.stringify({ Durum: "S1", "Teslim tarihi": "2026-13-01" }),
    });
    expect(badDate.body.results[0].errors.join(" ")).toContain("geçerli bir tarih");

    const ok = await murat.upload(url, [{ name: "KİRİŞ-detay.pdf", data: "v1" }], {
      attributes: JSON.stringify({ Durum: "S1", "Teslim tarihi": "2026-11-01", Serbest: "evet" }),
    });
    expect(ok.status).toBe(200);
    expect(ok.body.results[0]).toMatchObject({ ok: true, version: 1 });
    fileIds.kiris = ok.body.results[0].fileId;

    // A new version keeps the earlier values, so the required attribute is satisfied.
    const v2 = await murat.upload(url, [{ name: "KİRİŞ-detay.pdf", data: "v2" }]);
    expect(v2.body.results[0]).toMatchObject({ ok: true, version: 2 });

    const others = await murat.upload(url, [{ name: "Kolon listesi.txt", data: "kolon" }], {
      attributes: JSON.stringify({ Durum: "S2" }),
    });
    fileIds.kolon = others.body.results[0].fileId;
    const top = await murat.upload(`${P()}/folders/${designId}/files`, [{ name: "kırış-notlar.txt", data: "notlar" }], {
      attributes: JSON.stringify({ Durum: "S1" }),
    });
    fileIds.notlar = top.body.results[0].fileId;
    const wip = await murat.upload(`${P()}/folders/${wipId}/files`, [{ name: "Gizli kiriş.txt", data: "gizli" }], {
      attributes: JSON.stringify({ Durum: "S0" }),
    });
    fileIds.gizli = wip.body.results[0].fileId;
    expect(Object.values(fileIds).every(Boolean)).toBe(true);
  });

  it("validates attribute edits and renames keys with the definition", async () => {
    const bad = await murat.patch(`${P()}/files/${fileIds.kiris}`, { attributes: { Durum: "X" } });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toContain("geçerli bir seçenek değil");
    const cleared = await murat.patch(`${P()}/files/${fileIds.kiris}`, { attributes: { Durum: "" } });
    expect(cleared.status).toBe(400);
    const good = await murat.patch(`${P()}/files/${fileIds.kiris}`, { attributes: { Durum: "S2", Serbest: "" } });
    expect(good.status).toBe(200);
    expect(good.body.attributes).toEqual({ Durum: "S2", "Teslim tarihi": "2026-11-01" });

    const defs = (await admin.get(`${P()}/attribute-definitions`)).body;
    const teslim = defs.find((d: { name: string }) => d.name === "Teslim tarihi");
    expect((await admin.patch(`${P()}/attribute-definitions/${teslim.id}`, { name: "Teslim" })).status).toBe(200);
    const file = await murat.get(`${P()}/files/${fileIds.kiris}`);
    expect(file.body.attributes).toEqual({ Durum: "S2", Teslim: "2026-11-01" });
  });

  it("searches with Turkish casing, attribute and extension filters, respecting permissions", async () => {
    const names = (r: { body: { results: { name: string }[] } }) => r.body.results.map((x) => x.name).sort();
    // İ/I/ı/i are treated alike: "kiriş", "KIRIŞ" and "kırış" find the same files.
    for (const q of ["kiriş", "KIRIŞ", "kırış"]) {
      const r = await murat.get(`${P()}/search?q=${encodeURIComponent(q)}`);
      expect(r.status).toBe(200);
      expect(names(r)).toEqual(["Gizli kiriş.txt", "KİRİŞ-detay.pdf", "kırış-notlar.txt"]);
    }
    const hit = (await murat.get(`${P()}/search?q=detay`)).body.results[0];
    expect(hit.folderPath).toBe("Proje Dosyaları / 01-WIP (Çalışmada) / Tasarım / Alt");

    // Attribute values match q too; attr.<name> filters exactly for list attributes.
    expect(names(await murat.get(`${P()}/search?q=s2`))).toEqual(["Kolon listesi.txt", "KİRİŞ-detay.pdf"]);
    expect(names(await murat.get(`${P()}/search?${encodeURIComponent("attr.Durum")}=S1`))).toEqual(["kırış-notlar.txt"]);
    expect(names(await murat.get(`${P()}/search?ext=txt&folderId=${designId}`))).toEqual([
      "Kolon listesi.txt",
      "kırış-notlar.txt",
    ]);
    expect(names(await murat.get(`${P()}/search?q=kiriş&ext=pdf`))).toEqual(["KİRİŞ-detay.pdf"]);

    // Semih sees nothing until he gets view on Tasarım; then only files below it.
    expect((await semih.get(`${P()}/search?q=kiriş`)).body.results).toEqual([]);
    expect((await semih.get(`${P()}/search?folderId=${wipId}`)).status).toBe(404);
    await admin.put(`${P()}/folders/${designId}/permissions`, {
      entries: [{ subjectType: "user", subjectId: semihId, level: "view" }],
    });
    await admin.put(`${P()}/folders/${altId}/permissions`, {
      entries: [{ subjectType: "user", subjectId: semihId, level: "view_download" }],
    });
    expect(names(await semih.get(`${P()}/search?q=KİRİŞ`))).toEqual(["KİRİŞ-detay.pdf", "kırış-notlar.txt"]);
  });

  it("zips folders with their structure and lists files without download rights", async () => {
    const z = await semih.zip(pid, { folderIds: [designId], fileIds: [fileIds.gizli] });
    expect(z.status).toBe(200);
    expect(z.headers["content-type"]).toBe("application/zip");
    expect(Object.keys(z.entries).sort()).toEqual(["Tasarım/Alt/Kolon listesi.txt", "Tasarım/Alt/KİRİŞ-detay.pdf", "_eksikler.txt"]);
    expect(z.entries["Tasarım/Alt/KİRİŞ-detay.pdf"]).toBe("v2");
    // View-only file is listed by path; a file Semih cannot see is listed by id only.
    expect(z.entries["_eksikler.txt"]).toContain("Tasarım / kırış-notlar.txt");
    expect(z.entries["_eksikler.txt"]).toContain(fileIds.gizli);
    expect(z.entries["_eksikler.txt"]).not.toContain("Gizli");

    const file = await murat.get(`${P()}/files/${fileIds.kiris}`);
    const v1 = file.body.versions.find((v: { version: number }) => v.version === 1).id;
    const mz = await murat.zip(pid, { fileIds: [fileIds.kiris, fileIds.notlar], versionIds: [v1] });
    expect(mz.entries).toEqual({ "KİRİŞ-detay.pdf": "v2", "kırış-notlar.txt": "notlar", "KİRİŞ-detay (V1).pdf": "v1" });

    expect((await murat.zip(pid, {})).status).toBe(400);
    const activity = (await admin.get(`${P()}/activity`)).body.map((e: { action: string }) => e.action);
    expect(activity).toContain("file.zip_downloaded");
  });

  it("lists files whose stored content is missing instead of crashing the zip", async () => {
    const up = await admin.upload(`${P()}/folders/${wipId}/files`, [{ name: "kayip.txt", data: "yok" }], {
      attributes: JSON.stringify({ Durum: "S1" }),
    });
    const fileId = up.body.results[0].fileId;
    expect(fileId, JSON.stringify(up.body)).toBeTruthy();
    const [v] = await handle.db.select().from(fileVersions).where(eq(fileVersions.fileId, fileId));
    rmSync(storage.localPath(v.storageKey));
    const z = await admin.zip(pid, { fileIds: [fileId, fileIds.notlar] });
    expect(z.status).toBe(200);
    expect(Object.keys(z.entries).sort()).toEqual(["_eksikler.txt", "kırış-notlar.txt"]);
    expect(z.entries["_eksikler.txt"]).toContain("kayip.txt");
    expect((await admin.get("/auth/me")).status).toBe(200);
  });

  it("restores a deleted file and reports name conflicts", async () => {
    expect((await murat.del(`${P()}/files/${fileIds.kolon}`)).status).toBe(200);
    await murat.upload(`${P()}/folders/${altId}/files`, [{ name: "Kolon listesi.txt", data: "yeni" }], {
      attributes: JSON.stringify({ Durum: "S0" }),
    });

    expect((await murat.get(`${P()}/trash`)).status).toBe(403);
    const trash = await pm.get(`${P()}/trash`);
    expect(trash.status).toBe(200);
    expect(trash.body.files[0]).toMatchObject({
      id: fileIds.kolon,
      name: "Kolon listesi.txt",
      deletedByName: "Murat",
      folderAlive: true,
      path: "Proje Dosyaları / 01-WIP (Çalışmada) / Tasarım / Alt",
    });

    const clash = await pm.post(`${P()}/trash/files/${fileIds.kolon}/restore`);
    expect(clash.status).toBe(409);
    expect(clash.body.message).toContain('"Kolon listesi.txt" adlı bir dosya zaten var');
    const renamed = await pm.post(`${P()}/trash/files/${fileIds.kolon}/restore`, { name: "Kolon listesi (eski).txt" });
    expect(renamed.status).toBe(200);
    const contents = await murat.get(`${P()}/folders/${altId}/contents`);
    expect(contents.body.files.map((f: { name: string }) => f.name)).toContain("Kolon listesi (eski).txt");
    expect((await pm.get(`${P()}/trash`)).body.files).toEqual([]);
  });

  it("restores a folder subtree with the files deleted together with it", async () => {
    // A file deleted earlier stays in the bin when its folder is restored.
    await murat.del(`${P()}/files/${fileIds.kolon}`);
    const sub = (await admin.post(`${P()}/folders`, { parentId: altId, name: "Detaylar" })).body.id;
    await admin.del(`${P()}/folders/${altId}`);

    const trash = (await pm.get(`${P()}/trash`)).body;
    expect(trash.folders).toHaveLength(1);
    expect(trash.folders[0]).toMatchObject({ id: altId, name: "Alt", folderCount: 1, fileCount: 2, parentAlive: true });
    expect(trash.files.map((f: { id: string }) => f.id)).toEqual([fileIds.kolon]);
    expect(trash.files[0].folderAlive).toBe(false);

    const early = await pm.post(`${P()}/trash/files/${fileIds.kolon}/restore`);
    expect(early.status).toBe(409);
    expect(early.body.message).toContain("Önce klasörü geri yükleyin");

    const r = await pm.post(`${P()}/trash/folders/${altId}/restore`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ folders: 2, files: 2 });
    const contents = await murat.get(`${P()}/folders/${altId}/contents`);
    expect(contents.body.folders.map((f: { id: string }) => f.id)).toEqual([sub]);
    expect(contents.body.files.map((f: { name: string }) => f.name).sort()).toEqual(["Kolon listesi.txt", "KİRİŞ-detay.pdf"]);
    expect((await pm.get(`${P()}/trash`)).body.files.map((f: { id: string }) => f.id)).toEqual([fileIds.kolon]);

    // Name conflict for a folder.
    const tmp = (await admin.post(`${P()}/folders`, { parentId: designId, name: "Geçici" })).body.id;
    await admin.del(`${P()}/folders/${tmp}`);
    await admin.post(`${P()}/folders`, { parentId: designId, name: "Geçici" });
    const clash = await pm.post(`${P()}/trash/folders/${tmp}/restore`);
    expect(clash.status).toBe(409);
    expect(clash.body.message).toContain('"Geçici" adlı bir klasör zaten var');
    expect((await pm.post(`${P()}/trash/folders/${tmp}/restore`, { name: "Geçici 2" })).status).toBe(200);
  });

  it("deletes permanently (system admins only) and frees unreferenced storage", async () => {
    const versions = await handle.db.select().from(fileVersions).where(eq(fileVersions.fileId, fileIds.kiris));
    expect(versions).toHaveLength(2);
    const keys = versions.map((v) => v.storageKey);
    for (const k of keys) expect(existsSync(storage.localPath(k))).toBe(true);
    // Another version row shares the V1 object (e.g. a copy); it must survive the purge.
    const shared = versions.find((v) => v.version === 1)!;
    await handle.db.insert(fileVersions).values({
      fileId: fileIds.notlar,
      version: 99,
      storageKey: shared.storageKey,
      size: shared.size,
      sha256: shared.sha256,
    });

    await murat.del(`${P()}/files/${fileIds.kiris}`);
    expect((await pm.del(`${P()}/trash/files/${fileIds.kiris}`)).status).toBe(403);
    const purge = await admin.del(`${P()}/trash/files/${fileIds.kiris}`);
    expect(purge.status).toBe(200);
    expect(purge.body).toMatchObject({ versions: 2, removedObjects: 1 });
    const v2 = versions.find((v) => v.version === 2)!;
    expect(existsSync(storage.localPath(v2.storageKey))).toBe(false);
    expect(existsSync(storage.localPath(shared.storageKey))).toBe(true);
    expect((await admin.get(`${P()}/trash`)).body.files.map((f: { id: string }) => f.id)).not.toContain(fileIds.kiris);
    // Live files cannot be purged.
    expect((await admin.del(`${P()}/trash/files/${fileIds.notlar}`)).status).toBe(404);

    // Purge a whole folder.
    const altFiles = (await murat.get(`${P()}/folders/${altId}/contents`)).body.files.map((f: { id: string }) => f.id);
    const altVersions = await handle.db.select().from(fileVersions).where(inArray(fileVersions.fileId, altFiles));
    await admin.del(`${P()}/folders/${altId}`);
    const pf = await admin.del(`${P()}/trash/folders/${altId}`);
    expect(pf.status).toBe(200);
    expect(pf.body).toMatchObject({ folders: 2 });
    for (const v of altVersions) expect(existsSync(storage.localPath(v.storageKey))).toBe(false);
    const after = (await admin.get(`${P()}/trash`)).body;
    expect(after.folders.map((f: { id: string }) => f.id)).not.toContain(altId);
    expect(after.files.map((f: { id: string }) => f.id)).not.toContain(fileIds.kolon);

    const actions = (await admin.get(`${P()}/activity`)).body.map((e: { action: string }) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining(["attribute.created", "folder.attributes_bound", "file.restored", "folder.restored", "file.purged", "folder.purged"]),
    );
  });
});
