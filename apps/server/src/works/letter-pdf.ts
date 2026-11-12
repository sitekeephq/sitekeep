/**
 * Official letter PDF ("Resmi yazı") for outgoing correspondence, built with pdf-lib. Layout follows
 * the Odoo report of sevend_yazismalar: sender header, Sayı/Tarih/Konu block (labels and dates in
 * every letter language), Proje / Belge No, centred recipient, then per language the İLGİ list,
 * body and signature. Bilingual letters print side by side ("columns", with a divider) or one
 * after another ("stacked", with a rule). body2 starts on a new page. Text is word-wrapped and
 * flows over as many pages as needed; every page gets a numbered footer.
 */
import {
  LETTER_LABELS,
  combinedDate,
  combinedLabel,
  letterLanguages,
  letterSubject,
  letterValues,
  parseLetterText,
  parseRuns,
  referenceLine,
  referenceMark,
  type LetterData,
  type LetterLang,
  type LetterReference,
  type LetterRun,
} from "@sitekeep/shared";
import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { pdfFonts } from "./pdf.js";

export interface LetterPdfInput {
  /** Sender company name (header and signature). */
  company: string;
  projectCode: string;
  projectName: string;
  number: string;
  /** Letter date: the "tarih" field, else the send date. */
  date: string | Date;
  title: string;
  letter: LetterData;
  /** Client's project code (proje_kodu). */
  projectRef: string | null;
  /** "Belge No" (document number) when present. */
  docNo: string | null;
  /** "İlgi" letters, oldest first. */
  references: LetterReference[];
}

const W = 595.28;
const H = 841.89;
const M = 56;
const TOP = H - M;
const BOTTOM = M + 18;
const SIZE = 10;
const LEAD = 14;
const GUTTER = 24;

const INK = rgb(0.1, 0.12, 0.16);
const MUTED = rgb(0.38, 0.44, 0.5);
const RULE = rgb(0.75, 0.78, 0.82);

interface Seg {
  text: string;
  bold: boolean;
}

/** One printed line of a column. */
interface Line {
  segs: Seg[];
  /** Left offset inside the column (hanging indent of list items). */
  indent: number;
  /** List mark drawn at the column's left edge (a), •). */
  mark?: string;
  align: "left" | "center";
  /** Centre inside the right half (signature of single-column letters). */
  half?: boolean;
  size: number;
  height: number;
  rule?: boolean;
  color?: ReturnType<typeof rgb>;
}

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
  clean: (s: string) => string;
}

const space = (h: number): Line => ({ segs: [], indent: 0, align: "left", size: SIZE, height: h });

/** Words, spaces and forced breaks of runs, for greedy wrapping. */
function tokens(runs: LetterRun[]): (Seg | "\n")[] {
  const out: (Seg | "\n")[] = [];
  for (const r of runs)
    for (const part of r.text.split(/(\n|\s+)/)) {
      if (part === "") continue;
      if (part === "\n") out.push("\n");
      else out.push({ text: /^\s+$/.test(part) ? " " : part, bold: r.bold });
    }
  return out;
}

function segWidth(f: Fonts, s: Seg, size: number): number {
  return (s.bold ? f.bold : f.regular).widthOfTextAtSize(s.text, size);
}

function lineWidth(f: Fonts, segs: Seg[], size: number): number {
  return segs.reduce((sum, s) => sum + segWidth(f, s, size), 0);
}

/** Splits a word that is wider than the line into pieces that fit. */
function splitWord(f: Fonts, s: Seg, width: number, size: number): Seg[] {
  const out: Seg[] = [];
  let cur = "";
  for (const ch of s.text) {
    if (cur && segWidth(f, { text: cur + ch, bold: s.bold }, size) > width) {
      out.push({ text: cur, bold: s.bold });
      cur = ch;
    } else cur += ch;
  }
  if (cur) out.push({ text: cur, bold: s.bold });
  return out;
}

/** Greedy word wrap of styled runs into lines no wider than `width`. */
function wrap(f: Fonts, runs: LetterRun[], width: number, size = SIZE): Seg[][] {
  const lines: Seg[][] = [];
  let cur: Seg[] = [];
  let curW = 0;
  const push = () => {
    while (cur.length && cur[cur.length - 1]!.text === " ") cur.pop();
    lines.push(cur);
    cur = [];
    curW = 0;
  };
  const cleaned = runs.map((r) => ({ ...r, text: f.clean(r.text) }));
  for (const t of tokens(cleaned)) {
    if (t === "\n") {
      push();
      continue;
    }
    if (t.text === " " && !cur.length) continue;
    const w = segWidth(f, t, size);
    if (curW + w <= width) {
      cur.push(t);
      curW += w;
      continue;
    }
    if (t.text === " ") {
      push();
      continue;
    }
    if (cur.length) push();
    if (w <= width) {
      cur.push(t);
      curW = w;
    } else {
      const pieces = splitWord(f, t, width, size);
      for (const [i, p] of pieces.entries()) {
        cur.push(p);
        curW = segWidth(f, p, size);
        if (i < pieces.length - 1) push();
      }
    }
  }
  if (cur.length || !lines.length) push();
  // Merge neighbouring segments of the same weight (fewer drawText calls).
  return lines.map((segs) =>
    segs.reduce<Seg[]>((acc, s) => {
      const last = acc[acc.length - 1];
      if (last && last.bold === s.bold) last.text += s.text;
      else acc.push({ ...s });
      return acc;
    }, []),
  );
}

function textLines(f: Fonts, runs: LetterRun[], width: number, opts: Partial<Line> = {}): Line[] {
  const indent = opts.indent ?? 0;
  const size = opts.size ?? SIZE;
  return wrap(f, runs, width - indent, size).map((segs, i) => ({
    segs,
    indent,
    align: "left",
    size,
    height: Math.round(size * 1.4),
    ...opts,
    mark: i === 0 ? opts.mark : undefined,
  }));
}

/** Body text with light markup (paragraphs, bullets, bold). */
function bodyLines(f: Fonts, text: string, width: number): Line[] {
  const out: Line[] = [];
  const blocks = parseLetterText(text);
  blocks.forEach((b, i) => {
    if (b.kind === "li") out.push(...textLines(f, b.runs, width, { indent: 14, mark: "•" }));
    else out.push(...textLines(f, b.runs, width));
    // Consecutive bullets stay together; paragraphs get a gap.
    out.push(space(b.kind === "li" && blocks[i + 1]?.kind === "li" ? 2 : 6));
  });
  return out;
}

/** One language: İLGİ list, free reference text, body and the signature block. */
function languageLines(f: Fonts, p: LetterPdfInput, lang: LetterLang, width: number, signatureHalf: boolean): Line[] {
  const v = letterValues(p.letter, p.title, lang);
  const labels = LETTER_LABELS[lang];
  const out: Line[] = [];
  if (p.references.length || v.referenceText.trim()) {
    out.push(...textLines(f, [{ text: `${labels.references}:`, bold: true }], width));
    p.references.forEach((r, i) => out.push(...textLines(f, [{ text: referenceLine(lang, r), bold: false }], width, { indent: 18, mark: referenceMark(i) })));
    if (v.referenceText.trim())
      for (const line of v.referenceText.trim().split(/\r?\n/)) out.push(...textLines(f, parseRuns(line || " "), width));
    out.push(space(10));
  }
  out.push(...bodyLines(f, v.body, width));
  out.push(space(24));
  const sign = (text: string, bold = false) =>
    text.trim() ? textLines(f, [{ text, bold }], signatureHalf ? width / 2 : width, { align: "center", half: signatureHalf }) : [];
  out.push(...sign(p.letter.signer.name), ...sign(v.signerTitle), ...sign(p.company, true));
  return out;
}

export async function letterPdf(p: LetterPdfInput): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(p.number);
  doc.setSubject(letterSubject(p.letter, p.title));
  doc.setProducer("SiteKeep");
  doc.setCreator("SiteKeep");
  const f: Fonts = await pdfFonts(doc);
  const langs = letterLanguages(p.letter);
  const columns = langs.length > 1 && p.letter.layout === "columns";
  const fullW = W - 2 * M;
  const colW = columns ? (fullW - GUTTER) / 2 : fullW;

  let page: PDFPage = doc.addPage([W, H]);
  let y = TOP;

  const drawSegs = (segs: Seg[], x: number, yy: number, size: number, color = INK) => {
    let cx = x;
    for (const s of segs) {
      const font = s.bold ? f.bold : f.regular;
      page.drawText(s.text, { x: cx, y: yy, size, font, color });
      cx += font.widthOfTextAtSize(s.text, size);
    }
  };

  // ---- Header: sender and project ------------------------------------------------------------
  for (const segs of wrap(f, [{ text: p.company, bold: true }], fullW, 14)) {
    drawSegs(segs, M, y - 14, 14);
    y -= 18;
  }
  for (const segs of wrap(f, [{ text: `${p.projectCode} · ${p.projectName}`, bold: false }], fullW, 9)) {
    drawSegs(segs, M, y - 9, 9, MUTED);
    y -= 12;
  }
  y -= 4;
  page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.8, color: RULE });
  y -= 18;

  // ---- Sayı / Tarih / Konu (left), Proje / Belge No (right) ----------------------------------
  const leftW = fullW * 0.6;
  const rightW = fullW - leftW - 12;
  const labelled = (key: "ref" | "date" | "subject" | "project" | "doc", value: string): LetterRun[] => [
    { text: `${combinedLabel(p.letter, key)}: `, bold: true },
    { text: value, bold: false },
  ];
  const left = [
    ...wrap(f, labelled("ref", p.number), leftW),
    ...wrap(f, labelled("date", combinedDate(p.letter, p.date)), leftW),
    ...wrap(f, labelled("subject", letterSubject(p.letter, p.title)), leftW),
  ];
  const right = [
    ...(p.projectRef ? wrap(f, labelled("project", p.projectRef), rightW) : []),
    ...(p.docNo ? wrap(f, labelled("doc", p.docNo), rightW) : []),
  ];
  const rows = Math.max(left.length, right.length);
  for (let i = 0; i < rows; i++) {
    if (left[i]) drawSegs(left[i]!, M, y - SIZE, SIZE);
    if (right[i]) drawSegs(right[i]!, W - M - lineWidth(f, right[i]!, SIZE), y - SIZE, SIZE);
    y -= LEAD;
  }

  // ---- Recipient (centred, upper case) ---------------------------------------------------------
  y -= 26;
  const r = p.letter.recipient;
  if (r.name.trim()) {
    const upper = r.name.trim().toLocaleUpperCase(langs.includes("tr") ? "tr-TR" : "en-GB");
    for (const segs of wrap(f, [{ text: upper, bold: true }], fullW, 12)) {
      drawSegs(segs, M + (fullW - lineWidth(f, segs, 12)) / 2, y - 12, 12);
      y -= 16;
    }
  }
  for (const line of r.address.split(/\r?\n/).filter((l) => l.trim()))
    for (const segs of wrap(f, [{ text: line.trim(), bold: false }], fullW)) {
      drawSegs(segs, M + (fullW - lineWidth(f, segs, SIZE)) / 2, y - SIZE, SIZE);
      y -= LEAD;
    }
  y -= 20;

  // ---- Flowing body ------------------------------------------------------------------------------
  const newPage = () => {
    page = doc.addPage([W, H]);
    y = TOP;
  };

  const drawLine = (l: Line, x: number, w: number, yy: number) => {
    if (l.rule) {
      page.drawLine({ start: { x, y: yy - l.height / 2 }, end: { x: x + w, y: yy - l.height / 2 }, thickness: 0.8, color: RULE });
      return;
    }
    if (!l.segs.length && !l.mark) return;
    const base = yy - l.size;
    if (l.mark) drawSegs([{ text: l.mark, bold: false }], x + (l.indent > 16 ? 2 : 0), base, l.size, l.color);
    if (l.align === "center") {
      const areaX = l.half ? x + w / 2 : x;
      const areaW = l.half ? w / 2 : w;
      drawSegs(l.segs, areaX + (areaW - lineWidth(f, l.segs, l.size)) / 2, base, l.size, l.color);
    } else drawSegs(l.segs, x + l.indent, base, l.size, l.color);
  };

  /** Flows columns side by side; each column continues on the next page independently. */
  const flow = (cols: Line[][]) => {
    const pos = cols.map(() => 0);
    const xs = cols.map((_, i) => M + i * (colW + GUTTER));
    for (;;) {
      const startY = y;
      let lowest = y;
      cols.forEach((lines, ci) => {
        let cy = startY;
        while (pos[ci]! < lines.length) {
          const l = lines[pos[ci]!]!;
          if (cy - l.height < BOTTOM) break;
          drawLine(l, xs[ci]!, cols.length > 1 ? colW : fullW, cy);
          cy -= l.height;
          pos[ci]!++;
        }
        lowest = Math.min(lowest, cy);
      });
      if (cols.length > 1)
        page.drawLine({ start: { x: M + colW + GUTTER / 2, y: startY }, end: { x: M + colW + GUTTER / 2, y: lowest }, thickness: 0.6, color: RULE });
      y = lowest;
      if (cols.every((lines, ci) => pos[ci]! >= lines.length)) return;
      newPage();
    }
  };

  const halfSignature = !columns;
  if (columns) flow(langs.map((lang) => languageLines(f, p, lang, colW, false)));
  else {
    const lines: Line[] = [];
    langs.forEach((lang, i) => {
      if (i) lines.push(space(14), { ...space(10), rule: true }, space(14));
      lines.push(...languageLines(f, p, lang, fullW, halfSignature));
    });
    flow([lines]);
  }

  // ---- body2: extra page ---------------------------------------------------------------------
  const extra = langs.map((lang) => letterValues(p.letter, p.title, lang).body2);
  if (extra.some((t) => t.trim())) {
    newPage();
    if (columns) flow(extra.map((t) => bodyLines(f, t, colW)));
    else {
      const lines: Line[] = [];
      extra.forEach((t, i) => {
        if (!t.trim()) return;
        if (lines.length) lines.push(space(14), { ...space(10), rule: true }, space(14));
        lines.push(...bodyLines(f, t, fullW));
      });
      flow([lines]);
    }
  }

  // ---- Footer ------------------------------------------------------------------------------------
  const pages = doc.getPages();
  pages.forEach((pg, i) => {
    const text = f.clean(`${p.number} · ${i + 1}/${pages.length}`);
    const w = f.regular.widthOfTextAtSize(text, 8);
    pg.drawLine({ start: { x: M, y: M }, end: { x: W - M, y: M }, thickness: 0.5, color: RULE });
    pg.drawText(text, { x: W - M - w, y: M - 14, size: 8, font: f.regular, color: MUTED });
    pg.drawText(f.clean(p.company), { x: M, y: M - 14, size: 8, font: f.regular, color: MUTED });
  });
  return doc.save();
}
