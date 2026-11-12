/**
 * Comparison report (A4 PDF, pdf-lib): summary, checks, title-block table, text changes and the
 * overlay thumbnails the browser rendered (the server never renders PDF pages itself).
 */
import { PDFDocument, rgb, type PDFFont, type PDFImage, type PDFPage } from "pdf-lib";
import type { DocCompareFlag, DocCompareResult, PageRegions, SummaryBullet } from "@sitekeep/shared";
import { DEFAULT_LANGUAGE, intlLocale, tFor } from "../i18n/index.js";
import { pdfFonts } from "../works/pdf.js";
import { changeText } from "./text-diff.js";

export interface ReportInput {
  projectCode: string;
  projectName: string;
  fileA: string;
  fileB: string;
  versionA: number;
  versionB: number;
  result: DocCompareResult;
  regions: PageRegions[] | null;
  flags: DocCompareFlag[];
  summary: SummaryBullet[];
  ai: { used: boolean; model: string | null; note: string | null };
  thumbnails: { page: number; bytes: Uint8Array; png: boolean }[];
  preparedBy: string;
  date: Date;
  /** Language of the report (the requester's). */
  lang?: string;
}

const W = 595.28;
const H = 841.89;
const M = 44;
const INK = rgb(0.11, 0.15, 0.2);
const MUTED = rgb(0.37, 0.44, 0.5);
const LINE = rgb(0.8, 0.84, 0.88);
const OLD = rgb(0.78, 0.12, 0.12);
const NEW = rgb(0.12, 0.35, 0.78);
const WARN = rgb(0.57, 0.25, 0.05);

export async function comparisonReportPdf(p: ReportInput): Promise<Uint8Array> {
  const lang = p.lang ?? DEFAULT_LANGUAGE;
  const t = tFor(lang);
  const doc = await PDFDocument.create();
  doc.setTitle(t("doccompare:report.docTitle", { file: p.fileB }));
  doc.setProducer("SiteKeep");
  doc.setCreationDate(p.date);
  const f = await pdfFonts(doc);
  let page: PDFPage = doc.addPage([W, H]);
  let y = H - M;

  const newPage = () => {
    page = doc.addPage([W, H]);
    y = H - M;
  };
  const ensure = (h: number) => {
    if (y - h < M + 16) newPage();
  };
  const wrap = (text: string, width: number, size: number, font: PDFFont): string[] => {
    const words = f.clean(text).split(/\s+/);
    const lines: string[] = [];
    let cur = "";
    for (const w of words) {
      const next = cur ? `${cur} ${w}` : w;
      if (font.widthOfTextAtSize(next, size) <= width) cur = next;
      else {
        if (cur) lines.push(cur);
        let piece = w;
        while (font.widthOfTextAtSize(piece, size) > width && piece.length > 1) {
          let k = piece.length - 1;
          while (k > 1 && font.widthOfTextAtSize(piece.slice(0, k), size) > width) k--;
          lines.push(piece.slice(0, k));
          piece = piece.slice(k);
        }
        cur = piece;
      }
    }
    if (cur) lines.push(cur);
    return lines.length ? lines : [""];
  };
  const para = (text: string, opts: { size?: number; font?: PDFFont; color?: ReturnType<typeof rgb>; indent?: number; bullet?: string } = {}) => {
    const size = opts.size ?? 9.5;
    const font = opts.font ?? f.regular;
    const indent = opts.indent ?? 0;
    const lines = wrap(text, W - 2 * M - indent - (opts.bullet ? 10 : 0), size, font);
    for (let i = 0; i < lines.length; i++) {
      ensure(size + 4);
      if (i === 0 && opts.bullet) page.drawText(f.clean(opts.bullet), { x: M + indent, y, size, font, color: opts.color ?? INK });
      page.drawText(lines[i]!, { x: M + indent + (opts.bullet ? 10 : 0), y, size, font, color: opts.color ?? INK });
      y -= size + 3.5;
    }
  };
  const heading = (text: string) => {
    ensure(30);
    y -= 8;
    page.drawText(f.clean(text), { x: M, y, size: 12, font: f.bold, color: INK });
    y -= 6;
    page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.6, color: LINE });
    y -= 13;
  };

  // Header.
  page.drawText(f.clean(t("doccompare:report.title")), { x: M, y, size: 17, font: f.bold, color: INK });
  y -= 20;
  para(`${p.projectCode} · ${p.projectName}`, { color: MUTED });
  y -= 4;
  const same = p.fileA === p.fileB;
  para(same ? t("doccompare:report.file", { file: p.fileB }) : t("doccompare:report.oldFile", { file: p.fileA }), { font: f.bold });
  const revisions = { from: p.result.revisionA ?? "?", to: p.result.revisionB ?? "?" };
  para(
    same
      ? p.result.revisionA || p.result.revisionB
        ? t("doccompare:report.versionsWithRevision", { versionA: p.versionA, versionB: p.versionB, revisionA: revisions.from, revisionB: revisions.to })
        : t("doccompare:report.versions", { versionA: p.versionA, versionB: p.versionB })
      : t("doccompare:report.newFile", { file: p.fileB, versionA: p.versionA, versionB: p.versionB }),
  );
  para(t("doccompare:report.preparedBy", { name: p.preparedBy, date: p.date.toLocaleString(intlLocale(lang), { timeZone: "Europe/Istanbul" }) }), {
    color: MUTED,
    size: 8.5,
  });
  if (p.result.note) para(p.result.note, { color: WARN, size: 9 });

  heading(t("doccompare:report.summary"));
  para(
    p.ai.used
      ? t("doccompare:report.aiSummary", { model: p.ai.model ?? "model" })
      : p.ai.note
        ? t("doccompare:report.ruleSummaryWithNote", { note: p.ai.note })
        : t("doccompare:report.ruleSummary"),
    {
    color: MUTED,
    size: 8.5,
  });
  y -= 2;
  for (const b of p.summary) para(`${b.page ? `[s.${b.page}] ` : ""}${b.text}`, { bullet: "•", color: b.severity === "warn" ? WARN : INK });

  if (p.flags.length) {
    heading(t("doccompare:report.checks"));
    for (const fl of p.flags) para(fl.message, { bullet: fl.severity === "warn" ? "!" : "i", color: fl.severity === "warn" ? WARN : INK });
  }

  if (p.result.antet.length) {
    heading(t("doccompare:report.antetChanges"));
    const c1 = 150;
    const c2 = (W - 2 * M - c1) / 2;
    ensure(16);
    for (const [label, x] of [
      [t("doccompare:report.columns.field"), M],
      [t("doccompare:report.columns.old"), M + c1],
      [t("doccompare:report.columns.new"), M + c1 + c2],
    ] as const)
      page.drawText(f.clean(label), { x, y, size: 8.5, font: f.bold, color: MUTED });
    y -= 12;
    for (const c of p.result.antet) {
      const la = wrap(c.label, c1 - 6, 9, f.regular);
      const lo = wrap(c.old ?? "—", c2 - 6, 9, f.regular);
      const ln = wrap(c.new ?? "—", c2 - 6, 9, f.regular);
      const n = Math.max(la.length, lo.length, ln.length);
      ensure(n * 12 + 4);
      for (let i = 0; i < n; i++) {
        if (la[i]) page.drawText(la[i]!, { x: M, y, size: 9, font: f.regular, color: INK });
        if (lo[i]) page.drawText(lo[i]!, { x: M + c1, y, size: 9, font: f.regular, color: OLD });
        if (ln[i]) page.drawText(ln[i]!, { x: M + c1 + c2, y, size: 9, font: f.regular, color: NEW });
        y -= 12;
      }
      page.drawLine({ start: { x: M, y: y + 8 }, end: { x: W - M, y: y + 8 }, thickness: 0.3, color: LINE });
    }
  }

  if (p.result.sheets?.some((s) => s.status !== "same")) {
    heading(t("doccompare:report.sheetChanges"));
    let left = 200;
    for (const s of p.result.sheets.filter((x) => x.status !== "same")) {
      para(t("doccompare:report.sheetCounts", { name: s.name, changed: s.changed, added: s.added, removed: s.removed }), { font: f.bold });
      for (const r of s.rows) {
        if (left-- <= 0) break;
        if (r.kind === "changed")
          para(t("doccompare:report.rowChanged", { row: r.rowB, cells: (r.cells ?? []).map((c) => `${c.col} "${c.old}" → "${c.new}"`).join(", ") }), { indent: 8, size: 8.5 });
        else
          para(t(r.kind === "added" ? "doccompare:report.rowAdded" : "doccompare:report.rowRemoved", { row: r.rowB ?? r.rowA, text: r.text ?? "" }), {
            indent: 8,
            size: 8.5,
            color: r.kind === "added" ? NEW : OLD,
          });
      }
    }
  }

  if (p.result.pages.length) {
    heading(t("doccompare:report.textChanges"));
    let left = 250;
    for (const pg of p.result.pages) {
      if (left <= 0) break;
      const n = { page: pg.page, changed: pg.changed, added: pg.added, removed: pg.removed };
      para(t(p.result.kind === "pdf" ? "doccompare:report.pageCounts" : "doccompare:report.textCounts", n), { font: f.bold, size: 9.5 });
      for (const c of pg.changes) {
        if (left-- <= 0) break;
        para(c.antet ? t("doccompare:report.inAntet", { text: changeText(c, t) }) : changeText(c, t), {
          indent: 8,
          size: 8.5,
          bullet: c.kind === "added" ? "+" : c.kind === "removed" ? "−" : "~",
          color: c.kind === "added" ? NEW : c.kind === "removed" ? OLD : INK,
        });
      }
      if (pg.more) para(t("doccompare:report.more", { count: pg.more }), { indent: 8, size: 8.5, color: MUTED });
    }
  }

  if (p.thumbnails.length) {
    heading(t("doccompare:report.visual"));
    para(t("doccompare:report.legend"), { color: MUTED, size: 8.5 });
    const regionCount = new Map((p.regions ?? []).map((r) => [r.page, r]));
    for (const th of p.thumbnails) {
      let img: PDFImage;
      try {
        img = th.png ? await doc.embedPng(th.bytes) : await doc.embedJpg(th.bytes);
      } catch {
        continue;
      }
      const maxW = W - 2 * M;
      const maxH = (H - 2 * M) / 2 - 30;
      const s = Math.min(maxW / img.width, maxH / img.height);
      const w = img.width * s;
      const h = img.height * s;
      ensure(h + 26);
      const reg = regionCount.get(th.page);
      const caption = reg?.only
        ? t(reg.only === "B" ? "doccompare:report.pageOnlyNew" : "doccompare:report.pageNotInNew", { page: th.page })
        : reg
          ? t("doccompare:report.pageRegions", { page: th.page, count: reg.regions.length })
          : t("doccompare:report.page", { page: th.page });
      page.drawText(f.clean(caption), {
        x: M,
        y,
        size: 9,
        font: f.bold,
        color: INK,
      });
      y -= 6;
      page.drawImage(img, { x: M, y: y - h, width: w, height: h });
      page.drawRectangle({ x: M, y: y - h, width: w, height: h, borderColor: LINE, borderWidth: 0.6 });
      y -= h + 14;
    }
  }

  const pages = doc.getPages();
  pages.forEach((pg, i) => {
    const text = `${i + 1} / ${pages.length}`;
    pg.drawText(text, { x: W - M - f.regular.widthOfTextAtSize(text, 8), y: M - 18, size: 8, font: f.regular, color: MUTED });
    pg.drawText(f.clean(t("doccompare:report.footer")), { x: M, y: M - 18, size: 8, font: f.regular, color: MUTED });
  });
  return doc.save();
}
