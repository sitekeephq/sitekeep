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
  canEdit: boolean;
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
