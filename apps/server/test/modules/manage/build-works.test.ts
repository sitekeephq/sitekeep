import { hasAi } from "../../helpers/modules.js"; // AI steps run when the AI module is installed
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { PDFDocument } from "pdf-lib";
import { buildApp } from "../../../src/app/build-app.js";
import { hashPassword } from "../../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../../src/db/index.js";
import { users } from "../../../src/db/schema.js";
import { JobQueue } from "../../../src/jobs/queue.js";
import { LocalStorage } from "../../../src/core/platform/storage.js";
import { runDueReminders } from "../../../src/workflow/reminders.js";
import { readXlsx, writeXlsx } from "../../../src/core/formats/xlsx.js";

let handle: DbHandle;
let app: FastifyInstance;
let dataDir: string;
const PW = "Sifre-1234567";
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

// Fake OpenAI-compatible model on 127.0.0.1 (local → allowed in "local_only"); no real model is called.
let stub: Server;
let stubUrl: string;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "7dcde-build-"));
  handle = await openDb("memory://");
  const storage = new LocalStorage(path.join(dataDir, "storage"));
  app = await buildApp({ db: handle.db, storage, jobs: new JobQueue(handle.db, storage), secretKey: Buffer.alloc(32, 3) });
  await handle.db.insert(users).values({ email: "admin@7d.test", name: "Admin", passwordHash: await hashPassword(PW), isAdmin: true });
  stub = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      const system: string = body.messages?.[0]?.content ?? "";
      const answer = system.includes("tutanağından")
        ? '```json\n{"items":[{"konu":"Kolon kalıbı","karar":"Kalıp çizimi revize edilecek","sorumlu":"Aytuğ","termin":"15.11.2026"},{"konu":"İSG eğitimi","karar":null,"sorumlu":"Bilinmeyen Kişi","termin":"yakında"}]}\n```'
        : '{"title":"Mekanik şaft ölçüsü","fields":{"soru":"Şaft ölçüsü nedir?","disiplin":"Mekanik","kategori":"Uydurma","oncelik":"Yüksek","bilinmeyen":"x"}}';
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: "x", model: body.model, choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: answer } }] }));
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

function api(cookie: string) {
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
type Client = ReturnType<typeof api>;

const RFI_FIELDS = { soru: "Kolon ölçüsü nedir?", kategori: "Tasarım Koordinasyonu", oncelik: "Normal", maliyet_etkisi: "Yok", takvim_etkisi: "Var" };

describe("build works: RFI, submittal, meetings", () => {
  let admin: Client, semih: Client, aytug: Client, zeynep: Client, murat: Client;
  const ids: Record<string, string> = {};
  let pid: string;
  let wipId: string;
  let versionId: string;
  const P = () => `/projects/${pid}`;

  it("sets up a project with contractor, consultant and client", async () => {
    admin = api(await login("admin@7d.test"));
    for (const c of ["CNS", "HLL", "ZRT", "DIS"]) ids[c] = (await admin.post("/companies", { name: c })).body.id;
    const p = await admin.post("/projects", { code: "PAS", name: "ZAVM" });
    pid = p.body.id;
    for (const [key, company, name] of [
      ["semih", "CNS", "Semih"],
      ["aytug", "HLL", "Aytuğ Kaya"],
      ["zeynep", "ZRT", "Zeynep"],
      ["murat", "DIS", "Murat"],
    ] as const) {
      ids[key] = (await admin.post("/users", { email: `${key}@b.test`, name, password: PW, companyId: ids[company] })).body.id;
      expect((await admin.post(`${P()}/members`, { email: `${key}@b.test` })).status).toBe(200);
    }
    semih = api(await login("semih@b.test"));
    aytug = api(await login("aytug@b.test"));
    zeynep = api(await login("zeynep@b.test"));
    murat = api(await login("murat@b.test"));
    wipId = (await admin.get(`${P()}/folders/${p.body.rootFolderId}/contents`)).body.folders[0].id;
    await admin.put(`${P()}/folders/${wipId}/permissions`, { entries: [{ subjectType: "company", subjectId: ids.CNS, level: "edit" }] });
    const up = await semih.upload(`${P()}/folders/${wipId}/files`, "M-101.pdf", "pafta");
    expect(up.status, JSON.stringify(up.body)).toBe(200);
    versionId = (await semih.get(`${P()}/folders/${wipId}/contents`)).body.files[0].latest.id;
  });

  let rfiId: string;
  let rfiTemplate: string;

  it("numbers RFIs per discipline and validates required fields", async () => {
    const types = (await semih.get(`${P()}/work-types`)).body;
    expect(types.find((t: any) => t.key === "rfi").category).toBe("rfi");
    const missing = await semih.post(`${P()}/works`, { typeKey: "rfi", title: "Eksik", fields: { soru: "?" }, toCompanyIds: [ids.HLL] });
    expect(missing.status).toBe(400);
    expect(missing.body.message).toContain("Disiplin");
    const mk = (title: string, disiplin: string) =>
      semih.post(`${P()}/works`, { typeKey: "rfi", title, fields: { ...RFI_FIELDS, disiplin }, toCompanyIds: [ids.HLL], links: [{ kind: "file_version", targetId: versionId, role: "ek" }] });
    const r1 = await mk("Kolon ölçüsü", "M - Mekanik");
    expect(r1.status, JSON.stringify(r1.body)).toBe(200);
    expect(r1.body.number).toBe("CNS_HLL_M_BT_001");
    expect((await mk("Şaft", "M - Mekanik")).body.number).toBe("CNS_HLL_M_BT_002");
    expect((await mk("Pano", "E - Elektrik")).body.number).toBe("CNS_HLL_E_BT_001");
    rfiId = r1.body.id;
    expect(r1.body.build).toMatchObject({ category: "rfi", canSubmit: true, revisions: [] });
    // Drafts stay invisible to the addressee.
    expect((await aytug.get(`${P()}/works/${rfiId}`)).status).toBe(404);
  });

  it("runs the RFI through CNS → HLL → ZRT with an official response", async () => {
    const tpl = await admin.post(`${P()}/workflow-templates`, {
      kind: "rfi",
      name: "RFI: Müşavir → İdare",
      steps: [
        { name: "Müşavir", assignees: [{ type: "company", id: ids.HLL }], rule: "any", days: 3, outcomes: ["reviewed", "revise_resubmit"] },
        { name: "İdare", assignees: [{ type: "company", id: ids.ZRT }], rule: "any", days: 4, outcomes: ["reviewed", "revise_resubmit"] },
      ],
    });
    expect(tpl.status, JSON.stringify(tpl.body)).toBe(200);
    rfiTemplate = tpl.body.id;
    const auto = await admin.put(`${P()}/work-automation/${rfiTemplate}`, { autoTransmittal: true, include: "all", purpose: "bilgi", send: true });
    expect(auto.status, JSON.stringify(auto.body)).toBe(200);
    const rfiType = (await admin.get(`${P()}/work-types`)).body.find((t: any) => t.key === "rfi");
    expect((await admin.put(`${P()}/work-types/${rfiType.id}`, { defaultWorkflowTemplateId: rfiTemplate })).status).toBe(200);

    expect((await aytug.post(`${P()}/works/${rfiId}/submit`, {})).status).toBe(404);
    const sub = await semih.post(`${P()}/works/${rfiId}/submit`, { comment: "Acil" });
    expect(sub.status, JSON.stringify(sub.body)).toBe(200);
    let d = (await semih.get(`${P()}/works/${rfiId}`)).body;
    expect(d.status).toBe("acik");
    expect(d.dueDate > today()).toBe(true);
    expect(d.build.workflow).toMatchObject({ stepIndex: 0, canAct: false, needsResponse: true });
    expect(d.build.ballInCourt).toEqual([ids.HLL]);
    expect((await semih.post(`${P()}/works/${rfiId}/submit`, {})).status).toBe(409);

    // The client reviewer sees the RFI as a workflow participant; outsiders do not.
    expect((await zeynep.get(`${P()}/works/${rfiId}`)).status).toBe(200);
    expect((await murat.get(`${P()}/works/${rfiId}`)).status).toBe(404);
    expect((await zeynep.get(`${P()}/works?category=rfi`)).body.map((w: any) => w.id)).toContain(rfiId);

    // Only the current step's assignees answer; RFIs need an official response.
    expect((await zeynep.post(`${P()}/works/${rfiId}/respond`, { outcome: "reviewed", response: "x" })).status).toBe(403);
    expect((await semih.post(`${P()}/works/${rfiId}/respond`, { outcome: "reviewed", response: "x" })).status).toBe(403);
    const tasks = (await aytug.get("/my-tasks")).body;
    expect(tasks.find((t: any) => t.subjectId === rfiId)).toMatchObject({ kind: "rfi", code: "CNS_HLL_M_BT_001", stepName: "Müşavir" });
    expect((await aytug.post(`${P()}/works/${rfiId}/respond`, { outcome: "reviewed" })).status).toBe(400);
    expect((await aytug.post(`${P()}/works/${rfiId}/respond`, { outcome: "approved", response: "x" })).status).toBe(400);
    const r1 = await aytug.post(`${P()}/works/${rfiId}/respond`, { outcome: "reviewed", comment: "Uygun", response: "Müşavir görüşü: 60x60" });
    expect(r1.status, JSON.stringify(r1.body)).toBe(200);
    expect((await aytug.post(`${P()}/works/${rfiId}/respond`, { outcome: "reviewed", response: "x" })).status).toBe(403);
    d = (await zeynep.get(`${P()}/works/${rfiId}`)).body;
    expect(d.build.workflow).toMatchObject({ stepIndex: 1, canAct: true });
    expect(d.build.workflow.steps[0]).toMatchObject({ state: "done", answers: [{ userName: "Aytuğ Kaya", response: "Müşavir görüşü: 60x60" }] });
    expect(d.build.workflow.actingFor).toEqual(["ZRT"]);

    const r2 = await zeynep.post(`${P()}/works/${rfiId}/respond`, { outcome: "reviewed", response: "Resmi cevap: kolon 60x60 olacak." });
    expect(r2.status, JSON.stringify(r2.body)).toBe(200);
    d = (await semih.get(`${P()}/works/${rfiId}`)).body;
    expect(d.status).toBe("cevaplandi");
    expect(d.fields.resmi_cevap).toBe("Resmi cevap: kolon 60x60 olacak.");
    expect(d.build.officialResponse).toBe("Resmi cevap: kolon 60x60 olacak.");
    expect(d.build.revisions).toHaveLength(1);
    expect(d.build.revisions[0]).toMatchObject({ rev: 0, status: "decided", outcomeLabel: "Görüldü" });
    expect(d.build.ballInCourt).toEqual([ids.CNS]);

    // Automatic transmittal back to the submitter with the RFI's attachment.
    const trs = (await semih.get(`${P()}/works?type=transmittal`)).body;
    expect(trs).toHaveLength(1);
    expect(trs[0]).toMatchObject({ status: "gonderildi", toCompanyIds: [ids.CNS] });
    const tr = (await semih.get(`${P()}/works/${trs[0].id}`)).body;
    expect(tr.links.some((l: any) => l.kind === "work" && l.role === "kaynak" && l.targetId === rfiId)).toBe(true);
    expect(tr.links.some((l: any) => l.kind === "file_version" && l.targetId === versionId)).toBe(true);

    const close = await semih.patch(`${P()}/works/${rfiId}`, { status: "kapandi" });
    expect(close.body).toMatchObject({ status: "kapandi", closed: true });
  });

  it("switches RFI numbering to the ZAVM preset", async () => {
    expect((await semih.put(`${P()}/build/numbering`, { preset: "zavm" })).status).toBe(403);
    expect((await admin.put(`${P()}/build/numbering`, { preset: "zavm" })).body.changed).toEqual(["rfi", "submittal-kalemi"]);
    const r = await semih.post(`${P()}/works`, { typeKey: "rfi", title: "Kolon detayı", fields: { ...RFI_FIELDS, disiplin: "M - Mekanik" }, toCompanyIds: [ids.HLL] });
    expect(r.body.number).toBe("PAS_CNS_M_RFI_001_Kolon-detayı");
    const r2 = await semih.post(`${P()}/works`, { typeKey: "rfi", title: "Başka konu", fields: { ...RFI_FIELDS, disiplin: "M - Mekanik" }, toCompanyIds: [ids.HLL] });
    expect(r2.body.number).toBe("PAS_CNS_M_RFI_002_Başka-konu");
    await admin.put(`${P()}/build/numbering`, { preset: "standart" });
  });

  let itemId: string;
  let basId: string;

  it("revises a submittal item on the same record (rev 0 → rev 1 → approved)", async () => {
    const c = await semih.post(`${P()}/works`, {
      typeKey: "submittal-kalemi",
      title: "Klima santrali",
      fields: { tur: "MOS - Malzeme Onay", disiplin: "M - Mekanik", bolum_kodu: "23 73 00" },
      toCompanyIds: [ids.HLL],
    });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(c.body.number).toBe("CNS_MOS_M_0001");
    itemId = c.body.id;
    expect((await semih.post(`${P()}/works/${itemId}/submit`, {})).status).toBe(200);
    expect((await semih.get(`${P()}/works/${itemId}`)).body.status).toBe("incelemede");
    const opts = (await aytug.get(`${P()}/works/${itemId}`)).body.build.workflow.options.map((o: any) => o.code);
    expect(opts).toEqual(["approved", "approved_with_comments", "revise_resubmit", "rejected"]);
    expect((await aytug.post(`${P()}/works/${itemId}/respond`, { outcome: "revise_resubmit", comment: "Ses değerleri eksik" })).status).toBe(200);
    let d = (await semih.get(`${P()}/works/${itemId}`)).body;
    expect(d).toMatchObject({ status: "revize", build: { rev: 0, canRevise: true, ballInCourt: [ids.CNS] } });
    expect((await aytug.post(`${P()}/works/${itemId}/revise`, {})).status).toBe(403);
    expect((await semih.post(`${P()}/works/${itemId}/revise`, {})).status).toBe(200);
    d = (await semih.get(`${P()}/works/${itemId}`)).body;
    expect(d).toMatchObject({ id: itemId, number: "CNS_MOS_M_0001", status: "taslak", build: { rev: 1, canSubmit: true } });
    expect((await semih.post(`${P()}/works/${itemId}/submit`, { comment: "Rev 1" })).status).toBe(200);
    expect((await aytug.post(`${P()}/works/${itemId}/respond`, { outcome: "approved" })).status).toBe(200);
    d = (await semih.get(`${P()}/works/${itemId}`)).body;
    expect(d.status).toBe("onaylandi");
    expect(d.build.revisions.map((r: any) => [r.rev, r.outcomeLabel])).toEqual([
      [0, "Revize Et ve Tekrar Gönder"],
      [1, "Onaylandı"],
    ]);
    expect(d.build.revisions[0].steps[0].answers[0].comment).toBe("Ses değerleri eksik");
  });

  it("allows only 'Görüldü' for information submittals (BAS)", async () => {
    const c = await semih.post(`${P()}/works`, {
      typeKey: "submittal-kalemi",
      title: "Haftalık rapor",
      fields: { tur: "BAS - Bilgi Amaçlı", disiplin: "G - Genel" },
      toCompanyIds: [ids.HLL],
    });
    basId = c.body.id;
    expect((await semih.post(`${P()}/works/${basId}/submit`, {})).status).toBe(200);
    expect((await aytug.get(`${P()}/works/${basId}`)).body.build.workflow.options).toEqual([{ code: "reviewed", label: "Görüldü", kind: "info" }]);
    expect((await aytug.post(`${P()}/works/${basId}/respond`, { outcome: "approved" })).status).toBe(400);
    // Step reminders reach work steps too (due in 14 days).
    const rem = await runDueReminders(handle.db, new Date(Date.now() + 20 * 86_400_000));
    expect(rem.overdue).toBeGreaterThanOrEqual(1);
    expect((await aytug.post(`${P()}/works/${basId}/respond`, { outcome: "reviewed" })).status).toBe(200);
    const d = (await semih.get(`${P()}/works/${basId}`)).body;
    expect(d).toMatchObject({ status: "goruldu", closed: true });
    expect(d.build.revisions[0].outcomeLabel).toBe("Görüldü");
  });

  it("rolls a package's status up from its items", async () => {
    const pkg = await semih.post(`${P()}/works`, { typeKey: "submittal-paketi", title: "Mekanik malzemeler", fields: { bolum: "MOS", disiplin: "M - Mekanik" }, toCompanyIds: [ids.HLL] });
    expect(pkg.status, JSON.stringify(pkg.body)).toBe(200);
    expect(pkg.body.number).toBe("MOS-01 M");
    const pkgId = pkg.body.id;
    const draft = await semih.post(`${P()}/works`, {
      typeKey: "submittal-kalemi",
      title: "Fan coil",
      fields: { tur: "MOS - Malzeme Onay", disiplin: "M - Mekanik" },
      toCompanyIds: [ids.HLL],
      parentWorkId: pkgId,
    });
    expect((await semih.post(`${P()}/works/${pkgId}/items`, { workIds: [itemId] })).status).toBe(200);
    let p = (await semih.get(`${P()}/works/${pkgId}`)).body;
    expect(p.status).toBe("kismen");
    expect(p.build.children.map((c: any) => c.id).sort()).toEqual([itemId, draft.body.id].sort());
    expect(p.build.canSubmit).toBe(true);
    expect((await semih.post(`${P()}/works/${pkgId}/submit`, {})).status).toBe(200);
    expect((await semih.get(`${P()}/works/${pkgId}`)).body.status).toBe("incelemede");
    expect((await aytug.post(`${P()}/works/${draft.body.id}/respond`, { outcome: "approved_with_comments" })).status).toBe(200);
    p = (await semih.get(`${P()}/works/${pkgId}`)).body;
    expect(p).toMatchObject({ status: "onaylandi", closed: true });
    expect((await semih.get(`${P()}/works?parent=${pkgId}`)).body).toHaveLength(2);
  });

  it("imports a spec register (preview, then create)", async () => {
    const items = [
      { sectionCode: "08 71 00", sectionTitle: "Kapı donanımı", type: "MOS", discipline: "A", description: "Kapı kolu numunesi ve föyü", page: 12, excerpt: "Yüklenici ... sunacaktır." },
      { sectionCode: "08 71 00", sectionTitle: "Kapı donanımı", type: "Uygulama / Atölye Çizimi", discipline: "Mimari", description: "Kapı detayları" },
      { sectionCode: "09 30 00", type: "XYZ", discipline: "A", description: "Seramik" },
    ];
    const pre = await semih.post(`${P()}/submittals/import`, { items, packages: "section" });
    expect(pre.status, JSON.stringify(pre.body)).toBe(200);
    expect(pre.body).toMatchObject({ dryRun: true, valid: 2, invalid: 1, created: null });
    expect(pre.body.rows[0]).toMatchObject({ kind: "MOS - Malzeme Onay", discipline: "A - Mimari", packageKey: "08 71 00|A - Mimari" });
    expect(pre.body.rows[2].problems[0]).toContain("XYZ");
    expect(pre.body.packages).toEqual([{ key: "08 71 00|A - Mimari", bolum: "08 71 00", discipline: "A - Mimari", count: 2, existingId: null }]);
    expect((await semih.get(`${P()}/works?category=submittal`)).body).toHaveLength(3);

    const made = await semih.post(`${P()}/submittals/import`, { items, packages: "section", dryRun: false, toCompanyIds: [ids.HLL] });
    expect(made.status, JSON.stringify(made.body)).toBe(200);
    expect(made.body.created.items).toHaveLength(2);
    expect(made.body.created.packages).toHaveLength(1);
    const pkg = (await semih.get(`${P()}/works/${made.body.created.packages[0]}`)).body;
    expect(pkg.number).toBe("087100-01 A");
    expect(pkg.build.children).toHaveLength(2);
    const first = (await semih.get(`${P()}/works/${made.body.created.items[0]}`)).body;
    expect(first).toMatchObject({ number: "CNS_MOS_A_0001", fields: { bolum_kodu: "08 71 00", sayfa: "12", alinti: "Yüklenici ... sunacaktır." } });

    // CSV and XLSX carry the same columns (Turkish headers accepted).
    const csv = "Bölüm kodu;Bölüm adı;Tür;Disiplin;Açıklama;Sayfa\n09 30 00;Seramik;NUM;A;\"Seramik numunesi; 3 renk\";4\n";
    const c = await semih.post(`${P()}/submittals/import`, { format: "csv", content: csv });
    expect(c.body).toMatchObject({ valid: 1, invalid: 0 });
    expect(c.body.rows[0].item.description).toBe("Seramik numunesi; 3 renk");
    const xlsx = await writeXlsx([
      { name: "Register", columns: [{ title: "Section code" }, { title: "Type" }, { title: "Discipline" }, { title: "Description" }, { title: "Page" }], rows: [["05 12 00", "UCZ", "S", "Çelik atölye çizimleri", 7]] },
    ]);
    const x = await semih.post(`${P()}/submittals/import`, { format: "xlsx", content: xlsx.toString("base64"), dryRun: false });
    expect(x.status, JSON.stringify(x.body)).toBe(200);
    expect(x.body.created.items).toHaveLength(1);
    expect(x.body.rows[0]).toMatchObject({ kind: "UCZ - Uygulama / Atölye Çizimi", discipline: "S - Statik", item: { page: 7 } });

    // Rows from "Şartname analizi" (doc-intelligence codes; excluded rows are skipped).
    const di = await semih.post(`${P()}/submittals/import`, {
      items: [
        { id: "S001", sectionCode: "23 05 00", sectionTitle: null, page: 3, description: "Teknik föy – Pompa", excerpt: "onaya sunulacaktır", type: "MOS", typeConfidence: 0.9, discipline: "MEK", keywords: ["teknik föy"] },
        { id: "S002", sectionCode: "23 05 00", sectionTitle: null, page: 4, description: "Numune", excerpt: "", type: "NUM", typeConfidence: 0.8, discipline: "MEK", keywords: [], excluded: true },
      ],
    });
    expect(di.body).toMatchObject({ valid: 1, invalid: 0, rows: [{ kind: "MOS - Malzeme Onay", discipline: "M - Mekanik" }] });
  });

  let meetingId: string;

  it("turns minutes into action works, carries open ones to the next meeting and prints a PDF", async () => {
    const m = await semih.post(`${P()}/works`, {
      typeKey: "toplanti",
      title: "Haftalık koordinasyon",
      fields: { tur: "Koordinasyon", tarih: "2026-10-12", saat: "10:00", yer: "Şantiye ofisi" },
      toCompanyIds: [ids.HLL, ids.ZRT],
    });
    expect(m.status, JSON.stringify(m.body)).toBe(200);
    meetingId = m.body.id;
    expect(m.body.number).toMatch(/^PAS-TPL-\d{4}-001$/);
    expect(m.body.status).toBe("planlandi");
    const save = await semih.put(`${P()}/works/${meetingId}/meeting`, {
      attendees: [{ userId: ids.semih, companyId: ids.CNS, present: true }, { name: "Ali Veli", companyText: "Tasarım ofisi", present: true }],
      agenda: [{ text: "İş programı" }, { text: "Kalıp çizimleri" }],
    });
    expect(save.status, JSON.stringify(save.body)).toBe(200);
    expect((await semih.put(`${P()}/works/${meetingId}/meeting`, { attendees: [{ present: true }] })).status).toBe(400);
    const min = await semih.put(`${P()}/works/${meetingId}/minutes`, {
      items: [
        { konu: "İş programı", karar: "Program onaylandı" },
        { konu: "Kalıp çizimi revizyonu", karar: "Revize edilecek", sorumluUserId: ids.aytug, termin: "2026-10-20" },
        { konu: "İSG eğitimi", sorumluCompanyId: ids.ZRT, termin: "2026-10-25" },
      ],
      notes: "Bir sonraki toplantı pazartesi.",
    });
    expect(min.status, JSON.stringify(min.body)).toBe(200);
    expect(min.body).toMatchObject({ created: 2, updated: 0 });
    let d = (await semih.get(`${P()}/works/${meetingId}`)).body;
    expect(d.status).toBe("yapildi");
    expect(d.build.children).toHaveLength(2);
    expect(d.build.children.every((c: any) => c.typeKey === "aksiyon" && c.status === "acik")).toBe(true);
    const items = d.build.meeting.minutes.items;
    expect(items[0].actionWorkId).toBeNull();
    const kalip = items[1].actionWorkId;
    // Saving again updates the same actions instead of creating new ones.
    const again = await semih.put(`${P()}/works/${meetingId}/minutes`, { items: items.map((i: any) => ({ ...i, termin: i.termin ?? null })) });
    expect(again.body).toMatchObject({ created: 0, updated: 2 });

    // The responsible person sees and closes their action.
    const action = (await aytug.get(`${P()}/works/${kalip}`)).body;
    expect(action).toMatchObject({ assigneeUserId: ids.aytug, dueDate: "2026-10-20", parentWorkId: meetingId, build: { parent: { id: meetingId } } });
    expect((await aytug.patch(`${P()}/works/${kalip}`, { status: "kapandi" })).body.status).toBe("kapandi");

    const next = await semih.post(`${P()}/works/${meetingId}/next-meeting`, {});
    expect(next.status, JSON.stringify(next.body)).toBe(200);
    expect(next.body.number).toMatch(/-002$/);
    const n = (await semih.get(`${P()}/works/${next.body.id}`)).body;
    expect(n.fields.tarih).toBe("2026-10-19");
    expect(n.build.carried).toHaveLength(1);
    expect(n.build.carried[0].title).toBe("İSG eğitimi");
    expect(n.build.meeting.agenda[0].text).toContain("devreden");
    expect(n.build.meeting.attendees).toHaveLength(2);
    expect((await semih.post(`${P()}/works/${meetingId}/next-meeting`, {})).status).toBe(409);

    const pdf = await semih.get(`${P()}/works/${meetingId}/minutes.pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.raw.headers["content-type"]).toBe("application/pdf");
    const doc = await PDFDocument.load(pdf.raw.rawPayload);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
    expect(doc.getTitle()).toContain("tutanağı");
    expect((await semih.get(`${P()}/works/${next.body.id}/minutes.pdf`)).status).toBe(200);
    expect((await semih.get(`${P()}/works/${rfiId}/minutes.pdf`)).status).toBe(400);
    d = (await semih.get(`${P()}/works?category=action&open=1`)).body;
    expect(d.map((w: any) => w.title)).toEqual(["İSG eğitimi"]);
  });

  it("lists the submittal register and the RFI log, with Excel export", async () => {
    const reg = await semih.get(`${P()}/submittals/register`);
    expect(reg.status).toBe(200);
    const row = reg.body.find((r: any) => r.id === itemId);
    expect(row).toMatchObject({ rev: 1, status: "onaylandi", kind: "MOS", kindLabel: "Malzeme Onay", sectionCode: "23 73 00", packageNumber: "MOS-01 M", outcomeLabel: "Onaylandı", ballInCourt: [] });
    const open = reg.body.find((r: any) => r.status === "taslak");
    expect(open.ballInCourt).toEqual([]);
    const x = await semih.get(`${P()}/submittals/register?format=xlsx`);
    expect(x.raw.headers["content-type"]).toContain("spreadsheetml");
    const table = readXlsx(x.raw.rawPayload);
    expect(table[0]![0]).toBe("Numara");
    expect(table.length).toBe(reg.body.length + 1);

    const log = (await semih.get(`${P()}/rfis/log`)).body;
    const r = log.find((l: any) => l.id === rfiId);
    expect(r).toMatchObject({ number: "CNS_HLL_M_BT_001", status: "kapandi", discipline: "M - Mekanik", priority: "Normal", response: "Resmi cevap: kolon 60x60 olacak.", overdue: false, daysOpen: 0, to: ["HLL"] });
    expect(log.find((l: any) => l.number === "CNS_HLL_E_BT_001")).toMatchObject({ status: "taslak", daysOpen: null });
    // Outsiders see nothing of other companies' drafts.
    expect((await murat.get(`${P()}/rfis/log`)).body).toHaveLength(0);
    const lx = await semih.get(`${P()}/rfis/log?format=xlsx`);
    expect(readXlsx(lx.raw.rawPayload)[1]).toContain("CNS_HLL_M_BT_001");
  });

  it("cancels a running workflow", async () => {
    const c = await semih.post(`${P()}/works`, { typeKey: "submittal-kalemi", title: "İptal", fields: { tur: "NUM - Numune", disiplin: "M - Mekanik" }, toCompanyIds: [ids.HLL] });
    await semih.post(`${P()}/works/${c.body.id}/submit`, {});
    expect((await aytug.post(`${P()}/works/${c.body.id}/cancel`, {})).status).toBe(403);
    expect((await semih.post(`${P()}/works/${c.body.id}/cancel`, { comment: "Vazgeçildi" })).status).toBe(200);
    const d = (await semih.get(`${P()}/works/${c.body.id}`)).body;
    expect(d).toMatchObject({ status: "iptal", build: { revisions: [{ status: "cancelled" }] } });
    expect((await aytug.post(`${P()}/works/${c.body.id}/respond`, { outcome: "approved" })).status).toBe(409);
  });

  it.skipIf(!hasAi)("suggests actions from minutes and drafts RFIs with a (fake) local model", async () => {
    const body = { text: "Kalıp çizimi Aytuğ tarafından 15.11.2026'ya kadar revize edilecek. İSG eğitimi yapılacak." };
    expect((await semih.post(`${P()}/ai/minutes-actions`, body)).status).toBe(503);
    const prov = await admin.post("/admin/ai/providers", { name: "Yerel", kind: "openai_compatible", baseUrl: `${stubUrl}/v1`, model: "qwen3:8b" });
    expect(prov.status, JSON.stringify(prov.body)).toBe(200);
    await admin.put("/admin/settings/ai", { defaultProviderId: prov.body.id });
    const s = await semih.post(`${P()}/ai/minutes-actions`, body);
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    expect(s.body.items).toEqual([
      { konu: "Kolon kalıbı", karar: "Kalıp çizimi revize edilecek", sorumluUserId: ids.aytug, sorumluCompanyId: ids.HLL, sorumluText: null, termin: "2026-11-15" },
      { konu: "İSG eğitimi", karar: null, sorumluUserId: null, sorumluCompanyId: null, sorumluText: "Bilinmeyen Kişi", termin: null },
    ]);
    // Suggestions only: nothing was created.
    expect((await semih.get(`${P()}/works?category=action`)).body).toHaveLength(2);

    const draft = await semih.post(`${P()}/ai/rfi-draft`, { description: "Mekanik şaft ölçüsü belirsiz", fileVersionId: versionId });
    expect(draft.status, JSON.stringify(draft.body)).toBe(200);
    expect(draft.body).toMatchObject({
      title: "Mekanik şaft ölçüsü",
      fields: { soru: "Şaft ölçüsü nedir?", disiplin: "M - Mekanik", oncelik: "Yüksek" },
      links: [{ kind: "file_version", targetId: versionId }],
    });
    expect(draft.body.fields.kategori).toBeUndefined();
    expect(draft.body.notes.some((n: string) => n.includes("Uydurma"))).toBe(true);
    expect((await murat.post(`${P()}/ai/rfi-draft`, { description: "Mekanik şaft", fileVersionId: versionId })).status).toBe(404);

    await admin.put("/admin/settings/ai", { mode: "off" });
    const off = await semih.post(`${P()}/ai/minutes-actions`, body);
    expect(off.status).toBe(403);
    expect(off.body.error).toBe("ai_off");
    await admin.put("/admin/settings/ai", { mode: "local_only" });
  });

  it("meetings module off: no new actions from minutes, AI suggestions or the next meeting; existing meetings stay readable", async () => {
    const m = await semih.post(`${P()}/works`, { typeKey: "toplanti", title: "Modül testi toplantısı", fields: { tur: "Koordinasyon", tarih: "2026-11-02", saat: "10:00" }, toCompanyIds: [ids.HLL] });
    expect(m.status, JSON.stringify(m.body)).toBe(200);
    const mid = m.body.id;
    const first = await semih.put(`${P()}/works/${mid}/minutes`, { items: [{ konu: "Kalıp", sorumluUserId: ids.aytug, termin: "2026-11-09" }] });
    expect(first.body).toMatchObject({ created: 1, updated: 0 });
    const saved = (await semih.get(`${P()}/works/${mid}`)).body.build.meeting.minutes.items;
    const actionId = saved[0].actionWorkId;

    expect((await admin.put(`${P()}/modules`, { modules: { meetings: false } })).status).toBe(200);
    try {
      // Existing meetings, actions and the minutes PDF stay readable.
      expect((await semih.get(`${P()}/works/${mid}`)).status).toBe(200);
      expect((await aytug.get(`${P()}/works/${actionId}`)).status).toBe(200);
      expect((await semih.get(`${P()}/works/${mid}/minutes.pdf`)).status).toBe(200);
      expect((await semih.get(`${P()}/works?category=action`)).body.map((w: any) => w.id)).toContain(actionId);

      // A new action line is refused; nothing is written.
      const refused = await semih.put(`${P()}/works/${mid}/minutes`, {
        items: [...saved.map((i: any) => ({ ...i, termin: i.termin ?? null })), { konu: "Yeni eylem", sorumluCompanyId: ids.ZRT, termin: "2026-11-16" }],
      });
      expect(refused.status).toBe(403);
      expect(refused.body.error).toBe("module_disabled");
      expect(refused.body.message).toMatch(/^Toplantı ve Eylem modülü bu projede kapalı/);
      expect((await semih.get(`${P()}/works/${mid}`)).body.build.children).toHaveLength(1);

      // Editing the existing action and adding plain (non-action) lines still works.
      const edit = await semih.put(`${P()}/works/${mid}/minutes`, {
        items: [{ ...saved[0], konu: "Kalıp (revize)", termin: "2026-11-10" }, { konu: "Bilgi notu", karar: "Not alındı" }],
      });
      expect(edit.status, JSON.stringify(edit.body)).toBe(200);
      expect(edit.body).toMatchObject({ created: 0, updated: 1 });

      // AI suggestions exist to create actions: refused too (also when the AI task queue runs this route).
      const ai = await semih.post(`${P()}/ai/minutes-actions`, { text: "Kalıp çizimi Aytuğ tarafından revize edilecek, termin 20.11.2026." });
      expect(ai.status).toBe(403);
      expect(ai.body.error).toBe("module_disabled");

      // "Sonraki toplantıyı oluştur" and a new meeting are refused.
      const next = await semih.post(`${P()}/works/${mid}/next-meeting`, {});
      expect(next.status).toBe(403);
      expect(next.body.error).toBe("module_disabled");
      expect((await semih.post(`${P()}/works`, { typeKey: "toplanti", title: "Yeni toplantı", fields: {} })).status).toBe(403);
    } finally {
      await admin.put(`${P()}/modules`, { modules: { meetings: true } });
    }
    expect((await semih.post(`${P()}/works/${mid}/next-meeting`, {})).status).toBe(200);
  });
});
