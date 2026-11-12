/**
 * Transmittal cover sheet (A4 PDF) built with pdf-lib. Liberation Sans is embedded for Turkish
 * letters; when the font files are missing, Helvetica is used and the text is transliterated.
 */
import { pdfFontBytes } from "../core/formats/pdf-fonts.js";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { DEFAULT_LANGUAGE, intlLocale, tFor } from "../i18n/index.js";

export interface CoverFile {
  name: string;
  version: number;
  revision: string | null;
}

export interface TransmittalCover {
  projectCode: string;
  projectName: string;
  number: string;
  title: string;
  date: Date;
  purpose: string;
  from: string | null;
  to: string[];
  cc: string[];
  note: string | null;
  files: CoverFile[];
  createdBy: string;
  /** Language of the cover's labels (the sender's). */
  lang?: string;
}

const fontBytes = pdfFontBytes;

const TR_ASCII: Record<string, string> = { ı: "i", İ: "I", ş: "s", Ş: "S", ğ: "g", Ğ: "G" }; // i18n-ok: transliteration table

export async function transmittalCoverPdf(c: TransmittalCover): Promise<Uint8Array> {
  const lang = c.lang ?? DEFAULT_LANGUAGE;
  const t = tFor(lang);
  const doc = await PDFDocument.create();
  doc.setTitle(c.number);
  doc.setSubject(t("works:coverPdf.subject", { title: c.title }));
  doc.setProducer("SiteKeep");
  doc.setCreationDate(c.date);
  const bytes = fontBytes();
  let regular: PDFFont, bold: PDFFont;
  let clean = (s: string) => s;
  if (bytes) {
    doc.registerFontkit(fontkit);
    regular = await doc.embedFont(bytes.regular, { subset: true });
    bold = await doc.embedFont(bytes.bold, { subset: true });
  } else {
    regular = await doc.embedFont(StandardFonts.Helvetica);
    bold = await doc.embedFont(StandardFonts.HelveticaBold);
    clean = (s) => s.replace(/[ıİşŞğĞ]/g, (ch) => TR_ASCII[ch] ?? ch).replace(/[^\x20-\x7e -ÿ]/g, "?");
  }

  const W = 595.28;
  const H = 841.89;
  const M = 48;
  const ink = rgb(0.11, 0.15, 0.2);
  const muted = rgb(0.37, 0.44, 0.5);
  const line = rgb(0.8, 0.84, 0.88);
  let page: PDFPage = doc.addPage([W, H]);
  let y = H - M;

  const text = (s: string, x: number, size: number, font = regular, color = ink) =>
    page.drawText(clean(s), { x, y, size, font, color });
  const fit = (s: string, width: number, size: number, font = regular) => {
    let out = clean(s);
    if (font.widthOfTextAtSize(out, size) <= width) return out;
    while (out.length > 1 && font.widthOfTextAtSize(`${out}…`, size) > width) out = out.slice(0, -1);
    return `${out}…`;
  };
  const wrap = (s: string, width: number, size: number) => {
    const lines: string[] = [];
    for (const para of clean(s).split(/\r?\n/)) {
      let cur = "";
      for (const word of para.split(/\s+/)) {
        const next = cur ? `${cur} ${word}` : word;
        if (regular.widthOfTextAtSize(next, size) > width && cur) {
          lines.push(cur);
          cur = word;
        } else cur = next;
      }
      lines.push(cur);
    }
    return lines;
  };
  const newPageIfNeeded = (need: number) => {
    if (y - need > M + 30) return false;
    page = doc.addPage([W, H]);
    y = H - M;
    return true;
  };

  // Header
  text(t("works:coverPdf.title"), M, 20, bold);
  page.drawText(clean(c.number), {
    x: W - M - bold.widthOfTextAtSize(clean(c.number), 12),
    y: y + 4,
    size: 12,
    font: bold,
    color: ink,
  });
  y -= 18;
  text(`${c.projectCode} · ${c.projectName}`, M, 10, regular, muted);
  y -= 12;
  page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 1, color: line });
  y -= 22;

  const rows: [string, string][] = [
    [t("works:coverPdf.subjectLabel"), c.title],
    [t("works:coverPdf.date"), c.date.toLocaleDateString(intlLocale(lang))],
    [t("works:coverPdf.purpose"), c.purpose],
    [t("works:coverPdf.from"), c.from ?? "—"],
    [t("works:coverPdf.to"), c.to.join(", ") || "—"],
    [t("works:coverPdf.cc"), c.cc.join(", ") || "—"],
    [t("works:coverPdf.preparedBy"), c.createdBy],
  ];
  for (const [k, v] of rows) {
    text(k, M, 10, bold, muted);
    const lines = wrap(v, W - 2 * M - 110, 10);
    for (const [i, l] of lines.entries()) {
      page.drawText(l, { x: M + 110, y: y - i * 13, size: 10, font: regular, color: ink });
    }
    y -= Math.max(1, lines.length) * 13 + 5;
  }
  if (c.note) {
    y -= 4;
    text(t("works:coverPdf.note"), M, 10, bold, muted);
    for (const l of wrap(c.note, W - 2 * M - 110, 10)) {
      page.drawText(l, { x: M + 110, y, size: 10, font: regular, color: ink });
      y -= 13;
    }
  }

  // File table
  y -= 16;
  const cols = [
    { title: "#", x: M, w: 24 },
    { title: t("works:coverPdf.file"), x: M + 24, w: W - 2 * M - 24 - 70 - 90 },
    { title: t("works:coverPdf.version"), x: W - M - 160, w: 70 },
    { title: t("works:coverPdf.revision"), x: W - M - 90, w: 90 },
  ];
  const header = () => {
    page.drawRectangle({ x: M, y: y - 5, width: W - 2 * M, height: 18, color: rgb(0.96, 0.97, 0.98) });
    for (const col of cols) page.drawText(clean(col.title), { x: col.x + 4, y, size: 9, font: bold, color: muted });
    y -= 20;
  };
  text(t("works:coverPdf.files", { count: c.files.length }), M, 12, bold);
  y -= 20;
  header();
  c.files.forEach((f, i) => {
    if (newPageIfNeeded(16)) header();
    const cells = [String(i + 1), f.name, `V${f.version}`, f.revision ?? "—"];
    cells.forEach((v, ci) => {
      const col = cols[ci]!;
      page.drawText(fit(v, col.w - 8, 9), { x: col.x + 4, y, size: 9, font: regular, color: ink });
    });
    y -= 6;
    page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.5, color: line });
    y -= 11;
  });
  if (!c.files.length) {
    text(t("works:coverPdf.noFiles"), M + 4, 9, regular, muted);
    y -= 14;
  }

  // Receipt box
  newPageIfNeeded(80);
  y -= 24;
  page.drawRectangle({ x: M, y: y - 50, width: W - 2 * M, height: 62, borderColor: line, borderWidth: 1 });
  text(t("works:coverPdf.receipt"), M + 8, 10, bold);
  y -= 16;
  text(t("works:coverPdf.receiptName"), M + 8, 9, regular, muted);
  text(t("works:coverPdf.receiptSign"), M + 280, 9, regular, muted);

  // Footer on every page
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    const footer = clean(t("works:coverPdf.footer", { number: c.number, page: i + 1, pages: pages.length }));
    p.drawText(footer, { x: M, y: 28, size: 8, font: regular, color: muted });
  });
  return doc.save();
}

/** Embeds Liberation Sans (or Helvetica with transliteration) for other work PDFs (meeting minutes). */
export async function pdfFonts(doc: PDFDocument): Promise<{ regular: PDFFont; bold: PDFFont; clean: (s: string) => string }> {
  const bytes = fontBytes();
  if (bytes) {
    doc.registerFontkit(fontkit);
    return {
      regular: await doc.embedFont(bytes.regular, { subset: true }),
      bold: await doc.embedFont(bytes.bold, { subset: true }),
      clean: (s) => s,
    };
  }
  return {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    clean: (s) => s.replace(/[ıİşŞğĞ]/g, (ch) => TR_ASCII[ch] ?? ch).replace(/[^\x20-\x7e\xa0-\xff]/g, "?"),
  };
}
