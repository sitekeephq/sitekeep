/**
 * Drawing sheets and sheet sets (FP-2, docs/features/SHEETS.md):
 *   GET   /projects/:pid/sheets                          list/search (q, discipline, revision, state, setId, all, limit, offset)
 *   GET   /projects/:pid/sheets/export?format=csv|xlsx   sheet list ("pafta listesi") of the same filters
 *   POST  /projects/:pid/sheets/rescan                   project administrators: queue the files in scope
 *   GET   /projects/:pid/sheets/:sid                     detail with history across versions and files
 *   PATCH /projects/:pid/sheets/:sid                     { number?, title?, discipline? } (edit right on the folder)
 *   GET   /projects/:pid/versions/:vid/sheets            sheets of one version
 *   POST  /projects/:pid/versions/:vid/sheets/extract    read the sheets again (edit right on the folder)
 *   POST  /projects/:pid/sheets/:sid/template-preview    project administrators: what a title-block template reads here
 *   GET   /projects/:pid/sheet-settings                  members; PUT: project administrators (states, folders,
 *                                                         title-block template, OCR switch)
 *   GET   /admin/sheets-ocr                              system administrators: the installation's OCR switch; PUT { enabled }
 *   GET   /projects/:pid/sheet-sets                      sets
 *   POST  /projects/:pid/sheet-sets                      { name, description?, sheetIds? }
 *   GET   /projects/:pid/sheet-sets/:setId               set with its items and issues
 *   PATCH /projects/:pid/sheet-sets/:setId               { name?, description? }
 *   DELETE /projects/:pid/sheet-sets/:setId
 *   POST  /projects/:pid/sheet-sets/:setId/items         { sheetIds } add
 *   POST  /projects/:pid/sheet-sets/:setId/items/remove  { keys } remove
 *   POST  /projects/:pid/sheet-sets/:setId/publish       { note? } snapshot → next issue
 *   GET   /projects/:pid/sheet-sets/:setId/issues/:issue a published issue
 *   GET   /projects/:pid/sheet-sets/:setId/export?format=csv|xlsx&issue=n
 *   GET   /projects/:pid/sheet-sets/:setId/zip?issue=n   PDFs (and DWGs) of the set as a zip
 * Visibility follows the documents list (FolderTree, task-team WIP rule included). Set changes and
 * publications are audited (sheet_set.*), sheet edits too (sheet.updated).
 */
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  CDE_STATES,
  TITLE_BLOCK_FIELDS,
  compareSheetNumbers,
  foldTr,
  normalizeTitleBlockTemplate,
  sheetExportName,
  sheetKey,
  type DrawingSheetDetailDto,
  type SheetOcrAdminDto,
  type SheetTemplatePreviewDto,
  type DrawingSheetDto,
  type DrawingSheetListDto,
  type SheetSetDto,
  type SheetSetItemDto,
  type SheetSetPublicationDto,
  type SheetSetPublicationItem,
  type SheetSetSummaryDto,
  type SheetSettingsDto,
} from "@sitekeep/shared";
import type { ResolvedDeps } from "../app/deps.js";
import { FolderTree, isUuid, projectAccess, requireProjectAdmin, userNames, type ProjectAccess } from "../core/security/access.js";
import { audit } from "../core/platform/audit.js";
import { badRequest, conflict, forbidden, notFound } from "../core/platform/http.js";
import { drawingSheetSettings, drawingSheets, fileVersions, files, sheetSetItems, sheetSetPublications, sheetSets } from "../db/schema.js";
import { msg, tReq } from "../i18n/index.js";
import { sendZip } from "../modules/documents/zip.js";
import { sheetListRows, sheetListColumns, sendSheetList } from "./export.js";
import {
  SHEETS_JOB,
  canEditSheet,
  canSeeFile,
  inSheetScope,
  loadSheetSettings,
  loadSheets,
  newestFirst,
  processSheets,
  readPdfSheets,
  sheetFileContext,
  resolveLatest,
  toSheetDto,
  type SheetJoined,
} from "./service.js";
import { OCR_DPI, OCR_LANGUAGES, ocrDisabledByEnv, ocrEnabledForInstance, ocrInstanceSwitch, setOcrInstanceSwitch } from "./ocr.js";

type SetRow = typeof sheetSets.$inferSelect;

const listQuery = z.object({
  q: z.string().max(200).optional(),
  discipline: z.string().max(100).optional(),
  revision: z.string().max(40).optional(),
  state: z.enum([...CDE_STATES, "none"]).optional(),
  setId: z.string().uuid().optional(),
  folderId: z.string().uuid().optional(),
  /** "1": every version's sheets, not only the current versions'. */
  all: z.enum(["0", "1"]).optional(),
  limit: z.coerce.number().int().min(1).max(5000).default(1000),
  offset: z.coerce.number().int().min(0).default(0),
});
type ListQuery = z.infer<typeof listQuery>;

const updateSchema = z
  .object({
    number: z.string().trim().min(1).max(120),
    title: z.string().trim().max(300).nullable(),
    discipline: z.string().trim().max(100).nullable(),
  })
  .partial()
  .strict();

const setSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).nullable().optional(),
  sheetIds: z.array(z.string().uuid()).max(5000).optional(),
});
const setPatchSchema = z.object({ name: z.string().trim().min(1).max(120), description: z.string().trim().max(1000).nullable() }).partial().strict();
const relBox = z.object({ x0: z.number(), y0: z.number(), x1: z.number(), y1: z.number() });
const regionSchema = z.object({
  box: relBox,
  fields: z
    .array(
      z.object({
        key: z.enum(TITLE_BLOCK_FIELDS),
        box: relBox.nullable().optional(),
        label: z.string().max(60).nullable().optional(),
      }),
    )
    .max(TITLE_BLOCK_FIELDS.length * 2),
});
const settingsSchema = z
  .object({
    states: z.array(z.enum(CDE_STATES)).max(CDE_STATES.length),
    folderIds: z.array(z.string().uuid()).max(200),
    titleBlock: z
      .object({
        landscape: regionSchema.nullable(),
        portrait: regionSchema.nullable(),
        sample: z.object({ versionId: z.string().uuid(), page: z.number().int().min(1) }).nullable().optional(),
      })
      .nullable(),
    ocr: z.boolean(),
  })
  .partial()
  .strict();

const fold = (s: string) => foldTr(s);

export async function sheetRoutes(api: FastifyInstance, deps: ResolvedDeps) {
  const { db, storage, jobs } = deps;
  jobs.register(SHEETS_JOB, async (job) => {
    await processSheets(db, storage, String(job.payload.versionId), {
      force: job.payload.force === true,
      log: (m) => api.log.warn({ versionId: job.payload.versionId }, m),
    });
  });

  /** Visible sheets of the project (current versions unless `all`). */
  async function visibleSheets(tree: FolderTree, a: ProjectAccess, opts: { all?: boolean; keys?: string[] } = {}): Promise<DrawingSheetDto[]> {
    const rows = await loadSheets(db, a.project.id, { currentOnly: !opts.all, keys: opts.keys });
    return rows.filter((r) => canSeeFile(tree, a, r.f)).map((r) => toSheetDto(tree, r));
  }

  async function setKeys(setId: string): Promise<string[]> {
    const rows = await db.select({ k: sheetSetItems.numberKey }).from(sheetSetItems).where(eq(sheetSetItems.setId, setId));
    return rows.map((r) => r.k);
  }

  async function filtered(tree: FolderTree, a: ProjectAccess, q: ListQuery): Promise<DrawingSheetDto[]> {
    let keys: Set<string> | null = null;
    if (q.setId) {
      await loadSet(a, q.setId);
      keys = new Set(await setKeys(q.setId));
    }
    const all = await visibleSheets(tree, a, { all: q.all === "1" });
    const text = q.q?.trim() ? fold(q.q.trim()) : null;
    const below = q.folderId && tree.byId.has(q.folderId) ? new Set([q.folderId, ...tree.descendants(q.folderId)]) : null;
    return all
      .filter((s) => !keys || keys.has(sheetKey(s.number)))
      .filter((s) => !q.discipline || s.discipline === q.discipline)
      .filter((s) => !q.revision || s.revision === q.revision)
      .filter((s) => !q.state || (q.state === "none" ? s.state === null : s.state === q.state))
      .filter((s) => !below || below.has(s.folderId))
      .filter((s) => !text || fold(`${s.number} ${s.title ?? ""} ${s.fileName} ${s.discipline ?? ""}`).includes(text))
      .sort((x, y) => compareSheetNumbers(x.number, y.number) || newestFirst(x, y));
  }

  api.get<{ Params: { pid: string }; Querystring: Record<string, string> }>("/projects/:pid/sheets", async (req): Promise<DrawingSheetListDto> => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const q = listQuery.parse(req.query);
    const tree = await FolderTree.load(db, a.project.id);
    const list = await filtered(tree, a, q);
    // Filter values of every visible current sheet (not only of this page of results).
    const base = await visibleSheets(tree, a, { all: q.all === "1" });
    const uniq = (v: (string | null)[]) => [...new Set(v.filter((x): x is string => !!x))].sort((x, y) => compareSheetNumbers(x, y));
    return {
      sheets: list.slice(q.offset, q.offset + q.limit),
      total: list.length,
      disciplines: uniq(base.map((s) => s.discipline)),
      revisions: uniq(base.map((s) => s.revision)),
    };
  });

  api.get<{ Params: { pid: string }; Querystring: Record<string, string> }>("/projects/:pid/sheets/export", async (req, reply) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const { format = "csv", ...rest } = req.query;
    const q = listQuery.parse({ ...rest, limit: 5000 });
    const tree = await FolderTree.load(db, a.project.id);
    const list = await filtered(tree, a, q);
    const t = tReq(req);
    const name = sheetExportName(a.project.code, t("sheets:export.listName"));
    return sendSheetList(reply, format, name, t("sheets:export.sheetName"), sheetListColumns(t), sheetListRows(list, t));
  });

  api.post<{ Params: { pid: string } }>("/projects/:pid/sheets/rescan", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    requireProjectAdmin(a);
    const tree = await FolderTree.load(db, a.project.id);
    const settings = await loadSheetSettings(db, a.project.id);
    const rows = await db
      .select({ f: files, vid: fileVersions.id })
      .from(files)
      .innerJoin(fileVersions, and(eq(fileVersions.fileId, files.id), eq(fileVersions.version, files.currentVersion)))
      .where(and(eq(files.projectId, a.project.id), isNull(files.deletedAt)));
    let queued = 0;
    for (const r of rows) {
      if (!/\.(pdf|dwg|dxf)$/i.test(r.f.name) || !inSheetScope(tree, settings, r.f.folderId)) continue;
      await jobs.enqueue(SHEETS_JOB, { versionId: r.vid });
      queued++;
    }
    await audit(db, { projectId: a.project.id, userId: a.user.id, action: "sheet.rescanned", targetType: "project", targetId: a.project.id, details: { queued } });
    return { queued };
  });

  async function loadSheet(tree: FolderTree, a: ProjectAccess, sid: string): Promise<SheetJoined> {
    if (!isUuid(sid)) throw notFound(msg("sheets:entities.sheet"));
    const [row] = await loadSheets(db, a.project.id, { ids: [sid] });
    if (!row || !canSeeFile(tree, a, row.f)) throw notFound(msg("sheets:entities.sheet"));
    return row;
  }

  api.get<{ Params: { pid: string; sid: string } }>("/projects/:pid/sheets/:sid", async (req): Promise<DrawingSheetDetailDto> => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const tree = await FolderTree.load(db, a.project.id);
    const row = await loadSheet(tree, a, req.params.sid);
    const history = (await visibleSheets(tree, a, { all: true, keys: [row.s.numberKey] })).sort(newestFirst);
    const sets = await db
      .select({ id: sheetSets.id, name: sheetSets.name })
      .from(sheetSetItems)
      .innerJoin(sheetSets, eq(sheetSets.id, sheetSetItems.setId))
      .where(and(eq(sheetSets.projectId, a.project.id), eq(sheetSetItems.numberKey, row.s.numberKey)))
      .orderBy(asc(sheetSets.name));
    return { sheet: toSheetDto(tree, row), history, sets, canEdit: canEditSheet(tree, a, row.f), canManage: a.isProjectAdmin };
  });

  api.patch<{ Params: { pid: string; sid: string } }>("/projects/:pid/sheets/:sid", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const tree = await FolderTree.load(db, a.project.id);
    const row = await loadSheet(tree, a, req.params.sid);
    if (!canEditSheet(tree, a, row.f)) throw forbidden(msg("sheets:errors.editDenied"));
    const body = updateSchema.parse(req.body ?? {});
    const set: Partial<typeof drawingSheets.$inferInsert> = { edited: true, editedBy: a.user.id, editedAt: new Date(), updatedAt: new Date() };
    if (body.number !== undefined) {
      set.number = body.number;
      set.numberKey = sheetKey(body.number);
      set.numberSource = "manual";
    }
    if (body.title !== undefined) set.title = body.title || null;
    if (body.discipline !== undefined) set.discipline = body.discipline || null;
    await db.update(drawingSheets).set(set).where(eq(drawingSheets.id, row.s.id));
    const before = { number: row.s.number, title: row.s.title, discipline: row.s.discipline };
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "sheet.updated",
      targetType: "file",
      targetId: row.f.id,
      details: { sheetId: row.s.id, page: row.s.page, version: row.v.version, before, after: body },
    });
    const [updated] = await loadSheets(db, a.project.id, { ids: [row.s.id] });
    return toSheetDto(tree, updated!);
  });

  /** What a title-block template (not saved yet) reads on this sheet; scanned pages are read by OCR. */
  api.post<{ Params: { pid: string; sid: string } }>("/projects/:pid/sheets/:sid/template-preview", async (req): Promise<SheetTemplatePreviewDto> => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    requireProjectAdmin(a);
    const tree = await FolderTree.load(db, a.project.id);
    const row = await loadSheet(tree, a, req.params.sid);
    if (!/\.pdf$/i.test(row.f.name)) throw badRequest(msg("sheets:errors.notPdf"));
    const body = z.object({ titleBlock: settingsSchema.shape.titleBlock.unwrap() }).strict().parse(req.body ?? {});
    const settings = await loadSheetSettings(db, a.project.id);
    const titleBlock = normalizeTitleBlockTemplate(body.titleBlock);
    const ctx = await sheetFileContext(db, tree, row.f);
    const [s] = await readPdfSheets(db, storage.localPath(row.v.storageKey), ctx, { titleBlock, ocr: settings.ocr }, { page: row.s.page });
    if (!s) throw notFound(msg("sheets:entities.sheet"));
    const { page: _p, pageCount: _c, ...values } = s;
    return values;
  });

  async function loadVersionFile(a: ProjectAccess, tree: FolderTree, vid: string) {
    if (!isUuid(vid)) throw notFound(msg("sheets:entities.version"));
    const [row] = await db
      .select({ v: fileVersions, f: files })
      .from(fileVersions)
      .innerJoin(files, eq(files.id, fileVersions.fileId))
      .where(and(eq(fileVersions.id, vid), eq(files.projectId, a.project.id), isNull(files.deletedAt)));
    if (!row || !canSeeFile(tree, a, row.f)) throw notFound(msg("sheets:entities.version"));
    return row;
  }

  api.get<{ Params: { pid: string; vid: string } }>("/projects/:pid/versions/:vid/sheets", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const tree = await FolderTree.load(db, a.project.id);
    const { v, f } = await loadVersionFile(a, tree, req.params.vid);
    const rows = await loadSheets(db, a.project.id, { versionId: v.id });
    return {
      sheets: rows.map((r) => toSheetDto(tree, r)).sort((x, y) => x.page - y.page),
      inScope: inSheetScope(tree, await loadSheetSettings(db, a.project.id), f.folderId),
      canEdit: canEditSheet(tree, a, f),
    };
  });

  api.post<{ Params: { pid: string; vid: string } }>("/projects/:pid/versions/:vid/sheets/extract", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const tree = await FolderTree.load(db, a.project.id);
    const { v, f } = await loadVersionFile(a, tree, req.params.vid);
    if (!canEditSheet(tree, a, f)) throw forbidden(msg("sheets:errors.editDenied"));
    if (!/\.(pdf|dwg|dxf)$/i.test(f.name)) throw badRequest(msg("sheets:errors.notDrawing"));
    // Asked for explicitly: read even outside the folders of the settings.
    await jobs.enqueue(SHEETS_JOB, { versionId: v.id, force: true });
    return { queued: true };
  });

  // ---- settings ----------------------------------------------------------------------------

  api.get<{ Params: { pid: string } }>("/projects/:pid/sheet-settings", async (req): Promise<SheetSettingsDto> => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const s = await loadSheetSettings(db, a.project.id);
    return { ...s, ocrInstance: await ocrEnabledForInstance(db), canEdit: a.isProjectAdmin };
  });

  api.put<{ Params: { pid: string } }>("/projects/:pid/sheet-settings", async (req): Promise<SheetSettingsDto> => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    requireProjectAdmin(a);
    const body = settingsSchema.parse(req.body ?? {});
    const before = await loadSheetSettings(db, a.project.id);
    const tree = await FolderTree.load(db, a.project.id);
    if (body.folderIds?.some((id) => !tree.byId.has(id))) throw badRequest(msg("sheets:errors.unknownFolder"));
    const titleBlock = body.titleBlock === undefined ? before.titleBlock : normalizeTitleBlockTemplate(body.titleBlock);
    if (body.titleBlock && !titleBlock) throw badRequest(msg("sheets:errors.badTemplate"));
    const next = {
      states: [...new Set(body.states ?? before.states)],
      folderIds: [...new Set(body.folderIds ?? before.folderIds)],
      titleBlock,
      ocr: body.ocr ?? before.ocr,
    };
    await db
      .insert(drawingSheetSettings)
      .values({ projectId: a.project.id, ...next })
      .onConflictDoUpdate({ target: drawingSheetSettings.projectId, set: { ...next, updatedAt: new Date() } });
    await audit(db, { projectId: a.project.id, userId: a.user.id, action: "sheet.settings_updated", targetType: "project", targetId: a.project.id, details: { before, after: next } });
    return { ...next, ocrInstance: await ocrEnabledForInstance(db), canEdit: true };
  });

  // ---- installation OCR switch (system administrators) ----------------------------------------

  const ocrAdmin = async (): Promise<SheetOcrAdminDto> => ({
    enabled: await ocrInstanceSwitch(db),
    disabledByEnv: ocrDisabledByEnv(),
    languages: [...OCR_LANGUAGES],
    dpi: OCR_DPI,
  });

  api.get("/admin/sheets-ocr", async (req): Promise<SheetOcrAdminDto> => {
    if (!req.user?.isAdmin) throw forbidden(msg("admin:errors.adminOnly"));
    return ocrAdmin();
  });

  api.put("/admin/sheets-ocr", async (req): Promise<SheetOcrAdminDto> => {
    if (!req.user?.isAdmin) throw forbidden(msg("admin:errors.adminOnly"));
    const body = z.object({ enabled: z.boolean() }).strict().parse(req.body ?? {});
    const before = await ocrInstanceSwitch(db);
    await setOcrInstanceSwitch(db, body.enabled, req.user.id);
    await audit(db, { userId: req.user.id, action: "settings.sheets_ocr_updated", details: { before, after: body.enabled } });
    return ocrAdmin();
  });

  // ---- sets --------------------------------------------------------------------------------

  async function loadSet(a: ProjectAccess, setId: string): Promise<SetRow> {
    if (!isUuid(setId)) throw notFound(msg("sheets:entities.set"));
    const [row] = await db.select().from(sheetSets).where(and(eq(sheetSets.id, setId), eq(sheetSets.projectId, a.project.id)));
    if (!row) throw notFound(msg("sheets:entities.set"));
    return row;
  }

  const canManage = (a: ProjectAccess, s: SetRow) => a.isProjectAdmin || s.createdBy === a.user.id;
  function requireManage(a: ProjectAccess, s: SetRow) {
    if (!canManage(a, s)) throw forbidden(msg("sheets:errors.setManageDenied"));
  }

  async function latestIssues(projectId: string) {
    const rows = await db
      .select({ setId: sheetSetPublications.setId, issue: sheetSetPublications.issue, publishedAt: sheetSetPublications.publishedAt })
      .from(sheetSetPublications)
      .where(eq(sheetSetPublications.projectId, projectId));
    const out = new Map<string, { issue: number; publishedAt: Date }>();
    for (const r of rows) if (!out.has(r.setId) || out.get(r.setId)!.issue < r.issue) out.set(r.setId, { issue: r.issue, publishedAt: r.publishedAt });
    return out;
  }

  function summary(a: ProjectAccess, s: SetRow, count: number, last?: { issue: number; publishedAt: Date }): SheetSetSummaryDto {
    return {
      id: s.id,
      name: s.name,
      description: s.description,
      itemCount: count,
      issue: last?.issue ?? null,
      publishedAt: last?.publishedAt.toISOString() ?? null,
      createdBy: s.createdBy,
      updatedAt: s.updatedAt.toISOString(),
      canManage: canManage(a, s),
    };
  }

  /** The set's items resolved to the caller's visible sheets; items with only hidden sheets are counted, not listed. */
  async function resolveItems(tree: FolderTree, a: ProjectAccess, setId: string): Promise<{ items: SheetSetItemDto[]; hidden: number }> {
    const items = await db.select().from(sheetSetItems).where(eq(sheetSetItems.setId, setId)).orderBy(asc(sheetSetItems.position), asc(sheetSetItems.number));
    const keys = items.map((i) => i.numberKey);
    const rows = await loadSheets(db, a.project.id, { currentOnly: true, keys });
    const anyByKey = new Set(rows.map((r) => r.s.numberKey));
    const visible = new Map<string, DrawingSheetDto[]>();
    for (const r of rows) {
      if (!canSeeFile(tree, a, r.f)) continue;
      const list = visible.get(r.s.numberKey) ?? [];
      list.push(toSheetDto(tree, r));
      visible.set(r.s.numberKey, list);
    }
    let hidden = 0;
    const out: SheetSetItemDto[] = [];
    for (const i of items) {
      const sheet = resolveLatest(visible.get(i.numberKey) ?? []);
      if (!sheet && anyByKey.has(i.numberKey)) {
        hidden++;
        continue;
      }
      out.push({ key: i.numberKey, number: sheet?.number ?? i.number, sheet });
    }
    out.sort((x, y) => compareSheetNumbers(x.number, y.number));
    return { items: out, hidden };
  }

  async function setDto(tree: FolderTree, a: ProjectAccess, s: SetRow): Promise<SheetSetDto> {
    const { items, hidden } = await resolveItems(tree, a, s.id);
    const pubs = await db.select().from(sheetSetPublications).where(eq(sheetSetPublications.setId, s.id)).orderBy(desc(sheetSetPublications.issue));
    const fileFolders = await loadFileFolders(pubs.flatMap((p) => p.items.map((i) => i.fileId)));
    const names = await userNames(db, pubs.map((p) => p.publishedBy));
    const last = pubs[0];
    return {
      ...summary(a, s, items.length + hidden, last ? { issue: last.issue, publishedAt: last.publishedAt } : undefined),
      items,
      hidden,
      publications: pubs.map((p) => ({
        id: p.id,
        issue: p.issue,
        note: p.note,
        publishedBy: p.publishedBy,
        publishedByName: p.publishedBy ? (names.get(p.publishedBy) ?? null) : null,
        publishedAt: p.publishedAt.toISOString(),
        hidden: p.items.filter((it) => !visibleItem(tree, a, it, fileFolders)).length,
      })),
    };
  }

  type FileFolders = Map<string, { folderId: string; createdBy: string | null }>;
  /** Folder and uploader of the live files referenced by publications. */
  async function loadFileFolders(ids: string[]): Promise<FileFolders> {
    const out: FileFolders = new Map();
    const unique = [...new Set(ids)].filter(isUuid);
    if (!unique.length) return out;
    const rows = await db
      .select({ id: files.id, folderId: files.folderId, createdBy: files.createdBy })
      .from(files)
      .where(and(inArray(files.id, unique), isNull(files.deletedAt)));
    for (const r of rows) out.set(r.id, { folderId: r.folderId, createdBy: r.createdBy });
    return out;
  }
  function visibleItem(tree: FolderTree, a: ProjectAccess, it: SheetSetPublicationItem, map: FileFolders): boolean {
    const f = map.get(it.fileId);
    return !!f && canSeeFile(tree, a, f);
  }

  api.get<{ Params: { pid: string } }>("/projects/:pid/sheet-sets", async (req): Promise<{ sets: SheetSetSummaryDto[] }> => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const sets = await db.select().from(sheetSets).where(eq(sheetSets.projectId, a.project.id)).orderBy(asc(sheetSets.name));
    const counts = await db
      .select({ setId: sheetSetItems.setId, n: sql<number>`count(*)::int` })
      .from(sheetSetItems)
      .innerJoin(sheetSets, eq(sheetSets.id, sheetSetItems.setId))
      .where(eq(sheetSets.projectId, a.project.id))
      .groupBy(sheetSetItems.setId);
    const byId = new Map(counts.map((c) => [c.setId, Number(c.n)]));
    const last = await latestIssues(a.project.id);
    return { sets: sets.map((s) => summary(a, s, byId.get(s.id) ?? 0, last.get(s.id))) };
  });

  /** Number keys of sheets the caller can see, by sheet id. */
  async function keysOf(tree: FolderTree, a: ProjectAccess, sheetIds: string[]): Promise<{ key: string; number: string }[]> {
    const rows = await loadSheets(db, a.project.id, { ids: [...new Set(sheetIds)] });
    const seen = rows.filter((r) => canSeeFile(tree, a, r.f));
    if (seen.length !== new Set(sheetIds).size) throw notFound(msg("sheets:entities.sheet"));
    const out = new Map<string, string>();
    for (const r of seen) out.set(r.s.numberKey, r.s.number);
    return [...out].map(([key, number]) => ({ key, number }));
  }

  async function addItems(setId: string, userId: string, items: { key: string; number: string }[]): Promise<number> {
    if (!items.length) return 0;
    const [{ max } = { max: 0 }] = await db
      .select({ max: sql<number>`coalesce(max(${sheetSetItems.position}), 0)::int` })
      .from(sheetSetItems)
      .where(eq(sheetSetItems.setId, setId));
    const rows = await db
      .insert(sheetSetItems)
      .values(items.map((i, n) => ({ setId, numberKey: i.key, number: i.number, position: Number(max) + n + 1, addedBy: userId })))
      .onConflictDoNothing()
      .returning({ k: sheetSetItems.numberKey });
    return rows.length;
  }

  api.post<{ Params: { pid: string } }>("/projects/:pid/sheet-sets", async (req, reply) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const body = setSchema.parse(req.body ?? {});
    const tree = await FolderTree.load(db, a.project.id);
    const items = body.sheetIds?.length ? await keysOf(tree, a, body.sheetIds) : [];
    const [dupe] = await db
      .select({ id: sheetSets.id })
      .from(sheetSets)
      .where(and(eq(sheetSets.projectId, a.project.id), sql`lower(${sheetSets.name}) = lower(${body.name})`));
    if (dupe) throw conflict(msg("sheets:errors.setNameTaken", { name: body.name }));
    const [row] = await db
      .insert(sheetSets)
      .values({ projectId: a.project.id, name: body.name, description: body.description ?? null, createdBy: a.user.id })
      .returning();
    const added = await addItems(row!.id, a.user.id, items);
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "sheet_set.created",
      targetType: "sheet_set",
      targetId: row!.id,
      details: { name: row!.name, items: added },
    });
    reply.status(201);
    return setDto(tree, a, row!);
  });

  api.get<{ Params: { pid: string; setId: string } }>("/projects/:pid/sheet-sets/:setId", async (req): Promise<SheetSetDto> => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const s = await loadSet(a, req.params.setId);
    const tree = await FolderTree.load(db, a.project.id);
    return setDto(tree, a, s);
  });

  api.patch<{ Params: { pid: string; setId: string } }>("/projects/:pid/sheet-sets/:setId", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const s = await loadSet(a, req.params.setId);
    requireManage(a, s);
    const body = setPatchSchema.parse(req.body ?? {});
    if (body.name && body.name.toLocaleLowerCase() !== s.name.toLocaleLowerCase()) {
      const [dupe] = await db
        .select({ id: sheetSets.id })
        .from(sheetSets)
        .where(and(eq(sheetSets.projectId, a.project.id), sql`lower(${sheetSets.name}) = lower(${body.name})`));
      if (dupe) throw conflict(msg("sheets:errors.setNameTaken", { name: body.name }));
    }
    const [row] = await db
      .update(sheetSets)
      .set({ ...(body.name ? { name: body.name } : {}), ...(body.description !== undefined ? { description: body.description || null } : {}), updatedAt: new Date() })
      .where(eq(sheetSets.id, s.id))
      .returning();
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "sheet_set.updated",
      targetType: "sheet_set",
      targetId: s.id,
      details: { before: { name: s.name, description: s.description }, after: body },
    });
    const tree = await FolderTree.load(db, a.project.id);
    return setDto(tree, a, row!);
  });

  api.delete<{ Params: { pid: string; setId: string } }>("/projects/:pid/sheet-sets/:setId", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const s = await loadSet(a, req.params.setId);
    requireManage(a, s);
    await db.delete(sheetSets).where(eq(sheetSets.id, s.id));
    await audit(db, { projectId: a.project.id, userId: a.user.id, action: "sheet_set.deleted", targetType: "sheet_set", targetId: s.id, details: { name: s.name } });
    return { ok: true };
  });

  api.post<{ Params: { pid: string; setId: string } }>("/projects/:pid/sheet-sets/:setId/items", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const s = await loadSet(a, req.params.setId);
    requireManage(a, s);
    const { sheetIds } = z.object({ sheetIds: z.array(z.string().uuid()).min(1).max(5000) }).parse(req.body ?? {});
    const tree = await FolderTree.load(db, a.project.id);
    const items = await keysOf(tree, a, sheetIds);
    const added = await addItems(s.id, a.user.id, items);
    await db.update(sheetSets).set({ updatedAt: new Date() }).where(eq(sheetSets.id, s.id));
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "sheet_set.items_added",
      targetType: "sheet_set",
      targetId: s.id,
      details: { name: s.name, numbers: items.map((i) => i.number).slice(0, 500), added },
    });
    return { added };
  });

  api.post<{ Params: { pid: string; setId: string } }>("/projects/:pid/sheet-sets/:setId/items/remove", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const s = await loadSet(a, req.params.setId);
    requireManage(a, s);
    const { keys } = z.object({ keys: z.array(z.string().min(1).max(200)).min(1).max(5000) }).parse(req.body ?? {});
    const removed = await db
      .delete(sheetSetItems)
      .where(and(eq(sheetSetItems.setId, s.id), inArray(sheetSetItems.numberKey, keys)))
      .returning({ number: sheetSetItems.number });
    await db.update(sheetSets).set({ updatedAt: new Date() }).where(eq(sheetSets.id, s.id));
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "sheet_set.items_removed",
      targetType: "sheet_set",
      targetId: s.id,
      details: { name: s.name, numbers: removed.map((r) => r.number).slice(0, 500) },
    });
    return { removed: removed.length };
  });

  api.post<{ Params: { pid: string; setId: string } }>("/projects/:pid/sheet-sets/:setId/publish", async (req): Promise<SheetSetPublicationDto> => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const s = await loadSet(a, req.params.setId);
    requireManage(a, s);
    const { note } = z.object({ note: z.string().trim().max(1000).nullable().optional() }).parse(req.body ?? {});
    const tree = await FolderTree.load(db, a.project.id);
    const { items, hidden } = await resolveItems(tree, a, s.id);
    const snapshot: SheetSetPublicationItem[] = items
      .filter((i): i is SheetSetItemDto & { sheet: DrawingSheetDto } => !!i.sheet)
      .map(({ sheet }) => ({
        sheetId: sheet.id,
        fileId: sheet.fileId,
        versionId: sheet.versionId,
        version: sheet.version,
        page: sheet.page,
        number: sheet.number,
        title: sheet.title,
        discipline: sheet.discipline,
        revision: sheet.revision,
        suitability: sheet.suitability,
        date: sheet.date,
        fileName: sheet.fileName,
      }));
    if (!snapshot.length) throw badRequest(msg("sheets:errors.emptySet"));
    const [{ max } = { max: 0 }] = await db
      .select({ max: sql<number>`coalesce(max(${sheetSetPublications.issue}), 0)::int` })
      .from(sheetSetPublications)
      .where(eq(sheetSetPublications.setId, s.id));
    const [pub] = await db
      .insert(sheetSetPublications)
      .values({ setId: s.id, projectId: a.project.id, issue: Number(max) + 1, note: note ?? null, items: snapshot, publishedBy: a.user.id })
      .returning();
    await db.update(sheetSets).set({ updatedAt: new Date() }).where(eq(sheetSets.id, s.id));
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "sheet_set.published",
      targetType: "sheet_set",
      targetId: s.id,
      details: {
        name: s.name,
        issue: pub!.issue,
        note: pub!.note,
        count: snapshot.length,
        skipped: items.length - snapshot.length + hidden,
        sheets: snapshot.slice(0, 500).map((i) => ({ number: i.number, revision: i.revision, versionId: i.versionId, page: i.page })),
      },
    });
    const names = await userNames(db, [a.user.id]);
    return {
      id: pub!.id,
      issue: pub!.issue,
      note: pub!.note,
      publishedBy: a.user.id,
      publishedByName: names.get(a.user.id) ?? null,
      publishedAt: pub!.publishedAt.toISOString(),
      items: snapshot,
      hidden: 0,
    };
  });

  async function loadIssue(tree: FolderTree, a: ProjectAccess, s: SetRow, issue: number): Promise<SheetSetPublicationDto> {
    const [p] = await db
      .select()
      .from(sheetSetPublications)
      .where(and(eq(sheetSetPublications.setId, s.id), eq(sheetSetPublications.issue, issue)));
    if (!p) throw notFound(msg("sheets:entities.issue"));
    const fileFolders = await loadFileFolders(p.items.map((i) => i.fileId));
    const items = p.items.filter((i) => visibleItem(tree, a, i, fileFolders));
    const names = await userNames(db, [p.publishedBy]);
    return {
      id: p.id,
      issue: p.issue,
      note: p.note,
      publishedBy: p.publishedBy,
      publishedByName: p.publishedBy ? (names.get(p.publishedBy) ?? null) : null,
      publishedAt: p.publishedAt.toISOString(),
      items,
      hidden: p.items.length - items.length,
    };
  }

  const issueParam = (v: unknown) => z.coerce.number().int().min(1).max(100000).parse(v);

  api.get<{ Params: { pid: string; setId: string; issue: string } }>("/projects/:pid/sheet-sets/:setId/issues/:issue", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const s = await loadSet(a, req.params.setId);
    const tree = await FolderTree.load(db, a.project.id);
    return loadIssue(tree, a, s, issueParam(req.params.issue));
  });

  /** The rows of a set: an issue's snapshot, or the set as it is now. */
  async function setRows(tree: FolderTree, a: ProjectAccess, s: SetRow, issue: string | undefined): Promise<{ sheets: DrawingSheetDto[] | null; snapshot: SheetSetPublicationItem[] | null; issue: number | null }> {
    if (issue) {
      const p = await loadIssue(tree, a, s, issueParam(issue));
      return { sheets: null, snapshot: p.items, issue: p.issue };
    }
    const { items } = await resolveItems(tree, a, s.id);
    return { sheets: items.map((i) => i.sheet).filter((x): x is DrawingSheetDto => !!x), snapshot: null, issue: null };
  }

  api.get<{ Params: { pid: string; setId: string }; Querystring: { format?: string; issue?: string } }>(
    "/projects/:pid/sheet-sets/:setId/export",
    async (req, reply) => {
      const a = await projectAccess(db, req.params.pid, req.user!);
      const s = await loadSet(a, req.params.setId);
      const tree = await FolderTree.load(db, a.project.id);
      const r = await setRows(tree, a, s, req.query.issue);
      const t = tReq(req);
      const rows = r.snapshot ? sheetListRows(r.snapshot.map((i) => ({ ...i, state: null, cdeStatus: null })), t) : sheetListRows(r.sheets!, t);
      return sendSheetList(reply, req.query.format ?? "csv", sheetExportName(a.project.code, s.name, r.issue), s.name, sheetListColumns(t), rows);
    },
  );

  api.get<{ Params: { pid: string; setId: string }; Querystring: { issue?: string } }>(
    "/projects/:pid/sheet-sets/:setId/zip",
    async (req, reply: FastifyReply) => {
      const a = await projectAccess(db, req.params.pid, req.user!);
      const s = await loadSet(a, req.params.setId);
      const tree = await FolderTree.load(db, a.project.id);
      const r = await setRows(tree, a, s, req.query.issue);
      const versionIds = [...new Set(r.snapshot ? r.snapshot.map((i) => i.versionId) : r.sheets!.map((x) => x.versionId))];
      if (!versionIds.length) throw badRequest(msg("sheets:errors.emptySet"));
      await audit(db, {
        projectId: a.project.id,
        userId: a.user.id,
        action: "sheet_set.downloaded",
        targetType: "sheet_set",
        targetId: s.id,
        details: { name: s.name, issue: r.issue, files: versionIds.length },
      });
      return sendZip(deps, req.params.pid, req.user!, { versionIds, name: sheetExportName(a.project.code, s.name, r.issue) }, reply);
    },
  );
}
