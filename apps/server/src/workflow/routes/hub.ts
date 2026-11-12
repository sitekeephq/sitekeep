/**
 * The simple project screen (docs/product/SIMPLIFICATION.md, 1. aşama):
 *
 *   GET    /projects/:pid/today                  project "Bugün": my items, overdue, upcoming, recent changes,
 *                                                "Günün Özeti" (?ai=0: do not start an AI summary run)
 *   GET    /projects/:pid/today/summary          "Günün Özeti" only (the page polls it while a run is going)
 *   POST   /projects/:pid/today/summary          {force?} "Yenile"; ?wait=1 answers in the request (task queue)
 *   GET    /projects/:pid/saved-views            my views + views shared with the project
 *   POST   /projects/:pid/saved-views            {name, view, params, shared?}  (shared: project admins)
 *   PATCH  /projects/:pid/saved-views/:id        {name?, view?, params?, shared?}
 *   DELETE /projects/:pid/saved-views/:id
 *   PUT    /projects/:pid/saved-views/order      {ids} — order of my own views
 *   GET    /me/prefs, PATCH /me/prefs            per-user settings ("Gelişmiş Ayarları Göster")
 *
 * "Bugün" is fast and has no AI: it reads works, steps, forms, issues and the activity log with
 * the caller's visibility rules. Its summary (today/service.ts) is deterministic; the AI summary of
 * phase 2 is written in the background from a compact input and cached per user.
 */
import { and, asc, desc, eq, gte, inArray, ne } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  HUB_VIEW_KEYS,
  SAVED_VIEW_MAX_PARAMS,
  SAVED_VIEW_MAX_PER_USER,
  WORK_STATUS,
  can,
  canSeeWork,
  isWorkAddressee,
  type HubViewKey,
  type MyTaskDto,
  type ProjectTodayDto,
  type SavedViewDto,
  type TodayChangeDayDto,
  type TodayChangeDto,
  type TodayMineGroup,
  type TodayRowDto,
  type UserPrefs,
  projectPath,
} from "@sitekeep/shared";
import type { ResolvedDeps } from "../../app/deps.js";
import { FolderTree, isUuid, projectAccess, userNames, type ProjectAccess } from "../../core/security/access.js";
import {
  auditLog,
  companies,
  files,
  issues,
  reviews,
  savedViews,
  users,
  workReceipts,
  workflowInstances,
  works,
} from "../../db/schema.js";
import type { Db } from "../../db/index.js";
import { badRequest, conflict, forbidden, notFound } from "../../core/platform/http.js";
import { DEFAULT_LANGUAGE, labelFor, msg, render, requestLanguage, tFor, type MsgKey } from "../../i18n/index.js";
import { capability } from "../../sdk/capabilities.js";
import { SUBJECT_REVIEW, reviewLink } from "../../workflow/reviews.js";
import { actorFor, memberWithRoles } from "../../workflow/service.js";
import { participantWorkIds } from "../../works/participants.js";
import { addDaysIso, isClosed, projectTypes, toSummary, todayIso, viewerOf, workLink } from "../../works/service.js";
import { canSee as canSeeReview } from "../review-access.js";
import { myTasksFor } from "./notifications.js";
import { refreshTodaySummary, todaySummary } from "../../today/service.js";
import type { TodayData } from "../../today/text.js";

/** Days ahead for "Yaklaşan Terminler". */
export const TODAY_UPCOMING_DAYS = 7;
/** Days back for "Son Değişiklikler". */
export const TODAY_CHANGE_DAYS = 7;
/** Rows per list on the page. */
/** Safety cap for one Bugün list. The page itself shows ten rows and opens the rest on demand. */
const ROW_CAP = 500;

const viewKey = z.enum(HUB_VIEW_KEYS);
const paramsSchema = z
  .record(z.string().regex(/^[a-z0-9_-]{1,40}$/i), z.string().max(300))
  .refine((p) => Object.keys(p).length <= SAVED_VIEW_MAX_PARAMS, render(DEFAULT_LANGUAGE, msg("workflow:errors.tooManyFilters", { max: SAVED_VIEW_MAX_PARAMS })))
  .transform((p) => Object.fromEntries(Object.entries(p).filter(([k, v]) => k !== "gorunum" && v !== "")));
const nameSchema = z.string().trim().min(1).max(80);

export async function hubRoutes(api: FastifyInstance, deps: ResolvedDeps) {
  const { db } = deps;
  // ---- Saved views --------------------------------------------------------------------------

  api.get<{ Params: { pid: string } }>("/projects/:pid/saved-views", async (req): Promise<SavedViewDto[]> => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const rows = await db
      .select()
      .from(savedViews)
      .where(eq(savedViews.projectId, a.project.id))
      .orderBy(asc(savedViews.position), asc(savedViews.name));
    const visible = rows.filter((r) => r.ownerId === a.user.id || r.shared);
    const names = await userNames(db, visible.map((r) => r.ownerId));
    // Mine first (in my order), then views others shared with the project.
    const mine = visible.filter((r) => r.ownerId === a.user.id);
    const others = visible.filter((r) => r.ownerId !== a.user.id).sort((x, y) => x.name.localeCompare(y.name, "tr"));
    return [...mine, ...others].map((r) => savedViewDto(r, a, names));
  });

  api.post<{ Params: { pid: string } }>("/projects/:pid/saved-views", async (req): Promise<SavedViewDto> => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const body = z
      .object({ name: nameSchema, view: viewKey, params: paramsSchema.default({}), shared: z.boolean().default(false) })
      .parse(req.body);
    if (body.shared && !a.isProjectAdmin) throw forbidden(msg("workflow:errors.shareViewAdminOnly"));
    const own = await db
      .select({ position: savedViews.position })
      .from(savedViews)
      .where(and(eq(savedViews.projectId, a.project.id), eq(savedViews.ownerId, a.user.id)));
    if (own.length >= SAVED_VIEW_MAX_PER_USER) throw conflict(msg("workflow:errors.tooManyViews", { max: SAVED_VIEW_MAX_PER_USER }));
    const position = own.reduce((m, r) => Math.max(m, r.position + 1), 0);
    const [row] = await db
      .insert(savedViews)
      .values({ projectId: a.project.id, ownerId: a.user.id, name: body.name, view: body.view, params: body.params, shared: body.shared, position })
      .returning();
    return savedViewDto(row!, a, new Map([[a.user.id, a.user.name]]));
  });

  api.patch<{ Params: { pid: string; id: string } }>("/projects/:pid/saved-views/:id", async (req): Promise<SavedViewDto> => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const row = await loadView(db, a, req.params.id);
    if (!canEditView(row, a)) throw forbidden(msg("workflow:errors.editViewNotAllowed"));
    const body = z
      .object({ name: nameSchema.optional(), view: viewKey.optional(), params: paramsSchema.optional(), shared: z.boolean().optional() })
      .parse(req.body);
    if (body.shared !== undefined && body.shared !== row.shared && !a.isProjectAdmin)
      throw forbidden(msg("workflow:errors.shareViewAdminOnly"));
    // Someone else's shared view: an administrator may rename or unshare it, not change its filters.
    if (row.ownerId !== a.user.id && (body.view !== undefined || body.params !== undefined))
      throw forbidden(msg("workflow:errors.othersViewFilters"));
    const [updated] = await db
      .update(savedViews)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(savedViews.id, row.id))
      .returning();
    return savedViewDto(updated!, a, await userNames(db, [updated!.ownerId]));
  });

  api.delete<{ Params: { pid: string; id: string } }>("/projects/:pid/saved-views/:id", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const row = await loadView(db, a, req.params.id);
    if (!canEditView(row, a)) throw forbidden(msg("workflow:errors.deleteViewNotAllowed"));
    await db.delete(savedViews).where(eq(savedViews.id, row.id));
    return { ok: true };
  });

  api.put<{ Params: { pid: string } }>("/projects/:pid/saved-views/order", async (req): Promise<SavedViewDto[]> => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const body = z.object({ ids: z.array(z.string().uuid()).max(SAVED_VIEW_MAX_PER_USER * 2) }).parse(req.body);
    const own = await db
      .select()
      .from(savedViews)
      .where(and(eq(savedViews.projectId, a.project.id), eq(savedViews.ownerId, a.user.id)));
    const ownIds = new Set(own.map((r) => r.id));
    const ordered = body.ids.filter((id) => ownIds.has(id));
    if (ordered.length !== body.ids.length) throw badRequest(msg("workflow:errors.orderOwnViewsOnly"));
    // Views left out keep their relative order after the given ones.
    const rest = own.filter((r) => !ordered.includes(r.id)).sort((x, y) => x.position - y.position).map((r) => r.id);
    const all = [...ordered, ...rest];
    for (const [i, id] of all.entries()) await db.update(savedViews).set({ position: i }).where(eq(savedViews.id, id));
    const rows = await db
      .select()
      .from(savedViews)
      .where(and(eq(savedViews.projectId, a.project.id), eq(savedViews.ownerId, a.user.id)))
      .orderBy(asc(savedViews.position));
    return rows.map((r) => savedViewDto(r, a, new Map([[a.user.id, a.user.name]])));
  });

  // ---- User preferences ---------------------------------------------------------------------

  api.get("/me/prefs", async (req): Promise<UserPrefs> => {
    const [u] = await db.select({ prefs: users.prefs }).from(users).where(eq(users.id, req.user!.id));
    return u?.prefs ?? {};
  });

  api.patch("/me/prefs", async (req): Promise<UserPrefs> => {
    const body = z
      .object({
        advancedSettings: z.boolean().optional(),
        todaySummaryCollapsed: z.boolean().optional(),
        // BCP 47 ("en", "tr", "pt-BR"); the web app offers what it has translations for.
        language: z.string().regex(/^[a-z]{2,3}(-[A-Z]{2})?$/).optional(),
      })
      .strict()
      .parse(req.body);
    const [u] = await db.select({ prefs: users.prefs }).from(users).where(eq(users.id, req.user!.id));
    const prefs: UserPrefs = { ...(u?.prefs ?? {}), ...body };
    await db.update(users).set({ prefs }).where(eq(users.id, req.user!.id));
    return prefs;
  });

  // ---- Project "Bugün" ----------------------------------------------------------------------

  api.get<{ Params: { pid: string }; Querystring: { ai?: string } }>("/projects/:pid/today", async (req): Promise<ProjectTodayDto> => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const now = new Date();
    const lang = requestLanguage(req);
    const data = await projectToday(db, a, now, lang);
    return { ...data, summary: await todaySummary(deps, a, data, now, { kick: req.query.ai !== "0", lang }) };
  });

  // ---- "Günün Özeti" (always the caller's own summary) --------------------------------------

  api.get<{ Params: { pid: string } }>("/projects/:pid/today/summary", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const now = new Date();
    const lang = requestLanguage(req);
    return todaySummary(deps, a, await projectToday(db, a, now, lang), now, { kick: true, lang });
  });

  api.post<{ Params: { pid: string }; Querystring: { wait?: string } }>("/projects/:pid/today/summary", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const body = z.object({ force: z.boolean().optional() }).parse(req.body ?? {});
    const now = new Date();
    const lang = requestLanguage(req);
    const data = await projectToday(db, a, now, lang);
    return refreshTodaySummary(deps, a, data, now, { wait: req.query.wait === "1", force: !!body.force, lang });
  });
}

type SavedViewRow = typeof savedViews.$inferSelect;

function canEditView(r: SavedViewRow, a: ProjectAccess): boolean {
  return r.ownerId === a.user.id || (r.shared && a.isProjectAdmin);
}

async function loadView(db: Db, a: ProjectAccess, id: string): Promise<SavedViewRow> {
  if (!isUuid(id)) throw notFound(msg("workflow:entities.savedView"));
  const [row] = await db.select().from(savedViews).where(and(eq(savedViews.id, id), eq(savedViews.projectId, a.project.id)));
  // Someone else's private view does not exist for the caller.
  if (!row || (row.ownerId !== a.user.id && !row.shared)) throw notFound(msg("workflow:entities.savedView"));
  return row;
}

function savedViewDto(r: SavedViewRow, a: ProjectAccess, names: Map<string, string>): SavedViewDto {
  return {
    id: r.id,
    projectId: r.projectId,
    name: r.name,
    view: r.view as HubViewKey,
    params: r.params ?? {},
    shared: r.shared,
    position: r.position,
    ownerId: r.ownerId,
    ownerName: names.get(r.ownerId),
    mine: r.ownerId === a.user.id,
    canEdit: canEditView(r, a),
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

// ---- "Bugün" ----------------------------------------------------------------------------------

/** Audit actions shown under "Son Değişiklikler" (sentence case, without the person; plural by count). */
const CHANGE_TEXTS: Record<string, MsgKey> = {
  "file.uploaded": "workflow:changes.fileUploaded",
  "file.version_added": "workflow:changes.fileVersionAdded",
  "work.created": "workflow:changes.workCreated",
  "work.sent": "workflow:changes.workSent",
  "work.received": "workflow:changes.workReceived",
  "work.responded": "workflow:changes.workResponded",
  "work.submitted": "workflow:changes.workSubmitted",
  "work.minutes_saved": "workflow:changes.workMinutesSaved",
  "work.cancelled": "workflow:changes.workCancelled",
  "issue.created": "workflow:changes.issueCreated",
  "issue.updated": "workflow:changes.issueUpdated",
  "issue.commented": "workflow:changes.issueCommented",
  "review.started": "workflow:changes.reviewStarted",
  "review.submitted": "workflow:changes.reviewSubmitted",
  "review.completed": "workflow:changes.reviewCompleted",
  "form.created": "workflow:changes.formCreated",
  "form.submitted": "workflow:changes.formSubmitted",
  "form.reviewed": "workflow:changes.formReviewed",
  "form.closed": "workflow:changes.formClosed",
  "schedule.imported": "workflow:changes.scheduleImported",
  "param_change.created": "workflow:changes.paramChangeCreated",
  "param_change.approved": "workflow:changes.paramChangeApproved",
  "param_change.applied": "workflow:changes.paramChangeApplied",
  "param_change.authoring": "workflow:changes.paramChangeAuthoring",
  "param_change.verified": "workflow:changes.paramChangeVerified",
  "param_change.values_lost": "workflow:changes.paramChangeValuesLost",
};
const CHANGE_ACTIONS = Object.keys(CHANGE_TEXTS);

function rowSort(x: TodayRowDto, y: TodayRowDto): number {
  return (x.dueDate ?? "9999").localeCompare(y.dueDate ?? "9999") || x.number.localeCompare(y.number, "tr");
}

/** Project "Bugün" with the caller's visibility (the same rules as the lists behind each line). */
export async function projectToday(db: Db, a: ProjectAccess, now = new Date(), lang: string = DEFAULT_LANGUAGE): Promise<TodayData> {
  const tr = tFor(lang);
  const pid = a.project.id;
  const today = todayIso(now);
  const until = addDaysIso(today, TODAY_UPCOMING_DAYS);
  const viewer = viewerOf(a);
  const mine: Record<TodayMineGroup, TodayRowDto[]> = { tasks: [], works: [], actions: [], replies: [], receipts: [], forms: [], issues: [] };
  const overdue: TodayRowDto[] = [];
  const upcoming: TodayRowDto[] = [];

  // Works: the caller sees them as in the İşler list (company rules + workflow participants).
  const types = await projectTypes(db, pid);
  const workRows = await db.select().from(works).where(eq(works.projectId, pid)).orderBy(asc(works.dueDate), desc(works.createdAt));
  const participant = await participantWorkIds(db, a, workRows.filter((w) => w.workflowInstanceId && !canSeeWork(w, viewer)).map((w) => w.id));
  const visibleWorks = workRows.filter((w) => canSeeWork(w, viewer) || participant.has(w.id));
  const openWorks = visibleWorks.filter((w) => !isClosed(types.find((t) => t.id === w.typeId)!, w.status));
  const receipts = openWorks.length ? await db.select().from(workReceipts).where(inArray(workReceipts.workId, openWorks.map((w) => w.id))) : [];
  const names = await userNames(db, openWorks.map((w) => w.createdBy));
  // Sender companies: who waits for an answer ("Prota'nın 2 bilgi talebi").
  const fromIds = [...new Set(openWorks.map((w) => w.fromCompanyId).filter((x): x is string => !!x))];
  const companyNames = new Map(
    fromIds.length ? (await db.select({ id: companies.id, name: companies.name }).from(companies).where(inArray(companies.id, fromIds))).map((c) => [c.id, c.name]) : [],
  );
  for (const w of openWorks) {
    const t = types.find((x) => x.id === w.typeId)!;
    const s = toSummary(w, t, names, today);
    const row: TodayRowDto = {
      kind: "work",
      id: w.id,
      number: w.number,
      title: w.title,
      typeLabel: t.name,
      statusLabel: s.statusLabel,
      statusTone: s.statusTone,
      dueDate: w.dueDate,
      overdue: s.overdue,
      link: workLink(pid, w.id),
      ...(w.fromCompanyId && companyNames.has(w.fromCompanyId) && { party: companyNames.get(w.fromCompanyId) }),
    };
    const sent = w.status !== WORK_STATUS.draft;
    const actionRecipient = !!viewer.companyId && w.toCompanyIds.includes(viewer.companyId);
    const received = !!viewer.companyId && receipts.some((r) => r.workId === w.id && r.companyId === viewer.companyId);
    if (w.assigneeUserId === a.user.id) (t.category === "action" ? mine.actions : mine.works).push(row);
    if (sent && actionRecipient && w.replyRequired && (w.status === WORK_STATUS.sent || w.status === WORK_STATUS.received))
      mine.replies.push({ ...row, note: tr("workflow:today.replyAwaited") });
    if (w.status === WORK_STATUS.sent && isWorkAddressee(w, viewer) && !received) mine.receipts.push({ ...row, note: tr("workflow:today.receiptAwaited") });
    if (w.dueDate && w.dueDate < today) overdue.push(row);
    else if (w.dueDate && w.dueDate <= until) upcoming.push(row);
    const meetingDay = t.category === "meeting" ? w.fields.tarih : null;
    if (typeof meetingDay === "string" && meetingDay >= today && meetingDay <= until)
      upcoming.push({ ...row, dueDate: meetingDay, overdue: false, note: tr("workflow:today.meetingDay") });
  }

  // Steps waiting for me: reviews, work steps (RFI, submittal…) and form approvals.
  const tasks = await myTasksFor(db, a.user, pid);
  for (const t of tasks) {
    const row = taskRow(t, lang);
    mine.tasks.push(row);
    if (t.overdue) overdue.push(row);
    else if (row.dueDate && row.dueDate <= until) upcoming.push(row);
  }

  // Forms I still have to fill (drafts, also those returned to me); Field's.
  const fieldForms = capability("field.forms");
  for (const f of fieldForms ? await fieldForms.drafts(db, pid, a.user.id, ROW_CAP) : [])
    mine.forms.push({
      kind: "form",
      id: f.id,
      number: f.number,
      title: f.name,
      typeLabel: tr("workflow:today.form"),
      statusLabel: labelFor(lang, "formStatus", "draft"),
      statusTone: "",
      dueDate: null,
      overdue: false,
      link: fieldForms!.link(pid, f.id),
      note: f.round > 1 ? tr("workflow:today.returnedToYou") : undefined,
    });

  // Issues: every member sees them; mine = assigned to me, or to my company without a person.
  const openIssues = await db
    .select()
    .from(issues)
    .where(and(eq(issues.projectId, pid), ne(issues.status, "closed")))
    .orderBy(desc(issues.number));
  for (const i of openIssues) {
    const due = i.dueDate ? i.dueDate.slice(0, 10) : null;
    const row: TodayRowDto = {
      kind: "issue",
      id: i.id,
      number: `#${i.number}`,
      title: i.title,
      typeLabel: tr("workflow:today.issue"),
      statusLabel: labelFor(lang, "issueStatus", i.status),
      statusTone: i.status === "open" ? "danger" : i.status === "in_progress" ? "warn" : "info",
      dueDate: due,
      overdue: !!due && due < today,
      link: projectPath(pid, `issues/${i.id}`),
    };
    const myCompany = !i.assigneeUserId && !!i.assigneeCompanyId && i.assigneeCompanyId === viewer.companyId;
    if (i.assigneeUserId === a.user.id || myCompany) mine.issues.push(row);
    if (due && due < today) overdue.push(row);
    else if (due && due <= until) upcoming.push(row);
  }

  // A work assigned to me whose step also waits for me is one line: the step (it says what to do).
  const taskIds = new Set(mine.tasks.map((r) => r.id));
  mine.works = mine.works.filter((r) => !taskIds.has(r.id));
  mine.actions = mine.actions.filter((r) => !taskIds.has(r.id));
  for (const k of Object.keys(mine) as TodayMineGroup[]) mine[k] = mine[k].sort(rowSort).slice(0, ROW_CAP);
  /** One line per record and date (a meeting may show its due date and its meeting day). */
  const dedupe = (list: TodayRowDto[]) => {
    const seen = new Set<string>();
    return [...list.filter((r) => r.kind === "task"), ...list.filter((r) => r.kind !== "task")].filter((r) => {
      const key = `${r.id}:${r.dueDate ?? ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  const overdueRows = dedupe(overdue).sort(rowSort);
  const upcomingRows = dedupe(upcoming).sort(rowSort);
  const changes = await recentChanges(db, a, now, new Set(visibleWorks.map((w) => w.id)), lang);
  const mineIds = new Set(Object.values(mine).flatMap((list) => list.map((r) => r.id)));

  return {
    projectId: pid,
    mine,
    overdue: overdueRows.slice(0, ROW_CAP),
    upcoming: upcomingRows.slice(0, ROW_CAP),
    upcomingDays: TODAY_UPCOMING_DAYS,
    changes,
    changeDays: TODAY_CHANGE_DAYS,
    counts: {
      mine: mineIds.size,
      overdue: overdueRows.length,
      upcoming: upcomingRows.length,
      changes: changes.reduce((n, d) => n + d.changes.length, 0),
    },
    generatedAt: now.toISOString(),
  };
}

function taskRow(t: MyTaskDto, lang: string): TodayRowDto {
  return {
    kind: "task",
    id: t.subjectId,
    number: t.code ?? `#${t.number}`,
    title: t.name,
    typeLabel: labelFor(lang, "workflowKind", t.kind),
    dueDate: t.stepDueAt ? todayIso(new Date(t.stepDueAt)) : null,
    overdue: t.overdue,
    link: t.link,
    note: `${t.stepIndex + 1}. ${t.stepName}`,
  };
}

/**
 * Activity log of the last days, grouped by day and by person + action ("Emel 3 dosya yükledi"),
 * only for records the caller may see.
 */
async function recentChanges(db: Db, a: ProjectAccess, now: Date, visibleWorkIds: Set<string>, lang: string): Promise<TodayChangeDayDto[]> {
  const pid = a.project.id;
  const since = new Date(now.getTime() - TODAY_CHANGE_DAYS * 86_400_000);
  const rows = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.projectId, pid), gte(auditLog.at, since), inArray(auditLog.action, CHANGE_ACTIONS)))
    .orderBy(desc(auditLog.id))
    .limit(1000);
  if (!rows.length) return [];
  const ids = (type: string) => [...new Set(rows.filter((r) => r.targetType === type && r.targetId && isUuid(r.targetId)).map((r) => r.targetId!))];

  // Labels, links and visibility per record type.
  const label = new Map<string, { label: string; link: string | null }>();
  const workIds = ids("work").filter((id) => visibleWorkIds.has(id));
  if (workIds.length)
    for (const w of await db.select({ id: works.id, number: works.number, title: works.title }).from(works).where(inArray(works.id, workIds)))
      label.set(`work:${w.id}`, { label: `${w.number} ${w.title}`, link: workLink(pid, w.id) });

  const fileIds = ids("file");
  if (fileIds.length) {
    const tree = await FolderTree.load(db, pid);
    for (const f of await db.select().from(files).where(and(inArray(files.id, fileIds), eq(files.projectId, pid)))) {
      if (f.deletedAt || !tree.byId.has(f.folderId)) continue;
      const perm = tree.permission(a.principal, f.folderId);
      if (!can(perm.level, "view") && !(perm.canUpload && f.createdBy === a.user.id)) continue;
      label.set(`file:${f.id}`, { label: f.name, link: projectPath(pid, `files/${f.folderId}?file=${f.id}`) });
    }
  }

  const issueIds = ids("issue");
  if (issueIds.length)
    for (const i of await db.select({ id: issues.id, number: issues.number, title: issues.title }).from(issues).where(and(inArray(issues.id, issueIds), eq(issues.projectId, pid))))
      label.set(`issue:${i.id}`, { label: `#${i.number} ${i.title}`, link: projectPath(pid, `issues/${i.id}`) });

  const reviewIds = ids("review");
  if (reviewIds.length) {
    const rs = await db
      .select({ r: reviews, i: workflowInstances })
      .from(reviews)
      .innerJoin(workflowInstances, and(eq(workflowInstances.subjectType, SUBJECT_REVIEW), eq(workflowInstances.subjectId, reviews.id)))
      .where(and(inArray(reviews.id, reviewIds), eq(reviews.projectId, pid)));
    const member = await memberWithRoles(db, pid, a.user.id);
    for (const { r, i } of rs)
      if (canSeeReview(a, actorFor(a.user, member, i.startedBy), r, i))
        label.set(`review:${r.id}`, { label: `${r.code ?? `#${r.number}`} ${r.name}`.trim(), link: reviewLink(pid, r.id) });
  }

  const formIds = ids("form");
  const fieldForms = capability("field.forms");
  if (formIds.length && fieldForms)
    for (const f of await fieldForms.list(db, { projectId: pid, ids: formIds }))
      label.set(`form:${f.id}`, { label: `${f.number} ${f.name}`, link: fieldForms.link(pid, f.id) });

  const scheduleIds = ids("schedule");
  const planning = capability("planning.schedules");
  if (scheduleIds.length && planning) for (const s of await planning.labels(db, pid, scheduleIds)) label.set(`schedule:${s.id}`, { label: s.label, link: s.link });

  // Parameter change requests (Coordinate): visible with their IFC file.
  const changeIds = ids("param_change");
  const paramChanges = capability("coordinate.paramChanges");
  if (changeIds.length && paramChanges) {
    const tree = await FolderTree.load(db, pid);
    for (const r of await paramChanges.list(db, pid, changeIds)) {
      if (r.file.deletedAt || !tree.byId.has(r.file.folderId)) continue;
      const perm = tree.permission(a.principal, r.file.folderId);
      if (!can(perm.level, "view") && !(perm.canUpload && r.file.createdBy === a.user.id)) continue;
      label.set(`param_change:${r.id}`, { label: r.label, link: r.link });
    }
  }

  const people = await userNames(db, rows.map((r) => r.userId));
  const days = new Map<string, Map<string, TodayChangeDto & { seen: Set<string> }>>();
  for (const r of rows) {
    const target = label.get(`${r.targetType}:${r.targetId}`);
    if (!target) continue; // deleted, or not visible to the caller
    const day = todayIso(r.at);
    const groups = days.get(day) ?? days.set(day, new Map()).get(day)!;
    const key = `${r.userId ?? ""}|${r.action}`;
    let g = groups.get(key);
    if (!g) {
      g = { at: r.at.toISOString(), userName: r.userId ? (people.get(r.userId) ?? null) : null, action: r.action, text: "", count: 0, items: [], seen: new Set() };
      groups.set(key, g);
    }
    const targetKey = `${r.targetType}:${r.targetId}`;
    if (g.seen.has(targetKey)) continue;
    g.seen.add(targetKey);
    g.count++;
    if (g.items.length < 3) g.items.push(target);
  }
  return [...days.entries()]
    .sort(([x], [y]) => y.localeCompare(x))
    .map(([day, groups]) => ({
      day,
      changes: [...groups.values()].map(({ seen: _seen, ...g }) => {
        return { ...g, text: render(lang, msg(CHANGE_TEXTS[g.action]!, { count: g.count })) };
      }),
    }));
}
