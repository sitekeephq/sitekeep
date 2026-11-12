import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { PDFDocument } from "pdf-lib";
import { allItems, type FormItem, type FormTemplateSchema } from "@sitekeep/shared";
import { formFlowLines } from "@7dimensions-project/sitekeep-ee-field/shared/form-pdf.js";
import { buildApp } from "../../../src/app/build-app.js";
import { hashPassword } from "../../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../../src/db/index.js";
import { users } from "../../../src/db/schema.js";
import type { AiProvider, ChatMessage } from "../../../src/ai/provider.js";
import { compileFlow, generateFlow, type FlowContext } from "@7dimensions-project/sitekeep-ee-field/internal/flow.js";
import { flowOutputSchema } from "../../../src/contracts/forms.js";
import { nameFields } from "@7dimensions-project/sitekeep-ee-field/internal/pdf-ai.js";
import { analysePdfForm, candidatesToSchema } from "@7dimensions-project/sitekeep-ee-field/internal/pdf-detect.js";
import { renderSourceFormPdf } from "@7dimensions-project/sitekeep-ee-field/internal/pdf-fill.js";
import { readPdfLayout, type LayoutText } from "@7dimensions-project/sitekeep-ee-field/internal/pdf-layout.js";
import { JobQueue } from "../../../src/jobs/queue.js";
import { LocalStorage } from "../../../src/core/platform/storage.js";
import { acroFormPdf, scannedPdf, textLayerFormPdf } from "./form-pdf-fixtures.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const PW = "Sifre-1234567";

/** A fake model: answers from a queue and records the conversations. */
function fakeProvider(answers: string[]): AiProvider & { calls: ChatMessage[][] } {
  const calls: ChatMessage[][] = [];
  return {
    id: "fake",
    name: "Sahte",
    kind: "openai_compatible",
    model: "sahte-1",
    external: false,
    calls,
    async chat(messages) {
      calls.push(messages);
      const text = answers.shift() ?? "{}";
      return { text, toolCalls: [], model: "sahte-1", stopReason: "stop" };
    },
    async embed() {
      return [];
    },
  };
}

function byLabel(schema: FormTemplateSchema, label: string): FormItem {
  const it = allItems(schema).find((i) => i.label === label);
  if (!it) throw new Error(`no item ${label}: ${allItems(schema).map((i) => i.label).join(", ")}`);
  return it;
}

/** Text items of a page whose text contains `s`. */
function find(items: LayoutText[], s: string): LayoutText[] {
  return items.filter((i) => i.s.includes(s));
}

describe("field detection", () => {
  it("reads AcroForm fields exactly: names, types, options, page and box", async () => {
    const r = await analysePdfForm(await acroFormPdf());
    expect(r.level).toBe("acroform");
    expect(r.title).toBe("İsg Saha Denetim Formu");
    const by = Object.fromEntries(r.candidates.map((c) => [c.pdf.acroField, c]));
    expect(by.santiye_adi).toMatchObject({ label: "Şantiye Adı", type: "text", pdf: { page: 1 } });
    // pdf-lib draws the widget at y = 841.89 − 128 (bottom-left) with height 16 → top-left y ≈ 112.
    // (the widget rectangle includes half the border: ±0.5 pt)
    expect(Math.abs(by.santiye_adi!.pdf.x - 140)).toBeLessThanOrEqual(1);
    expect(Math.abs(by.santiye_adi!.pdf.y - 112)).toBeLessThanOrEqual(1);
    expect(Math.abs(by.santiye_adi!.pdf.w - 250)).toBeLessThanOrEqual(1);
    expect(by.denetim_tarihi).toMatchObject({ label: "Denetim Tarihi", type: "date" });
    expect(by.baret).toMatchObject({ label: "Baret kullanılıyor", type: "yes_no", allowNa: false });
    expect(by.hava).toMatchObject({ label: "Hava Durumu", type: "choice", options: ["Güneşli", "Yağmurlu"] });
    expect(by.hava!.pdf.marks!.map((m) => m.acroValue)).toEqual(["Güneşli", "Yağmurlu"]);
    expect(by.risk).toMatchObject({ type: "choice", options: ["Düşük", "Orta", "Yüksek"] });
    expect(by.notlar).toMatchObject({ label: "Notlar", type: "text", multiline: true });
  });

  it("finds labels, blanks, tick boxes, a note box, a table and signature lines on a text-layer PDF", async () => {
    const r = await analysePdfForm(await textLayerFormPdf());
    expect(r.level).toBe("text");
    expect(r.title).toBe("Beton Döküm Kontrol Formu");
    const s = candidatesToSchema(r.candidates);
    expect(s.sections.map((x) => x.title)).toEqual(["Genel Bilgiler", "Kontroller"]);
    const proje = byLabel(s, "Proje Adı");
    expect(proje).toMatchObject({ type: "text", pdf: { page: 1 } });
    // The dotted run starts after "Proje Adı: " and ends at the end of the text item (x 50 + 185.6).
    expect(proje.pdf!.x).toBeGreaterThan(85);
    expect(proje.pdf!.x + proje.pdf!.w).toBeCloseTo(235.6, 0);
    expect(byLabel(s, "Döküm Tarihi").type).toBe("date");
    expect(byLabel(s, "Döküm Yeri").pdf).toMatchObject({ x: 115, w: 215 });
    const kalip = byLabel(s, "Kalıp temizliği yapıldı mı?");
    expect(kalip).toMatchObject({ type: "yes_no", allowNa: false });
    expect(kalip.pdf!.marks).toEqual([expect.objectContaining({ value: "yes", x: 300 }), expect.objectContaining({ value: "no", x: 360 })]);
    expect(byLabel(s, "Açıklama")).toMatchObject({ type: "text", multiline: true });
    const table = byLabel(s, "Malzeme Listesi");
    expect(table.type).toBe("table");
    expect(table.columns!.map((c) => [c.label, c.type])).toEqual([
      ["Sıra", "text"],
      ["Malzeme", "text"],
      ["Miktar (m³)", "number"],
    ]);
    expect(table.pdf).toMatchObject({ rows: 3, colX: [50, 100, 380, 545], headerH: 20 });
    expect(byLabel(s, "Hazırlayan İmza").type).toBe("signature");
    expect(byLabel(s, "Kontrol Eden İmza").pdf!.y + byLabel(s, "Kontrol Eden İmza").pdf!.h).toBeLessThanOrEqual(560);
  });

  it("says clearly that a scanned PDF needs a vision model or OCR", async () => {
    const r = await analysePdfForm(await scannedPdf(PNG));
    expect(r.level).toBe("scanned");
    expect(r.candidates).toEqual([]);
    expect(r.messages.join(" ")).toMatch(/taranmış.*görüntü modeli.*OCR.*elle/s);
  });
});

describe("naming with the local model (mocked)", () => {
  it("renames and regroups within what the geometry allows, keeping placement", async () => {
    const r = await analysePdfForm(await textLayerFormPdf());
    const schema = candidatesToSchema(r.candidates);
    const n = allItems(schema).length;
    const fake = fakeProvider([
      "bozuk",
      JSON.stringify({
        name: "Beton Döküm Kontrol Formu",
        fields: [
          { n: 1, label: "Proje", type: "text", section: "Proje Bilgileri" },
          { n: 4, label: "Kalıp Temiz", type: "text", section: "Kontroller" },
          { n: n, label: "Kontrol Eden (İmza)", type: "signature", section: "İmzalar" },
        ],
      }),
    ]);
    const out = await nameFields(fake, schema);
    expect(out.repaired).toBe(true);
    expect(fake.calls[0]!.at(-1)!.content).not.toContain("%PDF");
    expect(out.schema.sections.map((s) => s.title)).toEqual(expect.arrayContaining(["Proje Bilgileri", "İmzalar"]));
    const items = allItems(out.schema);
    expect(items[0]).toMatchObject({ label: "Proje", pdf: allItems(schema)[0]!.pdf });
    // A tick-box item stays yes / no even if the model says text.
    expect(items.find((i) => i.label === "Kalıp Temiz")!.type).toBe("yes_no");
    expect(out.kept).toBe(n - 3);
    expect(out.name).toBe("Beton Döküm Kontrol Formu");
    // A copied prompt placeholder is not taken as the form name.
    const copied = await nameFields(fakeProvider([JSON.stringify({ name: "Formun adı", fields: [{ n: 1, label: "Proje" }] })]), schema, "Beton Döküm");
    expect(copied.name).toBeNull();
  });
});

describe("flow from a description (mocked model)", () => {
  const schema: FormTemplateSchema = {
    sections: [
      {
        id: "b",
        title: "Genel",
        items: [
          { id: "proje", type: "text", label: "Proje Adı" },
          { id: "hazirlayan_imza", type: "signature", label: "Hazırlayan İmza" },
          { id: "kontrol_eden_imza", type: "signature", label: "Kontrol Eden İmza" },
        ],
      },
    ],
  };
  const ctx: FlowContext = {
    roles: [
      { id: "11111111-1111-4111-8111-111111111111", name: "Şantiye Şefi" },
      { id: "22222222-2222-4222-8222-222222222222", name: "Kalite Kontrol" },
    ],
    companies: [{ id: "33333333-3333-4333-8333-333333333333", name: "Müşavir A.Ş.", code: "MUS" }],
    members: [],
    schema,
    templateName: "Beton Döküm",
    description:
      "Formu şantiye şefi doldurur, kalite kontrol mühendisi kontrol eder; ret olursa yükleniciye geri döner; onaylanınca müşavire bilgi gider; 3 gün içinde cevap verilmeli; imza alanlarını onaylayan kişi doldurur",
  };
  const good = {
    name: "Beton Döküm Onay Akışı",
    filler: "Şantiye Şefi",
    steps: [{ who: "Kalite Kontrol Mühendisi", action: "kontrol", outcomes: ["Onay", "Ret"], onReject: "doldurana", days: 3, fields: [] }],
    notifyOnApproved: ["Müşavir"],
  };

  it("accepts a valid answer and flags unknown roles with suggestions", async () => {
    const fake = fakeProvider([JSON.stringify(good)]);
    const r = await generateFlow(fake, ctx);
    expect(r.repaired).toBe(false);
    expect(fake.calls[0]![1]!.content).toContain("kontrol_eden_imza: Kontrol Eden İmza [signature]");
    const step = r.flow.steps[0]!;
    expect(step).toMatchObject({ days: 3, rule: "any", outcomes: ["approved", "rejected"], formFields: ["kontrol_eden_imza"] });
    expect(step.outcomeOptions!.map((o) => o.label)).toEqual(["Onay", "Ret"]);
    expect(step.returnTo).toBeUndefined();
    expect(r.flow.chain.form!.fillers).toEqual([{ type: "role", id: ctx.roles[0]!.id }]);
    // "Kalite Kontrol Mühendisi" is not a project role: placeholder + suggestion "Kalite Kontrol".
    expect(step.assignees).toEqual([{ type: "role", id: "new:Kalite Kontrol Mühendisi" }]);
    const kk = r.unresolved.find((u) => u.name === "Kalite Kontrol Mühendisi")!;
    expect(kk.suggestions[0]).toMatchObject({ name: "Kalite Kontrol", assignee: { type: "role", id: ctx.roles[1]!.id } });
    // "Müşavir" matches the company "Müşavir A.Ş." only as a suggestion.
    expect(r.unresolved.find((u) => u.name === "Müşavir")!.suggestions[0]!.name).toBe("Müşavir A.Ş.");
    expect(r.lines[0]).toBe("1. Şantiye Şefi doldurur");
    expect(r.lines[1]).toBe("2. Kalite Kontrol Mühendisi kontrol eder (Onay → kapanır; Ret → 1. adıma döner) · 3 gün · Doldurur: Kontrol Eden İmza");
    expect(r.lines).toContain("Onaylanınca bilgi: Müşavir (?)");
  });

  it("repairs once with the validation errors, then gives up with a clear message", async () => {
    const fake = fakeProvider([JSON.stringify({ steps: [] }), JSON.stringify(good)]);
    const r = await generateFlow(fake, ctx);
    expect(r.repaired).toBe(true);
    expect(fake.calls[1]!.at(-1)!.content).toMatch(/geçersiz[\s\S]*steps/);

    const bad = fakeProvider(["metin, JSON yok", JSON.stringify({ steps: [{ who: "", onReject: 5 }] })]);
    await expect(generateFlow(bad, ctx)).rejects.toMatchObject({ status: 422, code: "ai_invalid_flow" });
  });

  it("assigns a step by a form item (by_attribute)", () => {
    const c = compileFlow(flowOutputSchema.parse({ steps: [{ who: { attribute: "Proje Adı", map: { A: "Kalite Kontrol" } }, outcomes: ["Onay", "Ret"] }] }), ctx);
    expect(c.problems).toEqual([]);
    expect(c.flow.steps[0]!.assignees).toEqual([]);
    expect(c.flow.steps[0]!.assigneeRule).toEqual({ type: "by_attribute", attribute: "proje", map: { A: [{ type: "role", id: ctx.roles[1]!.id }] } });
  });

  it("maps return paths to earlier steps only", () => {
    const out = flowOutputSchema.parse({
      steps: [
        { who: "Kalite Kontrol", outcomes: ["Onay", "İade"] },
        { who: "Proje Yöneticisi", action: "onay", outcomes: ["Onay", "Ret"], onReject: 2 },
      ],
    });
    const c = compileFlow(out, ctx);
    expect(c.problems).toEqual([]);
    expect(c.flow.steps[1]).toMatchObject({ returnTo: 0, assignees: [{ type: "role", id: "project_admin" }] });
    expect(formFlowLines(c.flow, c.names)[2]).toContain("Ret → 2. adıma döner");
    const wrong = compileFlow(flowOutputSchema.parse({ steps: [{ who: "Kalite Kontrol", onReject: 3 }] }), ctx);
    expect(wrong.problems.join(" ")).toContain("önceki");
  });
});

describe("PDF templates through the API", () => {
  let handle: DbHandle;
  let app: FastifyInstance;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(os.tmpdir(), "7dcde-formpdf-"));
    handle = await openDb("memory://");
    const storage = new LocalStorage(path.join(dataDir, "storage"));
    app = await buildApp({ db: handle.db, storage, jobs: new JobQueue(handle.db, storage), secretKey: Buffer.alloc(32, 5) });
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
      upload: async (url: string, fields: Record<string, string>, file: { name: string; data: Uint8Array }) => {
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

  let admin: Client;
  let sef: Client;
  let kk: Client;
  let musavir: Client;
  let pid: string;
  let sefRole: string;
  let kkRole: string;
  let musavirCo: string;
  let tid: string;
  let sourceId: string;
  let schema: FormTemplateSchema;

  it("sets up a project with roles", async () => {
    admin = client(await login("admin@7d.test"));
    musavirCo = (await admin.post("/companies", { name: "Müşavir Mühendislik", code: "MUS" })).body.id;
    const sefId = (await admin.post("/users", { email: "sef@x.test", name: "Şef Ali", password: PW })).body.id;
    const kkId = (await admin.post("/users", { email: "kk@x.test", name: "Kalite Ayşe", password: PW })).body.id;
    await admin.post("/users", { email: "mus@x.test", name: "Müşavir Can", password: PW, companyId: musavirCo });
    pid = (await admin.post("/projects", { code: "PKF", name: "Metro" })).body.id;
    for (const e of ["sef@x.test", "kk@x.test"]) expect((await admin.post(`/projects/${pid}/members`, { email: e })).status).toBe(200);
    expect((await admin.post(`/projects/${pid}/members`, { email: "mus@x.test", companyId: musavirCo })).status).toBe(200);
    sefRole = (await admin.post(`/projects/${pid}/roles`, { name: "Şantiye Şefi" })).body.id;
    kkRole = (await admin.post(`/projects/${pid}/roles`, { name: "Kalite Kontrol Mühendisi" })).body.id;
    expect((await admin.post(`/projects/${pid}/roles/${sefRole}/members/${sefId}`)).status).toBe(200);
    expect((await admin.post(`/projects/${pid}/roles/${kkRole}/members/${kkId}`)).status).toBe(200);
    sef = client(await login("sef@x.test"));
    kk = client(await login("kk@x.test"));
    musavir = client(await login("mus@x.test"));
  });

  it("uploads a PDF, keeps it as the template source and saves the detected draft", async () => {
    expect((await sef.upload(`/projects/${pid}/form-templates/pdf`, {}, { name: "form.pdf", data: await textLayerFormPdf() })).status).toBe(403);
    const bad = await admin.upload(`/projects/${pid}/form-templates/pdf`, {}, { name: "x.pdf", data: Buffer.from("merhaba") });
    expect(bad.status).toBe(400);
    const r = await admin.upload(`/projects/${pid}/form-templates/pdf`, {}, { name: "beton-dokum.pdf", data: await textLayerFormPdf() });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ level: "text", source: { pageCount: 1, level: "text", fileName: "beton-dokum.pdf" }, draft: { name: "Beton Döküm Kontrol Formu", code: "BDKF" } });
    expect(r.body.source.pages[0].content).toHaveLength(4);
    sourceId = r.body.source.id;
    const file = await sef.get(`/projects/${pid}/form-pdf-sources/${sourceId}/file`);
    expect(file.raw.headers["content-type"]).toBe("application/pdf");
    expect(file.raw.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");

    schema = r.body.draft.schema;
    // The editor marks the second signature required and keeps the rest as detected.
    const sig = byLabel(schema, "Kontrol Eden İmza");
    expect(sig.id).toBe("kontrol_eden_imza");
    sig.required = true;
    byLabel(schema, "Proje Adı").required = true;
    const saved = await admin.post(`/projects/${pid}/form-templates`, { code: "BDK", name: r.body.draft.name, schema, sourceId });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body).toMatchObject({ origin: "pdf", source: { id: sourceId }, versions: [{ version: 1, sourceId }] });
    tid = saved.body.id;
    expect(allItems(saved.body.schema).find((i: FormItem) => i.id === "proje_adi")!.pdf).toMatchObject({ page: 1 });
  });

  it("scanned upload returns the vision / OCR message and no fields", async () => {
    const r = await admin.upload(`/projects/${pid}/form-templates/pdf`, {}, { name: "tarama.pdf", data: await scannedPdf(PNG) });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ level: "scanned", candidates: [], vision: { available: false } });
    expect(r.body.messages.join(" ")).toContain("görüntü modeli");
  });

  it("saves a flow: unknown placeholders are refused, fields must exist, steps own fields", async () => {
    const step = {
      name: "Kalite Kontrol Mühendisi kontrol eder",
      assignees: [{ type: "role", id: kkRole }],
      rule: "any",
      days: 3,
      outcomeOptions: [
        { code: "ONAY", label: "Onay", kind: "approved" },
        { code: "RET", label: "Ret", kind: "rejected" },
      ],
      formFields: ["kontrol_eden_imza"],
    };
    const chain = { form: { fillers: [{ type: "role", id: sefRole }], notifyOnApproved: [{ type: "company", id: musavirCo }] } };
    const placeholder = await admin.put(`/projects/${pid}/form-templates/${tid}/flow`, {
      name: "Beton Onay Akışı",
      steps: [{ ...step, assignees: [{ type: "role", id: "new:Kalite Kontrol" }] }],
      chain,
    });
    expect(placeholder.status).toBe(400);
    expect(placeholder.body.message).toContain("Eşleşmemiş rol: Kalite Kontrol");
    const unknown = await admin.put(`/projects/${pid}/form-templates/${tid}/flow`, { name: "x", steps: [{ ...step, formFields: ["yok"] }], chain });
    expect(unknown.status).toBe(400);
    expect(unknown.body.message).toContain("Şablonda olmayan alan: yok");
    const ok = await admin.put(`/projects/${pid}/form-templates/${tid}/flow`, { name: "Beton Onay Akışı", steps: [step], chain });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.flow.lines).toEqual([
      "1. Şantiye Şefi doldurur",
      "2. Kalite Kontrol Mühendisi kontrol eder (Onay → kapanır; Ret → 1. adıma döner) · 3 gün · Doldurur: Kontrol Eden İmza",
      "Onaylanınca bilgi: Müşavir Mühendislik",
      "Durum: onaylanınca Kapalı; iade veya retle doldurana dönerse Taslak",
    ]);
    expect(ok.body.template.flowLines).toEqual(ok.body.flow.lines);
    const list = (await sef.get(`/projects/${pid}/form-templates`)).body;
    expect(list[0]).toMatchObject({ origin: "pdf", flowLines: expect.arrayContaining(["1. Şantiye Şefi doldurur"]) });
  });

  let fid: string;

  it("enforces field permissions per flow step on the server", async () => {
    // Only the filler role may start the form.
    expect((await kk.post(`/projects/${pid}/forms`, { templateId: tid })).status).toBe(403);
    const f = await sef.post(`/projects/${pid}/forms`, { templateId: tid, formDate: "2026-10-12" });
    expect(f.status, JSON.stringify(f.body)).toBe(200);
    fid = f.body.id;
    expect(f.body.reservedFields).toEqual({ kontrol_eden_imza: "2. adım: Kalite Kontrol Mühendisi kontrol eder" });
    expect(f.body.source).toMatchObject({ id: sourceId });

    // The filler cannot sign for the checker, neither by upload nor by value.
    const sigUp = await sef.upload(`/projects/${pid}/forms/${fid}/attachments`, { itemId: "kontrol_eden_imza" }, { name: "i.png", data: PNG });
    expect(sigUp.status).toBe(403);
    expect(sigUp.body.message).toContain("2. adım");
    const own = await sef.upload(`/projects/${pid}/forms/${fid}/attachments`, { itemId: "hazirlayan_imza" }, { name: "i.png", data: PNG });
    expect(own.status).toBe(200);
    const table = byLabel(schema, "Malzeme Listesi");
    const [c1, c2, c3] = table.columns!.map((c) => c.id);
    const rows = ["Çimento", "Kum", "Çakıl", "Su", "Katkı (Ğ)"].map((m, i) => ({ [c1!]: String(i + 1), [c2!]: m, [c3!]: (i + 1) * 1.5 }));
    const values = {
      proje_adi: "Ataşehir Şantiyesi ÇĞİÖŞÜ",
      [byLabel(schema, "Döküm Tarihi").id]: "2026-10-12",
      [byLabel(schema, "Döküm Yeri").id]: "B Blok 3. kat döşeme",
      [byLabel(schema, "Kalıp temizliği yapıldı mı?").id]: "yes",
      [byLabel(schema, "Donatı paspayı uygun mu?").id]: "no",
      [table.id]: rows,
      hazirlayan_imza: own.body.id,
    };
    const forged = await sef.patch(`/projects/${pid}/forms/${fid}`, { values: { ...values, kontrol_eden_imza: own.body.id } });
    expect(forged.status).toBe(403);
    expect(forged.body.message).toContain('"Kontrol Eden İmza" alanını 2. adım');
    // The reserved item is required, but not from the filler.
    const sub = await sef.post(`/projects/${pid}/forms/${fid}/submit`, { values });
    expect(sub.status, JSON.stringify(sub.body)).toBe(200);
    expect(sub.body.status).toBe("in_review");
    expect(sub.body.stepFields).toEqual([]);

    const mine = await kk.get(`/projects/${pid}/forms/${fid}`);
    expect(mine.body.stepFields).toEqual(["kontrol_eden_imza"]);
    expect(mine.body.workflow).toMatchObject({ canAct: true, options: [{ code: "ONAY", label: "Onay" }, { code: "RET", label: "Ret" }] });
    // Approving before signing: the step's required item is missing.
    const early = await kk.post(`/projects/${pid}/forms/${fid}/review`, { code: "ONAY" });
    expect(early.status).toBe(400);
    expect(early.body.message).toContain("Kontrol Eden İmza");
    // The checker may only change their own items; the filler may not use the step endpoint.
    expect((await kk.patch(`/projects/${pid}/forms/${fid}/step-values`, { values: { proje_adi: "Başka" } })).status).toBe(403);
    expect((await sef.patch(`/projects/${pid}/forms/${fid}/step-values`, { values: { kontrol_eden_imza: own.body.id } })).status).toBe(403);
    expect((await kk.upload(`/projects/${pid}/forms/${fid}/attachments`, { itemId: "hazirlayan_imza" }, { name: "i.png", data: PNG })).status).toBe(403);
    const sig = await kk.upload(`/projects/${pid}/forms/${fid}/attachments`, { itemId: "kontrol_eden_imza" }, { name: "i.png", data: PNG });
    expect(sig.status, JSON.stringify(sig.body)).toBe(200);
    const signed = await kk.patch(`/projects/${pid}/forms/${fid}/step-values`, { values: { ...mine.body.values, kontrol_eden_imza: sig.body.id } });
    expect(signed.status, JSON.stringify(signed.body)).toBe(200);
    expect(signed.body.values.kontrol_eden_imza).toBe(sig.body.id);
    const done = await kk.post(`/projects/${pid}/forms/${fid}/review`, { code: "ONAY", comment: "Uygun" });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toMatchObject({ status: "closed", lastOutcome: "approved" });
    expect((await kk.patch(`/projects/${pid}/forms/${fid}/step-values`, { values: {} })).status).toBe(409);
    // The consultant company is told.
    const notes = (await musavir.get("/notifications")).body;
    expect(notes.some((n: any) => n.kind === "form.info" && n.title.includes("onaylandı"))).toBe(true);
  });

  it("prints the filled form on the original PDF: values in place, Turkish letters, stamp and a table overflow page", async () => {
    const res = await kk.get(`/projects/${pid}/forms/${fid}/pdf`);
    expect(res.status).toBe(200);
    const bytes = new Uint8Array(res.raw.rawPayload);
    if (process.env.DUMP_PDF) (await import("node:fs")).writeFileSync(process.env.DUMP_PDF, bytes);
    const layout = await readPdfLayout(bytes);
    expect(layout.pageCount).toBe(2);
    const p1 = layout.pages[0]!.items;
    // The original text is still there.
    expect(find(p1, "BETON DÖKÜM KONTROL FORMU")).toHaveLength(1);
    const proje = byLabel(schema, "Proje Adı").pdf!;
    const v = find(p1, "Ataşehir Şantiyesi ÇĞİÖŞÜ")[0]!;
    expect(v).toBeTruthy();
    expect(v.x).toBeGreaterThanOrEqual(proje.x);
    expect(v.x).toBeLessThan(proje.x + 10);
    expect(v.y).toBeGreaterThan(proje.y);
    expect(v.y).toBeLessThanOrEqual(proje.y + proje.h + 1);
    // Date as dd.mm.yyyy inside the underscored blank.
    const date = byLabel(schema, "Döküm Tarihi").pdf!;
    const d = find(p1, "12.10.2026")[0]!;
    expect(d.x).toBeGreaterThanOrEqual(date.x);
    expect(d.y).toBeGreaterThan(date.y);
    // Table rows 1–3 in the grid (row 2 between y 435 and 455, column "Malzeme" x 100–380); rows 4–5 overflow.
    const kum = find(p1, "Kum")[0]!;
    expect(kum.x).toBeGreaterThan(100);
    expect(kum.x).toBeLessThan(380);
    expect(kum.y).toBeGreaterThan(435);
    expect(kum.y).toBeLessThan(455);
    expect(find(p1, "Su")).toHaveLength(0);
    const p2 = layout.pages[1]!.items;
    expect(find(p2, "Malzeme Listesi (devam, 4–5. satırlar)")).toHaveLength(1);
    expect(find(p2, "Katkı (Ğ)")).toHaveLength(1);
    // Approval stamp in the free bottom margin of page 1, form number in the top margin.
    const stamp = find(p1, "ONAY DAMGASI")[0]!;
    expect(stamp.y).toBeGreaterThan(600);
    expect(p1.some((i) => i.s.includes("Kalite Kontrol Mühendisi kontrol eder") && i.s.includes("Kalite Ayşe") && i.s.includes("Onay"))).toBe(true);
    expect(find(p1, "Form No: BDK-")[0]!.y).toBeLessThan(40);
  });

  it("keeps the source PDF on every template version", async () => {
    const t = (await admin.get(`/projects/${pid}/form-templates/${tid}`)).body;
    const next = structuredClone(t.schema);
    next.sections[0].items[0].label = "Projenin Adı";
    const v2 = await admin.put(`/projects/${pid}/form-templates/${tid}`, { code: t.code, name: t.name, schema: next, workflowTemplateId: t.workflowTemplateId });
    expect(v2.status, JSON.stringify(v2.body)).toBe(200);
    expect(v2.body).toMatchObject({ versionCreated: true, currentVersion: 2, origin: "pdf", source: { id: sourceId } });
    expect(v2.body.versions.map((x: any) => [x.version, x.sourceId])).toEqual([
      [2, sourceId],
      [1, sourceId],
    ]);
    expect((await admin.get(`/projects/${pid}/form-templates/${tid}/versions/1`)).body.sourceId).toBe(sourceId);
    // The used version keeps printing on its PDF.
    expect((await kk.get(`/projects/${pid}/forms/${fid}/pdf`)).status).toBe(200);
  });

  it("sends a rejection back to an earlier step in a new round", async () => {
    const flow = (await admin.get(`/projects/${pid}/form-templates/${tid}/flow`)).body.flow;
    const steps = [
      flow.steps[0],
      {
        name: "Proje Yöneticisi onaylar",
        assignees: [{ type: "role", id: "project_admin" }],
        rule: "any",
        days: 2,
        outcomeOptions: [
          { code: "ONAY", label: "Onay", kind: "approved" },
          { code: "RET", label: "Ret", kind: "rejected" },
        ],
        returnTo: 0,
      },
    ];
    const saved = await admin.put(`/projects/${pid}/form-templates/${tid}/flow`, { ...flow, steps });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.flow.lines[2]).toContain("Ret → 2. adıma döner");
    const f = (await sef.post(`/projects/${pid}/forms`, { templateId: tid })).body;
    const own = await sef.upload(`/projects/${pid}/forms/${f.id}/attachments`, { itemId: "hazirlayan_imza" }, { name: "i.png", data: PNG });
    expect((await sef.post(`/projects/${pid}/forms/${f.id}/submit`, { values: { proje_adi: "X", hazirlayan_imza: own.body.id } })).body.status).toBe("in_review");
    const sig = await kk.upload(`/projects/${pid}/forms/${f.id}/attachments`, { itemId: "kontrol_eden_imza" }, { name: "i.png", data: PNG });
    await kk.patch(`/projects/${pid}/forms/${f.id}/step-values`, { values: { kontrol_eden_imza: sig.body.id } });
    expect((await kk.post(`/projects/${pid}/forms/${f.id}/review`, { code: "ONAY" })).body.workflow.stepIndex).toBe(1);
    const back = await admin.post(`/projects/${pid}/forms/${f.id}/review`, { code: "RET", comment: "İmzayı yenileyin" });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(back.body).toMatchObject({ status: "in_review", lastOutcome: "rejected", workflow: { stepIndex: 0, status: "running" } });
    const again = (await kk.get(`/projects/${pid}/forms/${f.id}`)).body;
    expect(again.workflow.canAct).toBe(true);
    expect(again.stepFields).toEqual(["kontrol_eden_imza"]);
    expect((await kk.post(`/projects/${pid}/forms/${f.id}/review`, { code: "ONAY" })).body.workflow.stepIndex).toBe(1);
    expect((await admin.post(`/projects/${pid}/forms/${f.id}/review`, { code: "ONAY" })).body.status).toBe("closed");
  });

  it("picks the step's assignees from the form's own answer (by_attribute)", async () => {
    const t = await admin.post(`/projects/${pid}/form-templates`, {
      code: "DSP",
      name: "Disiplin kontrolü",
      schema: {
        sections: [
          {
            id: "g",
            title: "Genel",
            items: [
              { id: "disiplin", type: "choice", label: "Disiplin", options: ["Elektrik", "İnşaat"], required: true },
              { id: "not", type: "text", label: "Not" },
            ],
          },
        ],
      },
    });
    expect(t.status, JSON.stringify(t.body)).toBe(200);
    const flow = await admin.put(`/projects/${pid}/form-templates/${t.body.id}/flow`, {
      name: "Disipline göre kontrol",
      steps: [
        {
          name: "Disiplin sorumlusu kontrol eder",
          assignees: [],
          rule: "any",
          days: 1,
          outcomes: ["approved", "rejected"],
          assigneeRule: { type: "by_attribute", attribute: "disiplin", map: { Elektrik: [{ type: "role", id: kkRole }] } },
        },
      ],
    });
    expect(flow.status, JSON.stringify(flow.body)).toBe(200);
    expect(flow.body.flow.lines[1]).toContain("Disiplin sorumlusu kontrol eder");
    const ok = (await sef.post(`/projects/${pid}/forms`, { templateId: t.body.id })).body;
    const sub = await sef.post(`/projects/${pid}/forms/${ok.id}/submit`, { values: { disiplin: "Elektrik" } });
    expect(sub.status, JSON.stringify(sub.body)).toBe(200);
    expect(sub.body.status).toBe("in_review");
    expect((await kk.get(`/projects/${pid}/forms/${ok.id}`)).body.workflow.canAct).toBe(true);
    // No assignee for "İnşaat" and no fallback: refused, the form stays a draft.
    const none = (await sef.post(`/projects/${pid}/forms`, { templateId: t.body.id })).body;
    const bad = await sef.post(`/projects/${pid}/forms/${none.id}/submit`, { values: { disiplin: "İnşaat" } });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toContain("Disiplin");
    expect((await sef.get(`/projects/${pid}/forms/${none.id}`)).body).toMatchObject({ status: "draft", submittedAt: null });
  });

  it("generate endpoints answer 503 without AI", async () => {
    const flow = await admin.post(`/projects/${pid}/form-templates/flow/generate`, { description: "Formu şantiye şefi doldurur, kalite kontrol onaylar.", templateId: tid });
    expect(flow.status).toBe(503);
    expect(flow.body.error).toBe("ai_unavailable");
    const names = await admin.post(`/projects/${pid}/form-templates/name-fields`, { schema });
    expect(names.status).toBe(503);
  });
});

describe("filled AcroForm output", () => {
  it("fills and flattens the fields with Turkish text and ticks", async () => {
    const src = await acroFormPdf();
    const r = await analysePdfForm(src);
    const schema = candidatesToSchema(r.candidates);
    const id = (field: string) => allItems(schema).find((i) => i.pdf?.acroField === field)!.id;
    const out = await renderSourceFormPdf({
      projectCode: "PKF",
      projectName: "Metro",
      templateCode: "ISG",
      templateName: "İSG Saha Denetim Formu",
      templateVersion: 1,
      number: "PKF-ISG-0001",
      status: "closed",
      formDate: "2026-10-12",
      locationPath: null,
      createdByName: "Şef Ali",
      createdAt: new Date(),
      submittedByName: "Şef Ali",
      submittedAt: new Date(),
      score: null,
      schema,
      values: { [id("santiye_adi")]: "Ataşehir Şantiyesi", [id("denetim_tarihi")]: "2026-10-12", [id("baret")]: "yes", [id("hava")]: "Yağmurlu", [id("risk")]: "Orta", [id("notlar")]: "Çalışma alanı düzenli; ışıklandırma yeterli." },
      attachments: [],
      loadAttachment: async () => null,
      locationNames: new Map(),
      fileNames: new Map(),
      issueRefs: new Map(),
      sourceBytes: src,
      pages: r.pages,
      stamps: [{ step: "1. Doldurdu", person: "Şef Ali", date: "12.10.2026", result: "Gönderildi" }],
    });
    const doc = await PDFDocument.load(out);
    expect(doc.getForm().getFields()).toHaveLength(0);
    const items = (await readPdfLayout(out)).pages[0]!.items;
    const site = find(items, "Ataşehir Şantiyesi")[0]!;
    expect(site.x).toBeGreaterThan(139);
    expect(site.y).toBeGreaterThan(112);
    expect(site.y).toBeLessThan(130);
    expect(find(items, "12.10.2026").length).toBeGreaterThan(0);
    expect(find(items, "Orta")).toHaveLength(1);
    expect(items.some((i) => i.s.includes("Çalışma alanı"))).toBe(true);
  });
});
