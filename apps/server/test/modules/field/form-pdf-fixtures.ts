/** Generated sample PDF forms for the PDF template tests (no client documents). */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";

const here = path.dirname(fileURLToPath(import.meta.url));
const fontDir = path.resolve(here, "../../../assets/fonts");

async function setup() {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const regular = await doc.embedFont(readFileSync(path.join(fontDir, "LiberationSans-Regular.ttf")), { subset: true });
  const bold = await doc.embedFont(readFileSync(path.join(fontDir, "LiberationSans-Bold.ttf")), { subset: true });
  return { doc, regular, bold };
}

const A4: [number, number] = [595.28, 841.89];
const INK = rgb(0, 0, 0);

/** Draws text with its baseline at `top` (top-left coordinates). */
function text(page: PDFPage, font: PDFFont, s: string, x: number, top: number, size = 10) {
  page.drawText(s, { x, y: A4[1] - top, size, font, color: INK });
}

function hline(page: PDFPage, x0: number, x1: number, top: number, thickness = 0.8) {
  page.drawLine({ start: { x: x0, y: A4[1] - top }, end: { x: x1, y: A4[1] - top }, thickness, color: INK });
}

function vline(page: PDFPage, x: number, top0: number, top1: number) {
  page.drawLine({ start: { x, y: A4[1] - top0 }, end: { x, y: A4[1] - top1 }, thickness: 0.8, color: INK });
}

function box(page: PDFPage, x: number, top: number, w: number, h: number) {
  page.drawRectangle({ x, y: A4[1] - top - h, width: w, height: h, borderColor: INK, borderWidth: 0.8 });
}

/**
 * Non-fillable form with a text layer: title, sections, dotted and underscored blanks, an
 * underline, Evet / Hayır tick boxes, a note box, a material table and two signature lines.
 */
export async function textLayerFormPdf(): Promise<Uint8Array> {
  const { doc, regular, bold } = await setup();
  const page = doc.addPage(A4);
  text(page, bold, "BETON DÖKÜM KONTROL FORMU", 150, 70, 16);
  text(page, bold, "GENEL BİLGİLER", 50, 110, 11);
  text(page, regular, "Proje Adı: ..................................................", 50, 135);
  text(page, regular, "Döküm Tarihi: ____________________", 50, 160);
  text(page, regular, "Döküm Yeri:", 50, 185);
  hline(page, 115, 330, 188);
  text(page, bold, "KONTROLLER", 50, 225, 11);
  text(page, regular, "Kalıp temizliği yapıldı mı?", 50, 250);
  box(page, 300, 241, 10, 10);
  text(page, regular, "Evet", 314, 250);
  box(page, 360, 241, 10, 10);
  text(page, regular, "Hayır", 374, 250);
  text(page, regular, "Donatı paspayı uygun mu?", 50, 275);
  box(page, 300, 266, 10, 10);
  text(page, regular, "Evet", 314, 275);
  box(page, 360, 266, 10, 10);
  text(page, regular, "Hayır", 374, 275);
  box(page, 50, 295, 495, 60);
  text(page, regular, "Açıklama:", 55, 307, 9);
  // Material table: header + 3 empty rows.
  text(page, bold, "Malzeme Listesi", 50, 385, 10);
  const cols = [50, 100, 380, 545];
  const rows = [395, 415, 435, 455, 475];
  for (const r of rows) hline(page, cols[0]!, cols[3]!, r);
  for (const c of cols) vline(page, c, rows[0]!, rows[rows.length - 1]!);
  text(page, bold, "Sıra", 55, 409, 9);
  text(page, bold, "Malzeme", 105, 409, 9);
  text(page, bold, "Miktar (m³)", 385, 409, 9);
  // Signatures: a line with the label under it.
  hline(page, 60, 230, 560);
  text(page, regular, "Hazırlayan İmza", 95, 575, 9);
  hline(page, 330, 500, 560);
  text(page, regular, "Kontrol Eden İmza", 360, 575, 9);
  return doc.save();
}

/** Fillable form (AcroForm): text, date, multi-line text, a check box, a radio group and a dropdown. */
export async function acroFormPdf(): Promise<Uint8Array> {
  const { doc, regular, bold } = await setup();
  const page = doc.addPage(A4);
  const form = doc.getForm();
  text(page, bold, "İSG SAHA DENETİM FORMU", 160, 70, 16);
  text(page, regular, "Şantiye Adı:", 50, 120);
  const site = form.createTextField("santiye_adi");
  site.addToPage(page, { x: 140, y: A4[1] - 128, width: 250, height: 16, font: regular });
  text(page, regular, "Denetim Tarihi:", 50, 150);
  const date = form.createTextField("denetim_tarihi");
  date.addToPage(page, { x: 140, y: A4[1] - 158, width: 120, height: 16, font: regular });
  text(page, regular, "Baret kullanılıyor", 70, 180);
  const cb = form.createCheckBox("baret");
  cb.addToPage(page, { x: 50, y: A4[1] - 183, width: 12, height: 12 });
  text(page, regular, "Hava Durumu:", 50, 210);
  const rg = form.createRadioGroup("hava");
  rg.addOptionToPage("Güneşli", page, { x: 140, y: A4[1] - 213, width: 12, height: 12 });
  text(page, regular, "Güneşli", 156, 210);
  rg.addOptionToPage("Yağmurlu", page, { x: 220, y: A4[1] - 213, width: 12, height: 12 });
  text(page, regular, "Yağmurlu", 236, 210);
  text(page, regular, "Risk Seviyesi:", 50, 240);
  const dd = form.createDropdown("risk");
  dd.addOptions(["Düşük", "Orta", "Yüksek"]);
  dd.addToPage(page, { x: 140, y: A4[1] - 248, width: 120, height: 16, font: regular });
  text(page, regular, "Notlar:", 50, 275);
  const notes = form.createTextField("notlar");
  notes.enableMultiline();
  notes.addToPage(page, { x: 50, y: A4[1] - 345, width: 450, height: 60, font: regular });
  form.updateFieldAppearances(regular);
  return doc.save();
}

/** Image-only page (a "scan"): no text layer, no fields. */
export async function scannedPdf(png: Uint8Array): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage(A4);
  const img = await doc.embedPng(png);
  page.drawImage(img, { x: 0, y: 0, width: A4[0], height: A4[1] });
  return doc.save();
}
