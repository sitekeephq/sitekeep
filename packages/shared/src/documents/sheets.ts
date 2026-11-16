/**
 * Drawing sheets (FP-2, docs/features/SHEETS.md): one page of a drawing file version, with its
 * number, title, discipline and revision; sheet sets group sheets and are published as snapshots.
 * Pure rules shared by the server (extraction, exports) and the web app (sorting, labels).
 */
import { foldTr } from "../kernel/attributes.js";
import { splitExtension } from "../kernel/naming.js";
import type { CdeState } from "./cde.js";

/** File extensions that are split into drawing sheets. */
export const SHEET_EXTENSIONS = ["pdf", "dwg", "dxf"] as const;

/** True when files with this name are drawings that become sheets. */
export function isSheetFile(name: string): boolean {
  return (SHEET_EXTENSIONS as readonly string[]).includes(splitExtension(name).extension.toLowerCase());
}

/** States whose folders are scanned for sheets when the project has no settings row. */
export const DEFAULT_SHEET_STATES: CdeState[] = ["shared", "published"];

/** Pages of one PDF read for sheets; later pages are not split. */
export const SHEET_MAX_PAGES = 500;

/** Where a sheet's number came from. */
export type SheetNumberSource = "titleblock" | "code" | "filename" | "manual";

/** How the title block of a page was read: its text layer, or OCR of a scanned page. */
export type SheetReadBy = "text" | "ocr";

/**
 * A rectangle in page-relative coordinates: 0..1 of the page width and height, origin top-left
 * of the page as it is displayed (rotation applied), so one box fits every paper size.
 */
export interface RelBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Fields a title-block template maps. */
export const TITLE_BLOCK_FIELDS = ["number", "title", "revision", "discipline", "date"] as const;
export type TitleBlockFieldKey = (typeof TITLE_BLOCK_FIELDS)[number];

/**
 * Where one field is in the title block: a sub-region (the text inside it, labels dropped) and/or
 * a label keyword (the value next to or below that label inside the title block).
 */
export interface TitleBlockFieldRule {
  key: TitleBlockFieldKey;
  box?: RelBox | null;
  label?: string | null;
}

/** The title block of one paper orientation: its rectangle and the field rules inside it. */
export interface TitleBlockRegion {
  box: RelBox;
  fields: TitleBlockFieldRule[];
}

export type PageOrientation = "landscape" | "portrait";

/** A project's title-block template (drawn on a sample sheet by a project administrator). */
export interface TitleBlockTemplate {
  landscape: TitleBlockRegion | null;
  portrait: TitleBlockRegion | null;
  /** The sheet the template was drawn on. */
  sample?: { versionId: string; page: number } | null;
}

/** OCR reads this part of a scanned page when the project has no title-block region: bottom right. */
export const DEFAULT_OCR_REGION: RelBox = { x0: 0.5, y0: 0.5, x1: 1, y1: 1 };

/** OCR results below this confidence are flagged more strongly in the interface. */
export const OCR_LOW_CONFIDENCE = 0.75;

export function pageOrientation(width: number, height: number): PageOrientation {
  return width >= height ? "landscape" : "portrait";
}

/** The region of a template for a page size (null when the template has none for its orientation). */
export function templateRegion(template: TitleBlockTemplate | null | undefined, width: number, height: number): TitleBlockRegion | null {
  if (!template) return null;
  return template[pageOrientation(width, height)] ?? null;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** A box ordered and clamped to the page; null when it is not a usable rectangle. */
export function normalizeRelBox(b: Partial<RelBox> | null | undefined): RelBox | null {
  if (!b) return null;
  const vals = [b.x0, b.y0, b.x1, b.y1].map((v) => (typeof v === "number" ? v : Number.NaN));
  if (vals.some((v) => !Number.isFinite(v))) return null;
  const [ax, ay, bx, by] = vals.map(clamp01) as [number, number, number, number];
  const r = (v: number) => Math.round(v * 10000) / 10000;
  const box = { x0: r(Math.min(ax, bx)), y0: r(Math.min(ay, by)), x1: r(Math.max(ax, bx)), y1: r(Math.max(ay, by)) };
  return box.x1 - box.x0 < 0.005 || box.y1 - box.y0 < 0.005 ? null : box;
}

/** A template cleaned for saving: boxes normalised, empty rules dropped, one rule per field. */
export function normalizeTitleBlockTemplate(t: TitleBlockTemplate | null | undefined): TitleBlockTemplate | null {
  if (!t) return null;
  const region = (r: TitleBlockRegion | null | undefined): TitleBlockRegion | null => {
    const box = normalizeRelBox(r?.box);
    if (!r || !box) return null;
    const seen = new Set<string>();
    const fields: TitleBlockFieldRule[] = [];
    for (const f of r.fields ?? []) {
      if (!(TITLE_BLOCK_FIELDS as readonly string[]).includes(f.key) || seen.has(f.key)) continue;
      const fb = normalizeRelBox(f.box);
      const label = f.label?.replace(/\s+/g, " ").trim().slice(0, 60) || null;
      if (!fb && !label) continue;
      seen.add(f.key);
      fields.push({ key: f.key, box: fb, label });
    }
    return { box, fields };
  };
  const landscape = region(t.landscape);
  const portrait = region(t.portrait);
  if (!landscape && !portrait) return null;
  return { landscape, portrait, sample: t.sample ?? null };
}

export interface DrawingSheetDto {
  id: string;
  fileId: string;
  versionId: string;
  /** Version number of the file. */
  version: number;
  /** True when the version is the file's current one. */
  current: boolean;
  /** 1-based page of the PDF (1 for DWG/DXF). */
  page: number;
  pageCount: number;
  number: string;
  numberSource: SheetNumberSource;
  title: string | null;
  discipline: string | null;
  revision: string | null;
  suitability: string | null;
  /** Issue date (YYYY-MM-DD): title block date, else the upload date. */
  date: string | null;
  /** Metadata edited by a person: extraction no longer overwrites it. */
  edited: boolean;
  /** How the title block was read (null: nothing could be read, e.g. a scan with OCR off). */
  readBy: SheetReadBy | null;
  /** Mean OCR confidence 0..1 of the words read (OCR only): the interface asks to check the values. */
  ocrConfidence: number | null;
  /** Values came from the project's title-block template. */
  fromTemplate: boolean;
  fileName: string;
  folderId: string;
  folderPath: string;
  state: CdeState | null;
  cdeStatus: string | null;
  /** "pdf", "dwg" or "dxf". */
  format: string;
  uploadedAt: string;
}

export interface DrawingSheetListDto {
  sheets: DrawingSheetDto[];
  total: number;
  /** Distinct values for the filters (of the sheets the caller can see). */
  disciplines: string[];
  revisions: string[];
}

export interface DrawingSheetDetailDto {
  sheet: DrawingSheetDto;
  /** Every sheet with the same number the caller can see, newest first (across versions and files). */
  history: DrawingSheetDto[];
  /** Sets that contain this sheet number. */
  sets: { id: string; name: string }[];
  canEdit: boolean;
  /** Project administrator: may draw the project's title-block template on this sheet. */
  canManage: boolean;
}

export interface DrawingSheetUpdate {
  number?: string;
  title?: string | null;
  discipline?: string | null;
}

export interface SheetSetItemDto {
  /** Key of the sheet in the set: its normalised number. */
  key: string;
  /** The latest visible sheet with this number (null when none is visible or left). */
  sheet: DrawingSheetDto | null;
  number: string;
}

export interface SheetSetPublicationItem {
  sheetId: string;
  fileId: string;
  versionId: string;
  version: number;
  page: number;
  number: string;
  title: string | null;
  discipline: string | null;
  revision: string | null;
  suitability: string | null;
  date: string | null;
  fileName: string;
}

export interface SheetSetPublicationDto {
  id: string;
  /** 1, 2, 3 … per set. */
  issue: number;
  note: string | null;
  publishedBy: string | null;
  publishedByName: string | null;
  publishedAt: string;
  items: SheetSetPublicationItem[];
  /** Items left out because the caller cannot see them. */
  hidden: number;
}

export interface SheetSetSummaryDto {
  id: string;
  name: string;
  description: string | null;
  itemCount: number;
  issue: number | null;
  publishedAt: string | null;
  createdBy: string | null;
  updatedAt: string;
  canManage: boolean;
}

export interface SheetSetDto extends SheetSetSummaryDto {
  items: SheetSetItemDto[];
  /** Items the caller cannot see. */
  hidden: number;
  publications: Omit<SheetSetPublicationDto, "items">[];
}

export interface SheetSettingsDto {
  /** Folder states whose PDFs and DWGs become sheets. */
  states: CdeState[];
  /** Extra folders (with their subfolders) scanned whatever their state. */
  folderIds: string[];
  /** Title-block template (a region per paper orientation); null = automatic reading only. */
  titleBlock: TitleBlockTemplate | null;
  /** OCR of scanned pages in this project (default on). */
  ocr: boolean;
  /** OCR is switched on for the installation (Administration → Privacy). */
  ocrInstance: boolean;
  canEdit: boolean;
}

export interface SheetSettingsInput {
  states?: CdeState[];
  folderIds?: string[];
  titleBlock?: TitleBlockTemplate | null;
  ocr?: boolean;
}

/** What a title-block template reads on one sheet (the editor's "Test on This Sheet"). */
export interface SheetTemplatePreviewDto {
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

/** Installation-wide OCR switch (system administrators). */
export interface SheetOcrAdminDto {
  enabled: boolean;
  /** SITEKEEP_SHEETS_OCR=off on the server: OCR stays off whatever the switch says. */
  disabledByEnv: boolean;
  /** Recognised languages (bundled with the server). */
  languages: string[];
  /** Resolution the title block is rendered at. */
  dpi: number;
}

/** Normalised sheet number: the key that links a sheet across versions, files and sets. */
export function sheetKey(number: string): string {
  return number
    .normalize("NFC")
    .toLocaleUpperCase("tr-TR")
    .replace(/İ/g, "I")
    .replace(/\s+/g, "")
    .trim();
}

/** Natural order of sheet numbers: A-101 < A-102 < A-1001; numbers within compare as numbers. */
export function compareSheetNumbers(a: string, b: string): number {
  return a.localeCompare(b, "en", { numeric: true, sensitivity: "base" });
}

/**
 * Sheet numbers of the pages of one file. A page keeps the number read from its title block;
 * a single-sheet file without one takes the document code, else the file name; the pages of a
 * multi-page file without one take "<code or name>-<page>" (page padded to the page count).
 * Numbers repeated inside the file get "(2)", "(3)" … so every page stays its own sheet.
 */
export function numberSheets(
  pages: { page: number; titleBlockNumber: string | null }[],
  fileName: string,
  documentCode: string | null,
): { page: number; number: string; source: SheetNumberSource }[] {
  const base = documentCode?.trim() || splitExtension(fileName.trim()).base.trim() || fileName;
  const fromCode = !!documentCode?.trim();
  const width = String(pages.length).length;
  const used = new Map<string, number>();
  return pages.map((p) => {
    let number: string;
    let source: SheetNumberSource;
    const read = p.titleBlockNumber?.replace(/\s+/g, " ").trim();
    if (read) {
      number = read;
      source = "titleblock";
    } else if (pages.length === 1) {
      number = base;
      source = fromCode ? "code" : "filename";
    } else {
      number = `${base}-${String(p.page).padStart(Math.max(2, width), "0")}`;
      source = fromCode ? "code" : "filename";
    }
    const key = sheetKey(number);
    const n = (used.get(key) ?? 0) + 1;
    used.set(key, n);
    if (n > 1) number = `${number} (${n})`;
    return { page: p.page, number, source };
  });
}

/** Names of naming-standard fields or attributes that hold a discipline. */
const DISCIPLINE_NAMES = ["disiplin", "discipline", "rol", "role", "bolum"];

/** Discipline from parsed name fields or attributes ("Rol: A", "Disiplin: Mimari"); null when none. */
export function disciplineFrom(fields: Record<string, string> | null | undefined): string | null {
  if (!fields) return null;
  for (const [k, v] of Object.entries(fields)) {
    const key = foldTr(k).normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
    if (DISCIPLINE_NAMES.includes(key) && v?.trim()) return v.trim();
  }
  return null;
}

/** File name of a sheet list export: "<project>-sheet-list" / "<project>-<set>-issue-03". */
export function sheetExportName(projectCode: string, setName?: string | null, issue?: number | null): string {
  const clean = (s: string) => s.replace(/[\\/:*?"<>|]/g, "_").trim();
  const parts = [clean(projectCode)];
  if (setName) parts.push(clean(setName));
  if (issue) parts.push(`issue-${String(issue).padStart(2, "0")}`);
  return parts.join("-");
}
