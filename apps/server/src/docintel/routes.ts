/**
 * Document intelligence ("Doküman zekâsı") routes:
 *   POST /projects/:pid/docintel/suggest?folderId=…&ai=1     multipart PDFs → title block + name suggestion (nothing stored)
 *   GET  /projects/:pid/versions/:vid/docintel               stored title block, revision warnings, live suggestion
 *   POST /projects/:pid/versions/:vid/docintel/extract       (re)run the extraction job
 *   POST /projects/:pid/versions/:vid/docintel/suggest       suggestion again, optionally with the language model
 *   POST /projects/:pid/docintel/spec-register               {versionId, ai?} → draft submittal register
 *   GET  /projects/:pid/docintel/spec-registers[/:rid]       list / detail
 *   PUT  /projects/:pid/docintel/spec-registers/:rid         edited items
 *   GET  /projects/:pid/docintel/spec-registers/:rid/export?format=csv|xlsx|json
 */
import { and, desc, eq, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  can,
  SUBMITTAL_DISCIPLINES,
  SUBMITTAL_TYPE_CODES,
  type SubmittalRegisterDto,
  type SubmittalRegisterItem,
  type SubmittalRegisterSummaryDto,
  type SuggestFileResultDto,
} from "@sitekeep/shared";
import type { ResolvedDeps } from "../app/deps.js";
import { FolderTree, isUuid, projectAccess, requireAction, type AuthUser } from "../core/security/access.js";
import { audit } from "../core/platform/audit.js";
import { docExtractions, fileVersions, files, specRegisters } from "../db/schema.js";
import { badRequest, notFound } from "../core/platform/http.js";
import { msg, requestLanguage, tFor } from "../i18n/index.js";
import { requireModule } from "../projects/modules.js";
import { analyzeAntet } from "../docintel/antet.js";
import { extractPdfText, pdfErrorText } from "../docintel/extract.js";
import { registerColumns, registerRows, toCsv, toXlsx } from "../docintel/export.js";
import { detectRevision } from "../docintel/revision.js";
import {
  EXTRACT_JOB,
  aiProviderFor,
  buildSuggestInput,
  isPdf,
  processVersion,
  suggestContext,
  versionDocIntel,
} from "../docintel/service.js";
import { buildRegister, refineRegisterWithAi } from "../docintel/spec.js";
import { refineWithAi, suggestNaming } from "../docintel/suggest.js";
import { cleanFileName, loadVersion, requireView } from "../modules/documents/public.js";

/** Upload-dialog suggestions: per-file size and count limits (files are read in memory, not stored). */
export const SUGGEST_MAX_BYTES = 30 * 1024 * 1024;
export const SUGGEST_MAX_FILES = 20;
/** Specifications are read up to this many pages. */
const SPEC_MAX_PAGES = 400;

const itemSchema = z.object({
  id: z.string().min(1).max(20),
  sectionCode: z.string().max(60).nullable(),
  sectionTitle: z.string().max(200).nullable(),
  page: z.number().int().min(1).max(100000),
  description: z.string().max(300),
  excerpt: z.string().max(1000),
  type: z.enum(SUBMITTAL_TYPE_CODES as unknown as [string, ...string[]]).nullable(),
  typeConfidence: z.number().min(0).max(1),
  discipline: z.enum(SUBMITTAL_DISCIPLINES.map((d) => d.code) as unknown as [string, ...string[]]).nullable(),
  keywords: z.array(z.string().max(60)).max(20),
  excluded: z.boolean().optional(),
  aiAssisted: z.boolean().optional(),
});

export async function docIntelRoutes(api: FastifyInstance, deps: ResolvedDeps) {
  const { db, storage, jobs, secretKey } = deps;
  jobs.register(EXTRACT_JOB, (job) => processVersion(db, storage, String(job.payload.versionId)));

  api.post<{ Params: { pid: string }; Querystring: { folderId?: string; ai?: string } }>(
    "/projects/:pid/docintel/suggest",
    async (req) => {
      const a = await projectAccess(db, req.params.pid, req.user!);
      const lang = requestLanguage(req);
      const t = tFor(lang);
      const folderId = req.query.folderId;
      if (!isUuid(folderId)) throw badRequest(msg("docintel:errors.folderIdRequired"));
      const tree = await FolderTree.load(db, a.project.id);
      requireAction(tree, a, folderId, "upload");
      if (!req.isMultipart()) throw badRequest(msg("docintel:errors.multipartExpected"));
      const ctx = await suggestContext(db, tree, folderId);
      const provider = await aiProviderFor(db, secretKey, a.project.id);
      const useAi = req.query.ai === "1" && !!provider;
      const results: SuggestFileResultDto[] = [];
      for await (const part of req.parts()) {
        if (part.type === "field") continue;
        const name = cleanFileName(part.filename);
        if (results.length >= SUGGEST_MAX_FILES) {
          part.file.resume();
          results.push({ name: name || part.filename, size: 0, ok: false, error: t("docintel:errors.tooManyFiles", { count: SUGGEST_MAX_FILES }), antet: null, revision: null, suggestion: null });
          continue;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        let tooBig = false;
        for await (const c of part.file) {
          size += (c as Buffer).length;
          if (size > SUGGEST_MAX_BYTES) tooBig = true;
          else chunks.push(c as Buffer);
        }
        if (!name) {
          results.push({ name: part.filename, size, ok: false, error: t("docintel:errors.invalidFileName"), antet: null, revision: null, suggestion: null });
          continue;
        }
        let antet = null;
        let error: string | undefined;
        if (isPdf(name) && !tooBig) {
          try {
            antet = analyzeAntet(await extractPdfText({ data: new Uint8Array(Buffer.concat(chunks)) }, { maxPages: 1, timeoutMs: 60_000 }), lang);
          } catch (e) {
            error = pdfErrorText(e, lang);
          }
        } else if (tooBig) {
          error = t("docintel:errors.tooBigForAntet", { mb: Math.round(SUGGEST_MAX_BYTES / 1024 / 1024) });
        }
        const revision = detectRevision(antet, name);
        const input = buildSuggestInput(ctx, name, antet, revision, undefined, lang);
        let suggestion = suggestNaming(input);
        if (useAi && antet) suggestion = await refineWithAi(provider!, input, suggestion);
        results.push({ name, size, ok: !error, error, antet, revision, suggestion });
      }
      if (!results.length) throw badRequest(msg("docintel:errors.noFile"));
      return { standard: ctx.standard, aiAvailable: !!provider, results };
    },
  );

  api.get<{ Params: { pid: string; vid: string } }>("/projects/:pid/versions/:vid/docintel", async (req) => {
    const { a, file, version, tree } = await loadVersion(db, req.params.pid, req.params.vid, req.user!);
    requireView(tree, a, file);
    const provider = await aiProviderFor(db, secretKey, a.project.id);
    return versionDocIntel(db, tree, file, version, !!provider, requestLanguage(req));
  });

  api.post<{ Params: { pid: string; vid: string } }>("/projects/:pid/versions/:vid/docintel/extract", async (req) => {
    const { a, file, version, tree } = await loadVersion(db, req.params.pid, req.params.vid, req.user!);
    requireView(tree, a, file);
    if (!isPdf(file.name)) throw badRequest(msg("docintel:errors.antetPdfOnly"));
    await db
      .insert(docExtractions)
      .values({ versionId: version.id, projectId: a.project.id, status: "pending" })
      .onConflictDoUpdate({ target: docExtractions.versionId, set: { status: "pending", error: null, updatedAt: new Date() } });
    await jobs.enqueue(EXTRACT_JOB, { versionId: version.id });
    return { status: "pending" };
  });

  api.post<{ Params: { pid: string; vid: string } }>("/projects/:pid/versions/:vid/docintel/suggest", async (req) => {
    const { a, file, version, tree } = await loadVersion(db, req.params.pid, req.params.vid, req.user!);
    requireView(tree, a, file);
    const body = z.object({ ai: z.boolean().optional() }).parse(req.body ?? {});
    const provider = await aiProviderFor(db, secretKey, a.project.id);
    const lang = requestLanguage(req);
    const dto = await versionDocIntel(db, tree, file, version, !!provider, lang);
    if (!dto.suggestion) throw badRequest(msg("docintel:errors.antetNotRead"));
    if (!body.ai) return dto.suggestion;
    if (!provider) throw badRequest(msg("docintel:errors.aiUnavailable"));
    const ctx = await suggestContext(db, tree, file.folderId);
    const input = buildSuggestInput(ctx, file.name, dto.antet, dto.revision, file.attributes, lang);
    const refined = await refineWithAi(provider, input, dto.suggestion);
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "docintel.ai_suggest",
      targetType: "file",
      targetId: file.id,
      details: { version: version.version, model: provider.model, accepted: refined.ai?.accepted ?? false },
    });
    return refined;
  });

  api.post<{ Params: { pid: string } }>("/projects/:pid/docintel/spec-register", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    requireModule(a, "spec");
    const body = z.object({ versionId: z.string().uuid(), ai: z.boolean().optional() }).parse(req.body);
    const { file, version, tree } = await loadVersion(db, req.params.pid, body.versionId, req.user!);
    requireView(tree, a, file);
    if (!isPdf(file.name)) throw badRequest(msg("docintel:errors.specPdfOnly"));
    const out = await extractPdfText({ filePath: storage.localPath(version.storageKey) }, { maxPages: SPEC_MAX_PAGES, timeoutMs: 300_000 });
    const lang = requestLanguage(req);
    let { items, sectionCount } = buildRegister(out, lang);
    let usedAi = false;
    if (body.ai) {
      const provider = await aiProviderFor(db, secretKey, a.project.id);
      if (!provider) throw badRequest(msg("docintel:errors.aiUnavailable"));
      const r = await refineRegisterWithAi(provider, items, { lang });
      items = r.items;
      usedAi = r.changed > 0;
    }
    const now = new Date();
    const [row] = await db
      .insert(specRegisters)
      .values({ projectId: a.project.id, versionId: version.id, items, sectionCount, pageCount: out.pageCount, usedAi, createdBy: a.user.id })
      .onConflictDoUpdate({
        target: specRegisters.versionId,
        set: { items, sectionCount, pageCount: out.pageCount, usedAi, updatedAt: now },
      })
      .returning();
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "docintel.spec_register",
      targetType: "file",
      targetId: file.id,
      details: { version: version.version, items: items.length, pages: out.pageCount, ai: usedAi },
    });
    return toRegisterDto(row!, file.name, version.version, file.id);
  });

  api.get<{ Params: { pid: string } }>("/projects/:pid/docintel/spec-registers", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const tree = await FolderTree.load(db, a.project.id);
    const rows = await db
      .select({ r: specRegisters, f: files, v: fileVersions })
      .from(specRegisters)
      .innerJoin(fileVersions, eq(fileVersions.id, specRegisters.versionId))
      .innerJoin(files, eq(files.id, fileVersions.fileId))
      .where(and(eq(specRegisters.projectId, a.project.id), isNull(files.deletedAt)))
      .orderBy(desc(specRegisters.updatedAt));
    return rows
      .filter((x) => tree.byId.has(x.f.folderId) && canSee(tree, a, x.f))
      .map(
        (x): SubmittalRegisterSummaryDto => ({
          id: x.r.id,
          versionId: x.v.id,
          fileId: x.f.id,
          fileName: x.f.name,
          version: x.v.version,
          itemCount: x.r.items.filter((i) => !i.excluded).length,
          updatedAt: x.r.updatedAt.toISOString(),
        }),
      );
  });

  const loadRegister = async (pid: string, rid: string, user: AuthUser) => {
    const a = await projectAccess(db, pid, user);
    if (!isUuid(rid)) throw notFound(msg("docintel:entities.register"));
    const [reg] = await db.select().from(specRegisters).where(and(eq(specRegisters.id, rid), eq(specRegisters.projectId, a.project.id)));
    if (!reg) throw notFound(msg("docintel:entities.register"));
    const { file, version, tree } = await loadVersion(db, pid, reg.versionId, user);
    requireView(tree, a, file);
    return { a, reg, file, version, tree };
  };

  api.get<{ Params: { pid: string; rid: string } }>("/projects/:pid/docintel/spec-registers/:rid", async (req) => {
    const { reg, file, version } = await loadRegister(req.params.pid, req.params.rid, req.user!);
    return toRegisterDto(reg, file.name, version.version, file.id);
  });

  api.put<{ Params: { pid: string; rid: string } }>("/projects/:pid/docintel/spec-registers/:rid", async (req) => {
    const { a, reg, file, version, tree } = await loadRegister(req.params.pid, req.params.rid, req.user!);
    const level = tree.permission(a.principal, file.folderId).level;
    if (reg.createdBy !== a.user.id && !can(level, "edit") && !a.isProjectAdmin)
      throw badRequest(msg("docintel:errors.registerEditDenied"));
    const body = z.object({ items: z.array(itemSchema).max(2000) }).parse(req.body);
    const ids = new Set(body.items.map((i) => i.id));
    if (ids.size !== body.items.length) throw badRequest(msg("docintel:errors.duplicateItemIds"));
    const [row] = await db
      .update(specRegisters)
      .set({ items: body.items as SubmittalRegisterItem[], updatedAt: new Date() })
      .where(eq(specRegisters.id, reg.id))
      .returning();
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "docintel.spec_register_updated",
      targetType: "file",
      targetId: file.id,
      details: { items: body.items.length },
    });
    return toRegisterDto(row!, file.name, version.version, file.id);
  });

  api.get<{ Params: { pid: string; rid: string }; Querystring: { format?: string } }>(
    "/projects/:pid/docintel/spec-registers/:rid/export",
    async (req, reply) => {
      const { reg, file, version } = await loadRegister(req.params.pid, req.params.rid, req.user!);
      const format = req.query.format ?? "csv";
      const t = tFor(requestLanguage(req));
      const base = `${file.name.replace(/\.[^.]+$/, "")}_${t("docintel:export.fileSuffix")}`;
      const disposition = (name: string) =>
        `attachment; filename="${name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "")}"; filename*=UTF-8''${encodeURIComponent(name)}`;
      if (format === "json") {
        reply.header("Content-Disposition", disposition(`${base}.json`));
        return toRegisterDto(reg, file.name, version.version, file.id);
      }
      const rows = registerRows(reg.items, t, requestLanguage(req));
      const columns = registerColumns(t);
      if (format === "xlsx") {
        const buf = await toXlsx(t("docintel:export.sheet"), columns, rows);
        reply.header("Content-Disposition", disposition(`${base}.xlsx`));
        reply.header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        return reply.send(buf);
      }
      if (format !== "csv") throw badRequest(msg("docintel:errors.badFormat"));
      reply.header("Content-Disposition", disposition(`${base}.csv`));
      reply.header("Content-Type", "text/csv; charset=utf-8");
      return reply.send(toCsv(columns, rows));
    },
  );
}

function canSee(tree: FolderTree, a: Awaited<ReturnType<typeof projectAccess>>, f: typeof files.$inferSelect): boolean {
  const perm = tree.permission(a.principal, f.folderId);
  return can(perm.level, "view") || (perm.canUpload && f.createdBy === a.user.id);
}

function toRegisterDto(r: typeof specRegisters.$inferSelect, fileName: string, version: number, fileId: string): SubmittalRegisterDto {
  return {
    id: r.id,
    projectId: r.projectId,
    versionId: r.versionId,
    fileId,
    fileName,
    version,
    items: r.items,
    sectionCount: r.sectionCount,
    pageCount: r.pageCount,
    usedAi: r.usedAi,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

