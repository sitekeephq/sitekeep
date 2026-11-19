/**
 * Full project export and restore (docs/features/PROJECT_EXPORT.md):
 *   GET    /projects/:pid/exports                 project administrators: scope, the last 20 exports, limits, estimate
 *   POST   /projects/:pid/exports                 project administrators: queue an export (scope by the caller)
 *   GET    /projects/:pid/exports/:id             project administrators: one export (progress)
 *   GET    /projects/:pid/exports/:id/download    project administrators: the ZIP
 *   DELETE /projects/:pid/exports/:id             project administrators: delete the ZIP before it expires
 *   GET    /project-imports                       system administrators: the last 20 restores
 *   POST   /project-imports                       system administrators: upload a package (multipart "file", fields "code", "name")
 *   GET    /project-imports/:id                   system administrators: one restore (progress, report)
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ProjectExportDto, ProjectExportStateDto, ProjectImportDto } from "@sitekeep/shared";
import type { AppDeps } from "../app/deps.js";
import { projectExports, projectImports, projects } from "../db/schema.js";
import { audit } from "../core/platform/audit.js";
import { HttpError, badRequest, conflict, forbidden, notFound } from "../core/platform/http.js";
import { isUuid, projectAccess, requireProjectAdmin, userNames } from "../core/security/access.js";
import { msg, requestLanguage } from "../i18n/index.js";
import { closeoutLimits } from "../closeout/config.js";
import { checkRoom } from "../closeout/build.js";
import { exportScopeOf, planExport } from "./collect.js";
import { PROJECT_EXPORT_JOB, runExportJob, sweepProjectExports } from "./export.js";
import { PROJECT_IMPORT_JOB, runImportJob } from "./import.js";

type ExportRow = typeof projectExports.$inferSelect;
type ImportRow = typeof projectImports.$inferSelect;

const codeSchema = z.string().trim().min(1).max(40);
const nameSchema = z.string().trim().min(1).max(200);

function exportDto(r: ExportRow, names: Map<string, string>): ProjectExportDto {
  return {
    id: r.id,
    status: r.status,
    scope: r.scope,
    requestedBy: { id: r.requestedBy, name: r.requestedBy ? (names.get(r.requestedBy) ?? null) : null },
    createdAt: r.createdAt.toISOString(),
    startedAt: r.startedAt?.toISOString() ?? null,
    finishedAt: r.finishedAt?.toISOString() ?? null,
    filesTotal: r.filesTotal,
    filesDone: r.filesDone,
    bytesTotal: r.bytesTotal,
    bytesDone: r.bytesDone,
    counts: r.counts ?? null,
    size: r.size,
    sha256: r.sha256,
    error: r.error,
    expiresAt: r.expiresAt?.toISOString() ?? null,
  };
}

function importDto(r: ImportRow, names: Map<string, string>): ProjectImportDto {
  return {
    id: r.id,
    status: r.status,
    fileName: r.fileName,
    requestedBy: { id: r.requestedBy, name: r.requestedBy ? (names.get(r.requestedBy) ?? null) : null },
    createdAt: r.createdAt.toISOString(),
    startedAt: r.startedAt?.toISOString() ?? null,
    finishedAt: r.finishedAt?.toISOString() ?? null,
    size: r.size,
    sha256: r.sha256,
    code: r.code,
    name: r.name,
    projectId: r.projectId,
    phase: r.phase ?? null,
    filesTotal: r.filesTotal,
    filesDone: r.filesDone,
    report: r.report ?? null,
    error: r.error,
  };
}

export async function portabilityRoutes(api: FastifyInstance, deps: AppDeps) {
  const { db, storage, jobs } = deps;
  const limits = closeoutLimits(deps.closeout);
  jobs.register(PROJECT_EXPORT_JOB, (job) => runExportJob({ db, storage, limits }, job.payload));
  jobs.register(PROJECT_IMPORT_JOB, (job) => runImportJob({ db, storage, jobs }, job.payload));

  async function adminAccess(pid: string, user: Parameters<typeof projectAccess>[2]) {
    const a = await projectAccess(db, pid, user);
    requireProjectAdmin(a);
    return a;
  }

  async function loadExport(projectId: string, id: string): Promise<ExportRow> {
    if (!isUuid(id)) throw notFound(msg("portability:entities.export"));
    const [row] = await db
      .select()
      .from(projectExports)
      .where(and(eq(projectExports.id, id), eq(projectExports.projectId, projectId)));
    if (!row) throw notFound(msg("portability:entities.export"));
    return row;
  }

  const exportDtos = async (rows: ExportRow[]) => {
    const names = await userNames(db, rows.map((r) => r.requestedBy));
    return rows.map((r) => exportDto(r, names));
  };
  const importDtos = async (rows: ImportRow[]) => {
    const names = await userNames(db, rows.map((r) => r.requestedBy));
    return rows.map((r) => importDto(r, names));
  };

  // ---- Export ----------------------------------------------------------------------------------

  api.get<{ Params: { pid: string } }>("/projects/:pid/exports", async (req): Promise<ProjectExportStateDto> => {
    const a = await adminAccess(req.params.pid, req.user!);
    await sweepProjectExports(db, storage);
    const scope = exportScopeOf(a);
    const rows = await db.select().from(projectExports).where(eq(projectExports.projectId, a.project.id)).orderBy(desc(projectExports.createdAt)).limit(20);
    const { entries } = await planExport(db, { access: a, scope });
    return {
      scope,
      exports: await exportDtos(rows),
      limits: { maxBytes: limits.maxBytes, retentionDays: limits.retentionDays },
      estimate: { files: new Set(entries.map((e) => e.file.id)).size, versions: entries.length, bytes: entries.reduce((n, e) => n + e.version.size, 0) },
    };
  });

  api.post<{ Params: { pid: string } }>("/projects/:pid/exports", async (req): Promise<ProjectExportDto> => {
    const a = await adminAccess(req.params.pid, req.user!);
    const [busy] = await db
      .select({ id: projectExports.id })
      .from(projectExports)
      .where(and(eq(projectExports.projectId, a.project.id), inArray(projectExports.status, ["queued", "running"])));
    if (busy) throw conflict(msg("portability:errors.busy"));
    const scope = exportScopeOf(a);
    const { entries } = await planExport(db, { access: a, scope });
    const bytes = entries.reduce((n, e) => n + e.version.size, 0);
    const refusal = await checkRoom(storage, limits, bytes);
    if (refusal) throw badRequest(refusal);
    const [row] = await db
      .insert(projectExports)
      .values({ projectId: a.project.id, requestedBy: a.user.id, scope, filesTotal: entries.length, bytesTotal: bytes })
      .returning();
    const jobId = await jobs.enqueue(PROJECT_EXPORT_JOB, { exportId: row!.id, lang: requestLanguage(req) });
    await db.update(projectExports).set({ jobId }).where(eq(projectExports.id, row!.id));
    return (await exportDtos([{ ...row!, jobId }]))[0]!;
  });

  api.get<{ Params: { pid: string; id: string } }>("/projects/:pid/exports/:id", async (req): Promise<ProjectExportDto> => {
    const a = await adminAccess(req.params.pid, req.user!);
    return (await exportDtos([await loadExport(a.project.id, req.params.id)]))[0]!;
  });

  api.get<{ Params: { pid: string; id: string } }>("/projects/:pid/exports/:id/download", async (req, reply) => {
    const a = await adminAccess(req.params.pid, req.user!);
    await sweepProjectExports(db, storage);
    const row = await loadExport(a.project.id, req.params.id);
    // A system administrator's (full) export is not handed to a project administrator.
    if (row.scope === "full" && exportScopeOf(a) !== "full") throw forbidden(msg("portability:errors.fullExportAdminOnly"));
    if (row.status === "expired") throw new HttpError(410, "gone", msg("portability:errors.expired"));
    if (row.status !== "done" || !row.storageKey) throw badRequest(msg("portability:errors.notReady"));
    const size = await storage.size(row.storageKey).catch(() => null);
    if (size === null) throw new HttpError(410, "gone", msg("portability:errors.expired"));
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "project.export_downloaded",
      targetType: "project_export",
      targetId: row.id,
      details: { size, sha256: row.sha256, scope: row.scope },
    });
    const name = `${a.project.code}-export-${row.createdAt.toISOString().slice(0, 10)}.zip`.replace(/[\\/:*?"<>|]/g, "_");
    const ascii = name.replace(/[^\x20-\x7e]/g, "_");
    reply.header("Content-Type", "application/zip");
    reply.header("Content-Length", String(size));
    reply.header("Content-Disposition", `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`);
    reply.header("Cache-Control", "no-store");
    return reply.send(storage.get(row.storageKey));
  });

  api.delete<{ Params: { pid: string; id: string } }>("/projects/:pid/exports/:id", async (req) => {
    const a = await adminAccess(req.params.pid, req.user!);
    const row = await loadExport(a.project.id, req.params.id);
    if (row.status === "queued" || row.status === "running") throw conflict(msg("portability:errors.busy"));
    if (row.scope === "full" && exportScopeOf(a) !== "full") throw forbidden(msg("portability:errors.fullExportAdminOnly"));
    if (row.storageKey) await storage.remove(row.storageKey);
    await db
      .update(projectExports)
      .set({ status: row.status === "done" ? "expired" : row.status, storageKey: null, expiresAt: row.status === "done" ? new Date() : row.expiresAt })
      .where(eq(projectExports.id, row.id));
    await audit(db, { projectId: a.project.id, userId: a.user.id, action: "project.export_deleted", targetType: "project_export", targetId: row.id });
    return { ok: true };
  });

  // ---- Restore (system administrators: it creates a project) ----------------------------------

  const requireSystemAdmin = (u: { isAdmin: boolean }) => {
    if (!u.isAdmin) throw forbidden(msg("portability:errors.importAdminOnly"));
  };

  api.get("/project-imports", async (req): Promise<ProjectImportDto[]> => {
    requireSystemAdmin(req.user!);
    return importDtos(await db.select().from(projectImports).orderBy(desc(projectImports.createdAt)).limit(20));
  });

  api.get<{ Params: { id: string } }>("/project-imports/:id", async (req): Promise<ProjectImportDto> => {
    requireSystemAdmin(req.user!);
    if (!isUuid(req.params.id)) throw notFound(msg("portability:entities.import"));
    const [row] = await db.select().from(projectImports).where(eq(projectImports.id, req.params.id));
    if (!row) throw notFound(msg("portability:entities.import"));
    return (await importDtos([row]))[0]!;
  });

  api.post("/project-imports", async (req): Promise<ProjectImportDto> => {
    requireSystemAdmin(req.user!);
    if (!req.isMultipart()) throw badRequest(msg("portability:errors.noFile"));
    const fields: Record<string, string> = {};
    let stored: { key: string; size: number; sha256: string } | null = null;
    let fileName: string | null = null;
    try {
      for await (const part of req.parts()) {
        if (part.type === "field") {
          fields[part.fieldname] = String(part.value);
          continue;
        }
        if (stored) {
          part.file.resume();
          continue;
        }
        fileName = (part.filename ?? "").slice(0, 200) || null;
        // Streamed into the storage; checked by the job (checksums) before anything is restored.
        stored = await storage.put(part.file, "imports");
        if (part.file.truncated) {
          await storage.remove(stored.key);
          throw new HttpError(413, "too_large", msg("portability:errors.fileTooLarge"));
        }
      }
      if (!stored?.size) throw badRequest(msg("portability:errors.noFile"));
      const code = codeSchema.safeParse(fields.code ?? "");
      if (!code.success) throw badRequest(msg("portability:errors.codeRequired"));
      const name = fields.name?.trim() ? nameSchema.parse(fields.name) : null;
      const [taken] = await db.select({ id: projects.id }).from(projects).where(and(eq(projects.code, code.data), eq(projects.archived, false)));
      if (taken) throw conflict(msg("projects:errors.codeTaken", { code: code.data }));
      const [row] = await db
        .insert(projectImports)
        .values({ requestedBy: req.user!.id, fileName, uploadKey: stored.key, size: stored.size, sha256: stored.sha256, code: code.data, name })
        .returning();
      const jobId = await jobs.enqueue(PROJECT_IMPORT_JOB, { importId: row!.id, lang: requestLanguage(req) });
      await db.update(projectImports).set({ jobId }).where(eq(projectImports.id, row!.id));
      return (await importDtos([{ ...row!, jobId }]))[0]!;
    } catch (e) {
      if (stored) {
        const [kept] = await db.select({ id: projectImports.id }).from(projectImports).where(eq(projectImports.uploadKey, stored.key));
        if (!kept) await storage.remove(stored.key).catch(() => undefined);
      }
      throw e;
    }
  });
}
