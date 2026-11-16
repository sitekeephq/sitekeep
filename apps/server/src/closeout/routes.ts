/**
 * Close-out archive API (ISO 19650-2 §5.8.1, docs/features/CLOSEOUT_ARCHIVE.md):
 *   GET    /projects/:pid/closeout                         project administrators: closed state, archives, limits, estimate
 *   POST   /projects/:pid/closeout/archives                project administrators: queue an archive {includeShared, versions, closeProject}
 *   GET    /projects/:pid/closeout/archives/:id            project administrators: one archive (progress)
 *   GET    /projects/:pid/closeout/archives/:id/download   project administrators: the ZIP
 *   DELETE /projects/:pid/closeout/archives/:id            project administrators: delete the ZIP before it expires
 *   POST   /projects/:pid/close                            project administrators: close (read-only) after a complete archive
 *   POST   /projects/:pid/reopen                           system administrators: reopen a closed project
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { CloseoutArchiveDto, CloseoutStateDto } from "@sitekeep/shared";
import type { AppDeps } from "../app/deps.js";
import { closeoutArchives, projects } from "../db/schema.js";
import { audit } from "../core/platform/audit.js";
import { HttpError, badRequest, conflict, forbidden, notFound } from "../core/platform/http.js";
import { isUuid, projectAccess, requireProjectAdmin, userNames } from "../core/security/access.js";
import { msg, requestLanguage } from "../i18n/index.js";
import { closeoutLimits } from "./config.js";
import { estimate, planEntries } from "./collect.js";
import { CLOSEOUT_JOB, checkRoom, closeProject, runCloseoutJob, sweepCloseoutArchives } from "./build.js";

type Row = typeof closeoutArchives.$inferSelect;

const createSchema = z.object({
  includeShared: z.boolean().default(false),
  versions: z.enum(["latest", "all"]).default("latest"),
  closeProject: z.boolean().default(false),
});
const reopenSchema = z.object({ reason: z.string().trim().max(1000).optional() });

function toDto(r: Row, names: Map<string, string>): CloseoutArchiveDto {
  return {
    id: r.id,
    status: r.status,
    options: r.options,
    requestedBy: { id: r.requestedBy, name: r.requestedBy ? (names.get(r.requestedBy) ?? null) : null },
    createdAt: r.createdAt.toISOString(),
    startedAt: r.startedAt?.toISOString() ?? null,
    finishedAt: r.finishedAt?.toISOString() ?? null,
    filesTotal: r.filesTotal,
    filesDone: r.filesDone,
    bytesTotal: r.bytesTotal,
    bytesDone: r.bytesDone,
    size: r.size,
    sha256: r.sha256,
    auditChain: r.auditChain ?? null,
    problems: r.problems,
    error: r.error,
    expiresAt: r.expiresAt?.toISOString() ?? null,
  };
}

export async function closeoutRoutes(api: FastifyInstance, deps: AppDeps) {
  const { db, storage, jobs } = deps;
  const limits = closeoutLimits(deps.closeout);
  jobs.register(CLOSEOUT_JOB, (job) => runCloseoutJob({ db, storage, limits }, job.payload));

  async function adminAccess(pid: string, user: Parameters<typeof projectAccess>[2]) {
    const a = await projectAccess(db, pid, user);
    requireProjectAdmin(a);
    return a;
  }

  async function loadArchive(projectId: string, id: string): Promise<Row> {
    if (!isUuid(id)) throw notFound(msg("closeout:entities.archive"));
    const [row] = await db
      .select()
      .from(closeoutArchives)
      .where(and(eq(closeoutArchives.id, id), eq(closeoutArchives.projectId, projectId)));
    if (!row) throw notFound(msg("closeout:entities.archive"));
    return row;
  }

  const dtos = async (rows: Row[]) => {
    const names = await userNames(db, rows.map((r) => r.requestedBy));
    return rows.map((r) => toDto(r, names));
  };

  api.get<{ Params: { pid: string } }>("/projects/:pid/closeout", async (req): Promise<CloseoutStateDto> => {
    const a = await adminAccess(req.params.pid, req.user!);
    await sweepCloseoutArchives(db, storage);
    const rows = await db.select().from(closeoutArchives).where(eq(closeoutArchives.projectId, a.project.id)).orderBy(desc(closeoutArchives.createdAt)).limit(20);
    const p = a.project;
    const closer = p.closedBy ? await userNames(db, [p.closedBy]) : new Map<string, string>();
    return {
      closed: !!p.closedAt,
      closedAt: p.closedAt?.toISOString() ?? null,
      closedBy: p.closedAt ? { id: p.closedBy, name: p.closedBy ? (closer.get(p.closedBy) ?? null) : null } : null,
      archives: await dtos(rows),
      limits: { maxBytes: limits.maxBytes, retentionDays: limits.retentionDays },
      estimate: await estimate(db, p.id),
    };
  });

  api.post<{ Params: { pid: string } }>("/projects/:pid/closeout/archives", async (req): Promise<CloseoutArchiveDto> => {
    const a = await adminAccess(req.params.pid, req.user!);
    const options = createSchema.parse(req.body ?? {});
    const [busy] = await db
      .select({ id: closeoutArchives.id })
      .from(closeoutArchives)
      .where(and(eq(closeoutArchives.projectId, a.project.id), inArray(closeoutArchives.status, ["queued", "running"])));
    if (busy) throw conflict(msg("closeout:errors.busy"));
    const { entries } = await planEntries(db, a.project.id, options);
    if (!entries.length) throw badRequest(msg("closeout:errors.nothingToArchive"));
    const refusal = await checkRoom(storage, limits, entries.reduce((n, e) => n + e.version.size, 0));
    if (refusal) throw badRequest(refusal);
    const [row] = await db
      .insert(closeoutArchives)
      .values({
        projectId: a.project.id,
        requestedBy: a.user.id,
        options: { ...options, closeProject: options.closeProject && !a.project.closedAt },
        filesTotal: entries.length,
        bytesTotal: entries.reduce((n, e) => n + e.version.size, 0),
      })
      .returning();
    const jobId = await jobs.enqueue(CLOSEOUT_JOB, { archiveId: row!.id, lang: requestLanguage(req) });
    await db.update(closeoutArchives).set({ jobId }).where(eq(closeoutArchives.id, row!.id));
    return (await dtos([{ ...row!, jobId }]))[0]!;
  });

  api.get<{ Params: { pid: string; id: string } }>("/projects/:pid/closeout/archives/:id", async (req): Promise<CloseoutArchiveDto> => {
    const a = await adminAccess(req.params.pid, req.user!);
    return (await dtos([await loadArchive(a.project.id, req.params.id)]))[0]!;
  });

  api.get<{ Params: { pid: string; id: string } }>("/projects/:pid/closeout/archives/:id/download", async (req, reply) => {
    const a = await adminAccess(req.params.pid, req.user!);
    await sweepCloseoutArchives(db, storage);
    const row = await loadArchive(a.project.id, req.params.id);
    if (row.status === "expired") throw new HttpError(410, "gone", msg("closeout:errors.expired"));
    if (row.status !== "done" || !row.storageKey) throw badRequest(msg("closeout:errors.notReady"));
    const size = await storage.size(row.storageKey).catch(() => null);
    if (size === null) throw new HttpError(410, "gone", msg("closeout:errors.expired"));
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "project.closeout_archive_downloaded",
      targetType: "closeout_archive",
      targetId: row.id,
      details: { size, sha256: row.sha256 },
    });
    const name = `${a.project.code}-closeout-${row.createdAt.toISOString().slice(0, 10)}.zip`.replace(/[\\/:*?"<>|]/g, "_");
    const ascii = name.replace(/[^\x20-\x7e]/g, "_");
    reply.header("Content-Type", "application/zip");
    reply.header("Content-Length", String(size));
    reply.header("Content-Disposition", `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`);
    reply.header("Cache-Control", "no-store");
    return reply.send(storage.get(row.storageKey));
  });

  api.delete<{ Params: { pid: string; id: string } }>("/projects/:pid/closeout/archives/:id", async (req) => {
    const a = await adminAccess(req.params.pid, req.user!);
    const row = await loadArchive(a.project.id, req.params.id);
    if (row.status === "queued" || row.status === "running") throw conflict(msg("closeout:errors.busy"));
    if (row.storageKey) await storage.remove(row.storageKey);
    await db
      .update(closeoutArchives)
      .set({ status: row.status === "done" ? "expired" : row.status, storageKey: null, expiresAt: row.status === "done" ? new Date() : row.expiresAt })
      .where(eq(closeoutArchives.id, row.id));
    await audit(db, { projectId: a.project.id, userId: a.user.id, action: "project.closeout_archive_deleted", targetType: "closeout_archive", targetId: row.id });
    return { ok: true };
  });

  api.post<{ Params: { pid: string } }>("/projects/:pid/close", async (req) => {
    const a = await adminAccess(req.params.pid, req.user!);
    const [archive] = await db
      .select()
      .from(closeoutArchives)
      .where(and(eq(closeoutArchives.projectId, a.project.id), inArray(closeoutArchives.status, ["done", "expired"]), eq(closeoutArchives.problems, 0)))
      .orderBy(desc(closeoutArchives.finishedAt))
      .limit(1);
    if (!archive) throw badRequest(msg("closeout:errors.archiveFirst"));
    if (!(await closeProject(db, a.project.id, a.user.id, archive.id))) throw conflict(msg("closeout:errors.alreadyClosed"));
    return { ok: true };
  });

  api.post<{ Params: { pid: string } }>("/projects/:pid/reopen", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    if (!req.user!.isAdmin) throw forbidden(msg("closeout:errors.reopenAdminOnly"));
    const { reason } = reopenSchema.parse(req.body ?? {});
    if (!a.project.closedAt) throw conflict(msg("closeout:errors.notClosed"));
    await db.update(projects).set({ closedAt: null, closedBy: null }).where(eq(projects.id, a.project.id));
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "project.reopened",
      targetType: "project",
      targetId: a.project.id,
      details: { closedAt: a.project.closedAt.toISOString(), ...(reason ? { reason } : {}) },
    });
    return { ok: true };
  });
}
