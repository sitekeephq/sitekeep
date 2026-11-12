import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { ZipFile } from "yazl";
import * as XLSX from "xlsx";
import type { SheetPreviewDto, VersionPreviewDto } from "@sitekeep/shared";
import { buildApp } from "../../src/app/build-app.js";
import { hashPassword } from "../../src/core/security/auth.js";
import { openDb, type DbHandle } from "../../src/db/index.js";
import { users, versionPreviews, versionTexts } from "../../src/db/schema.js";
import { JobQueue } from "../../src/jobs/queue.js";
import { LocalStorage } from "../../src/core/platform/storage.js";
import { Converters, ConverterTimeoutError, findSoffice, type ProcessRunner } from "../../src/previews/converters.js";
import { officeText, pptxText } from "../../src/previews/office-text.js";
import { cleanDxfText, decodeText, dxfInfo, parseSheet } from "../../src/previews/preview-worker.js";
import { decodeScene } from "../../src/previews/scene-worker.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function zip(entries: Record<string, string>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const z = new ZipFile();
    for (const [name, body] of Object.entries(entries)) z.addBuffer(Buffer.from(body, "utf8"), name);
    z.end();
    const chunks: Buffer[] = [];
    z.outputStream.on("data", (c: Buffer) => chunks.push(c));
    z.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    z.outputStream.on("error", reject);
  });
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
function docx(paragraphs: string[]): Promise<Buffer> {
  const body = paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`).join("");
  return zip({ "word/document.xml": `<?xml version="1.0"?><w:document ${W}><w:body>${body}</w:body></w:document>` });
}

const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
function pptx(slides: { text: string; notes?: string }[]): Promise<Buffer> {
  const e: Record<string, string> = {};
  // Presentation order is reversed against the file numbers to check that the order is read.
  const ids = slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join("");
  e["ppt/presentation.xml"] = `<p:presentation xmlns:p="p" xmlns:r="${REL}"><p:sldIdLst>${ids}</p:sldIdLst></p:presentation>`;
  e["ppt/_rels/presentation.xml.rels"] =
    `<Relationships>${slides.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/slide" Target="slides/slide${slides.length - i}.xml"/>`).join("")}</Relationships>`;
  slides.forEach((s, i) => {
    const n = slides.length - i;
    e[`ppt/slides/slide${n}.xml`] = `<p:sld><p:sp><a:p><a:r><a:t>${s.text}</a:t></a:r></a:p></p:sp></p:sld>`;
    if (s.notes) {
      e[`ppt/slides/_rels/slide${n}.xml.rels`] =
        `<Relationships><Relationship Id="rId2" Type="${REL}/notesSlide" Target="../notesSlides/notesSlide${n}.xml"/></Relationships>`;
      e[`ppt/notesSlides/notesSlide${n}.xml`] =
        `<p:notes><p:sp><p:nvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr></p:sp>` +
        `<p:sp><p:nvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${s.notes}</a:t></a:r></a:p></p:txBody></p:sp></p:notes>`;
    }
  });
  return zip(e);
}

function xlsx(): Buffer {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ["Poz", "Tanım", "Miktar", "Tarih"],
    ["15.150", "Beton C30/37 döküm", 1234.5, 46096],
    ["15.160", "Kalıp", 10, null],
  ]);
  ws["C2"]!.z = "#,##0.00";
  ws["D2"]!.z = "m/d/yy";
  ws["C3"] = { t: "n", v: 20, f: "C2*0+20" };
  ws["!merges"] = [{ s: { r: 3, c: 0 }, e: { r: 3, c: 1 } }];
  ws["A4"] = { t: "s", v: "Toplam" };
  ws["!ref"] = "A1:D4";
  ws["!cols"] = [{ wch: 10 }, { wpx: 200 }];
  XLSX.utils.book_append_sheet(wb, ws, "Metraj");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["gizli"]]), "Gizli");
  wb.Workbook = { Sheets: [{ Hidden: 0 }, { Hidden: 1 }] };
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

/** Windows-1254 bytes of Turkish text (only the letters used here). */
function cp1254(s: string): Buffer {
  const map: Record<string, number> = { ı: 0xfd, İ: 0xdd, ş: 0xfe, Ş: 0xde, ğ: 0xf0, Ğ: 0xd0, ü: 0xfc, Ü: 0xdc, ö: 0xf6, Ö: 0xd6, ç: 0xe7, Ç: 0xc7 };
  return Buffer.from([...s].map((c) => map[c] ?? c.charCodeAt(0)));
}

function dxf(texts: { type: "TEXT" | "MTEXT"; value: string }[], header = "  9\n$ACADVER\n  1\nAC1015\n  9\n$DWGCODEPAGE\n  3\nANSI_1254\n"): string {
  const ents = texts.map((t) => `  0\n${t.type}\n  8\nYAZI\n 10\n0\n 20\n0\n 40\n2.5\n  1\n${t.value}\n`).join("");
  return `  0\nSECTION\n  2\nHEADER\n${header}  0\nENDSEC\n  0\nSECTION\n  2\nENTITIES\n${ents}  0\nENDSEC\n  0\nEOF\n`;
}

async function onePagePdf(text: string): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([595, 842]).drawText(text, { x: 50, y: 780, size: 12, font });
  doc.addPage([595, 842]);
  return Buffer.from(await doc.save());
}

// ---------------------------------------------------------------------------
// Pure parts
// ---------------------------------------------------------------------------

describe("office text", () => {
  it("reads docx paragraphs", async () => {
    const r = officeText(await docx(["Zemin etüdü raporu", "Kazık boyu 18 m &amp; çap 80 cm"]), "docx");
    expect(r?.text).toBe("Zemin etüdü raporu\nKazık boyu 18 m & çap 80 cm");
  });

  it("reads pptx slides in presentation order with speaker notes", async () => {
    const buf = await pptx([{ text: "Proje takvimi", notes: "Gecikmeleri anlat" }, { text: "Riskler" }]);
    const p = pptxText(buf);
    expect(p.slides).toEqual(["Proje takvimi", "Riskler"]);
    expect(p.notes).toEqual(["Gecikmeleri anlat", ""]);
    expect(officeText(buf, "pptx")?.text).toContain("Notlar: Gecikmeleri anlat");
  });

  it("returns null for binary formats", () => {
    expect(officeText(Buffer.from("not a zip"), "doc")).toBeNull();
    expect(officeText(Buffer.from("not a zip"), "docx")).toBeNull();
  });
});

describe("sheet parsing", () => {
  it("keeps values, Turkish number and date formats, merges, widths and hidden sheets", () => {
    const { data, text } = parseSheet(xlsx(), "xlsx");
    expect(data.sheets.map((s) => [s.name, s.hidden])).toEqual([
      ["Metraj", false],
      ["Gizli", true],
    ]);
    const s = data.sheets[0]!;
    expect(s.rows[0]).toEqual(["Poz", "Tanım", "Miktar", "Tarih"]);
    expect(s.rows[1]).toEqual(["15.150", "Beton C30/37 döküm", ["1.234,50"], ["15.03.2026"]]);
    expect(s.rows[2]![2]).toEqual(["20"]); // formula: cached value
    expect(s.rows[3]).toEqual(["Toplam"]);
    expect(s.merges).toEqual([{ r0: 3, c0: 0, r1: 3, c1: 1 }]);
    expect(s.colWidths[0]).toBeGreaterThan(55); // 10 characters (SheetJS gives pixels)
    expect(s.colWidths[0]).toBeLessThan(90);
    expect(s.colWidths[1]).toBe(200);
    expect(s.rowCount).toBe(4);
    expect(text).toContain("Beton C30/37 döküm");
    expect(text).not.toContain("gizli");
  });

  it("shows Turkish date formats SheetJS cannot format (dd.mm.yyyy)", () => {
    const ws = XLSX.utils.aoa_to_sheet([["Tarih", "Saat"]]);
    ws["A2"] = { t: "n", v: 46297, z: "dd.mm.yyyy" };
    ws["B2"] = { t: "n", v: 46297.5, z: "dd.mm.yyyy hh:mm" };
    ws["!ref"] = "A1:B2";
    const buf = XLSX.write({ SheetNames: ["S"], Sheets: { S: ws } }, { type: "buffer", bookType: "xlsx" }) as Buffer;
    expect(parseSheet(buf, "xlsx").data.sheets[0]!.rows[1]).toEqual([["02.10.2026"], ["02.10.2026 12:00"]]);
  });

  it("reads Windows-1254 CSV with semicolons", () => {
    const buf = cp1254("Kod;Açıklama;Tutar\nA1;Şap işçiliği;12,5\n");
    expect(decodeText(buf)).toContain("Şap işçiliği");
    const s = parseSheet(buf, "csv").data.sheets[0]!;
    expect(s.rows[1]).toEqual(["A1", "Şap işçiliği", ["12,5"]]);
  });

  it("handles 50 000 rows", () => {
    const rows = Array.from({ length: 50_000 }, (_, i) => [`R${i}`, i, i * 1.5, "x"]);
    const buf = XLSX.write({ SheetNames: ["S"], Sheets: { S: XLSX.utils.aoa_to_sheet(rows) } }, { type: "buffer", bookType: "xlsx" }) as Buffer;
    const s = parseSheet(buf, "xlsx").data.sheets[0]!;
    expect(s.rowCount).toBe(50_000);
    expect(s.rows[49_999]).toEqual(["R49999", ["49999"], ["74998,5"], "x"]);
  });
});

describe("DXF text", () => {
  it("decodes code page 1254 and MTEXT formatting", () => {
    const body = Buffer.concat([
      Buffer.from(dxf([{ type: "TEXT", value: "@@1" }, { type: "MTEXT", value: "{\\fArial|b1;KES\\U+0130T}\\PA-A %%c12" }]).split("@@1")[0]!, "latin1"),
      cp1254("Zemin Kat Planı"),
      Buffer.from(dxf([{ type: "TEXT", value: "@@1" }, { type: "MTEXT", value: "{\\fArial|b1;KES\\U+0130T}\\PA-A %%c12" }]).split("@@1")[1]!, "latin1"),
    ]);
    const info = dxfInfo(body);
    expect(info.encoding).toBe("windows-1254");
    expect(info.text.split("\n")).toEqual(["Zemin Kat Planı", "KESİT", "A-A Ø12"]);
  });

  it("treats R2007+ drawings as UTF-8 and cleans codes", () => {
    const info = dxfInfo(Buffer.from(dxf([{ type: "TEXT", value: "Çatı arası" }], "  9\n$ACADVER\n  1\nAC1027\n"), "utf8"));
    expect(info).toMatchObject({ encoding: "utf-8", text: "Çatı arası" });
    expect(cleanDxfText("\\A1;\\H2.5;Not\\~1 %%d")).toBe("Not 1 °");
  });
});

describe("converters", () => {
  it("auto-detection honours CDE_SOFFICE_PATH", () => {
    expect(findSoffice({ CDE_SOFFICE_PATH: path.join(os.tmpdir(), "yok", "soffice.exe") })).toBeNull();
  });

  it("times out a hanging converter", async () => {
    const hang: ProcessRunner = () => new Promise(() => undefined);
    const c = new Converters({ sofficePath: "soffice", runner: hang, timeoutMs: 50 });
    const input = path.join(os.tmpdir(), `7dcde-test-${Date.now()}.docx`);
    writeFileSync(input, "x");
    await expect(c.officeToPdf(input, "docx", `${input}.pdf`)).rejects.toBeInstanceOf(ConverterTimeoutError);
    rmSync(input, { force: true });
  });
});

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

const PW = "Viewer-Test-Password-1";
let dataDir: string;
let handle: DbHandle;
let jobs: JobQueue;
let app: FastifyInstance;
/** Mock converter behaviour for the next conversions. */
let mode: "ok" | "hang" | "missing" | "broken" | "civil" = "ok";
let pdfText = "Ofis belgesi";

/** Civil 3D drawing as LibreDWG writes it: AECC classes and an empty ENTITIES section. */
const CIVIL_DXF =
  "  0\nSECTION\n  2\nHEADER\n  9\n$ACADVER\n  1\nAC1024\n  0\nENDSEC\n  0\nSECTION\n  2\nCLASSES\n" +
  ["AECC_ALIGNMENT", "AECC_CORRIDOR", "AECC_TIN_SURFACE"].map((n) => `  0\nCLASS\n  1\n${n}\n  2\nAeccDb${n}\n  3\nAeccDb\n 90\n0\n`).join("") +
  "  0\nENDSEC\n  0\nSECTION\n  2\nENTITIES\n  0\nENDSEC\n  0\nEOF\n";

const runner: ProcessRunner = async (cmd, args, opts) => {
  if (mode === "hang") return new Promise(() => undefined);
  if (mode === "broken") return { code: 1, stdout: "", stderr: "Error: source file could not be loaded" };
  if (args.includes("--convert-to")) {
    const outDir = args[args.indexOf("--outdir") + 1]!;
    writeFileSync(path.join(outDir, "input.pdf"), await onePagePdf(pdfText));
    expect(args.some((a) => a.startsWith("-env:UserInstallation=file:"))).toBe(true);
  } else if (mode === "civil") {
    writeFileSync(args[args.indexOf("-o") + 1]!, CIVIL_DXF);
    return { code: 0, stdout: "", stderr: "ERROR: Invalid object type 512\n".repeat(300) };
  } else {
    const out = args[args.indexOf("-o") + 1]!;
    writeFileSync(out, dxf([{ type: "TEXT", value: "Aks A-1 kolon" }], "  9\n$ACADVER\n  1\nAC1032\n"));
  }
  expect(opts.timeoutMs).toBeGreaterThan(0);
  return { code: 0, stdout: "", stderr: "" };
};

const real = () => new Converters({ sofficePath: "soffice", dwg2dxfPath: "dwg2dxf", runner, timeoutMs: 200 });
const missing = new Converters({ sofficePath: null, dwg2dxfPath: null });
const converters = {
  officeToPdf: (...a: Parameters<Converters["officeToPdf"]>) => (mode === "missing" ? missing : real()).officeToPdf(...a),
  dwgToDxf: (...a: Parameters<Converters["dwgToDxf"]>) => (mode === "missing" ? missing : real()).dwgToDxf(...a),
  status: () => (mode === "missing" ? missing : real()).status(),
} as unknown as Converters;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "7dcde-viewers-"));
  handle = await openDb("memory://");
  const storage = new LocalStorage(path.join(dataDir, "storage"));
  jobs = new JobQueue(handle.db, storage);
  app = await buildApp({ db: handle.db, storage, jobs, converters });
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

describe("viewer API", () => {
  let cookie: string;
  let pid: string;
  let folderId: string;

  const call = async (method: "GET" | "POST", url: string, headers: Record<string, string> = {}) => {
    const res = await app.inject({ method, url: `/api/v1${url}`, headers: { cookie, ...headers }, ...(method === "POST" && { payload: {} }) });
    return res;
  };
  const upload = async (name: string, data: Buffer): Promise<string> => {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(data)]), name);
    const req = new Request("http://x", { method: "POST", body: form });
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/folders/${folderId}/files`,
      headers: { cookie, "content-type": req.headers.get("content-type")! },
      payload: Buffer.from(await req.arrayBuffer()),
    });
    expect(res.statusCode, res.body).toBe(200);
    const fileId = res.json().results[0].fileId as string;
    const file = (await call("GET", `/projects/${pid}/files/${fileId}`)).json();
    return file.latest.id as string;
  };
  const status = async (vid: string): Promise<VersionPreviewDto> => (await call("GET", `/projects/${pid}/versions/${vid}/preview`)).json();
  const preview = (s: VersionPreviewDto, kind: string) => s.previews.find((p) => p.kind === kind);

  beforeAll(async () => {
    cookie = await login("admin@7d.test");
    const p = await app.inject({ method: "POST", url: "/api/v1/projects", headers: { cookie }, payload: { code: "VWR", name: "Görüntüleyici", template: "empty" } });
    pid = p.json().id;
    const f = await app.inject({ method: "POST", url: `/api/v1/projects/${pid}/folders`, headers: { cookie }, payload: { parentId: p.json().rootFolderId, name: "Dokümanlar" } });
    folderId = f.json().id;
  });

  it("indexes docx text, then makes the page-layout PDF when a converter is configured", async () => {
    mode = "ok";
    pdfText = "Ofis belgesi";
    const vid = await upload("Zemin Etüdü.docx", await docx(["Zemin etüdü raporu", "Yeraltı suyu 4,5 m derinlikte"]));
    expect((await status(vid)).previews).toMatchObject([{ kind: "text", status: "pending" }]);
    await jobs.drain();
    const s = await status(vid);
    expect(s).toMatchObject({ viewer: "document", viewerLabel: "Belge", canDownload: true, canRequest: [], pdfConverter: true });
    expect(preview(s, "text")).toMatchObject({ status: "ready", error: null });
    expect(preview(s, "text")!.meta.textChars).toBeGreaterThan(20);
    expect(preview(s, "pdf")).toMatchObject({ status: "ready", error: null, meta: { pageCount: 2 } });

    const pdf = await call("GET", `/projects/${pid}/versions/${vid}/pdf`);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");
    const direct = await call("GET", `/projects/${pid}/versions/${vid}/preview/pdf`);
    expect(direct.statusCode).toBe(200);

    const search = (await call("GET", `/projects/${pid}/search?q=${encodeURIComponent("YERALTI SUYU")}`)).json();
    expect(search.results.map((r: { name: string }) => r.name)).toEqual(["Zemin Etüdü.docx"]);
    expect(search.results[0].snippet).toContain("Yeraltı suyu 4,5 m");
  });

  it("takes the text of a .doc from its PDF", async () => {
    mode = "ok";
    pdfText = "Eski format sozlesme maddesi";
    const vid = await upload("Sözleşme.doc", Buffer.from("binary doc"));
    await jobs.drain();
    expect(preview(await status(vid), "pdf")!.status).toBe("ready");
    const [t] = await handle.db.select().from(versionTexts).where(eq(versionTexts.versionId, vid));
    expect(t?.content).toContain("Eski format sozlesme maddesi");
  });

  it("keeps speaker notes of a presentation", async () => {
    mode = "ok";
    const vid = await upload("Sunum.pptx", await pptx([{ text: "Kapak", notes: "Hoş geldiniz" }, { text: "Plan" }]));
    await jobs.drain();
    const s = await status(vid);
    expect(s.viewer).toBe("slides");
    expect(preview(s, "text")!.meta.notes).toEqual(["Hoş geldiniz", ""]);
    expect(preview(s, "pdf")!.meta.notes).toEqual(["Hoş geldiniz", ""]);
  });

  it("works without any converter: office text and notes for search and Sor, originals for the browser viewers", async () => {
    mode = "missing";
    const odt = await upload("Teklif.odt", await zip({ "content.xml": "<office:document-content><text:p>Teklif mektubu</text:p></office:document-content>" }));
    const docxVid = await upload("Şartname.docx", await docx(["Çatı izolasyonu TPO membran 1,5 mm"]));
    const pptxVid = await upload("Vinç Sunumu.pptx", await pptx([{ text: "Kule vinç bakımı", notes: "Cuma günü" }]));
    await jobs.drain();
    for (const vid of [odt, docxVid, pptxVid]) {
      const s = await status(vid);
      // No PDF is queued without a converter: nothing "unavailable", nothing failed.
      expect(s.pdfConverter).toBe(false);
      expect(s.previews).toMatchObject([{ kind: "text", status: "ready", error: null }]);
      expect(s.canRequest).toEqual(["pdf"]);
      expect((await call("GET", `/projects/${pid}/versions/${vid}/pdf`)).statusCode).toBe(404);
    }
    expect(preview(await status(pptxVid), "text")!.meta.notes).toEqual(["Cuma günü"]);
    const [t] = await handle.db.select().from(versionTexts).where(eq(versionTexts.versionId, pptxVid));
    expect(t).toMatchObject({ source: "office" });
    expect(t!.content).toContain("Kule vinç bakımı");
    expect(t!.content).toContain("Notlar: Cuma günü");
    for (const q of ["teklif mektubu", "TPO MEMBRAN", "kule vinç"]) {
      const search = (await call("GET", `/projects/${pid}/search?q=${encodeURIComponent(q)}`)).json();
      expect(search.results.length, q).toBeGreaterThan(0);
    }
    // The browser viewers read the original file.
    const media = await call("GET", `/projects/${pid}/versions/${docxVid}/media`);
    expect(media.statusCode).toBe(200);
    expect(media.headers["content-type"]).toBe("application/octet-stream");
    expect(media.headers["content-security-policy"]).toContain("sandbox");
    expect(media.rawPayload.subarray(0, 2).toString()).toBe("PK");
    expect((await call("GET", `/projects/${pid}/versions/${pptxVid}/media`)).statusCode).toBe(200);

    // Asked for anyway: "unavailable" with the admin hint, not an error.
    let s = (await call("POST", `/projects/${pid}/versions/${odt}/preview/pdf`)).json() as VersionPreviewDto;
    await jobs.drain();
    s = await status(odt);
    expect(preview(s, "pdf")).toMatchObject({ status: "unavailable", error: null });
    expect(preview(s, "pdf")!.hint).toBeTruthy();

    // A converter configured later: the PDF is made on request.
    mode = "ok";
    s = (await call("POST", `/projects/${pid}/versions/${odt}/preview/pdf`)).json();
    expect(preview(s, "pdf")!.status).toBe("pending");
    expect(s.pdfConverter).toBe(true);
    await jobs.drain();
    expect(preview(await status(odt), "pdf")!.status).toBe("ready");
  });

  it("fails on timeout and on converter errors without crashing", async () => {
    mode = "hang";
    const v1 = await upload("Uzun.docx", await docx(["uzun"]));
    await jobs.drain();
    expect(preview(await status(v1), "pdf")).toMatchObject({ status: "failed", error: "Dönüşüm zaman aşımına uğradı." });
    // The text was read anyway.
    expect(preview(await status(v1), "text")!.status).toBe("ready");
    mode = "broken";
    const v2 = await upload("Bozuk.pptx", Buffer.from("bozuk"));
    await jobs.drain();
    const s = await status(v2);
    expect(preview(s, "pdf")!.status).toBe("failed");
    expect(preview(s, "pdf")!.error).toContain("source file could not be loaded");
    expect(s.canRequest).toEqual(["pdf"]);
  });

  it("builds a sheet preview and offers a PDF on demand", async () => {
    mode = "ok";
    const vid = await upload("Metraj.xlsx", xlsx());
    await jobs.drain();
    const s = await status(vid);
    expect(s).toMatchObject({ viewer: "sheet", canRequest: ["pdf"] });
    expect(s.previews[0]).toMatchObject({ kind: "sheet", status: "ready", meta: { sheets: ["Metraj", "Gizli"], truncated: false } });
    const res = await call("GET", `/projects/${pid}/versions/${vid}/preview/sheet`);
    expect(res.headers["content-encoding"]).toBe("gzip");
    const data = JSON.parse(gunzipSync(res.rawPayload).toString("utf8")) as SheetPreviewDto;
    expect(data.sheets[0]!.rows[1]![2]).toEqual(["1.234,50"]);
    const search = (await call("GET", `/projects/${pid}/search?q=c30%2F37`)).json();
    expect(search.results[0].name).toBe("Metraj.xlsx");

    await call("POST", `/projects/${pid}/versions/${vid}/preview/pdf`);
    await jobs.drain();
    expect((await status(vid)).previews.find((p) => p.kind === "pdf")?.status).toBe("ready");
    expect((await call("POST", `/projects/${pid}/versions/${vid}/preview/dxf`)).statusCode).toBe(400);
  });

  it("converts DWG to DXF and reads DXF text", async () => {
    mode = "ok";
    const dwg = await upload("Kat Planı.dwg", Buffer.from("AC1032 fake dwg"));
    await jobs.drain();
    const s = await status(dwg);
    expect(preview(s, "dxf")).toMatchObject({ status: "ready", meta: { encoding: "utf-8", repairs: 0 } });
    expect(preview(s, "dxf")!.meta.cad).toMatchObject({ status: "ok", entities: 1, converterErrors: 0 });
    const out = await call("GET", `/projects/${pid}/versions/${dwg}/preview/dxf`);
    expect(out.body).toContain("Aks A-1 kolon");

    // The prebuilt 2D scene follows the DXF: gzip container, ETag revalidation.
    expect(preview(s, "scene")).toMatchObject({ status: "ready", meta: { scene: { format: 1, model: null } } });
    expect(preview(s, "scene")!.meta.sceneModelKey).toBeUndefined();
    const sc = await call("GET", `/projects/${pid}/versions/${dwg}/preview/scene`);
    expect(sc.statusCode).toBe(200);
    expect(sc.headers["content-encoding"]).toBe("gzip");
    expect(sc.headers["cache-control"]).toBe("private, no-cache");
    const packed = gunzipSync(sc.rawPayload);
    expect(Number(sc.headers["x-scene-bytes"])).toBe(packed.length);
    const { scene, header } = decodeScene(packed);
    expect(scene.batches.length).toBeGreaterThan(0);
    expect(scene.hasMissingChars).toBe(false);
    expect(header.acadver).toBe("AC1032");
    const again = await call("GET", `/projects/${pid}/versions/${dwg}/preview/scene`, { "if-none-match": String(sc.headers.etag) });
    expect(again.statusCode).toBe(304);

    const dxfVid = await upload("Kesit.dxf", Buffer.from(dxf([{ type: "TEXT", value: "Döşeme kotu +3.50" }], "  9\n$ACADVER\n  1\nAC1027\n")));
    await jobs.drain();
    expect(preview(await status(dxfVid), "dxf")).toMatchObject({ status: "ready", meta: { original: true, encoding: "utf-8", repairs: 0 } });
    expect((await call("GET", `/projects/${pid}/versions/${dxfVid}/preview/dxf`)).body).toContain("Döşeme kotu");
    const search = (await call("GET", `/projects/${pid}/search?q=${encodeURIComponent("DÖŞEME KOTU")}`)).json();
    expect(search.results.map((r: { name: string }) => r.name)).toEqual(["Kesit.dxf"]);

    // A DXF written by LibreDWG 0.13 (a value broken over two lines) is repaired and stored as a derivative.
    const brokenDxf = dxf([{ type: "TEXT", value: "Kesit A-A@@Ölçek 1/50" }], "  9\n$ACADVER\n  1\nAC1027\n").replace("@@", "\n");
    const fixVid = await upload("Kesit 0.13.dxf", Buffer.from(brokenDxf));
    await jobs.drain();
    const fs1 = await status(fixVid);
    expect(preview(fs1, "dxf")).toMatchObject({ status: "ready", meta: { repairs: 1, cad: { status: "ok", entities: 1 } } });
    expect(preview(fs1, "dxf")!.meta.original).toBeUndefined();
    expect((await call("GET", `/projects/${pid}/versions/${fixVid}/preview/dxf`)).body).toContain("Kesit A-A Ölçek 1/50");
    expect(preview(fs1, "scene")).toMatchObject({ status: "ready" });

    // Civil 3D drawing: checked, no scene; the viewer shows its card.
    mode = "civil";
    const civil = await upload("Aliyman.dwg", Buffer.from("AC1024 civil"));
    await jobs.drain();
    const cs = await status(civil);
    expect(preview(cs, "dxf")).toMatchObject({ status: "ready", meta: { cad: { status: "civil3d", aeccClasses: 3, entities: 0, converterErrors: 300 } } });
    expect(preview(cs, "scene")).toBeUndefined();

    mode = "missing";
    const v2 = await upload("Diğer.dwg", Buffer.from("fake"));
    await jobs.drain();
    expect(preview(await status(v2), "dxf")).toMatchObject({ status: "unavailable" });
    expect(preview(await status(v2), "dxf")!.hint).toContain("dwg2dxf");
  });

  it("indexes PDF text and serves media with byte ranges", async () => {
    mode = "ok";
    const pdfVid = await upload("Rapor.pdf", await onePagePdf("Haftalik ilerleme raporu"));
    const mp4 = await upload("Şantiye.mp4", Buffer.from("0123456789"));
    await jobs.drain();
    expect((await status(pdfVid)).previews[0]).toMatchObject({ kind: "text", status: "ready", meta: { pageCount: 2 } });
    expect((await call("GET", `/projects/${pid}/search?q=ilerleme`)).json().results[0].name).toBe("Rapor.pdf");
    // The PDF endpoint serves the original PDF.
    expect((await call("GET", `/projects/${pid}/versions/${pdfVid}/pdf`)).rawPayload.length).toBeGreaterThan(100);

    expect((await status(mp4))).toMatchObject({ viewer: "video", previews: [] });
    const part = await call("GET", `/projects/${pid}/versions/${mp4}/media`, { range: "bytes=2-5" });
    expect(part.statusCode).toBe(206);
    expect(part.headers["content-range"]).toBe("bytes 2-5/10");
    expect(part.headers["content-type"]).toBe("video/mp4");
    expect(part.body).toBe("2345");
    expect((await call("GET", `/projects/${pid}/versions/${mp4}/media`, { range: "bytes=20-" })).statusCode).toBe(416);
    expect((await call("GET", `/projects/${pid}/versions/${mp4}/media`)).body).toBe("0123456789");
  });

  it("queues previews of older versions when first opened and shows unsupported files", async () => {
    mode = "ok";
    const vid = await upload("Ek.xlsx", xlsx());
    await handle.db.delete(versionPreviews).where(eq(versionPreviews.versionId, vid));
    expect((await status(vid)).previews).toMatchObject([{ kind: "sheet", status: "pending" }]);
    await jobs.drain();
    expect((await status(vid)).previews[0]!.status).toBe("ready");

    const rvt = await upload("Model.rvt", Buffer.from("rvt"));
    expect(await status(rvt)).toMatchObject({ viewer: "none", viewerLabel: "Önizleme yok", previews: [], canRequest: [] });
    expect((await call("GET", `/projects/${pid}/versions/${rvt}/media`)).statusCode).toBe(415);
    expect((await call("GET", `/projects/${pid}/versions/${rvt}/preview/nope`)).statusCode).toBe(404);
  });

  it("reports converter status to administrators", async () => {
    mode = "missing";
    const res = (await call("GET", "/admin/converters")).json();
    expect(res.soffice).toMatchObject({ available: false, path: null });
    expect(res.dwg2dxf.hint).toContain("CDE_DWG2DXF_PATH");
    mode = "ok";
  });
});
