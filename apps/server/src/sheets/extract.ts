/**
 * Sheets of one drawing version (FP-2, docs/features/SHEETS.md): every PDF page is a sheet, its
 * number, title, discipline, revision and date read from the page's title block with the
 * rule-based reader of document intelligence (docintel/antet.ts). DWG/DXF files are one sheet.
 */
import { disciplineFrom, normalizeRevision, numberSheets, type AntetResult, type SheetNumberSource } from "@sitekeep/shared";
import { analyzePage, antetValue } from "../docintel/antet.js";
import type { WorkerOutput } from "../docintel/pdf-worker.js";

export interface ExtractedSheet {
  page: number;
  pageCount: number;
  number: string;
  numberSource: SheetNumberSource;
  title: string | null;
  discipline: string | null;
  revision: string | null;
  date: string | null;
}

export interface SheetFileContext {
  fileName: string;
  documentCode: string | null;
  description: string | null;
  /** Fields of the name parsed with the folder's naming standard (discipline / role). */
  nameFields: Record<string, string> | null;
  attributes: Record<string, string>;
}

/** Discipline when the title block has none: the name's role field, else a discipline attribute. */
function fallbackDiscipline(ctx: SheetFileContext): string | null {
  return disciplineFrom(ctx.nameFields) ?? disciplineFrom(ctx.attributes);
}

/** Sheets of a PDF from its text layer (all pages read). */
export function sheetsFromPdf(out: WorkerOutput, ctx: SheetFileContext): ExtractedSheet[] {
  const pageCount = Math.max(out.pageCount, out.pages.length);
  const pages: { page: number; antet: AntetResult | null; titleBlockNumber: string | null }[] = out.pages.map((p) => {
    const antet = analyzePage(p, pageCount);
    return {
      page: p.n,
      antet,
      // Sheet number first; a drawing number or document number stands in for it.
      titleBlockNumber: antetValue(antet, "sheetNo") ?? antetValue(antet, "drawingNo") ?? antetValue(antet, "docNo"),
    };
  });
  if (!pages.length) pages.push({ page: 1, antet: null, titleBlockNumber: null });
  const numbers = numberSheets(pages, ctx.fileName, ctx.documentCode);
  const single = pages.length === 1;
  return pages.map((p, i) => {
    const title = antetValue(p.antet, "title");
    const rev = antetValue(p.antet, "revision");
    return {
      page: p.page,
      pageCount,
      number: numbers[i]!.number,
      numberSource: numbers[i]!.source,
      title: title ?? (single ? ctx.description?.trim() || null : null),
      discipline: antetValue(p.antet, "discipline") ?? fallbackDiscipline(ctx),
      revision: rev ? (normalizeRevision(rev) ?? rev) : null,
      date: antetValue(p.antet, "date"),
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
  };
}
