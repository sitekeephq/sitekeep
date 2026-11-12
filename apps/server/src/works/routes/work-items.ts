import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  LETTER_STATUS,
  WORK_DUE_SOON_DAYS,
  WORK_STATUS,
  canSeeWork,
  emptyLetter,
  foldTr,
  validateWorkFields,
} from "@sitekeep/shared";
import { projectAccess, userNames } from "../../core/security/access.js";
import { audit } from "../../core/platform/audit.js";
import { HttpError, badRequest, conflict, notFound } from "../../core/platform/http.js";
import { msg, requestLanguage } from "../../i18n/index.js";
import { projectMembers, works } from "../../db/schema.js";
import { requireWorkModule } from "../../projects/modules.js";
import { notify } from "../../workflow/service.js";
import { isLetterType, isOutgoingLetter, letterOf, letterPatchSchema, mergeLetter } from "../letter.js";
import {
  addDaysIso,
  addEvent,
  attachSourceFile,
  companyNames,
  createWork,
  isClosed,
  projectTypes,
  requireEdit,
  toSummary,
  todayIso,
  viewerOf,
  workLink,
} from "../service.js";
import { participantWorkIds } from "../participants.js";
import { readUpload } from "../intake-upload.js";
import { date, defined, fieldsSchema, linkSchema, uuid, type WorksRouteContext } from "./route-helpers.js";

function matchesView(view: string, w: typeof works.$inferSelect, t: Awaited<ReturnType<typeof projectTypes>>[number]): boolean {
  if (t.category !== "correspondence") return false;
  switch (view) {
    case "awaiting":
      return w.replyRequired && (w.status === WORK_STATUS.sent || w.status === WORK_STATUS.received);
    case "unmailed":
      return isOutgoingLetter(t) && !!w.sentAt && w.status !== LETTER_STATUS.cancelled && !letterOf(w).mailSentAt;
    case "archived":
      return w.status === LETTER_STATUS.archived;
    case "cancelled":
      return w.status === LETTER_STATUS.cancelled;
    default:
      return true;
  }
}

export function registerWorkItemRoutes(r: WorksRouteContext) {
  const { api, db, storage, deps, worksCtx } = r;

  api.get<{
    Params: { pid: string };
    Querystring: {
      type?: string;
      status?: string;
      q?: string;
      open?: string;
      due?: string;
      mine?: string;
      limit?: string;
      category?: string;
      parent?: string;
      view?: string;
    };
  }>("/projects/:pid/works", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const types = await projectTypes(db, a.project.id);
    const q = req.query;
    const typeFilter = q.type ? q.type.split(",").filter(Boolean) : [];
    const rows = await db
      .select()
      .from(works)
      .where(and(eq(works.projectId, a.project.id), q.status ? inArray(works.status, q.status.split(",")) : undefined))
      .orderBy(desc(works.createdAt));
    const viewer = viewerOf(a);
    const today = todayIso();
    const soon = addDaysIso(today, WORK_DUE_SOON_DAYS);
    const needle = q.q?.trim() ? foldTr(q.q.trim()) : null;
    const limit = Math.min(Math.max(Number(q.limit) || 500, 1), 2000);
    const categories = q.category ? q.category.split(",").filter(Boolean) : [];
    const participant = await participantWorkIds(db, a, rows.filter((w) => w.workflowInstanceId && !canSeeWork(w, viewer)).map((w) => w.id));
    const out = [];
    for (const w of rows) {
      const t = types.find((x) => x.id === w.typeId)!;
      if (typeFilter.length && !typeFilter.includes(t.key) && !typeFilter.includes(t.id)) continue;
      if (categories.length && !categories.includes(t.category)) continue;
      if (q.parent && w.parentWorkId !== q.parent) continue;
      if (!canSeeWork(w, viewer) && !participant.has(w.id)) continue;
      const closed = isClosed(t, w.status);
      if (q.open === "1" && closed) continue;
      if (q.mine === "1" && w.assigneeUserId !== a.user.id && w.createdBy !== a.user.id) continue;
      if (q.due === "overdue" && (closed || !w.dueDate || w.dueDate >= today)) continue;
      if (q.due === "soon" && (closed || !w.dueDate || w.dueDate < today || w.dueDate > soon)) continue;
      if (needle && !foldTr(`${w.number} ${w.title} ${Object.values(w.fields).join(" ")}`).includes(needle)) continue;
      if (q.view && !matchesView(q.view, w, t)) continue;
      out.push({ w, t });
      if (out.length >= limit) break;
    }
    const names = await userNames(db, out.map((x) => x.w.createdBy));
    return out.map(({ w, t }) => toSummary(w, t, names, today));
  });

  api.post<{ Params: { pid: string } }>("/projects/:pid/works", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const body = z.object({
      typeId: uuid.optional(),
      typeKey: z.string().max(40).optional(),
      title: z.string().trim().min(1).max(300),
      fields: fieldsSchema.optional(),
      status: z.string().max(40).optional(),
      fromCompanyId: uuid.nullable().optional(),
      toCompanyIds: z.array(uuid).max(50).optional(),
      ccCompanyIds: z.array(uuid).max(50).optional(),
      assigneeUserId: uuid.nullable().optional(),
      dueDate: date.nullable().optional(),
      replyRequired: z.boolean().optional(),
      links: z.array(linkSchema).max(500).optional(),
      parentWorkId: uuid.nullable().optional(),
      letter: letterPatchSchema.optional(),
      sourceUploadId: z.string().max(4000).optional(),
    }).parse(req.body);
    const types = await projectTypes(db, a.project.id);
    const type = types.find((t) => t.id === body.typeId || (!body.typeId && t.key === body.typeKey));
    if (!type) throw notFound(msg("works:entities.workType"));
    requireWorkModule(a, type.category);
    const viewer = viewerOf(a);
    const { letter, sourceUploadId, ...rest } = body;
    const staged = sourceUploadId ? readUpload(deps.secretKey, sourceUploadId, a.project.id, a.user.id) : null;
    if (staged && (await storage.size(staged.obj.key).catch(() => -1)) !== staged.obj.size)
      throw new HttpError(410, "upload_expired", msg("works:errors.uploadMissing"));
    const work = await createWork(db, a, a.project, type, { userId: a.user.id, companyId: viewer.companyId }, {
      ...rest,
      letter: letter ? mergeLetter(emptyLetter(), letter) : null,
      lang: requestLanguage(req),
    });
    if (staged) await attachSourceFile(worksCtx, a.project, work, type, a.user.id, staged.obj, staged.name);
    return r.detail(a, work.id, requestLanguage(req));
  });

  api.get<{ Params: { pid: string; wid: string } }>("/projects/:pid/works/:wid", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const { work } = await r.visible(a, req.params.wid);
    return r.detail(a, work.id, requestLanguage(req));
  });

  api.patch<{ Params: { pid: string; wid: string } }>("/projects/:pid/works/:wid", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const { work, type } = await r.visible(a, req.params.wid);
    requireEdit(work, a);
    const body = z.object({
      title: z.string().trim().min(1).max(300).optional(),
      fields: fieldsSchema.optional(),
      status: z.string().max(40).optional(),
      fromCompanyId: uuid.nullable().optional(),
      toCompanyIds: z.array(uuid).max(50).optional(),
      ccCompanyIds: z.array(uuid).max(50).optional(),
      assigneeUserId: uuid.nullable().optional(),
      dueDate: date.nullable().optional(),
      replyRequired: z.boolean().optional(),
    }).parse(req.body);
    const fields = body.fields ? { ...work.fields, ...body.fields } : undefined;
    if (fields) {
      for (const [k, v] of Object.entries(fields)) if (v === null || v === "") delete fields[k];
      const problems = validateWorkFields(type.fields, fields, false, requestLanguage(req));
      if (problems.length) throw badRequest(problems.join(" "));
    }
    if (body.status !== undefined && body.status !== work.status && isLetterType(type)) {
      const locked: string[] = [LETTER_STATUS.archived, LETTER_STATUS.cancelled];
      if (locked.includes(body.status) || locked.includes(work.status))
        throw conflict(msg("works:errors.useLetterActions"));
    }
    if (body.status !== undefined) {
      if (!type.statuses.some((s) => s.key === body.status)) throw badRequest(msg("works:errors.invalidStatus", { status: body.status }));
      if (body.status === WORK_STATUS.sent && work.status !== WORK_STATUS.sent)
        throw badRequest(msg("works:errors.useSend"));
    }
    if (work.status !== WORK_STATUS.draft && (body.toCompanyIds || body.ccCompanyIds || body.fromCompanyId !== undefined))
      throw conflict(msg("works:errors.recipientsLocked"));
    const companyIds = [...(body.toCompanyIds ?? []), ...(body.ccCompanyIds ?? []), ...(body.fromCompanyId ? [body.fromCompanyId] : [])];
    if (companyIds.length && (await companyNames(db, companyIds)).size !== new Set(companyIds).size) throw badRequest(msg("works:errors.companyNotFound"));
    if (body.assigneeUserId) {
      const [m] = await db.select().from(projectMembers)
        .where(and(eq(projectMembers.projectId, a.project.id), eq(projectMembers.userId, body.assigneeUserId)));
      if (!m) throw badRequest(msg("works:errors.assigneeNotMember"));
    }
    const to = body.toCompanyIds ? [...new Set(body.toCompanyIds)] : undefined;
    const cc = body.ccCompanyIds ? [...new Set(body.ccCompanyIds)].filter((c) => !(to ?? work.toCompanyIds).includes(c)) : undefined;
    const now = new Date();
    const closedNow = body.status !== undefined ? isClosed(type, body.status) : undefined;
    const [updated] = await db.update(works).set({
      ...defined({
        title: body.title,
        fields,
        status: body.status,
        fromCompanyId: body.fromCompanyId,
        toCompanyIds: to,
        ccCompanyIds: cc,
        assigneeUserId: body.assigneeUserId,
        dueDate: body.dueDate,
        replyRequired: body.replyRequired,
      }),
      ...(closedNow === undefined ? {} : { closedAt: closedNow ? (work.closedAt ?? now) : null }),
      updatedAt: now,
    }).where(eq(works.id, work.id)).returning();
    const changed = Object.keys(defined(body)).filter((k) => k !== "status");
    if (changed.length) await addEvent(db, work.id, "updated", a.user.id, null, { changed });
    if (body.status !== undefined && body.status !== work.status)
      await addEvent(db, work.id, "status", a.user.id, null, { from: work.status, to: body.status });
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "work.updated",
      targetType: "work",
      targetId: work.id,
      details: { number: work.number, ...defined({ ...body, fields: body.fields ? Object.keys(body.fields) : undefined }) },
    });
    if (body.assigneeUserId && body.assigneeUserId !== work.assigneeUserId && body.assigneeUserId !== a.user.id)
      await notify(db, [body.assigneeUserId], {
        projectId: a.project.id,
        kind: "work.assigned",
        title: msg("works:notifications.assigned", { number: work.number, title: updated!.title }),
        link: workLink(a.project.id, work.id),
      });
    return r.detail(a, updated!.id, requestLanguage(req));
  });

  api.post<{ Params: { pid: string; wid: string } }>("/projects/:pid/works/:wid/comments", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const { work } = await r.visible(a, req.params.wid);
    const body = z.object({ body: z.string().trim().min(1).max(10000) }).parse(req.body);
    await addEvent(db, work.id, "comment", a.user.id, body.body);
    await db.update(works).set({ updatedAt: new Date() }).where(eq(works.id, work.id));
    return r.detail(a, work.id, requestLanguage(req));
  });
}
