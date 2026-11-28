/**
 * Drawing sheets (FP-2, docs/features/SHEETS.md): the extraction job, the project's sheet
 * settings, and the visibility-aware reads the routes share.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  CDE_STATES,
  DEFAULT_OCR_REGION,
  DEFAULT_SHEET_STATES,
  SHEET_MAX_PAGES,
  can,
  isSheetFile,
  normalizeTitleBlockTemplate,
  parseName,
  sheetKey,
  splitExtension,
  templateRegion,
  type CdeState,
  type DrawingSheetDto,
  type TitleBlockTemplate,
} from "@sitekeep/shared";
import type { Db } from "../db/index.js";
import { drawingSheetSettings, drawingSheets, fileVersions, files } from "../db/schema.js";
import type { JobQueue } from "../jobs/queue.js";
import type { Storage } from "../core/platform/storage.js";
import { FolderTree, type ProjectAccess } from "../core/security/access.js";
import { cdeStateOf } from "../cde/state.js";
import { extractPdfText } from "../docintel/extract.js";
import { standardForFolder } from "../modules/documents/naming-routes.js";
import { folderDisplayPath } from "../modules/documents/path.js";
import { sheetFromCad, sheetsFromPdf, type ExtractedSheet, type SheetFileContext } from "./extract.js";
import { ocrEnabledForInstance, ocrPdfPages } from "./ocr.js";

export const SHEETS_JOB = "sheets_extract";

type FileRow = typeof files.$inferSelect;
type VersionRow = typeof fileVersions.$inferSelect;
export type SheetRow = typeof drawingSheets.$inferSelect;

export interface SheetSettings {
  states: CdeState[];
  folderIds: string[];
  titleBlock: TitleBlockTemplate | null;
  ocr: boolean;
}

export async function loadSheetSettings(db: Db, projectId: string): Promise<SheetSettings> {
  const [row] = await db.select().from(drawingSheetSettings).where(eq(drawingSheetSettings.projectId, projectId));
  return row
    ? {
        states: row.states.filter((s) => (CDE_STATES as readonly string[]).includes(s)),
        folderIds: row.folderIds,
        titleBlock: normalizeTitleBlockTemplate(row.titleBlock),
        ocr: row.ocr,
      }
    : { states: [...DEFAULT_SHEET_STATES], folderIds: [], titleBlock: null, ocr: true };
}

/** True when files in the folder become sheets: its state is chosen, or it is (below) a chosen folder. */
export function inSheetScope(tree: FolderTree, settings: SheetSettings, folderId: string): boolean {
  if (!tree.byId.has(folderId)) return false;
  const state = cdeStateOf(tree, folderId);
  if (state && settings.states.includes(state)) return true;
  if (!settings.folderIds.length) return false;
  return tree.ancestry(folderId).some((id) => settings.folderIds.includes(id));
}

/** Upload hook: a PDF/DWG/DXF version is queued; the job checks the folder settings. */
export async function queueSheetsFor(jobs: JobQueue, versionId: string, fileName: string): Promise<void> {
  if (isSheetFile(fileName)) await jobs.enqueue(SHEETS_JOB, { versionId });
}

/**
 * Job: splits a drawing version into sheets. Out of scope (folder settings) or deleted: nothing
 * happens. Rows edited by a person keep their number, title and discipline.
 */
export async function processSheets(
  db: Db,
  storage: Storage,
  versionId: string,
  opts: { force?: boolean; log?: (msg: string) => void } = {},
): Promise<number> {
  const [row] = await db
    .select({ v: fileVersions, f: files })
    .from(fileVersions)
    .innerJoin(files, eq(files.id, fileVersions.fileId))
    .where(eq(fileVersions.id, versionId));
  if (!row || row.f.deletedAt || !isSheetFile(row.f.name)) return 0;
  const { v, f } = row;
  const tree = await FolderTree.load(db, f.projectId);
  const settings = await loadSheetSettings(db, f.projectId);
  if (!opts.force && !inSheetScope(tree, settings, f.folderId)) return 0;
  const ctx = await sheetFileContext(db, tree, f);
  const ext = splitExtension(f.name).extension.toLowerCase();
  const extracted =
    ext === "pdf"
      ? await storage.withLocalCopy(v.storageKey, (pdf) => readPdfSheets(db, pdf, ctx, settings, { log: opts.log }))
      : [sheetFromCad(ctx)];
  await saveSheets(db, f, v, extracted);
  return extracted.length;
}

/**
 * Sheets of a PDF: the text layer of its pages, OCR of the title block of scanned pages (when the
 * project and the installation allow it), then the template and the automatic reading. `page`
 * reads that one page only (the template preview).
 */
export async function readPdfSheets(
  db: Db,
  filePath: string,
  ctx: SheetFileContext,
  settings: Pick<SheetSettings, "titleBlock" | "ocr">,
  opts: { page?: number; log?: (msg: string) => void } = {},
): Promise<ExtractedSheet[]> {
  const out = await extractPdfText({ filePath }, { maxPages: opts.page ?? SHEET_MAX_PAGES, timeoutMs: 300_000 });
  if (opts.page) out.pages = out.pages.filter((p) => p.n === opts.page);
  // Scanned pages (no text layer): OCR of the title block.
  const ocr = new Map<number, number>();
  const scanned = out.pages.filter((p) => !p.items.length && p.width > 0 && p.height > 0);
  if (scanned.length && settings.ocr && (await ocrEnabledForInstance(db))) {
    const requests = scanned.map((p) => ({ n: p.n, box: templateRegion(settings.titleBlock, p.width, p.height)?.box ?? DEFAULT_OCR_REGION }));
    const read = await ocrPdfPages(filePath, requests, opts.log);
    for (const p of out.pages) {
      const r = read.get(p.n);
      if (!r) continue;
      p.items = r.items;
      ocr.set(p.n, r.confidence);
    }
  }
  return sheetsFromPdf(out, ctx, { template: settings.titleBlock, ocr });
}

/** Context of a drawing file for numbering and fallbacks (code, name, naming standard, attributes). */
export async function sheetFileContext(db: Db, tree: FolderTree, f: FileRow): Promise<SheetFileContext> {
  const standard = await standardForFolder(db, tree, f.folderId).catch(() => null);
  return {
    fileName: f.name,
    documentCode: f.documentCode,
    description: f.description,
    nameFields: standard ? parseName(standard, f.name) : null,
    attributes: f.attributes,
  };
}

/** Writes the sheets of a version; edited rows keep their metadata. */
export async function saveSheets(db: Db, f: FileRow, v: VersionRow, extracted: ExtractedSheet[]): Promise<void> {
  const existing = await db.select().from(drawingSheets).where(eq(drawingSheets.versionId, v.id));
  const byPage = new Map(existing.map((r) => [r.page, r]));
  for (const s of extracted) {
    const old = byPage.get(s.page);
    const keep = old?.edited;
    const values = {
      projectId: f.projectId,
      fileId: f.id,
      versionId: v.id,
      page: s.page,
      pageCount: s.pageCount,
      number: keep ? old!.number : s.number,
      numberKey: keep ? old!.numberKey : sheetKey(s.number),
      numberSource: keep ? old!.numberSource : s.numberSource,
      title: keep ? old!.title : s.title,
      discipline: keep ? old!.discipline : s.discipline,
      revision: s.revision,
      sheetDate: s.date,
      readBy: s.readBy,
      ocrConfidence: s.ocrConfidence,
      fromTemplate: s.fromTemplate,
      updatedAt: new Date(),
    };
    await db
      .insert(drawingSheets)
      .values(values)
      .onConflictDoUpdate({ target: [drawingSheets.versionId, drawingSheets.page], set: values });
  }
  const pages = new Set(extracted.map((s) => s.page));
  const stale = existing.filter((r) => !pages.has(r.page)).map((r) => r.id);
  if (stale.length) await db.delete(drawingSheets).where(inArray(drawingSheets.id, stale));
}

/** View rule of the documents list: view right on the folder, or the uploader on an upload-only folder. */
export function canSeeFile(tree: FolderTree, a: ProjectAccess, file: Pick<FileRow, "folderId" | "createdBy">): boolean {
  if (!tree.byId.has(file.folderId)) return false;
  const perm = tree.permission(a.principal, file.folderId);
  return can(perm.level, "view") || (perm.canUpload && file.createdBy === a.user.id);
}

export function canEditSheet(tree: FolderTree, a: ProjectAccess, file: Pick<FileRow, "folderId">): boolean {
  if (!tree.byId.has(file.folderId)) return false;
  return can(tree.permission(a.principal, file.folderId).level, "edit");
}

export interface SheetJoined {
  s: SheetRow;
  f: FileRow;
  v: VersionRow;
}

/** Sheets of live files in a project, joined with file and version (optionally by number keys or ids). */
export async function loadSheets(
  db: Db,
  projectId: string,
  where: { keys?: string[]; ids?: string[]; currentOnly?: boolean; fileId?: string; versionId?: string } = {},
): Promise<SheetJoined[]> {
  if (where.keys && !where.keys.length) return [];
  if (where.ids && !where.ids.length) return [];
  const rows = await db
    .select({ s: drawingSheets, f: files, v: fileVersions })
    .from(drawingSheets)
    .innerJoin(files, eq(files.id, drawingSheets.fileId))
    .innerJoin(fileVersions, eq(fileVersions.id, drawingSheets.versionId))
    .where(
      and(
        eq(drawingSheets.projectId, projectId),
        isNull(files.deletedAt),
        where.keys ? inArray(drawingSheets.numberKey, where.keys) : undefined,
        where.ids ? inArray(drawingSheets.id, where.ids) : undefined,
        where.fileId ? eq(drawingSheets.fileId, where.fileId) : undefined,
        where.versionId ? eq(drawingSheets.versionId, where.versionId) : undefined,
      ),
    );
  return where.currentOnly ? rows.filter((r) => r.v.version === r.f.currentVersion) : rows;
}

/** Issue date: title block date, else the upload day. */
function sheetDate(r: SheetJoined): string {
  return r.s.sheetDate ?? r.v.uploadedAt.toISOString().slice(0, 10);
}

export function toSheetDto(tree: FolderTree, r: SheetJoined): DrawingSheetDto {
  const known = tree.byId.has(r.f.folderId);
  return {
    id: r.s.id,
    fileId: r.f.id,
    versionId: r.v.id,
    version: r.v.version,
    current: r.v.version === r.f.currentVersion,
    page: r.s.page,
    pageCount: r.s.pageCount,
    number: r.s.number,
    numberSource: r.s.numberSource,
    title: r.s.title,
    discipline: r.s.discipline,
    // The version's ISO 19650 revision code wins over the one read on the page.
    revision: r.v.revisionCode ?? r.s.revision,
    suitability: r.v.suitabilityCode,
    date: sheetDate(r),
    edited: r.s.edited,
    readBy: r.s.readBy ?? null,
    ocrConfidence: r.s.ocrConfidence ?? null,
    fromTemplate: r.s.fromTemplate,
    fileName: r.f.name,
    folderId: r.f.folderId,
    folderPath: known ? folderDisplayPath(tree, r.f.folderId) : "",
    state: known ? cdeStateOf(tree, r.f.folderId) : null,
    cdeStatus: r.f.cdeStatus,
    format: splitExtension(r.f.name).extension.toLowerCase(),
    uploadedAt: r.v.uploadedAt.toISOString(),
  };
}

const STATE_RANK: Record<string, number> = { published: 3, shared: 2, wip: 1, archived: 0 };

/** Newest first: upload time, then the more advanced state, then the version. */
export function newestFirst(a: DrawingSheetDto, b: DrawingSheetDto): number {
  return (
    b.uploadedAt.localeCompare(a.uploadedAt) ||
    (STATE_RANK[b.state ?? ""] ?? -1) - (STATE_RANK[a.state ?? ""] ?? -1) ||
    b.version - a.version ||
    a.page - b.page
  );
}

/**
 * The sheet a set item stands for: among the current sheets with the number the caller can see,
 * the newest one that is not superseded or withdrawn (else the newest).
 */
export function resolveLatest(candidates: DrawingSheetDto[]): DrawingSheetDto | null {
  const list = [...candidates].sort(newestFirst);
  return list.find((s) => s.cdeStatus !== "superseded" && s.cdeStatus !== "withdrawn") ?? list[0] ?? null;
}
