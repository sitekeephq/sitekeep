import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  LETTER_ARCHIVABLE,
  LETTER_STATUS,
  WORK_FIELD_TYPES,
  WORK_LINK_KINDS,
  WORK_LINK_ROLES,
  WORK_STATUS,
  canEditWork,
  canSeeWork,
  checkNumberingPattern,
  checkWorkFieldDefs,
  isWorkAddressee,
  type WorkDetailDto,
  type WorkThreadItemDto,
} from "@sitekeep/shared";
import type { ResolvedDeps } from "../../app/deps.js";
import { isUuid, projectAccess, userNames } from "../../core/security/access.js";
import { audit } from "../../core/platform/audit.js";
import { badRequest, notFound } from "../../core/platform/http.js";
import { DEFAULT_LANGUAGE, msg, render } from "../../i18n/index.js";
import {
  folders,
  workEvents,
  workLinks,
  workReceipts,
  workTypes,
  workflowTemplates,
  works,
} from "../../db/schema.js";
import { deliveryChannel } from "../delivery.js";
import {
  buildEml,
  isLetterType,
  isOutgoingLetter,
  letterMail,
  letterOf,
  sendLetterMail,
  threadGraph,
} from "../letter.js";
import {
  addEvent,
  buildLetterPdf,
  canDeleteWork,
  companyNames,
  loadVisibleWork,
  projectTypes,
  resolveLinks,
  statusDef,
  toSummary,
  viewerOf,
} from "../service.js";
import { buildDetail } from "../detail.js";

export const uuid = z.string().uuid();
export const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const fieldValue = z.union([z.string().max(20000), z.number(), z.boolean(), z.null()]);
export const fieldsSchema = z.record(z.string(), fieldValue);
export const linkSchema = z.object({
  kind: z.enum(WORK_LINK_KINDS),
  targetId: uuid,
  role: z.enum(WORK_LINK_ROLES).optional(),
  meta: z.object({ signed: z.boolean().optional() }).optional(),
});
export const fieldDefSchema = z.object({
  key: z.string().trim().min(1).max(40),
  label: z.string().trim().min(1).max(120),
  type: z.enum(WORK_FIELD_TYPES),
  required: z.boolean().optional(),
  options: z.array(z.string().trim().min(1).max(120)).max(200).optional(),
  help: z.string().trim().max(300).optional(),
});

export function defined<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export function canEditLetter(w: typeof works.$inferSelect, t: typeof workTypes.$inferSelect): boolean {
  if (w.status === WORK_STATUS.draft) return true;
  return !!t.settings.incoming && w.status !== LETTER_STATUS.archived && w.status !== LETTER_STATUS.cancelled;
}

export function createWorksRouteContext(api: FastifyInstance, deps: ResolvedDeps) {
  const { db, storage } = deps;
  const worksCtx = { db, storage };

  async function visible(a: Awaited<ReturnType<typeof projectAccess>>, wid: string) {
    if (!isUuid(wid)) throw notFound(msg("works:entities.work"));
    return loadVisibleWork(db, a, wid);
  }

  async function loadLink(workId: string, lid: string) {
    if (!isUuid(lid)) throw notFound(msg("works:entities.link"));
    const [l] = await db.select().from(workLinks).where(and(eq(workLinks.id, lid), eq(workLinks.workId, workId)));
    if (!l) throw notFound(msg("works:entities.link"));
    return l;
  }

  async function loadType(projectId: string, tid: string) {
    if (!isUuid(tid)) throw notFound(msg("works:entities.workType"));
    const [t] = await db.select().from(workTypes).where(and(eq(workTypes.id, tid), eq(workTypes.projectId, projectId)));
    if (!t) throw notFound(msg("works:entities.workType"));
    return t;
  }

  async function checkType(
    projectId: string,
    body: {
      numberingPattern: string;
      fields: z.infer<typeof fieldDefSchema>[];
      defaultWorkflowTemplateId?: string | null;
      settings?: { coverFolderId?: string | null };
    },
    lang: string = DEFAULT_LANGUAGE,
  ) {
    const problems = [...checkNumberingPattern(body.numberingPattern, body.fields, lang), ...checkWorkFieldDefs(body.fields, lang)];
    if (problems.length) throw badRequest(problems.join(" "));
    if (body.defaultWorkflowTemplateId) {
      const [t] = await db
        .select()
        .from(workflowTemplates)
        .where(and(eq(workflowTemplates.id, body.defaultWorkflowTemplateId), eq(workflowTemplates.projectId, projectId)));
      if (!t) throw badRequest(msg("works:errors.workflowTemplateNotFound"));
    }
    if (body.settings?.coverFolderId) {
      const [f] = await db
        .select()
        .from(folders)
        .where(and(eq(folders.id, body.settings.coverFolderId), eq(folders.projectId, projectId), isNull(folders.deletedAt)));
      if (!f) throw badRequest(msg("works:errors.coverFolderNotFound"));
    }
  }

  async function visibleThread(a: Awaited<ReturnType<typeof projectAccess>>, workId: string): Promise<WorkThreadItemDto[]> {
    const { ids, edges } = await threadGraph(db, a.project.id, workId);
    const types = await projectTypes(db, a.project.id);
    const rows = await db
      .select()
      .from(works)
      .where(and(eq(works.projectId, a.project.id), inArray(works.id, [...ids])))
      .orderBy(asc(works.createdAt));
    const viewer = viewerOf(a);
    const shown = rows.filter((w) => canSeeWork(w, viewer));
    const names = await userNames(db, shown.map((w) => w.createdBy));
    const visibleIds = new Set(shown.map((w) => w.id));
    return shown.map(
      (w): WorkThreadItemDto => ({
        ...toSummary(w, types.find((t) => t.id === w.typeId)!, names),
        refs: edges.filter((e) => e.from === w.id && visibleIds.has(e.to)).map((e) => e.to),
      }),
    );
  }

  async function prepareMail(
    a: Awaited<ReturnType<typeof projectAccess>>,
    work: typeof works.$inferSelect,
    type: typeof workTypes.$inferSelect,
    from?: string,
  ) {
    if (!isOutgoingLetter(type)) throw badRequest(msg("works:errors.mailOutgoingOnly"));
    const letter = letterOf(work);
    const names = await companyNames(db, [work.fromCompanyId, work.ownerCompanyId]);
    const company = names.get(work.fromCompanyId ?? "") ?? names.get(work.ownerCompanyId ?? "") ?? "";
    const pdf = await buildLetterPdf(db, a.project, work, type);
    return letterMail(letter, {
      number: work.number,
      title: work.title,
      senderName: letter.signer.name.trim() || a.user.name,
      company,
      from: from ?? `"${a.user.name.replace(/"/g, "'")}" <${a.user.email}>`,
      pdf,
    });
  }

  async function markMailed(
    a: Awaited<ReturnType<typeof projectAccess>>,
    work: typeof works.$inferSelect,
    how: "smtp" | "manual",
    details: Record<string, unknown>,
  ) {
    const now = new Date();
    const letter = { ...letterOf(work), mailSentAt: now.toISOString() };
    await db.update(works).set({ data: { ...work.data, letter }, updatedAt: now }).where(eq(works.id, work.id));
    await addEvent(
      db,
      work.id,
      "mail",
      a.user.id,
      how === "smtp" ? "E-posta sunucudan gönderildi" : "E-posta gönderildi olarak işaretlendi", // i18n-ok: event message stored as data
      { how, ...details },
    );
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "work.mailed",
      targetType: "work",
      targetId: work.id,
      details: { number: work.number, how, ...details },
    });
  }

  async function detail(a: Awaited<ReturnType<typeof projectAccess>>, wid: string, lang: string = DEFAULT_LANGUAGE): Promise<WorkDetailDto> {
    const { work: w, type: t } = await loadVisibleWork(db, a, wid);
    const viewer = viewerOf(a);
    const links = await db.select().from(workLinks).where(eq(workLinks.workId, w.id)).orderBy(asc(workLinks.createdAt));
    const incoming = await db
      .select()
      .from(workLinks)
      .where(and(eq(workLinks.kind, "work"), eq(workLinks.targetId, w.id)))
      .orderBy(asc(workLinks.createdAt));
    const resolved = await resolveLinks(db, a, links, lang);
    const back = (await resolveLinks(db, a, incoming.map((l) => ({ ...l, incoming: true })), lang)).filter((l) => !l.target.missing);
    const events = await db.select().from(workEvents).where(eq(workEvents.workId, w.id)).orderBy(asc(workEvents.at));
    const receipts = await db.select().from(workReceipts).where(eq(workReceipts.workId, w.id)).orderBy(asc(workReceipts.receivedAt));
    const names = await userNames(db, [
      w.createdBy,
      w.assigneeUserId,
      w.delivery?.sentBy,
      ...events.map((e) => e.userId),
      ...receipts.map((r) => r.receivedBy),
    ]);
    const cnames = await companyNames(db, [
      w.fromCompanyId,
      w.ownerCompanyId,
      ...w.toCompanyIds,
      ...w.ccCompanyIds,
      ...receipts.map((r) => r.companyId),
    ]);
    const editable = canEditWork(w, viewer);
    const addressee = isWorkAddressee(w, viewer);
    const s = statusDef(t, w.status);
    return {
      ...toSummary(w, t, names),
      fields: w.fields,
      ownerCompanyId: w.ownerCompanyId,
      delivery: w.delivery ? { ...w.delivery, channelLabel: render(lang, deliveryChannel(w.delivery.channel)?.label ?? w.delivery.channel) } : null,
      receipts: receipts.map((r) => ({
        companyId: r.companyId,
        companyName: cnames.get(r.companyId),
        receivedAt: r.receivedAt.toISOString(),
        receivedBy: r.receivedBy,
        receivedByName: names.get(r.receivedBy),
      })),
      links: resolved,
      backlinks: back,
      events: events.map((e) => ({
        id: e.id,
        kind: e.kind,
        userId: e.userId,
        userName: e.userId ? names.get(e.userId) : undefined,
        message: e.message,
        details: e.details,
        at: e.at.toISOString(),
      })),
      workflowInstanceId: w.workflowInstanceId,
      canEdit: editable,
      canSend: editable && w.status === WORK_STATUS.draft && !t.settings.incoming && t.statuses.some((x) => x.key === WORK_STATUS.sent),
      canReceive: addressee && w.status !== WORK_STATUS.draft && !s.closed && !receipts.some((r) => r.companyId === viewer.companyId),
      canReply: w.status !== WORK_STATUS.draft && t.category === "correspondence",
      names: { ...Object.fromEntries(names), ...Object.fromEntries(cnames) },
      data: w.data,
      build: await buildDetail(db, a, w, t, lang),
      letter: isLetterType(t)
        ? {
            data: letterOf(w),
            threadCount: (await visibleThread(a, w.id)).filter((x) => x.id !== w.id).length,
            pdf: isOutgoingLetter(t),
            canArchive: editable && (LETTER_ARCHIVABLE as readonly string[]).includes(w.status),
            canCancel: editable && w.status !== LETTER_STATUS.archived && w.status !== LETTER_STATUS.cancelled,
            canReopen: editable && w.status === LETTER_STATUS.cancelled,
            canDelete: editable && canDeleteWork(w, t, a),
            canEditLetter: editable && canEditLetter(w, t),
            smtp: !!deps.mailer,
          }
        : null,
    };
  }

  return {
    api,
    deps,
    db,
    storage,
    worksCtx,
    visible,
    loadLink,
    loadType,
    checkType,
    visibleThread,
    prepareMail,
    markMailed,
    detail,
    buildEml,
    sendLetterMail,
  };
}

export type WorksRouteContext = ReturnType<typeof createWorksRouteContext>;
