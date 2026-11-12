import { hasAi } from "../../helpers/modules.js"; // AI steps run when the AI module is installed
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../../src/app/build-app.js";
import { hashPassword } from "../../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../../src/db/index.js";
import { users } from "../../../src/db/schema.js";
import { JobQueue } from "../../../src/jobs/queue.js";
import { LocalStorage } from "../../../src/core/platform/storage.js";
import { parseChainage, formatChainage } from "@sitekeep/shared";
import { templateSimilarity } from "@7dimensions-project/sitekeep-ee-field/shared/forms.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const IFC = readFileSync(path.join(here, "../../fixtures/sample-wall.ifc"));
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=",
  "base64",
);
const PW = "Sifre-1234567";

let handle: DbHandle;
let app: FastifyInstance;
let jobs: JobQueue;
let dataDir: string;

// Fake OpenAI-compatible model: the first answer is broken JSON, the repair answer is valid.
let stub: Server;
let stubUrl: string;
const stubCalls: any[] = [];
const GOOD = {
  code: "KLP",
  name: "Kalıp kontrol formu",
  category: "Kalite",
  sections: [
    { title: "Kalıp", items: [{ type: "yes_no", label: "Kalıp temiz" }, { type: "number", label: "Açıklık", unit: "mm", min: 0 }] },
    { title: "Sonuç", items: [{ type: "signature", label: "Kontrol eden" }] },
  ],
};

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "7dcde-forms-"));
  handle = await openDb("memory://");
  const storage = new LocalStorage(path.join(dataDir, "storage"));
  jobs = new JobQueue(handle.db, storage);
  app = await buildApp({ db: handle.db, storage, jobs, secretKey: Buffer.alloc(32, 3) });
  await handle.db.insert(users).values({ email: "admin@7d.test", name: "Admin", passwordHash: await hashPassword(PW), isAdmin: true });
  stub = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      stubCalls.push(body);
      const content =
        stubCalls.length % 2 === 1
          ? "İşte şablon: ```json\n{\"code\": \"KLP\", \"name\": \"Kalıp\", \"sections\": [{\"title\": \"A\", \"items\": [{\"type\": \"choice\", \"label\": \"Seç\"}]}]}\n```"
          : JSON.stringify(GOOD);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ model: body.model, choices: [{ finish_reason: "stop", message: { role: "assistant", content } }] }));
    });
  });
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
  stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await app.close();
  await handle.close();
  await new Promise((r) => stub.close(r));
  rmSync(dataDir, { recursive: true, force: true });
});

async function login(email: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PW } });
  expect(res.statusCode, res.body).toBe(200);
  return `cde_session=${res.cookies.find((c) => c.name === "cde_session")!.value}`;
}

function client(cookie: string) {
  const call = async (method: string, url: string, payload?: unknown) => {
    const res = await app.inject({ method: method as "GET", url: `/api/v1${url}`, headers: { cookie }, payload: payload as object });
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
    upload: async (url: string, fields: Record<string, string>, file: { name: string; data: Buffer }) => {
      const form = new FormData();
      for (const [k, v] of Object.entries(fields)) form.append(k, v);
      form.append("file", new Blob([file.data]), file.name);
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
type Client = ReturnType<typeof client>;

describe("chainage and similarity helpers", () => {
  it("parses and formats km", () => {
    expect(parseChainage("12+345.6")).toBeCloseTo(12.3456, 6);
    expect(parseChainage("Km 0+050")).toBeCloseTo(0.05, 6);
    expect(parseChainage("3,25")).toBe(3.25);
    expect(parseChainage("")).toBeNull();
    expect(() => parseChainage("abc")).toThrow();
    expect(formatChainage(12.3456)).toBe("12+345.6");
    expect(formatChainage(0.05)).toBe("0+050");
  });
  it("scores copied templates as near duplicates", () => {
    const schema = { sections: [{ id: "a", title: "A", items: [{ id: "x", type: "yes_no" as const, label: "Kalıp temiz" }] }] };
    const s = templateSimilarity({ name: "Döküm Onay Formu", schema }, { name: "Döküm Onay Formu (Ekim-Kasım Dönemi) GÜNCEL", schema });
    expect(s.score).toBe(1);
  });
});

describe("Forms and locations", () => {
  let admin: Client;
  let murat: Client;
  let semih: Client;
  let outsider: Client;
  let pid: string;
  let otherPid: string;
  let semihId: string;
  let wipId: string;
  let stationId: string;
  let tunnelId: string;
  let tplId: string;
  let formA: any;

  it("sets up a project with members", async () => {
    admin = client(await login("admin@7d.test"));
    await admin.post("/users", { email: "murat@x.test", name: "Murat", password: PW });
    semihId = (await admin.post("/users", { email: "semih@x.test", name: "Semih", password: PW })).body.id;
    await admin.post("/users", { email: "out@x.test", name: "Dışarıdan", password: PW });
    const p = await admin.post("/projects", { code: "PKF", name: "Metro" });
    pid = p.body.id;
    otherPid = (await admin.post("/projects", { code: "DIG", name: "Diğer" })).body.id;
    await admin.post(`/projects/${pid}/members`, { email: "murat@x.test" });
    await admin.post(`/projects/${pid}/members`, { email: "semih@x.test" });
    await admin.post(`/projects/${otherPid}/members`, { email: "out@x.test" });
    murat = client(await login("murat@x.test"));
    semih = client(await login("semih@x.test"));
    outsider = client(await login("out@x.test"));
    const contents = await admin.get(`/projects/${pid}/folders/${p.body.rootFolderId}/contents`);
    wipId = contents.body.folders[0].id;
  });

  it("manages the location tree with km chainage", async () => {
    const line = await admin.post(`/projects/${pid}/locations`, { name: "Hat 1", code: "L1", type: "Hat", kmStart: "0+000", kmEnd: "12+500" });
    expect(line.status).toBe(200);
    expect(line.body).toMatchObject({ kmStart: 0, kmEnd: 12.5 });
    const st = await admin.post(`/projects/${pid}/locations`, { parentId: line.body.id, name: "Pendik Merkez İstasyonu", code: "SG1", type: "İstasyon" });
    stationId = st.body.id;
    const t = await admin.post(`/projects/${pid}/locations`, { parentId: line.body.id, name: "Tünel", code: "T1", type: "Tünel kesimi", kmStart: 3.2, kmEnd: "4+100" });
    tunnelId = t.body.id;
    expect((await admin.post(`/projects/${pid}/locations`, { name: "x", kmStart: "5+000", kmEnd: "4+000" })).status).toBe(400);
    expect((await admin.post(`/projects/${pid}/locations`, { name: "Dup", code: "SG1" })).status).toBe(409);
    // Members read, only project admins write.
    expect((await murat.get(`/projects/${pid}/locations`)).body).toHaveLength(3);
    expect((await murat.post(`/projects/${pid}/locations`, { name: "x" })).status).toBe(403);
    expect((await outsider.get(`/projects/${pid}/locations`)).status).toBe(404);
    // No cycles.
    expect((await admin.patch(`/projects/${pid}/locations/${line.body.id}`, { parentId: stationId })).status).toBe(400);
    const ren = await admin.patch(`/projects/${pid}/locations/${tunnelId}`, { name: "Tünel kesimi 1", kmEnd: "4+200" });
    expect(ren.body).toMatchObject({ name: "Tünel kesimi 1", kmEnd: 4.2 });
  });

  it("imports locations from CSV (all or nothing)", async () => {
    const bad = await admin.post(`/projects/${pid}/locations/import-csv`, {
      csv: "Kod;Ad;Üst kod\nK-1;Kat -1;SG1\nK-2;Kat -2;YOK\n",
    });
    expect(bad.status).toBe(400);
    expect(bad.body.details[0]).toMatchObject({ line: 3 });
    const ok = await admin.post(`/projects/${pid}/locations/import-csv`, {
      csv: "﻿Kod;Ad;Tip;Üst kod;Km başlangıç;Km bitiş\nM-101;Mahal 101;Mahal;K-1;;\nK-1;Kat -1;Kat;SG1;;\nSG1;Pendik Merkez;İstasyon;L1;2+100;2+400\n\"L2\";\"Hat 2; Kaynarca\";Hat;;12+500;20+000\n",
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ created: 3, updated: 1 });
    const list = (await admin.get(`/projects/${pid}/locations`)).body;
    const k1 = list.find((l: any) => l.code === "K-1");
    expect(k1.parentId).toBe(stationId);
    expect(list.find((l: any) => l.code === "M-101").parentId).toBe(k1.id);
    expect(list.find((l: any) => l.code === "SG1")).toMatchObject({ name: "Pendik Merkez", kmStart: 2.1, kmEnd: 2.4 });
    expect(list.find((l: any) => l.code === "L2").name).toBe("Hat 2; Kaynarca");
  });

  it("builds locations from an IFC spatial structure", async () => {
    const up = await admin.upload(`/projects/${pid}/folders/${wipId}/files`, {}, { name: "model.ifc", data: IFC });
    expect(up.body.results[0].ok).toBe(true);
    const file = (await admin.get(`/projects/${pid}/files/${up.body.results[0].fileId}`)).body;
    const vid = file.latest.id;
    expect((await murat.post(`/projects/${pid}/locations/import-ifc`, { fileVersionId: vid })).status).toBe(403);
    const q = await admin.post(`/projects/${pid}/locations/import-ifc`, { fileVersionId: vid });
    expect(q.body.status).toBe("queued");
    await jobs.drain();
    const st = await admin.get(`/projects/${pid}/locations/import-jobs/${q.body.jobId}`);
    expect(st.body).toMatchObject({ status: "done", result: { created: 3, updated: 0, total: 3 } });
    const list = (await admin.get(`/projects/${pid}/locations`)).body;
    const site = list.find((l: any) => l.ifcClass === "IfcSite");
    const building = list.find((l: any) => l.ifcClass === "IfcBuilding");
    const storey = list.find((l: any) => l.ifcClass === "IfcBuildingStorey");
    expect(site).toMatchObject({ name: "Saha", type: "Saha", parentId: null, ifcGlobalId: "2g8CxpnGT3qhwr_2jLPk4D", ifcFileVersionId: vid });
    expect(building).toMatchObject({ name: "Bina", parentId: site.id });
    expect(storey).toMatchObject({ name: "Zemin Kat", type: "Kat", parentId: building.id, ifcGlobalId: "3Dlb1fXBP2a8eZBwP_VPHd" });
    // Re-import updates instead of duplicating.
    const again = await admin.post(`/projects/${pid}/locations/import-ifc`, { fileVersionId: vid });
    await jobs.drain();
    expect((await admin.get(`/projects/${pid}/locations/import-jobs/${again.body.jobId}`)).body.result).toMatchObject({ created: 0, updated: 3 });
    expect((await outsider.get(`/projects/${pid}/locations/import-jobs/${again.body.jobId}`)).status).toBe(404);
  });

  it("offers the built-in library", async () => {
    const lib = (await murat.get(`/projects/${pid}/form-templates/library`)).body;
    expect(lib.length).toBeGreaterThanOrEqual(5);
    expect(lib.map((x: any) => x.code)).toEqual(expect.arrayContaining(["BDO", "TKK", "GSR", "ISG", "MKS"]));
    const tkk = lib.find((x: any) => x.code === "TKK");
    expect(tkk.schema.sections[1].items[0].columns[0]).toMatchObject({ id: "km", type: "km" });
    const t = await admin.post(`/projects/${pid}/form-templates/from-library`, { key: "beton-dokum-onay" });
    expect(t.status, JSON.stringify(t.body)).toBe(200);
    expect(t.body).toMatchObject({ code: "BDO", currentVersion: 1, builtinKey: "beton-dokum-onay" });
    expect((await murat.post(`/projects/${pid}/form-templates/from-library`, { key: "isg-saha-denetimi" })).status).toBe(403);
  });

  const schemaV1 = {
    sections: [
      {
        title: "Kontroller",
        items: [
          { id: "kalip", type: "yes_no", label: "Kalıp temiz", required: true },
          { id: "paspayi", type: "number", label: "Paspayı", unit: "mm", min: 20, max: 75 },
          { id: "sinif", type: "choice", label: "Beton sınıfı", options: ["C30/37", "C35/45"] },
          { id: "yer", type: "location", label: "Döküm yeri" },
          { id: "foto", type: "photo", label: "Fotoğraflar", maxPhotos: 3 },
          {
            id: "tabaka",
            type: "table",
            label: "Ölçümler",
            columns: [
              { id: "nokta", label: "Nokta", type: "text", required: true },
              { id: "deger", label: "Değer", type: "number", unit: "cm", max: 50 },
              { id: "km", label: "Km", type: "km" },
            ],
          },
          { id: "puan", type: "score", label: "Puan" },
          { id: "imza", type: "signature", label: "Kontrol eden", required: true },
        ],
      },
    ],
  };

  it("creates templates with a numbering pattern and keeps used versions immutable", async () => {
    const bad = await admin.post(`/projects/${pid}/form-templates`, { code: "KK", name: "x", numberPattern: "{KOD}-{XYZ}", schema: schemaV1 });
    expect(bad.status).toBe(400);
    const dupIds = await admin.post(`/projects/${pid}/form-templates`, {
      code: "KK",
      name: "x",
      schema: { sections: [{ id: "s", title: "S", items: [{ id: "a", type: "text", label: "A" }, { id: "a", type: "text", label: "B" }] }] },
    });
    expect(dupIds.status).toBe(400);
    const t = await admin.post(`/projects/${pid}/form-templates`, {
      code: "KK",
      name: "Kalıp kontrol",
      numberPattern: "{PROJE}-{KOD}-{YYYY}-{000}",
      schema: schemaV1,
    });
    expect(t.status, JSON.stringify(t.body)).toBe(200);
    tplId = t.body.id;
    // Unused version: edited in place.
    const edit = await admin.put(`/projects/${pid}/form-templates/${tplId}`, {
      code: "KK",
      name: "Kalıp kontrol formu",
      numberPattern: "{PROJE}-{KOD}-{YYYY}-{000}",
      schema: schemaV1,
    });
    expect(edit.body).toMatchObject({ currentVersion: 1, versionCreated: false, name: "Kalıp kontrol formu" });

    formA = (await murat.post(`/projects/${pid}/forms`, { templateId: tplId, locationId: stationId, formDate: "2026-10-10" })).body;
    expect(formA).toMatchObject({ number: "PKF-KK-2026-001", status: "draft", templateVersion: 1, locationId: stationId });
    expect(formA.locationPath).toContain("Pendik Merkez");
    const b = (await murat.post(`/projects/${pid}/forms`, { templateId: tplId, formDate: "2026-10-11" })).body;
    expect(b.number).toBe("PKF-KK-2026-002");
    const c = (await murat.post(`/projects/${pid}/forms`, { templateId: tplId, formDate: "2027-01-02" })).body;
    expect(c.number).toBe("PKF-KK-2027-001");
    await murat.del(`/projects/${pid}/forms/${c.id}`);

    // Version 1 is used now: a schema change creates version 2.
    const v2schema = structuredClone(schemaV1);
    v2schema.sections[0]!.items.push({ id: "not", type: "text", label: "Notlar" } as any);
    const v2 = await admin.put(`/projects/${pid}/form-templates/${tplId}`, {
      code: "KK",
      name: "Kalıp kontrol formu",
      numberPattern: "{PROJE}-{KOD}-{YYYY}-{000}",
      schema: v2schema,
    });
    expect(v2.body).toMatchObject({ currentVersion: 2, versionCreated: true });
    expect(v2.body.versions.map((v: any) => [v.version, v.used])).toEqual([
      [2, false],
      [1, true],
    ]);
    const v1 = (await murat.get(`/projects/${pid}/form-templates/${tplId}/versions/1`)).body;
    expect(v1.schema.sections[0].items.map((i: any) => i.id)).not.toContain("not");
    const again = (await murat.get(`/projects/${pid}/forms/${formA.id}`)).body;
    expect(again.templateVersion).toBe(1);
    expect(again.schema.sections[0].items).toHaveLength(8);
    const d = (await murat.post(`/projects/${pid}/forms`, { templateId: tplId, formDate: "2026-10-12" })).body;
    expect(d).toMatchObject({ templateVersion: 2, number: "PKF-KK-2026-003" });
  });

  it("validates values: types, min/max, options and required items on submit", async () => {
    const url = `/projects/${pid}/forms/${formA.id}`;
    let r = await murat.patch(url, { values: { paspayi: 10 } });
    expect(r.status).toBe(400);
    expect(r.body.details[0]).toMatchObject({ itemId: "paspayi" });
    expect(r.body.message).toContain("en az 20");
    expect((await murat.patch(url, { values: { sinif: "C99" } })).status).toBe(400);
    expect((await murat.patch(url, { values: { tabaka: [{ nokta: "A", deger: 60 }] } })).status).toBe(400);
    expect((await murat.patch(url, { values: { yer: "00000000-0000-4000-8000-000000000000" } })).status).toBe(400);
    r = await murat.patch(url, { values: { kalip: "no", paspayi: 30, sinif: "C30/37", yer: tunnelId, tabaka: [{ nokta: "A", deger: 12.5, km: 3.45 }] } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.values.puan).toBe(0);
    expect(r.body.failedItems).toEqual([{ itemId: "kalip", label: "Kalıp temiz" }]);
    // Required signature is missing.
    const sub = await murat.post(`${url}/submit`);
    expect(sub.status).toBe(400);
    expect(sub.body.details.map((e: any) => e.itemId)).toEqual(["imza"]);
    // Others cannot edit Murat's draft.
    expect((await semih.patch(url, { values: {} })).status).toBe(403);
  });

  it("stores photos and signatures with permission checks", async () => {
    const url = `/projects/${pid}/forms/${formA.id}/attachments`;
    const badSig = await murat.upload(url, { itemId: "imza" }, { name: "imza.jpg", data: JPEG });
    expect(badSig.status).toBe(400);
    expect((await murat.upload(url, { itemId: "kalip" }, { name: "x.png", data: PNG })).status).toBe(400);
    expect((await murat.upload(url, { itemId: "foto" }, { name: "x.txt", data: Buffer.from("hello") })).status).toBe(400);
    expect((await semih.upload(url, { itemId: "foto" }, { name: "f.jpg", data: JPEG })).status).toBe(403);
    expect((await outsider.upload(url, { itemId: "foto" }, { name: "f.jpg", data: JPEG })).status).toBe(404);
    const sig = await murat.upload(url, { itemId: "imza" }, { name: "imza.png", data: PNG });
    expect(sig.status, JSON.stringify(sig.body)).toBe(200);
    expect(sig.body).toMatchObject({ kind: "signature", contentType: "image/png" });
    const photo = await murat.upload(url, { itemId: "foto" }, { name: "saha.jpg", data: JPEG });
    expect(photo.body).toMatchObject({ kind: "photo", contentType: "image/jpeg" });

    // Attachment ids must match their item.
    expect((await murat.patch(`/projects/${pid}/forms/${formA.id}`, { values: { kalip: "no", imza: photo.body.id } })).status).toBe(400);
    const ok = await murat.patch(`/projects/${pid}/forms/${formA.id}`, {
      values: { ...formA.values, kalip: "no", paspayi: 30, sinif: "C30/37", yer: tunnelId, tabaka: [{ nokta: "A", deger: 12.5 }], imza: sig.body.id, foto: [photo.body.id] },
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.attachments).toHaveLength(2);

    const get = await semih.get(`${url}/${sig.body.id}`);
    expect(get.status).toBe(200);
    expect(get.raw.headers["content-type"]).toBe("image/png");
    expect(get.raw.rawPayload.equals(PNG)).toBe(true);
    expect((await outsider.get(`${url}/${sig.body.id}`)).status).toBe(404);
    expect((await outsider.get(`/projects/${otherPid}/forms/${formA.id}/attachments/${sig.body.id}`)).status).toBe(404);
  });

  it("creates an issue from a failed item, linked to the form and its location", async () => {
    const r = await semih.post(`/projects/${pid}/forms/${formA.id}/items/kalip/issue`, { priority: "high" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.title).toBe("PKF-KK-2026-001: Kalıp temiz");
    expect(r.body.locationId).toBe(stationId);
    const issue = (await semih.get(`/projects/${pid}/issues/${r.body.issueId}`)).body;
    expect(issue).toMatchObject({ type: "Form", priority: "high" });
    expect(issue.description).toContain("Cevap: Hayır");
    const detail = (await murat.get(`/projects/${pid}/forms/${formA.id}`)).body;
    expect(detail.issueLinks).toEqual([expect.objectContaining({ itemId: "kalip", issueId: r.body.issueId, issueNumber: issue.number })]);
    const links = (await murat.get(`/projects/${pid}/location-links?kind=issue&targetId=${r.body.issueId}`)).body;
    expect(links).toEqual([expect.objectContaining({ locationId: stationId, label: expect.stringContaining("Kalıp temiz") })]);
    expect((await murat.post(`/projects/${pid}/forms/${formA.id}/items/yok/issue`, {})).status).toBe(404);
  });

  it("links issues to locations without touching the issues table", async () => {
    const i = (await murat.post(`/projects/${pid}/issues`, { title: "Tünelde sızıntı" })).body;
    expect((await semih.put(`/projects/${pid}/location-links`, { kind: "issue", targetId: i.id, locationId: tunnelId })).status).toBe(403);
    const r = await murat.put(`/projects/${pid}/location-links`, { kind: "issue", targetId: i.id, locationId: tunnelId });
    expect(r.status).toBe(200);
    const line = (await murat.get(`/projects/${pid}/locations`)).body.find((l: any) => l.code === "L1");
    const sub = (await murat.get(`/projects/${pid}/location-links?locationId=${line.id}&subtree=1`)).body;
    expect(sub.map((x: any) => x.kind).sort()).toEqual(["form", "issue", "issue"]);
    // Deleting a linked location needs confirmation.
    expect((await admin.del(`/projects/${pid}/locations/${tunnelId}`)).status).toBe(409);
  });

  it("submits, filters, closes and renders a PDF", async () => {
    const sub = await murat.post(`/projects/${pid}/forms/${formA.id}/submit`);
    expect(sub.status, JSON.stringify(sub.body)).toBe(200);
    expect(sub.body).toMatchObject({ status: "submitted", submittedByName: "Murat", failedCount: 1, canEdit: false });
    expect((await murat.patch(`/projects/${pid}/forms/${formA.id}`, { values: {} })).status).toBe(409);

    const list = async (qs: string) => (await semih.get(`/projects/${pid}/forms?${qs}`)).body.map((f: any) => f.number);
    expect(await list("status=submitted")).toEqual(["PKF-KK-2026-001"]);
    expect(await list("status=open")).toEqual(expect.arrayContaining(["PKF-KK-2026-001", "PKF-KK-2026-002", "PKF-KK-2026-003"]));
    const line = (await murat.get(`/projects/${pid}/locations`)).body.find((l: any) => l.code === "L1");
    expect(await list(`locationId=${line.id}`)).toEqual(["PKF-KK-2026-001"]);
    expect(await list(`templateId=${tplId}&from=2026-10-11&to=2026-10-11`)).toEqual(["PKF-KK-2026-002"]);

    expect((await murat.post(`/projects/${pid}/forms/${formA.id}/close`)).status).toBe(403);
    const closed = await admin.post(`/projects/${pid}/forms/${formA.id}/close`);
    expect(closed.body.status).toBe("closed");

    const pdf = await semih.get(`/projects/${pid}/forms/${formA.id}/pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.raw.headers["content-type"]).toBe("application/pdf");
    expect(pdf.raw.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.raw.rawPayload.length).toBeGreaterThan(2000);
    expect((await outsider.get(`/projects/${pid}/forms/${formA.id}/pdf`)).status).toBe(404);
  });

  it("runs an attached approval workflow on submit", async () => {
    const wf = await admin.post(`/projects/${pid}/workflow-templates`, {
      kind: "form",
      name: "Kontrol onayı",
      steps: [{ name: "Müşavir kontrolü", assignees: [{ type: "user", id: semihId }], rule: "any", days: 2, outcomes: ["approved", "rejected"] }],
    });
    expect(wf.status, JSON.stringify(wf.body)).toBe(200);
    const t = (await admin.get(`/projects/${pid}/form-templates/${tplId}`)).body;
    await admin.put(`/projects/${pid}/form-templates/${tplId}`, { ...t, workflowTemplateId: wf.body.id });
    const f = (await murat.post(`/projects/${pid}/forms`, { templateId: tplId, formDate: "2026-10-13" })).body;
    const sig = await murat.upload(`/projects/${pid}/forms/${f.id}/attachments`, { itemId: "imza" }, { name: "i.png", data: PNG });
    const values = { kalip: "yes", imza: sig.body.id };
    let r = await murat.post(`/projects/${pid}/forms/${f.id}/submit`, { values });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.status).toBe("in_review");
    expect(r.body.workflow).toMatchObject({ status: "running", stepName: "Müşavir kontrolü", canAct: false });
    const tasks = (await semih.get("/my-tasks")).body;
    expect(tasks).toEqual([expect.objectContaining({ kind: "form", subjectId: f.id, link: `/projects/${pid}/forms/${f.id}` })]);
    expect((await murat.post(`/projects/${pid}/forms/${f.id}/review`, { outcome: "approved" })).status).toBe(403);
    r = await semih.post(`/projects/${pid}/forms/${f.id}/review`, { outcome: "rejected", comment: "Fotoğraf ekleyin" });
    expect(r.body).toMatchObject({ status: "draft", lastOutcome: "rejected" });
    // Resubmitted in the next round, then approved.
    r = await murat.post(`/projects/${pid}/forms/${f.id}/submit`);
    expect(r.body.status).toBe("in_review");
    expect((await semih.get(`/projects/${pid}/forms/${f.id}`)).body.workflow.canAct).toBe(true);
    r = await semih.post(`/projects/${pid}/forms/${f.id}/review`, { outcome: "approved" });
    expect(r.body).toMatchObject({ status: "closed", lastOutcome: "approved" });
    expect(r.body.workflow.actions.map((x: any) => x.kind)).toEqual(["start", "submit", "step_completed", "completed", "start", "submit", "step_completed", "completed"]);
    expect((await semih.get("/my-tasks")).body).toEqual([]);
  });

  it("suggests and merges near-duplicate templates", async () => {
    const copy = await admin.post(`/projects/${pid}/form-templates/from-library`, {
      key: "beton-dokum-onay",
      code: "BDO2",
      name: "Beton döküm onay formu (Ekim-Kasım Dönemi) GÜNCEL",
    });
    expect(copy.status).toBe(200);
    const sim = (await admin.get(`/projects/${pid}/form-templates/similar`)).body;
    expect(sim[0]).toMatchObject({ score: 1, shared: expect.any(Number) });
    expect([sim[0].a.code, sim[0].b.code].sort()).toEqual(["BDO", "BDO2"]);
    const keep = sim[0].a.id;
    const merged = await admin.post(`/projects/${pid}/form-templates/${keep}/merge`, { fromTemplateId: sim[0].b.id });
    expect(merged.status).toBe(200);
    const codes = (await admin.get(`/projects/${pid}/form-templates`)).body.map((t: any) => t.code);
    expect(codes.filter((c: string) => c.startsWith("BDO"))).toHaveLength(1);
  });

  it.skipIf(!hasAi)("generates a template from a sentence (503 without AI, one repair with a fake model)", async () => {
    const none = await admin.post(`/projects/${pid}/form-templates/generate`, { description: "Kalıp kontrol formu, imzalı" });
    expect(none.status).toBe(503);
    expect(none.body.error).toBe("ai_unavailable");
    const prov = await admin.post("/admin/ai/providers", { name: "Sahte yerel", kind: "openai_compatible", baseUrl: `${stubUrl}/v1`, model: "qwen3:8b" });
    expect(prov.status, JSON.stringify(prov.body)).toBe(200);
    expect((await murat.post(`/projects/${pid}/form-templates/generate`, { description: "Kalıp kontrol formu" })).status).toBe(403);
    const r = await admin.post(`/projects/${pid}/form-templates/generate`, { description: "Kalıp kontrol formu, açıklık ölçümü ve imza" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ code: "KLP", name: "Kalıp kontrol formu", repaired: true, model: "qwen3:8b" });
    expect(r.body.schema.sections[0].items[0]).toMatchObject({ id: expect.any(String), type: "yes_no" });
    expect(stubCalls).toHaveLength(2);
    expect(stubCalls[1].messages.at(-1).content).toContain("geçersiz");
    // The draft can be saved as is.
    const saved = await admin.post(`/projects/${pid}/form-templates`, { code: r.body.code, name: r.body.name, schema: r.body.schema });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  });
});
