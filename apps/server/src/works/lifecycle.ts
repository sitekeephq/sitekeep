import { and, eq, inArray } from "drizzle-orm";
import {
  LETTER_ARCHIVABLE,
  LETTER_STATUS,
  WORK_STATUS,
  canSeeWork,
  isWorkAddressee,
  letterSendProblems,
  validateWorkFields,
  workTokenValues,
  type LetterData,
  type WorkEventKind,
  type WorkFieldValues,
} from "@sitekeep/shared";
import type { ProjectAccess } from "../core/security/access.js";
import { audit } from "../core/platform/audit.js";
import { badRequest, conflict, forbidden, notFound } from "../core/platform/http.js";
import type { Db } from "../db/index.js";
import { DEFAULT_LANGUAGE, msg } from "../i18n/index.js";
import {
  fileVersions,
  files,
  projects,
  workEvents,
  workLinks,
  workReceipts,
  works,
  type WorkDelivery,
} from "../db/schema.js";
import { requireWorkModule } from "../projects/modules.js";
import { notify } from "../workflow/service.js";
import { deliveryChannel } from "./delivery.js";
import { generateCover, generateLetterPdf } from "./pdf-attachments.js";
import {
  initialLetter,
  isLetterType,
  isOutgoingLetter,
  letterOf,
  recipientFromCompany,
} from "./letter.js";
import { dedupeLinks, defaultRole, checkLinkTarget, type LinkInput } from "./links.js";
import { participantWorkIds } from "./participants.js";
import {
  addEvent,
  allocateNumber,
  checkCompanies,
  checkMember,
  companyMembers,
  companyNames,
  companyRows,
  initialStatus,
  isClosed,
  projectTypes,
  requireEdit,
  statusDef,
  viewerOf,
  workLink,
  type TypeRow,
  type WorkRow,
  type WorksCtx,
} from "./work-core.js";

export interface CreateWorkInput {
  title: string;
  fields?: WorkFieldValues;
  status?: string;
  fromCompanyId?: string | null;
  toCompanyIds?: string[];
  ccCompanyIds?: string[];
  assigneeUserId?: string | null;
  dueDate?: string | null;
  replyRequired?: boolean;
  links?: LinkInput[];
  parentWorkId?: string | null;
  data?: Record<string, unknown>;
  letter?: LetterData | null;
  /** Language of the person creating the work (validation messages). */
  lang?: string;
}

export interface Creator {
  userId: string;
  companyId: string | null;
}

export async function createWork(
  db: Db,
  a: ProjectAccess | null,
  project: typeof projects.$inferSelect,
  type: TypeRow,
  creator: Creator,
  input: CreateWorkInput,
  eventMessage: string | null = null,
): Promise<WorkRow> {
  if (type.archivedAt) throw badRequest(msg("works:errors.typeArchived"));
  const fields = input.fields ?? {};
  const problems = validateWorkFields(type.fields, fields, false, input.lang ?? DEFAULT_LANGUAGE);
  if (problems.length) throw badRequest(problems.join(" "));
  const status = input.status ?? initialStatus(type);
  if (!type.statuses.some((s) => s.key === status)) throw badRequest(msg("works:errors.invalidStatus", { status }));
  if (status === WORK_STATUS.sent) throw badRequest(msg("works:errors.useSend"));
  const fromCompanyId = input.fromCompanyId === undefined ? (type.settings.incoming ? null : creator.companyId) : input.fromCompanyId;
  const to = [...new Set(input.toCompanyIds ?? [])];
  const cc = [...new Set(input.ccCompanyIds ?? [])].filter((c) => !to.includes(c));
  await checkCompanies(db, [...to, ...cc, ...(fromCompanyId ? [fromCompanyId] : [])]);
  await checkMember(db, project.id, input.assigneeUserId);
  const links = dedupeLinks(input.links ?? []);
  if (a) for (const l of links) await checkLinkTarget(db, a, l, null);
  if (input.parentWorkId) {
    const [parent] = await db.select().from(works).where(and(eq(works.id, input.parentWorkId), eq(works.projectId, project.id)));
    if (!parent || (a && !canSeeWork(parent, viewerOf(a)) && !(await participantWorkIds(db, a, [parent.id])).has(parent.id)))
      throw notFound(msg("works:entities.parentWork"));
  }
  const parties = await companyRows(db, [fromCompanyId, to[0]]);
  const data = isLetterType(type)
    ? { ...(input.data ?? {}), letter: await initialLetter(db, type, { fromCompanyId, toCompanyIds: to }, input.letter ?? null) }
    : (input.data ?? {});
  const sender = fromCompanyId ? parties.get(fromCompanyId) : undefined;
  const receiver = to[0] ? parties.get(to[0]) : undefined;
  const now = new Date();
  const work = await db.transaction(async (tx) => {
    const { number, seq } = await allocateNumber(tx, project.id, type, {
      projectCode: project.code,
      fromCompany: sender?.name ?? null,
      fromCode: sender?.code ?? null,
      toCompany: receiver?.name ?? null,
      toCode: receiver?.code ?? null,
      date: now,
      values: workTokenValues(type.fields, fields),
      subject: input.title,
    });
    const closed = !!statusDef(type, status).closed;
    const [row] = await tx
      .insert(works)
      .values({
        projectId: project.id,
        typeId: type.id,
        number,
        seq,
        title: input.title,
        status,
        fields,
        ownerCompanyId: creator.companyId,
        fromCompanyId,
        toCompanyIds: to,
        ccCompanyIds: cc,
        assigneeUserId: input.assigneeUserId ?? null,
        dueDate: input.dueDate ?? null,
        replyRequired: input.replyRequired ?? false,
        parentWorkId: input.parentWorkId ?? null,
        data,
        createdBy: creator.userId,
        createdAt: now,
        updatedAt: now,
        closedAt: closed ? now : null,
      })
      .returning();
    if (links.length)
      await tx.insert(workLinks).values(
        links.map((l) => ({
          workId: row!.id,
          kind: l.kind,
          targetId: l.targetId,
          role: l.role ?? defaultRole(l.kind),
          meta: l.meta ?? {},
          createdBy: creator.userId,
        })),
      );
    await tx.insert(workEvents).values({
      workId: row!.id,
      kind: "created",
      userId: creator.userId,
      message: eventMessage,
      details: { number, type: type.name, links: links.length },
      at: now,
    });
    return row!;
  });
  await audit(db, {
    projectId: project.id,
    userId: creator.userId,
    action: "work.created",
    targetType: "work",
    targetId: work.id,
    details: { number: work.number, type: type.key, title: work.title },
  });
  if (work.assigneeUserId && work.assigneeUserId !== creator.userId)
    await notify(db, [work.assigneeUserId], {
      projectId: project.id,
      kind: "work.assigned",
      title: msg("works:notifications.assigned", { number: work.number, title: work.title }),
      link: workLink(project.id, work.id),
    });
  return work;
}

export interface SendInput {
  channel: string;
  reference?: string | null;
  note?: string | null;
  /** Language of the sender (cover sheet labels). */
  lang?: string;
}

export async function sendWork(
  ctx: WorksCtx,
  project: typeof projects.$inferSelect,
  work: WorkRow,
  type: TypeRow,
  actorId: string,
  input: SendInput,
): Promise<WorkRow> {
  const { db } = ctx;
  if (type.settings.incoming) throw badRequest(msg("works:errors.incomingNotSent"));
  if (work.status !== WORK_STATUS.draft) throw conflict(msg("works:errors.onlyDraftSent"));
  if (!type.statuses.some((s) => s.key === WORK_STATUS.sent)) throw badRequest(msg("works:errors.typeNotSent"));
  if (!work.toCompanyIds.length) throw badRequest(msg("works:errors.recipientRequired"));
  const channel = deliveryChannel(input.channel);
  if (!channel) throw badRequest(msg("works:errors.unknownChannel"));
  const links = await db.select().from(workLinks).where(eq(workLinks.workId, work.id));
  const attachments = links.filter((l) => l.kind === "file_version" && l.role === "ek");
  if (type.category === "transmittal" && !attachments.length) throw badRequest(msg("works:errors.transmittalNeedsFile"));
  if (isLetterType(type)) {
    const problems = letterSendProblems(letterOf(work), work.number, input.lang ?? DEFAULT_LANGUAGE);
    if (problems.length) throw badRequest(problems.join(" "));
  }
  const attachmentRows = attachments.length
    ? await db
        .select({ v: fileVersions, f: files })
        .from(fileVersions)
        .innerJoin(files, eq(files.id, fileVersions.fileId))
        .where(inArray(fileVersions.id, attachments.map((l) => l.targetId)))
    : [];
  const signed = attachments.filter(
    (l) => l.meta.signed && attachmentRows.find((r) => r.v.id === l.targetId)?.f.name.toLowerCase().endsWith(".pdf"),
  );
  if (channel.requiresSignedPdf && !signed.length)
    throw badRequest(msg("works:errors.signedPdfRequired", { channel: channel.label }));
  if (type.category === "transmittal") await generateCover(ctx, project, work, type, actorId, input.lang);
  if (isOutgoingLetter(type)) await generateLetterPdf(ctx, project, work, type, actorId);
  const names = await companyNames(db, [work.fromCompanyId, ...work.toCompanyIds, ...work.ccCompanyIds]);
  const result = await channel.send({
    projectId: project.id,
    workId: work.id,
    number: work.number,
    title: work.title,
    fromCompany: work.fromCompanyId ? (names.get(work.fromCompanyId) ?? null) : null,
    toCompanies: work.toCompanyIds.map((c) => names.get(c) ?? c),
    ccCompanies: work.ccCompanyIds.map((c) => names.get(c) ?? c),
    attachments: attachments.flatMap((l) => {
      const r = attachmentRows.find((x) => x.v.id === l.targetId);
      return r
        ? [{ fileName: r.f.name, version: r.v.version, size: r.v.size, storageKey: r.v.storageKey, signed: !!l.meta.signed }]
        : [];
    }),
    reference: input.reference?.trim() || null,
    note: input.note?.trim() || null,
  });
  const now = new Date();
  const delivery: WorkDelivery = {
    channel: channel.id,
    status: result.status,
    reference: result.reference,
    note: input.note?.trim() || null,
    sentAt: now.toISOString(),
    sentBy: actorId,
    updatedAt: now.toISOString(),
  };
  const [updated] = await db
    .update(works)
    .set({ status: WORK_STATUS.sent, sentAt: now, delivery, updatedAt: now })
    .where(and(eq(works.id, work.id), eq(works.status, WORK_STATUS.draft)))
    .returning();
  if (!updated) throw conflict(msg("works:errors.changedMeanwhile"));
  await addEvent(db, work.id, "sent", actorId, result.message ?? null, {
    channel: channel.id,
    reference: result.reference,
    status: result.status,
    signedAttachments: signed.length,
  });
  await audit(db, {
    projectId: project.id,
    userId: actorId,
    action: "work.sent",
    targetType: "work",
    targetId: work.id,
    details: { number: work.number, channel: channel.id, reference: result.reference },
  });
  for (const l of links.filter((x) => x.kind === "work" && x.role === "ilgi" && x.meta.reply)) {
    const [target] = await db
      .update(works)
      .set({ status: WORK_STATUS.answered, updatedAt: now, closedAt: now })
      .where(and(eq(works.id, l.targetId), inArray(works.status, [WORK_STATUS.sent, WORK_STATUS.received])))
      .returning();
    if (target) await addEvent(db, target.id, "answered", actorId, `${work.number} ile cevaplandı` /* i18n-ok: event message stored as data */, { replyId: work.id });
  }
  const recipients = await companyMembers(db, project.id, [...work.toCompanyIds, ...work.ccCompanyIds]);
  await notify(
    db,
    [...recipients, ...(work.assigneeUserId ? [work.assigneeUserId] : [])].filter((u) => u !== actorId),
    {
      projectId: project.id,
      kind: "work.sent",
      title: `${type.name}: ${work.number} "${work.title}"`,
      body: work.replyRequired && work.dueDate ? msg("works:notifications.replyDue", { date: work.dueDate }) : null,
      link: workLink(project.id, work.id),
    },
  );
  return updated;
}

export async function receiveWork(db: Db, a: ProjectAccess, work: WorkRow, type: TypeRow): Promise<WorkRow> {
  const viewer = viewerOf(a);
  if (!isWorkAddressee(work, viewer) || !viewer.companyId) throw forbidden(msg("works:errors.notAddressee"));
  if (work.status === WORK_STATUS.draft) throw conflict(msg("works:errors.draftNotReceived"));
  const inserted = await db
    .insert(workReceipts)
    .values({ workId: work.id, companyId: viewer.companyId, receivedBy: a.user.id })
    .onConflictDoNothing()
    .returning();
  if (!inserted.length) throw conflict(msg("works:errors.alreadyReceived"));
  await addEvent(db, work.id, "received", a.user.id, null, { companyId: viewer.companyId });
  const receipts = await db.select().from(workReceipts).where(eq(workReceipts.workId, work.id));
  const allTo = work.toCompanyIds.every((c) => receipts.some((r) => r.companyId === c));
  let row = work;
  if (allTo && work.status === WORK_STATUS.sent && type.statuses.some((s) => s.key === WORK_STATUS.received)) {
    const [u] = await db.update(works).set({ status: WORK_STATUS.received, updatedAt: new Date() }).where(eq(works.id, work.id)).returning();
    row = u!;
    await addEvent(db, work.id, "status", null, null, { from: work.status, to: WORK_STATUS.received });
  }
  await audit(db, {
    projectId: a.project.id,
    userId: a.user.id,
    action: "work.received",
    targetType: "work",
    targetId: work.id,
    details: { number: work.number, companyId: viewer.companyId },
  });
  if (work.createdBy !== a.user.id)
    await notify(db, [work.createdBy], {
      projectId: a.project.id,
      kind: "work.received",
      title: msg("works:notifications.received", { number: work.number }),
      body: msg("works:notifications.receivedBody", { name: a.user.name }),
      link: workLink(a.project.id, work.id),
    });
  return row;
}

export function rePrefix(text: string): string {
  const t = text.trim();
  return /^re:\s/i.test(t) ? t : `RE: ${t}`;
}

export async function replyToWork(
  db: Db,
  a: ProjectAccess,
  original: WorkRow,
  originalType: TypeRow,
  input: { title?: string; typeKey?: string },
): Promise<WorkRow> {
  const types = await projectTypes(db, a.project.id);
  const key = input.typeKey ?? originalType.settings.replyTypeKey ?? "giden-yazi";
  const type = types.find((t) => t.key === key && !t.archivedAt);
  if (!type) throw badRequest(msg("works:errors.replyTypeMissing"));
  requireWorkModule(a, type.category);
  const viewer = viewerOf(a);
  const other = original.fromCompanyId ?? original.ownerCompanyId;
  const to = other && other !== viewer.companyId ? [other] : [];
  const cc = original.ccCompanyIds.filter((c) => c !== viewer.companyId && !to.includes(c));
  const fields: WorkFieldValues = {};
  for (const k of ["konu", "proje_kodu", "departman"]) {
    const v = original.fields[k];
    if (type.fields.some((f) => f.key === k) && typeof v === "string" && v) fields[k] = v;
  }
  let letter: LetterData | null = null;
  if (isLetterType(type) && isLetterType(originalType)) {
    const src = letterOf(original);
    letter = {
      ...letterOf({ data: {} }),
      language: src.language,
      secondaryLanguage: src.secondaryLanguage,
      layout: src.layout,
      translations: Object.fromEntries(
        Object.entries(src.translations)
          .filter(([, t]) => t?.subject?.trim())
          .map(([lang, t]) => [lang, { subject: rePrefix(t!.subject!) }]),
      ),
    };
    const r = await recipientFromCompany(db, other);
    if (r) letter.recipient = r;
  }
  const reply = await createWork(
    db,
    a,
    a.project,
    type,
    { userId: a.user.id, companyId: viewer.companyId },
    {
      title: input.title?.trim() || rePrefix(original.title).slice(0, 300),
      fields,
      fromCompanyId: viewer.companyId,
      toCompanyIds: to,
      ccCompanyIds: cc,
      links: [{ kind: "work", targetId: original.id, role: "ilgi", meta: { reply: true } }],
      letter,
    },
    `${original.number} sayılı yazıya cevap`, // i18n-ok: event message stored as data
  );
  await addEvent(db, original.id, "replied", a.user.id, `Cevap taslağı: ${reply.number}`, { replyId: reply.id }); // i18n-ok: event message stored as data
  return reply;
}

function requireLetter(type: TypeRow) {
  if (!isLetterType(type)) throw badRequest(msg("works:errors.lettersOnly"));
}

async function setLetterStatus(db: Db, a: ProjectAccess, work: WorkRow, type: TypeRow, to: string, kind: WorkEventKind): Promise<WorkRow> {
  if (!type.statuses.some((s) => s.key === to)) throw badRequest(msg("works:errors.statusMissing", { status: to }));
  const now = new Date();
  const [row] = await db
    .update(works)
    .set({ status: to, updatedAt: now, closedAt: isClosed(type, to) ? (work.closedAt ?? now) : null })
    .where(and(eq(works.id, work.id), eq(works.status, work.status)))
    .returning();
  if (!row) throw conflict(msg("works:errors.changedMeanwhile"));
  await addEvent(db, work.id, kind, a.user.id, null, { from: work.status, to });
  await audit(db, {
    projectId: a.project.id,
    userId: a.user.id,
    action: `work.${kind}`,
    targetType: "work",
    targetId: work.id,
    details: { number: work.number, from: work.status, to },
  });
  return row;
}

export async function archiveLetter(db: Db, a: ProjectAccess, work: WorkRow, type: TypeRow): Promise<WorkRow> {
  requireLetter(type);
  requireEdit(work, a);
  if (!(LETTER_ARCHIVABLE as readonly string[]).includes(work.status))
    throw conflict(msg("works:errors.archiveNotAllowed"));
  return setLetterStatus(db, a, work, type, LETTER_STATUS.archived, "archived");
}

export async function cancelLetter(db: Db, a: ProjectAccess, work: WorkRow, type: TypeRow, comment: string | null): Promise<WorkRow> {
  requireLetter(type);
  requireEdit(work, a);
  if (work.status === LETTER_STATUS.archived || work.status === LETTER_STATUS.cancelled)
    throw conflict(msg("works:errors.cancelLetterNotAllowed"));
  const row = await setLetterStatus(db, a, work, type, LETTER_STATUS.cancelled, "cancelled");
  if (comment) await addEvent(db, work.id, "comment", a.user.id, comment);
  return row;
}

export async function reopenLetter(db: Db, a: ProjectAccess, work: WorkRow, type: TypeRow): Promise<WorkRow> {
  requireLetter(type);
  requireEdit(work, a);
  if (work.status !== LETTER_STATUS.cancelled) throw conflict(msg("works:errors.reopenNotAllowed"));
  return setLetterStatus(db, a, work, type, WORK_STATUS.draft, "reopened");
}

const DELETABLE_CATEGORIES = new Set(["correspondence", "transmittal", "generic"]);

export function canDeleteWork(work: WorkRow, type: TypeRow, a: ProjectAccess): boolean {
  if (!DELETABLE_CATEGORIES.has(type.category)) return false;
  if (work.status !== WORK_STATUS.draft && work.status !== LETTER_STATUS.cancelled) return false;
  return a.isProjectAdmin || (work.status === WORK_STATUS.draft && work.createdBy === a.user.id);
}

export async function deleteWork(db: Db, a: ProjectAccess, work: WorkRow, type: TypeRow): Promise<void> {
  if (!DELETABLE_CATEGORIES.has(type.category)) throw badRequest(msg("works:errors.typeNotDeletable"));
  if (work.status !== WORK_STATUS.draft && work.status !== LETTER_STATUS.cancelled)
    throw conflict(msg("works:errors.deleteOnlyDraft"));
  if (!canDeleteWork(work, type, a))
    throw forbidden(msg("works:errors.deleteNotAllowed"));
  await db.delete(works).where(eq(works.id, work.id));
  await audit(db, {
    projectId: a.project.id,
    userId: a.user.id,
    action: "work.deleted",
    targetType: "work",
    targetId: work.id,
    details: { number: work.number, type: type.key, title: work.title, status: work.status },
  });
}
