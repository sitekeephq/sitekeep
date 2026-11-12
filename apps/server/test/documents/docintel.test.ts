import { hasManage } from "../helpers/modules.js"; // steps that create RFIs, letters or meetings need Manage
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { PDFDocument, StandardFonts, type PDFFont, type PDFPage } from "pdf-lib";
import {
  compareRevisions,
  normalizeRevision,
  revisionFromFileName,
  validateName,
  type AntetResult,
  type NamingStandard,
} from "@sitekeep/shared";
import { buildApp } from "../../src/app/build-app.js";
import { hashPassword } from "../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../src/db/index.js";
import { users } from "../../src/db/schema.js";
import { JobQueue } from "../../src/jobs/queue.js";
import { LocalStorage } from "../../src/core/platform/storage.js";
import { analyzeAntet, readLabel } from "../../src/docintel/antet.js";
import { extractPdfText } from "../../src/docintel/extract.js";
import { detectRevision, revisionWarnings } from "../../src/docintel/revision.js";
import { buildRegister, readHeading, refineRegisterWithAi } from "../../src/docintel/spec.js";
import { refineWithAi, suggestNaming, type ChatProvider, type SuggestInput } from "../../src/docintel/suggest.js";

// ---------------------------------------------------------------------------
// PDF fixtures (pdf-lib, standard Helvetica: WinAnsi letters only, so "TARIH" instead of "TARİH")
// ---------------------------------------------------------------------------

type Put = (text: string, x: number, y: number, size?: number) => void;

async function pdf(pages: { size: [number, number]; draw: (put: Put, page: PDFPage, font: PDFFont) => void }[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const p of pages) {
    const page = doc.addPage(p.size);
    p.draw((text, x, y, size = 8) => page.drawText(text, { x, y, size, font }), page, font);
  }
  return Buffer.from(await doc.save());
}

/** A3 landscape drawing with a title block bottom-right and a revision table above it. */
function drawing(opts: { rev: string; code?: string; sheetNo?: string; rows?: [string, string, string][]; note?: string }) {
  return pdf([
    {
      size: [1190, 842],
      draw: (put) => {
        put("ZEMIN KAT PLANI", 80, 780, 18);
        put("NOTLAR: Tüm ölçüler cm cinsindendir.", 80, 120, 8);
        if (opts.note) put(opts.note, 80, 100, 8);
        // Revision table (rows above the header).
        const rows = opts.rows ?? [
          ["P01", "01.02.2026", "ILK YAYIN"],
          ["P02", "15.03.2026", "YORUMLAR ISLENDI"],
        ];
        rows.forEach((r, i) => {
          const y = 262 + 12 * (i + 1);
          put(r[0], 862, y, 7);
          put(r[1], 900, y, 7);
          put(r[2], 970, y, 7);
        });
        put("REV", 862, 262, 6);
        put("TARIH", 900, 262, 6);
        put("ACIKLAMA", 970, 262, 6);
        // Title block.
        put("PROJE", 860, 230, 6);
        put("ZIRVE ANKARA VERI MERKEZI", 860, 218, 9);
        put("PAFTA ADI", 860, 196, 6);
        put("ZEMIN KAT PLANI", 860, 184, 10);
        put("AKS 1-5", 860, 172, 10);
        if (opts.code) put(`Çizim No: ${opts.code}`, 860, 140, 7);
        if (opts.sheetNo) put(`PAFTA NO: ${opts.sheetNo}`, 1040, 140, 7);
        put("ÖLÇEK", 860, 100, 6);
        put("1/50", 905, 100, 9);
        put("REV", 1000, 100, 6);
        put(opts.rev, 1000, 88, 10);
        put("TARIH", 1060, 100, 6);
        put("15.03.2026", 1060, 88, 9);
        put("ÇIZEN", 860, 60, 6);
        put("A. YILMAZ", 860, 50, 8);
        put("KONTROL", 960, 60, 6);
        put("B. KAYA", 960, 50, 8);
        put("ONAY", 1060, 60, 6);
        put("C. DEMIR", 1060, 50, 8);
      },
    },
  ]);
}

/** Two-page specification with numbered sections and submittal requirements. */
function specification() {
  const lines1 = [
    ["BÖLÜM 5 - BETON ISLERI", 12],
    ["5.1 Malzemeler", 11],
    ["Yüklenici, kullanilacak beton katkilarinin teknik föylerini ve kataloglarini idarenin onayina", 10],
    ["sunacaktir. Her beton sinifi için numune alinacak ve test raporlari kontrol mühendisine sunulacaktir.", 10],
    ["Beton dökümü hava sicakligi 5 derecenin altinda yapilmayacaktir.", 10],
    ["03 30 00 YERINDE DÖKME BETON", 12],
    ["Kalip ve iskele sistemleri için atölye çizimleri ve statik hesap raporu onaya sunulacaktir.", 10],
  ] as const;
  const lines2 = [
    ["MADDE 12 - Mekanik tesisat. Klima santrallerinin teknik föyleri onaya sunulacaktir.", 10],
    ["Yüklenici çalisma yöntemi için yöntem beyani hazirlayarak idareye sunacaktir.", 10],
    ["Tüm malzemeler onaya sunulacaktir.", 10],
  ] as const;
  const page = (lines: readonly (readonly [string, number])[], n: number) => ({
    size: [595, 842] as [number, number],
    draw: (put: Put) => {
      put("ZAVM Teknik Sartname", 60, 810, 8);
      lines.forEach(([t, s], i) => put(t, 50, 760 - i * 22, s));
      put(`Sayfa ${n}`, 280, 20, 8);
    },
  });
  return pdf([page(lines1, 1), page(lines2, 2)]);
}

const ZAVM: NamingStandard = {
  name: "Data Center Kodlama Sistemi",
  delimiter: "-",
  fields: [
    { name: "Proje", type: "list", values: [{ code: "ZAVM", description: "Zirve Ankara Veri Merkezi" }] },
    {
      name: "Firma",
      type: "list",
      values: [
        { code: "PAS", description: "Poyraz İnşaat" },
        { code: "CNS", description: "CNS" },
        { code: "HLL", description: "Hilal Müşavirlik" },
        { code: "ZRT", description: "Zirve Teknoloji" },
      ],
    },
    { name: "Hacim", type: "list", values: [{ code: "ZZ" }, { code: "XX" }] },
    { name: "Rol", type: "list", values: ["A", "S", "M", "E", "C", "L", "Z"].map((code) => ({ code })) },
    { name: "Kat", type: "list", values: ["ZZ", "XX", "00", "01", "02", "B1", "B2", "RF"].map((code) => ({ code })) },
    { name: "Alt Disiplin", type: "number", digits: 4 },
    { name: "Tip", type: "list", values: ["M3", "DR", "RP", "SP", "RI"].map((code) => ({ code })) },
    { name: "Aşama", type: "list", values: ["DE", "SD", "CD", "MC", "HO"].map((code) => ({ code })) },
    { name: "Numara", type: "number", digits: 4 },
  ],
};
const CODE = "ZAVM-CNS-ZZ-S-B1-0204-DR-SD-0012";

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

let handle: DbHandle;
let app: FastifyInstance;
let jobs: JobQueue;
let dataDir: string;
const PW = "Sifre-1234567";

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "7dcde-docintel-"));
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
    return { status: res.statusCode, body, raw: res };
  };
  const multipart = async (url: string, files: { name: string; data: Buffer }[], fields: Record<string, string> = {}) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    for (const f of files) form.append("file", new Blob([new Uint8Array(f.data)]), f.name);
    const req = new Request("http://x", { method: "POST", body: form });
    const res = await app.inject({
      method: "POST",
      url: `/api/v1${url}`,
      headers: { cookie, "content-type": req.headers.get("content-type")! },
      payload: Buffer.from(await req.arrayBuffer()),
    });
    return { status: res.statusCode, body: res.json() };
  };
  return {
    get: (u: string) => call("GET", u),
    post: (u: string, p?: unknown) => call("POST", u, p ?? {}),
    put: (u: string, p: unknown) => call("PUT", u, p),
    patch: (u: string, p: unknown) => call("PATCH", u, p),
    multipart,
  };
}

// ---------------------------------------------------------------------------
// Pure parts
// ---------------------------------------------------------------------------

describe("revision helpers", () => {
  it("parses and compares revision codes", () => {
    expect(normalizeRevision("P02")).toBe("P02");
    expect(normalizeRevision("c1")).toBe("C01");
    expect(normalizeRevision("Rev.B")).toBe("B");
    expect(normalizeRevision("Revizyon 2")).toBe("2");
    expect(normalizeRevision("R03")).toBe("R03");
    expect(normalizeRevision("1/50")).toBeNull();
    expect(compareRevisions("P02", "P01")).toBeGreaterThan(0);
    expect(compareRevisions("C01", "P05")).toBeGreaterThan(0);
    expect(compareRevisions("B", "C")).toBeLessThan(0);
    expect(compareRevisions("R03", "3")).toBe(0);
    expect(compareRevisions("P01", "B")).toBeNull();
  });

  it("finds revisions in file names", () => {
    expect(revisionFromFileName("Zemin kat_P02.pdf")?.value).toBe("P02");
    expect(revisionFromFileName("Kesit Rev.B.pdf")?.value).toBe("B");
    expect(revisionFromFileName("plan-R03.pdf")?.value).toBe("R03");
    expect(revisionFromFileName("rapor Revizyon 2.pdf")?.value).toBe("2");
    expect(revisionFromFileName("ZAVM-CNS-ZZ-S-B1-0204-DR-SD-0012.pdf")).toBeNull();
  });

  it("recognises labels with and without inline values (Turkish-aware)", () => {
    expect(readLabel("ÇİZİM NO")).toMatchObject({ key: "drawingNo", inline: null });
    expect(readLabel("Pafta Adı:")).toMatchObject({ key: "title", inline: null });
    expect(readLabel("Drawing No.: A-101")).toMatchObject({ key: "drawingNo", inline: "A-101" });
    expect(readLabel("ÖLÇEK 1/100")).toMatchObject({ key: "scale", inline: "1/100" });
    expect(readLabel("Alan: S20")).toMatchObject({ key: null, label: "Alan", inline: "S20" });
    expect(readLabel("Proje Ankara metrosu")).toBeNull();
  });

  it("recognises specification headings", () => {
    expect(readHeading("03 30 00 YERINDE DÖKME BETON")).toMatchObject({ code: "03 30 00" });
    expect(readHeading("Bölüm 5.2 Beton İşleri")).toMatchObject({ code: "Bölüm 5.2", title: "Beton İşleri" });
    expect(readHeading("MADDE 12 – Malzeme. Yüklenici sunacaktır.")).toMatchObject({ code: "Madde 12", title: "Malzeme", rest: "Yüklenici sunacaktır." });
    expect(readHeading("5.2.1 Kalıp İşleri")).toMatchObject({ code: "5.2.1" });
    expect(readHeading("Beton 28 günde 30 MPa dayanıma ulaşmalıdır.")).toBeNull();
  });
});

describe("title block extraction", () => {
  it("reads fields, confidence, the revision table and document codes", async () => {
    const out = await extractPdfText({ data: new Uint8Array(await drawing({ rev: "P02", code: CODE })) });
    const antet = analyzeAntet(out);
    const f = Object.fromEntries(antet.fields.map((x) => [x.key, x]));
    expect(antet.kind).toBe("drawing");
    expect(antet.region).not.toBeNull();
    expect(antet.region!.x0).toBeGreaterThan(800);
    expect(f.drawingNo).toMatchObject({ value: CODE, source: "inline" });
    expect(f.revision).toMatchObject({ value: "P02", source: "below" });
    expect(f.revision!.confidence).toBeGreaterThanOrEqual(0.8);
    expect(f.scale).toMatchObject({ value: "1/50", source: "right" });
    expect(f.date).toMatchObject({ value: "2026-03-15" });
    expect(f.title!.value).toBe("ZEMIN KAT PLANI AKS 1-5");
    expect(f.projectName!.value).toBe("ZIRVE ANKARA VERI MERKEZI");
    expect(f.drawnBy!.value).toBe("A. YILMAZ");
    expect(f.checkedBy!.value).toBe("B. KAYA");
    expect(f.approvedBy!.value).toBe("C. DEMIR");
    expect(antet.revisionTable).toEqual([
      { rev: "P01", date: "2026-02-01", description: "ILK YAYIN" },
      { rev: "P02", date: "2026-03-15", description: "YORUMLAR ISLENDI" },
    ]);
    expect(antet.codes).toContain(CODE);

    const rev = detectRevision(antet, "plan_P02.pdf");
    expect(rev).toMatchObject({ value: "P02", source: "antet" });
    expect(rev.confidence).toBeGreaterThan(0.9); // title block, table and file name agree
  });

  it("warns about inconsistent revisions", () => {
    const antet = { fields: [{ key: "revision", label: "REV", value: "P02", confidence: 0.9, source: "below", page: 1 }], revisionTable: [{ rev: "P03", date: null, description: null }] } as unknown as AntetResult;
    const info = detectRevision(antet, "plan_P01.pdf");
    const codes = revisionWarnings(info, { sha256: "b", version: 2 }, { version: 1, sha256: "a", revision: "P03" }, "P04").map((w) => w.code);
    expect(codes).toEqual(expect.arrayContaining(["revision_backwards", "table_mismatch", "name_mismatch", "attribute_mismatch"]));
  });
});

describe("naming suggestion", () => {
  const base = (antet: Partial<AntetResult>, fileName = "plan.pdf"): SuggestInput => ({
    standard: ZAVM,
    fileName,
    antet: { page: 1, pageCount: 1, pageSize: { width: 1190, height: 842 }, region: null, fields: [], pairs: [], revisionTable: [], codes: [], hasText: true, kind: "drawing", ...antet },
    revision: { value: "P02", source: "antet", confidence: 0.9, candidates: [{ value: "P02", source: "antet", raw: "REV: P02" }] },
    folderNames: ["ZAVM", "WIP", "Statik"],
    attributeDefs: [
      { name: "Revizyon", type: "text" },
      { name: "Pafta Adı", type: "text" },
      { name: "Tarih", type: "date" },
    ],
  });

  it("takes a validating document code from the title block and fills attributes", () => {
    const s = suggestNaming(
      base({
        fields: [
          { key: "drawingNo", label: "Çizim No", value: CODE, confidence: 0.9, source: "inline", page: 1 },
          { key: "title", label: "Pafta Adı", value: "ZEMİN KAT PLANI", confidence: 0.85, source: "below", page: 1 },
          { key: "date", label: "Tarih", value: "2026-03-15", confidence: 0.9, source: "below", page: 1 },
        ],
      }),
    );
    expect(s).toMatchObject({ ok: true, name: `${CODE}.pdf`, unchanged: false });
    expect(validateName(ZAVM, s.name!).ok).toBe(true);
    expect(s.fields.find((f) => f.field === "Alt Disiplin")).toMatchObject({ value: "0204", source: "code" });
    expect(s.fields.find((f) => f.field === "Alt Disiplin")!.explanation).toContain(`Antetteki 'Çizim No: ${CODE}'`);
    expect(Object.fromEntries(s.attributes.map((a) => [a.name, a.value]))).toEqual({
      Revizyon: "P02",
      "Pafta Adı": "ZEMİN KAT PLANI",
      Tarih: "2026-03-15",
    });
  });

  it("maps fields one by one (codes, Turkish descriptions, numbers, single values) and never invents values", () => {
    const s = suggestNaming(
      base(
        {
          fields: [
            { key: "company", label: "Yüklenici", value: "POYRAZ İNŞAAT", confidence: 0.8, source: "right", page: 1 },
            { key: "sheetNo", label: "Pafta No", value: "S-204", confidence: 0.8, source: "inline", page: 1 },
          ],
          pairs: [
            { label: "Kat", value: "B1", key: null },
            { label: "Tip", value: "DR", key: null },
            { label: "Aşama", value: "SD", key: null },
          ],
        },
        "eski ad.pdf",
      ),
    );
    const v = Object.fromEntries(s.fields.map((f) => [f.field, f.value]));
    expect(v).toMatchObject({ Proje: "ZAVM", Firma: "PAS", Kat: "B1", Tip: "DR", Aşama: "SD" });
    expect(s.fields.find((f) => f.field === "Firma")!.explanation).toBe("Antetteki 'Yüklenici: POYRAZ İNŞAAT' → Firma PAS");
    expect(s.fields.find((f) => f.field === "Proje")!.source).toBe("single");
    // One number for two number fields and nothing for Hacim: no name is invented.
    expect(s.fields.find((f) => f.field === "Alt Disiplin")).toMatchObject({ ambiguous: true, alternatives: ["0204"] });
    expect(s.fields.find((f) => f.field === "Hacim")!.value).toBeNull();
    expect(s.ok).toBe(false);
    expect(s.name).toBeNull();
    expect(s.errors.join(" ")).toContain("Hacim");
  });

  const ambiguous = () =>
    base({
      fields: [
        { key: "company", label: "Firma", value: "CNS", confidence: 0.8, source: "right", page: 1 },
        { key: "drawingNo", label: "Çizim No", value: "S-204-012", confidence: 0.8, source: "inline", page: 1 },
      ],
      pairs: [
        { label: "Kat", value: "B1", key: null },
        { label: "Tip", value: "DR", key: null },
        { label: "Aşama", value: "SD", key: null },
        { label: "Rol", value: "S", key: null },
      ],
    });

  it("uses a language model only for open fields and keeps its answer when the name validates", async () => {
    const input = ambiguous();
    const det = suggestNaming(input);
    expect(det.fields.find((f) => f.field === "Alt Disiplin")).toMatchObject({ value: "0204" });
    expect(det.fields.find((f) => f.field === "Numara")).toMatchObject({ value: "0012" });
    expect(det.fields.find((f) => f.field === "Hacim")!.value).toBeNull();
    let prompt = "";
    const fake: ChatProvider = {
      chat: async (messages) => {
        prompt = messages.map((m) => m.content).join("\n");
        return { text: '```json\n{"Hacim": "ZZ"}\n```', toolCalls: [], model: "fake", stopReason: "stop" };
      },
    };
    const s = await refineWithAi(fake, input, det);
    expect(prompt).toContain('"ad":"Hacim"');
    expect(prompt).not.toContain('"ad":"Kat"'); // decided fields are not sent
    expect(s).toMatchObject({ ok: true, name: "ZAVM-CNS-ZZ-S-B1-0204-DR-SD-0012.pdf", ai: { used: true, accepted: true } });
    expect(s.fields.find((f) => f.field === "Hacim")).toMatchObject({ value: "ZZ", source: "ai" });
  });

  it("rejects a language-model answer with values outside the standard", async () => {
    const input = ambiguous();
    const det = suggestNaming(input);
    const fake: ChatProvider = { chat: async () => ({ text: '{"Hacim": "QQ"}', toolCalls: [], model: "fake", stopReason: "stop" }) };
    const s = await refineWithAi(fake, input, det);
    expect(s.ai).toMatchObject({ used: true, accepted: false });
    expect(s.name).toBeNull();
    expect(s.fields.find((f) => f.field === "Hacim")!.value).toBeNull();
    const garbage: ChatProvider = { chat: async () => ({ text: "Bilmiyorum.", toolCalls: [], model: "fake", stopReason: "stop" }) };
    expect((await refineWithAi(garbage, input, det)).ai).toMatchObject({ used: true, accepted: false });
  });
});

describe("specification → submittal register", () => {
  it("finds sections and requirements deterministically", async () => {
    const out = await extractPdfText({ data: new Uint8Array(await specification()) }, { maxPages: 50 });
    const { items, sectionCount } = buildRegister(out);
    expect(sectionCount).toBe(4);
    const by = (t: string | null) => items.filter((i) => i.type === t);
    expect(by("MOS")[0]).toMatchObject({ sectionCode: "5.1", page: 1, discipline: "INS" });
    expect(by("MOS")[0]!.excerpt).toContain("teknik föylerini");
    expect(by("NUM")[0]).toMatchObject({ sectionCode: "5.1" });
    expect(by("UCZ")[0]).toMatchObject({ sectionCode: "03 30 00", sectionTitle: "YERINDE DÖKME BETON" });
    expect(by("MOS")[1]).toMatchObject({ sectionCode: "Madde 12", sectionTitle: "Mekanik tesisat", page: 2, discipline: "MEK" });
    expect(by("YB")[0]).toMatchObject({ page: 2 });
    expect(by(null)).toHaveLength(1);
    expect(items.some((i) => i.excerpt.includes("hava sicakligi"))).toBe(false);
    expect(items.map((i) => i.id)).toEqual(items.map((_, k) => `S${String(k + 1).padStart(3, "0")}`));
  });

  it("lets a language model type only the open items and ignores unknown types", async () => {
    const out = await extractPdfText({ data: new Uint8Array(await specification()) }, { maxPages: 50 });
    const { items } = buildRegister(out);
    const open = items.find((i) => !i.type)!;
    const fake: ChatProvider = {
      chat: async () => ({ text: JSON.stringify({ [open.id]: { tip: "MOS", ozet: "Malzeme onayı" }, S001: { tip: "XYZ" } }), toolCalls: [], model: "fake", stopReason: "stop" }),
    };
    const r = await refineRegisterWithAi(fake, items);
    expect(r.items.find((i) => i.id === open.id)).toMatchObject({ type: "MOS", aiAssisted: true, description: "Malzeme onayı" });
    expect(r.items.find((i) => i.id === "S001")!.type).toBe(items[0]!.type);
  });
});

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

describe("document intelligence API", () => {
  let admin: ReturnType<typeof api>;
  let pid: string;
  let folderId: string;
  let plainFolderId: string;
  let fileId: string;

  it("sets up a project with the ZAVM standard and attributes", async () => {
    admin = api(await login("admin@7d.test"));
    const p = await admin.post("/projects", { code: "ZAVM", name: "Zirve", template: "empty" });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    pid = p.body.id;
    const f = await admin.post(`/projects/${pid}/folders`, { parentId: p.body.rootFolderId, name: "Paylaşılan" });
    folderId = f.body.id;
    plainFolderId = (await admin.post(`/projects/${pid}/folders`, { parentId: p.body.rootFolderId, name: "Teknik Şartnameler" })).body.id;
    const s = await admin.post(`/projects/${pid}/naming-standards`, ZAVM);
    expect(s.status).toBe(200);
    expect((await admin.patch(`/projects/${pid}/folders/${folderId}`, { namingStandardId: s.body.id })).status).toBe(200);
    const ids: string[] = [];
    for (const d of [
      { name: "Revizyon", type: "text" },
      { name: "Pafta Adı", type: "text" },
    ])
      ids.push((await admin.post(`/projects/${pid}/attribute-definitions`, d)).body.id);
    expect((await admin.put(`/projects/${pid}/folders/${folderId}/attribute-bindings`, { definitionIds: ids })).status).toBe(200);
  });

  it("suggests a valid name from the title block before upload (nothing stored)", async () => {
    const data = await drawing({ rev: "P02", code: CODE });
    const r = await admin.multipart(`/projects/${pid}/docintel/suggest?folderId=${folderId}`, [
      { name: "zemin kat_P02.pdf", data },
      { name: "notlar.txt", data: Buffer.from("x") },
    ]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.standard.name).toBe(ZAVM.name);
    expect(r.body.aiAvailable).toBe(false);
    const [pdfRes, txt] = r.body.results;
    expect(pdfRes.suggestion).toMatchObject({ ok: true, name: `${CODE}.pdf` });
    expect(pdfRes.revision).toMatchObject({ value: "P02", source: "antet" });
    expect(pdfRes.suggestion.attributes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Revizyon", value: "P02" }),
        expect.objectContaining({ name: "Pafta Adı", value: "ZEMIN KAT PLANI AKS 1-5" }),
      ]),
    );
    expect(txt).toMatchObject({ ok: true, antet: null });
    const files = await admin.get(`/projects/${pid}/folders/${folderId}/contents`);
    expect(files.body.files).toHaveLength(0);
  });

  it("extracts uploaded PDFs in the background and warns about revisions", async () => {
    const v1 = await drawing({ rev: "P02", code: CODE });
    const up = await admin.multipart(`/projects/${pid}/folders/${folderId}/files`, [{ name: `${CODE}.pdf`, data: v1 }], {
      attributes: JSON.stringify({ Revizyon: "P02" }),
    });
    expect(up.status, JSON.stringify(up.body)).toBe(200);
    fileId = up.body.results[0].fileId;
    await jobs.drain();
    let file = (await admin.get(`/projects/${pid}/files/${fileId}`)).body;
    let d = await admin.get(`/projects/${pid}/versions/${file.latest.id}/docintel`);
    expect(d.status).toBe(200);
    expect(d.body).toMatchObject({ status: "done", warnings: [], suggestion: { ok: true, unchanged: true } });
    expect(d.body.antet.fields.find((x: any) => x.key === "revision").value).toBe("P02");

    // Same bytes again.
    await admin.multipart(`/projects/${pid}/folders/${folderId}/files`, [{ name: `${CODE}.pdf`, data: v1 }]);
    // Changed content, same revision.
    await admin.multipart(`/projects/${pid}/folders/${folderId}/files`, [{ name: `${CODE}.pdf`, data: await drawing({ rev: "P02", code: CODE, note: "Kolon ölçüleri güncellendi." }) }]);
    // Revision goes back.
    await admin.multipart(`/projects/${pid}/folders/${folderId}/files`, [
      { name: `${CODE}.pdf`, data: await drawing({ rev: "P01", code: CODE, rows: [["P01", "01.02.2026", "ILK YAYIN"]] }) },
    ]);
    await jobs.drain();
    file = (await admin.get(`/projects/${pid}/files/${fileId}`)).body;
    const codes = async (version: number) => {
      const v = file.versions.find((x: any) => x.version === version);
      return (await admin.get(`/projects/${pid}/versions/${v.id}/docintel`)).body.warnings.map((w: any) => w.code);
    };
    expect(await codes(2)).toContain("same_content");
    expect(await codes(3)).toContain("same_revision_changed");
    const latest = await codes(4);
    expect(latest).toContain("revision_backwards");
    expect(latest).toContain("attribute_mismatch"); // attribute still says P02

    // On demand re-extraction.
    const again = await admin.post(`/projects/${pid}/versions/${file.latest.id}/docintel/extract`);
    expect(again.body.status).toBe("pending");
    await jobs.drain();
    d = await admin.get(`/projects/${pid}/versions/${file.latest.id}/docintel`);
    expect(d.body.status).toBe("done");
    // Without a configured provider the AI path answers 400, the deterministic one works.
    expect((await admin.post(`/projects/${pid}/versions/${file.latest.id}/docintel/suggest`, { ai: true })).status).toBe(400);
    expect((await admin.post(`/projects/${pid}/versions/${file.latest.id}/docintel/suggest`, {})).body.ok).toBe(true);
  });

  it.skipIf(!hasManage)("builds, edits and exports a submittal register from a specification", async () => {
    const up = await admin.multipart(`/projects/${pid}/folders/${plainFolderId}/files`, [{ name: "Beton Sartnamesi.pdf", data: await specification() }]);
    expect(up.status).toBe(200);
    await jobs.drain();
    const file = (await admin.get(`/projects/${pid}/files/${up.body.results[0].fileId}`)).body;
    const d = await admin.get(`/projects/${pid}/versions/${file.latest.id}/docintel`);
    expect(d.body.specLike).toBe(true);
    const reg = await admin.post(`/projects/${pid}/docintel/spec-register`, { versionId: file.latest.id });
    expect(reg.status, JSON.stringify(reg.body)).toBe(200);
    expect(reg.body.items.length).toBeGreaterThanOrEqual(6);
    expect(reg.body).toMatchObject({ fileName: "Beton Sartnamesi.pdf", sectionCount: 4, pageCount: 2, usedAi: false });
    const list = await admin.get(`/projects/${pid}/docintel/spec-registers`);
    expect(list.body).toHaveLength(1);

    const items = reg.body.items.map((i: any) => (i.type ? i : { ...i, type: "BAS" }));
    items[0].excluded = true;
    const put = await admin.put(`/projects/${pid}/docintel/spec-registers/${reg.body.id}`, { items });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body.items.some((i: any) => i.type === null)).toBe(false);
    const bad = await admin.put(`/projects/${pid}/docintel/spec-registers/${reg.body.id}`, { items: [{ ...items[1], type: "XYZ" }] });
    expect(bad.status).toBe(400);

    const csv = await admin.get(`/projects/${pid}/docintel/spec-registers/${reg.body.id}/export?format=csv`);
    expect(csv.raw.headers["content-type"]).toContain("text/csv");
    expect(csv.raw.body.startsWith("﻿No;Bölüm Kodu;")).toBe(true);
    expect(csv.raw.body.split("\r\n").filter(Boolean)).toHaveLength(items.length); // header + rows − excluded
    const xlsx = await admin.get(`/projects/${pid}/docintel/spec-registers/${reg.body.id}/export?format=xlsx`);
    expect(xlsx.raw.rawPayload.subarray(0, 2).toString()).toBe("PK");
    const json = await admin.get(`/projects/${pid}/docintel/spec-registers/${reg.body.id}/export?format=json`);
    expect(json.body.items[0]).toHaveProperty("excerpt");
  });

  it("hides document intelligence from members without access", async () => {
    await admin.post("/users", { email: "osman@7d.test", name: "Osman", password: PW });
    await admin.post(`/projects/${pid}/members`, { email: "osman@7d.test", isProjectAdmin: false });
    const osman = api(await login("osman@7d.test"));
    const file = (await admin.get(`/projects/${pid}/files/${fileId}`)).body;
    expect((await osman.get(`/projects/${pid}/versions/${file.latest.id}/docintel`)).status).toBe(404);
    expect((await osman.get(`/projects/${pid}/docintel/spec-registers`)).body).toEqual([]);
    const r = await osman.multipart(`/projects/${pid}/docintel/suggest?folderId=${folderId}`, [{ name: "a.pdf", data: Buffer.from("%PDF") }]);
    expect([403, 404]).toContain(r.status);
  });
});
