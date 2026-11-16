/**
 * Sheets of one drawing version (FP-2, docs/features/SHEETS.md): every PDF page is a sheet, its
 * number, title, discipline, revision and date read from the page's title block: the project's
 * title-block template first (titleblock.ts), then the rule-based reader of document intelligence
 * (docintel/antet.ts) inside the template's rectangle and on the whole page. Scanned pages are read
 * by OCR (ocr.ts) before they come here. DWG/DXF files are one sheet.
 */
import {
  disciplineFrom,
  normalizeRevision,
  numberSheets,
  templateRegion,
  type AntetFieldKey,
  type AntetResult,
  type SheetNumberSource,
  type SheetReadBy,
  type TitleBlockTemplate,
} from "@sitekeep/shared";
import { analyzePage, antetValue } from "../docintel/antet.js";
import type { WorkerOutput } from "../docintel/pdf-worker.js";
import { applyTitleBlock, pageWithin, type TitleBlockValues } from "./titleblock.js";

export interface ExtractedSheet {
  page: number;
  pageCount: number;
  number: string;
  numberSource: SheetNumberSource;
  title: string | null;
  discipline: string | null;
  revision: string | null;
  date: string | null;
  readBy: SheetReadBy | null;
  ocrConfidence: number | null;
  fromTemplate: boolean;
}

export interface SheetFileContext {
  fileName: string;
  documentCode: string | null;
  description: string | null;
  /** Fields of the name parsed with the folder's naming standard (discipline / role). */
  nameFields: Record<string, string> | null;
  attributes: Record<string, string>;
}

export interface SheetReadOptions {
  /** The project's title-block template. */
  template?: TitleBlockTemplate | null;
  /** Pages whose text came from OCR, with the mean word confidence (0..1). */
  ocr?: Map<number, number>;
}

/** Discipline when the title block has none: the name's role field, else a discipline attribute. */
function fallbackDiscipline(ctx: SheetFileContext): string | null {
  return disciplineFrom(ctx.nameFields) ?? disciplineFrom(ctx.attributes);
}

interface PageRead {
  page: number;
  values: TitleBlockValues;
  titleBlockNumber: string | null;
  readBy: SheetReadBy | null;
  ocrConfidence: number | null;
  fromTemplate: boolean;
}

/** The first value of the keys in the template values, the title block in the region, then the page. */
function firstOf(antets: (AntetResult | null)[], keys: AntetFieldKey[]): string | null {
  for (const a of antets) for (const k of keys) {
    const v = antetValue(a, k);
    if (v) return v;
  }
  return null;
}

/** Sheets of a PDF from its text layer (all pages read; scanned pages carry OCR text). */
export function sheetsFromPdf(out: WorkerOutput, ctx: SheetFileContext, opts: SheetReadOptions = {}): ExtractedSheet[] {
  const pageCount = Math.max(out.pageCount, out.pages.length);
  const pages: PageRead[] = out.pages.map((p) => {
    const region = templateRegion(opts.template, p.width, p.height);
    const mapped = region ? applyTitleBlock(p, region) : {};
    const antets = [region ? analyzePage(pageWithin(p, region.box), pageCount) : null, analyzePage(p, pageCount)];
    const ocr = opts.ocr?.get(p.n);
    const values: TitleBlockValues = {
      // Sheet number first; a drawing number or document number stands in for it.
      number: mapped.number ?? firstOf(antets, ["sheetNo", "drawingNo", "docNo"]) ?? undefined,
      title: mapped.title ?? firstOf(antets, ["title"]) ?? undefined,
      revision: mapped.revision ?? firstOf(antets, ["revision"]) ?? undefined,
      discipline: mapped.discipline ?? firstOf(antets, ["discipline"]) ?? undefined,
      date: mapped.date ?? firstOf(antets, ["date"]) ?? undefined,
    };
    return {
      page: p.n,
      values,
      titleBlockNumber: values.number ?? null,
      readBy: ocr !== undefined ? "ocr" : p.items.length ? "text" : null,
      ocrConfidence: ocr ?? null,
      fromTemplate: Object.keys(mapped).length > 0,
    };
  });
  if (!pages.length) pages.push({ page: 1, values: {}, titleBlockNumber: null, readBy: null, ocrConfidence: null, fromTemplate: false });
  const numbers = numberSheets(pages, ctx.fileName, ctx.documentCode);
  const single = pages.length === 1;
  return pages.map((p, i) => {
    const rev = p.values.revision;
    return {
      page: p.page,
      pageCount,
      number: numbers[i]!.number,
      numberSource: numbers[i]!.source,
      title: p.values.title ?? (single ? ctx.description?.trim() || null : null),
      discipline: p.values.discipline ?? fallbackDiscipline(ctx),
      revision: rev ? (normalizeRevision(rev) ?? rev) : null,
      date: p.values.date ?? null,
      readBy: p.readBy,
      ocrConfidence: p.ocrConfidence,
      fromTemplate: p.fromTemplate,
    };
  });
}

/** The single sheet of a DWG/DXF (no title block reading: number from the code or name). */
export function sheetFromCad(ctx: SheetFileContext): ExtractedSheet {
  const [n] = numberSheets([{ page: 1, titleBlockNumber: null }], ctx.fileName, ctx.documentCode);
  return {
    page: 1,
    pageCount: 1,
    number: n!.number,
    numberSource: n!.source,
    title: ctx.description?.trim() || null,
    discipline: fallbackDiscipline(ctx),
    revision: null,
    date: null,
    readBy: null,
    ocrConfidence: null,
    fromTemplate: false,
  };
}
