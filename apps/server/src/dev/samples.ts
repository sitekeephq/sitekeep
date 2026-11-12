/**
 * Generated sample files for the developer tools: an A3 PDF drawing with a title block and revision
 * table, a text-layer PDF form, DOCX, XLSX, PPTX, DXF and the small IFC models of the test fixtures.
 * Nothing is read from outside the repository's test fixtures unless a caller passes a path.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { ZipFile } from "yazl";
import { pdfFontBytes } from "../core/formats/pdf-fonts.js";
import { writeXlsx } from "../core/formats/xlsx.js";

const here = path.dirname(fileURLToPath(import.meta.url));
/** apps/server/test/fixtures (from src/dev or dist/dev). */
export const FIXTURES_DIR = path.resolve(here, "../../test/fixtures");

export type SampleKind = "pdf_drawing" | "pdf_form" | "docx" | "xlsx" | "pptx" | "dxf" | "ifc" | "ifc_v2";

export interface Sample {
  name: string;
  data: Buffer;
}

async function withFont(): Promise<{ doc: PDFDocument; font: PDFFont; bold: PDFFont }> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const f = pdfFontBytes();
  if (!f) throw new Error("PDF fonts missing");
  return { doc, font: await doc.embedFont(f.regular, { subset: true }), bold: await doc.embedFont(f.bold, { subset: true }) };
}

const REV_ROWS: [string, string, string][] = [
  ["A", "02.02.2026", "İlk yayın"],
  ["B", "01.03.2026", "Müşavir görüşleri işlendi"],
  ["C", "05.04.2026", "Kolon ölçüleri güncellendi"],
  ["D", "10.05.2026", "Uygulama için revize"],
];

/** A3 drawing; later revisions change a column size and add a note (good for doc compare). */
export async function pdfDrawing(o: { title?: string; number?: string; revision?: string; project?: string } = {}): Promise<Buffer> {
  const rev = (o.revision ?? "A").toUpperCase();
  const revIndex = Math.max(0, REV_ROWS.findIndex((r) => r[0] === rev[0]));
  const { doc, font, bold } = await withFont();
  const page = doc.addPage([1190, 842]);
  const put = (text: string, x: number, y: number, size = 8, f: PDFFont = font) => page.drawText(text, { x, y, size, font: f });
  const title = o.title ?? "ZEMİN KAT PLANI";
  put(title, 80, 780, 18, bold);
  put("NOTLAR: Tüm ölçüler cm cinsindendir.", 80, 140);
  put(`KOLON S12 ${revIndex >= 2 ? "50x60" : "40x60"}`, 300, 500, 10);
  put("KİRİŞ K101 30x60", 300, 460, 10);
  if (revIndex >= 1) put("NOT 4: Döşeme kotu +0.15 olarak güncellendi.", 80, 120);
  // Revision table + title block (bottom right).
  page.drawRectangle({ x: 850, y: 40, width: 320, height: 300, borderColor: rgb(0, 0, 0), borderWidth: 1 });
  put("REV", 862, 262, 6);
  put("TARİH", 900, 262, 6);
  put("AÇIKLAMA", 970, 262, 6);
  REV_ROWS.slice(0, revIndex + 1).forEach((r, i) => {
    const y = 262 + 12 * (i + 1);
    put(r[0], 862, y, 7);
    put(r[1], 900, y, 7);
    put(r[2], 970, y, 7);
  });
  put("PROJE", 860, 230, 6);
  put(o.project ?? "DEMO KONUT PROJESİ", 860, 218, 9, bold);
  put("PAFTA ADI", 860, 196, 6);
  put(title, 860, 184, 10, bold);
  put(`Çizim No: ${o.number ?? "A-102"}`, 860, 140, 7);
  put("ÖLÇEK", 860, 100, 6);
  put("1/50", 905, 100, 9);
  put("REV", 1000, 100, 6);
  put(rev, 1000, 88, 10, bold);
  put("TARİH", 1060, 100, 6);
  put(REV_ROWS[revIndex]![1], 1060, 88, 9);
  put("ÇİZEN", 860, 60, 6);
  put("Z. ARSLAN", 860, 50, 8);
  return Buffer.from(await doc.save());
}

/** Text-layer form: dotted blanks, Evet/Hayır boxes, a table and signature lines (PDF'ten Şablon). */
export async function pdfForm(): Promise<Buffer> {
  const { doc, font, bold } = await withFont();
  const page: PDFPage = doc.addPage([595, 842]);
  const put = (t: string, x: number, y: number, size = 10, f: PDFFont = font) => page.drawText(t, { x, y, size, font: f });
  put("BETON DÖKÜM KONTROL FORMU", 150, 790, 16, bold);
  put("GENEL BİLGİLER", 50, 750, 12, bold);
  put("Proje Adı: ..............................................", 50, 725);
  put("Tarih: ..........................", 50, 705);
  put("Döküm Yeri: ..............................................", 50, 685);
  put("KONTROLLER", 50, 650, 12, bold);
  const box = (x: number, y: number) => page.drawRectangle({ x, y, width: 9, height: 9, borderColor: rgb(0, 0, 0), borderWidth: 0.8 });
  ["Kalıp temiz ve ıslatılmış", "Donatı paspayları uygun", "Vibratör hazır"].forEach((t, i) => {
    const y = 625 - i * 22;
    put(t, 50, y);
    box(330, y - 1);
    put("Evet", 343, y);
    box(390, y - 1);
    put("Hayır", 403, y);
  });
  put("MALZEME", 50, 540, 12, bold);
  const cols = [50, 200, 350, 500];
  const top = 520;
  for (let r = 0; r <= 4; r++) page.drawLine({ start: { x: 50, y: top - r * 20 }, end: { x: 500, y: top - r * 20 }, thickness: 0.8 });
  for (const x of cols) page.drawLine({ start: { x, y: top }, end: { x, y: top - 80 }, thickness: 0.8 });
  put("Sıra", 55, top - 14, 9, bold);
  put("Malzeme", 205, top - 14, 9, bold);
  put("Miktar (m³)", 355, top - 14, 9, bold);
  put("Açıklama", 50, 410, 12, bold);
  page.drawRectangle({ x: 50, y: 320, width: 450, height: 80, borderColor: rgb(0, 0, 0), borderWidth: 0.8 });
  page.drawLine({ start: { x: 60, y: 200 }, end: { x: 240, y: 200 }, thickness: 0.8 });
  page.drawLine({ start: { x: 320, y: 200 }, end: { x: 500, y: 200 }, thickness: 0.8 });
  put("Hazırlayan İmza", 100, 185, 9);
  put("Kontrol Eden İmza", 360, 185, 9);
  return Buffer.from(await doc.save());
}

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

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function docx(paragraphs: string[]): Promise<Buffer> {
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const body = paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${xml(p)}</w:t></w:r></w:p>`).join("");
  return zip({
    "[Content_Types].xml":
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    "_rels/.rels":
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    "word/document.xml": `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${body}</w:body></w:document>`,
  });
}

export function pptx(slides: string[]): Promise<Buffer> {
  const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
  const e: Record<string, string> = {
    "[Content_Types].xml":
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>',
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
    "ppt/presentation.xml": `<?xml version="1.0" encoding="UTF-8"?><p:presentation ${P} xmlns:r="${REL}"><p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join("")}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`,
    "ppt/_rels/presentation.xml.rels": `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${slides.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/slide" Target="slides/slide${i + 1}.xml"/>`).join("")}</Relationships>`,
  };
  slides.forEach((t, i) => {
    e[`ppt/slides/slide${i + 1}.xml`] = `<?xml version="1.0" encoding="UTF-8"?><p:sld ${P}><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${xml(t)}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
  });
  return zip(e);
}

export function dxf(texts: string[]): string {
  const ents = texts.map((t, i) => `  0\nTEXT\n  8\nYAZI\n 10\n0\n 20\n${i * 5}\n 40\n2.5\n  1\n${t}\n`).join("");
  return `  0\nSECTION\n  2\nHEADER\n  9\n$ACADVER\n  1\nAC1015\n  9\n$DWGCODEPAGE\n  3\nANSI_1254\n  0\nENDSEC\n  0\nSECTION\n  2\nENTITIES\n${ents}  0\nENDSEC\n  0\nEOF\n`;
}

/** Reads a test fixture by plain file name (no directories). */
export function fixture(name: string): Buffer {
  const base = path.basename(name);
  if (base !== name || !base) throw new Error("Fixture adı yalnız dosya adı olmalı.");
  const full = path.join(FIXTURES_DIR, base);
  if (!existsSync(full)) throw new Error(`Test dosyası yok: ${base}`);
  return readFileSync(full);
}

/** One sample file of a kind; `i` makes names unique, `revision` goes into title blocks. */
export async function makeSample(kind: SampleKind, o: { i?: number; revision?: string; name?: string; project?: string } = {}): Promise<Sample> {
  const n = String((o.i ?? 0) + 1).padStart(3, "0");
  switch (kind) {
    case "pdf_drawing":
      return { name: o.name ?? `DEMO-A-${n}.pdf`, data: await pdfDrawing({ number: `A-${n}`, revision: o.revision, project: o.project }) };
    case "pdf_form":
      return { name: o.name ?? `beton-dokum-formu-${n}.pdf`, data: await pdfForm() };
    case "docx":
      return {
        name: o.name ?? `DEMO-RP-${n}.docx`,
        data: await docx(["TEKNİK RAPOR", `Revizyon: ${o.revision ?? "A"}`, "Bu rapor geliştirici araçlarıyla üretilmiş örnek bir belgedir.", "Beton sınıfı C30/37 olarak öngörülmüştür."]),
      };
    case "xlsx":
      return {
        name: o.name ?? `DEMO-METRAJ-${n}.xlsx`,
        data: await writeXlsx([
          {
            name: "Metraj",
            columns: [{ title: "Poz" }, { title: "Tanım" }, { title: "Birim" }, { title: "Miktar" }],
            rows: [
              ["15.150", "Beton C30/37", "m³", 1234.5],
              ["15.160", "Kalıp", "m²", 860],
              ["23.010", "Nervürlü çelik S420", "ton", 96.4],
            ],
          },
        ]),
      };
    case "pptx":
      return { name: o.name ?? `DEMO-SUNUM-${n}.pptx`, data: await pptx(["Proje İlerleme Sunumu", "Kaba inşaat %62", "Gecikme riski: cephe"]) };
    case "dxf":
      return { name: o.name ?? `DEMO-KESIT-${n}.dxf`, data: Buffer.from(dxf(["KESİT A-A", "KOT +0.15", "PERDE P1 25 cm"]), "utf8") };
    case "ifc":
      return { name: o.name ?? `DEMO-MODEL-${n}.ifc`, data: fixture("sample-wall.ifc") };
    case "ifc_v2":
      return { name: o.name ?? `DEMO-MODEL-${n}.ifc`, data: fixture("sample-wall-v2.ifc") };
  }
}

/** A 1x1 PNG (signature / photo attachments of seeded forms). */
export const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
