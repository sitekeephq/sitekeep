import { eq } from "drizzle-orm";
import { z } from "zod";
import {
  DELIVERY_STATUSES,
  LETTER_LANGS,
  LETTER_LANGUAGE_LABELS,
  WORK_STATUS,
  letterValues,
} from "@sitekeep/shared";
import { projectAccess } from "../../core/security/access.js";
import { audit } from "../../core/platform/audit.js";
import { HttpError, badRequest, conflict } from "../../core/platform/http.js";
import { msg, requestLanguage } from "../../i18n/index.js";
import { works, type WorkDelivery } from "../../db/schema.js";
import { AiError, resolveProvider } from "../../ai/provider.js";
import { translateLetter } from "../letter-translate.js";
import {
  isLetterType,
  isOutgoingLetter,
  letterOf,
  letterPatchSchema,
  mergeLetter,
  pdfFileName,
} from "../letter.js";
import {
  addEvent,
  archiveLetter,
  buildLetterPdf,
  deleteWork,
  generateCover,
  receiveWork,
  reopenLetter,
  replyToWork,
  requireEdit,
  sendWork,
} from "../service.js";
import { defined, canEditLetter, type WorksRouteContext } from "./route-helpers.js";

export function registerWorkActionRoutes(r: WorksRouteContext) {
  const { api, db, deps, worksCtx } = r;

  api.post<{ Params: { pid: string; wid: string } }>("/projects/:pid/works/:wid/send", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const { work, type } = await r.visible(a, req.params.wid);
    requireEdit(work, a);
    const body = z.object({
      channel: z.string().max(40).default("cde"),
      reference: z.string().trim().max(200).nullable().optional(),
      note: z.string().trim().max(2000).nullable().optional(),
    }).parse(req.body ?? {});
    await sendWork(worksCtx, a.project, work, type, a.user.id, { ...body, lang: requestLanguage(req) });
    return r.detail(a, work.id, requestLanguage(req));
  });

  api.patch<{ Params: { pid: string; wid: string } }>("/projects/:pid/works/:wid/delivery", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const { work } = await r.visible(a, req.params.wid);
    requireEdit(work, a);
    if (!work.delivery) throw conflict(msg("works:errors.notSentYet"));
    const body = z.object({
      status: z.enum(DELIVERY_STATUSES).optional(),
      reference: z.string().trim().max(200).nullable().optional(),
      note: z.string().trim().max(2000).nullable().optional(),
    }).parse(req.body);
    const delivery: WorkDelivery = { ...work.delivery, ...defined(body), updatedAt: new Date().toISOString() };
    await db.update(works).set({ delivery, updatedAt: new Date() }).where(eq(works.id, work.id));
    await addEvent(db, work.id, "delivery", a.user.id, null, defined(body));
    return r.detail(a, work.id, requestLanguage(req));
  });

  api.post<{ Params: { pid: string; wid: string } }>("/projects/:pid/works/:wid/receive", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const { work, type } = await r.visible(a, req.params.wid);
    await receiveWork(db, a, work, type);
    return r.detail(a, work.id, requestLanguage(req));
  });

  api.post<{ Params: { pid: string; wid: string } }>("/projects/:pid/works/:wid/reply", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const { work, type } = await r.visible(a, req.params.wid);
    if (work.status === WORK_STATUS.draft) throw conflict(msg("works:errors.draftNoReply"));
    const body = z.object({ title: z.string().trim().max(300).optional(), typeKey: z.string().max(40).optional() }).parse(req.body ?? {});
    const reply = await replyToWork(db, a, work, type, body);
    return r.detail(a, reply.id, requestLanguage(req));
  });

  api.post<{ Params: { pid: string; wid: string } }>("/projects/:pid/works/:wid/cover", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const { work, type } = await r.visible(a, req.params.wid);
    requireEdit(work, a);
    await generateCover(worksCtx, a.project, work, type, a.user.id, requestLanguage(req));
    return r.detail(a, work.id, requestLanguage(req));
  });

  api.get<{ Params: { pid: string; wid: string } }>("/projects/:pid/works/:wid/thread", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const { work } = await r.visible(a, req.params.wid);
    return r.visibleThread(a, work.id);
  });

  api.put<{ Params: { pid: string; wid: string } }>("/projects/:pid/works/:wid/letter", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const { work, type } = await r.visible(a, req.params.wid);
    requireEdit(work, a);
    if (!isLetterType(type)) throw badRequest(msg("works:errors.letterDataCorrespondenceOnly"));
    if (!canEditLetter(work, type)) throw conflict(msg("works:errors.letterLocked"));
    const patch = letterPatchSchema.parse(req.body);
    const letter = mergeLetter(letterOf(work), patch);
    await db.update(works).set({ data: { ...work.data, letter }, updatedAt: new Date() }).where(eq(works.id, work.id));
    await addEvent(db, work.id, "letter", a.user.id, null, { changed: Object.keys(patch) });
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "work.letter_updated",
      targetType: "work",
      targetId: work.id,
      details: { number: work.number, changed: Object.keys(patch) },
    });
    return r.detail(a, work.id, requestLanguage(req));
  });

  api.get<{ Params: { pid: string; wid: string }; Querystring: { inline?: string } }>(
    "/projects/:pid/works/:wid/letter.pdf",
    async (req, reply) => {
      const a = await projectAccess(db, req.params.pid, req.user!);
      const { work, type } = await r.visible(a, req.params.wid);
      const pdf = await buildLetterPdf(db, a.project, work, type);
      const name = pdfFileName(work.number);
      reply.header("Content-Type", "application/pdf");
      reply.header("Content-Disposition", `${req.query.inline === "1" ? "inline" : "attachment"}; filename="${name.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`);
      return reply.send(Buffer.from(pdf));
    },
  );

  api.get<{ Params: { pid: string; wid: string } }>("/projects/:pid/works/:wid/letter.eml", async (req, reply) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const { work, type } = await r.visible(a, req.params.wid);
    requireEdit(work, a);
    const mail = await r.prepareMail(a, work, type);
    const eml = await r.buildEml(mail);
    const name = `${work.number.replace(/[^0-9A-Za-z._-]/g, "_")}.eml`;
    reply.header("Content-Type", "message/rfc822");
    reply.header("Content-Disposition", `attachment; filename="${name}"`);
    return reply.send(eml);
  });

  api.post<{ Params: { pid: string; wid: string } }>("/projects/:pid/works/:wid/letter/mail", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const { work, type } = await r.visible(a, req.params.wid);
    requireEdit(work, a);
    if (!deps.mailer) throw new HttpError(503, "smtp_off", msg("works:errors.smtpOff"));
    if (work.status === WORK_STATUS.draft) throw conflict(msg("works:errors.sendBeforeMail"));
    const mail = await r.prepareMail(a, work, type, deps.mailer.from);
    let messageId: string | null;
    try {
      messageId = await r.sendLetterMail(deps.mailer, mail);
    } catch (e) {
      throw new HttpError(502, "smtp_error", msg("works:errors.smtpError", { error: (e as Error).message }));
    }
    await r.markMailed(a, work, "smtp", { messageId, to: mail.to, cc: mail.cc });
    return r.detail(a, work.id, requestLanguage(req));
  });

  api.post<{ Params: { pid: string; wid: string } }>("/projects/:pid/works/:wid/letter/mail-sent", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const { work, type } = await r.visible(a, req.params.wid);
    requireEdit(work, a);
    if (!isOutgoingLetter(type)) throw badRequest(msg("works:errors.mailOutgoingOnly"));
    if (work.status === WORK_STATUS.draft) throw conflict(msg("works:errors.draftNotMailed"));
    if (letterOf(work).mailSentAt) throw conflict(msg("works:errors.alreadyMailed"));
    await r.markMailed(a, work, "manual", {});
    return r.detail(a, work.id, requestLanguage(req));
  });

  api.post<{ Params: { pid: string; wid: string } }>("/projects/:pid/works/:wid/letter/translate", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const { work, type } = await r.visible(a, req.params.wid);
    requireEdit(work, a);
    if (!isLetterType(type)) throw badRequest(msg("works:errors.translateCorrespondenceOnly"));
    const body = z.object({ language: z.enum(LETTER_LANGS).exclude(["tr"]) }).parse(req.body);
    let provider;
    try {
      provider = await resolveProvider(db, deps.secretKey, a.project.id);
    } catch (e) {
      if (e instanceof AiError && e.code === "ai_no_provider") throw new HttpError(503, "ai_unavailable", e.message);
      throw e;
    }
    const v = letterValues(letterOf(work), work.title, "tr");
    try {
      const suggestion = await translateLetter(provider, LETTER_LANGUAGE_LABELS[body.language], {
        subject: v.subject,
        body: v.body,
        body2: v.body2,
        signerTitle: v.signerTitle,
      });
      return { language: body.language, ...suggestion };
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(502, "ai_bad_answer", (e as Error).message);
    }
  });

  api.post<{ Params: { pid: string; wid: string } }>("/projects/:pid/works/:wid/archive", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const { work, type } = await r.visible(a, req.params.wid);
    await archiveLetter(db, a, work, type);
    return r.detail(a, work.id, requestLanguage(req));
  });

  api.post<{ Params: { pid: string; wid: string } }>("/projects/:pid/works/:wid/reopen", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const { work, type } = await r.visible(a, req.params.wid);
    await reopenLetter(db, a, work, type);
    return r.detail(a, work.id, requestLanguage(req));
  });

  api.delete<{ Params: { pid: string; wid: string } }>("/projects/:pid/works/:wid", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const { work, type } = await r.visible(a, req.params.wid);
    requireEdit(work, a);
    await deleteWork(db, a, work, type);
    return { ok: true };
  });
}
