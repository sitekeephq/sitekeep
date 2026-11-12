import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { WORK_STATUS } from "@sitekeep/shared";
import { projectAccess } from "../../core/security/access.js";
import { audit } from "../../core/platform/audit.js";
import { badRequest, conflict, notFound } from "../../core/platform/http.js";
import { msg, requestLanguage } from "../../i18n/index.js";
import { fileVersions, files, workLinks, works } from "../../db/schema.js";
import {
  addEvent,
  checkLinkTarget,
  defaultRole,
  requireEdit,
} from "../service.js";
import { linkSchema, type WorksRouteContext } from "./route-helpers.js";

export function registerWorkLinkRoutes(r: WorksRouteContext) {
  const { api, db, storage } = r;

  api.post<{ Params: { pid: string; wid: string } }>("/projects/:pid/works/:wid/links", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const { work } = await r.visible(a, req.params.wid);
    requireEdit(work, a);
    const body = z.union([linkSchema, z.object({ links: z.array(linkSchema).min(1).max(500) })]).parse(req.body);
    const list = "links" in body ? body.links : [body];
    for (const l of list) {
      const role = l.role ?? defaultRole(l.kind);
      if (role === "kapak") throw badRequest(msg("works:errors.coverAddedBySystem"));
      if (role === "ek" && l.kind !== "file_version") throw badRequest(msg("works:errors.attachmentFileOnly"));
      if (role === "ek" && work.status !== WORK_STATUS.draft) throw conflict(msg("works:errors.attachmentsLocked"));
      await checkLinkTarget(db, a, l, work.id);
    }
    const inserted = await db
      .insert(workLinks)
      .values(list.map((l) => ({
        workId: work.id,
        kind: l.kind,
        targetId: l.targetId,
        role: l.role ?? defaultRole(l.kind),
        meta: l.meta ?? {},
        createdBy: a.user.id,
      })))
      .onConflictDoNothing()
      .returning();
    if (inserted.length)
      await addEvent(db, work.id, "linked", a.user.id, null, {
        links: inserted.map((l) => ({ kind: l.kind, role: l.role, targetId: l.targetId })),
      });
    await db.update(works).set({ updatedAt: new Date() }).where(eq(works.id, work.id));
    return r.detail(a, work.id, requestLanguage(req));
  });

  api.patch<{ Params: { pid: string; wid: string; lid: string } }>("/projects/:pid/works/:wid/links/:lid", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const { work } = await r.visible(a, req.params.wid);
    requireEdit(work, a);
    const link = await r.loadLink(work.id, req.params.lid);
    const body = z.object({ signed: z.boolean() }).parse(req.body);
    if (link.kind !== "file_version" || link.role !== "ek") throw badRequest(msg("works:errors.signedFileOnly"));
    if (work.status !== WORK_STATUS.draft) throw conflict(msg("works:errors.attachmentsLocked"));
    await db.update(workLinks).set({ meta: { ...link.meta, signed: body.signed } }).where(eq(workLinks.id, link.id));
    await addEvent(db, work.id, "updated", a.user.id, null, { link: link.id, signed: body.signed });
    return r.detail(a, work.id, requestLanguage(req));
  });

  api.delete<{ Params: { pid: string; wid: string; lid: string } }>("/projects/:pid/works/:wid/links/:lid", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const { work } = await r.visible(a, req.params.wid);
    requireEdit(work, a);
    const link = await r.loadLink(work.id, req.params.lid);
    if (link.role === "kapak") throw badRequest(msg("works:errors.coverNotRemovable"));
    if (link.role === "ek" && work.status !== WORK_STATUS.draft) throw conflict(msg("works:errors.attachmentsLocked"));
    await db.delete(workLinks).where(eq(workLinks.id, link.id));
    await addEvent(db, work.id, "unlinked", a.user.id, null, { kind: link.kind, role: link.role, targetId: link.targetId });
    return r.detail(a, work.id, requestLanguage(req));
  });

  api.get<{ Params: { pid: string; wid: string; lid: string } }>(
    "/projects/:pid/works/:wid/links/:lid/download",
    async (req, reply) => {
      const a = await projectAccess(db, req.params.pid, req.user!);
      const { work } = await r.visible(a, req.params.wid);
      const link = await r.loadLink(work.id, req.params.lid);
      if (link.kind !== "file_version") throw notFound(msg("works:entities.file"));
      const [row] = await db
        .select({ v: fileVersions, f: files })
        .from(fileVersions)
        .innerJoin(files, eq(files.id, fileVersions.fileId))
        .where(and(eq(fileVersions.id, link.targetId), eq(files.projectId, a.project.id)));
      if (!row) throw notFound(msg("works:entities.file"));
      await audit(db, {
        projectId: a.project.id,
        userId: a.user.id,
        action: "file.downloaded",
        targetType: "file",
        targetId: row.f.id,
        details: { version: row.v.version, workId: work.id },
      });
      const name = row.f.name;
      const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
      const inline = (req.query as { inline?: string }).inline === "1";
      reply.header("Content-Disposition", `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`);
      reply.header("Content-Length", String(row.v.size));
      reply.header("Content-Type", name.toLowerCase().endsWith(".pdf") ? "application/pdf" : "application/octet-stream");
      return reply.send(storage.get(row.v.storageKey));
    },
  );
}
