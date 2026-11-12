import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { MyTaskDto, NotificationDto } from "@sitekeep/shared";
import type { AppDeps } from "../../app/deps.js";
import { isUuid, type AuthUser } from "../../core/security/access.js";
import type { Db } from "../../db/index.js";
import { notifications, projectMembers, projects, reviews, workRevisions, workflowActions, workflowInstances, works } from "../../db/schema.js";
import { SUBJECT_WORK_REVISION } from "../../works/participants.js";
import { workLink } from "../../works/service.js";
import { notFound } from "../../core/platform/http.js";
import { msg, render, requestLanguage } from "../../i18n/index.js";
import { isAssignee } from "../../workflow/engine.js";
import { SUBJECT_REVIEW, reviewLink } from "../../workflow/reviews.js";
import { actorFor, withRoleIds } from "../../workflow/service.js";
import { submittedNow } from "../review-access.js";
import { activeModules } from "../../app/modules.js";

export async function notificationRoutes(api: FastifyInstance, { db }: AppDeps) {
  /** The caller's notifications, unread first, newest first. */
  api.get<{ Querystring: { limit?: string; unread?: string } }>("/notifications", async (req) => {
    const limit = z.coerce.number().int().min(1).max(200).default(50).parse(req.query.limit ?? undefined);
    const rows = await db
      .select()
      .from(notifications)
      .where(
        and(eq(notifications.userId, req.user!.id), req.query.unread === "1" ? isNull(notifications.readAt) : undefined),
      )
      .orderBy(sql`${notifications.readAt} IS NOT NULL`, desc(notifications.createdAt))
      .limit(limit);
    const lang = requestLanguage(req);
    return rows.map((r) => toNotificationDto(r, lang));
  });

  api.get("/notifications/count", async (req) => {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(notifications)
      .where(and(eq(notifications.userId, req.user!.id), isNull(notifications.readAt)));
    return { unread: row?.n ?? 0 };
  });

  api.post<{ Params: { id: string } }>("/notifications/:id/read", async (req) => {
    if (!isUuid(req.params.id)) throw notFound(msg("workflow:entities.notification"));
    const [row] = await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.id, req.params.id), eq(notifications.userId, req.user!.id)))
      .returning();
    if (!row) throw notFound(msg("workflow:entities.notification"));
    return toNotificationDto(row, requestLanguage(req));
  });

  api.post("/notifications/read-all", async (req) => {
    const rows = await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.userId, req.user!.id), isNull(notifications.readAt)))
      .returning({ id: notifications.id });
    return { ok: true, marked: rows.length };
  });

  /** Open workflow steps assigned to the caller, across projects ("Görevlerim"). */
  api.get("/my-tasks", async (req) => myTasksFor(db, req.user!));
}

/**
 * Open workflow steps (reviews, work steps, form steps) assigned to the user, across the user's
 * projects or in one project (project "Bugün").
 */
export async function myTasksFor(db: Db, user: AuthUser, onlyProjectId?: string): Promise<MyTaskDto[]> {
  const memberships = await withRoleIds(
    db,
    await db.select().from(projectMembers).where(eq(projectMembers.userId, user.id)),
  );
  const projectRows = (user.isAdmin
    ? await db.select().from(projects).where(eq(projects.archived, false))
    : memberships.length
      ? await db
          .select()
          .from(projects)
          .where(
            and(
              inArray(
                projects.id,
                memberships.map((m) => m.projectId),
              ),
              eq(projects.archived, false),
            ),
          )
      : []
  ).filter((p) => !onlyProjectId || p.id === onlyProjectId);
  if (!projectRows.length) return [];
  const rows = await db
    .select({ i: workflowInstances, r: reviews })
    .from(workflowInstances)
    .innerJoin(
      reviews,
      and(eq(workflowInstances.subjectType, SUBJECT_REVIEW), eq(reviews.id, workflowInstances.subjectId)),
    )
    .where(
      and(
        inArray(
          workflowInstances.projectId,
          projectRows.map((p) => p.id),
        ),
        eq(workflowInstances.status, "running"),
      ),
    )
    .orderBy(asc(workflowInstances.stepDueAt));
  const done = await submittedNow(
    db,
    rows.map((x) => x.i),
    user.id,
  );
  const now = Date.now();
  const tasks: MyTaskDto[] = [];
  for (const { i, r } of rows) {
    if (done.has(i.id)) continue;
    const member = memberships.find((m) => m.projectId === i.projectId);
    const step = i.template.steps[i.stepIndex]!;
    if (!isAssignee(step, actorFor(user, member, i.startedBy))) continue;
    const p = projectRows.find((x) => x.id === i.projectId)!;
    tasks.push({
      projectId: p.id,
      projectCode: p.code,
      projectName: p.name,
      kind: i.kind,
      subjectId: r.id,
      number: r.number,
      name: r.name,
      stepIndex: i.stepIndex,
      stepName: step.name,
      stepDueAt: i.stepDueAt?.toISOString() ?? null,
      overdue: !!i.stepDueAt && i.stepDueAt.getTime() < now,
      link: reviewLink(p.id, r.id),
    });
  }
  // Work steps (RFI, submittal…) on the same engine.
  const workRows = await db
    .select({ i: workflowInstances, w: works })
    .from(workflowInstances)
    .innerJoin(workRevisions, and(eq(workflowInstances.subjectType, SUBJECT_WORK_REVISION), eq(workRevisions.id, workflowInstances.subjectId)))
    .innerJoin(works, eq(works.id, workRevisions.workId))
    .where(and(inArray(workflowInstances.projectId, projectRows.map((p) => p.id)), eq(workflowInstances.status, "running")))
    .orderBy(asc(workflowInstances.stepDueAt));
  const answered = workRows.length
    ? await db
        .select({ instanceId: workflowActions.instanceId, stepIndex: workflowActions.stepIndex })
        .from(workflowActions)
        .where(
          and(
            inArray(workflowActions.instanceId, workRows.map((x) => x.i.id)),
            eq(workflowActions.kind, "submit"),
            eq(workflowActions.userId, user.id),
          ),
        )
    : [];
  for (const { i, w } of workRows) {
    if (answered.some((x) => x.instanceId === i.id && x.stepIndex === i.stepIndex)) continue;
    const member = memberships.find((m) => m.projectId === i.projectId);
    const step = i.template.steps[i.stepIndex]!;
    if (!isAssignee(step, actorFor(user, member, i.startedBy))) continue;
    const p = projectRows.find((x) => x.id === i.projectId)!;
    tasks.push({
      projectId: p.id,
      projectCode: p.code,
      projectName: p.name,
      kind: i.kind,
      subjectId: w.id,
      number: w.seq,
      code: w.number,
      name: w.title,
      stepIndex: i.stepIndex,
      stepName: step.name,
      stepDueAt: i.stepDueAt?.toISOString() ?? null,
      overdue: !!i.stepDueAt && i.stepDueAt.getTime() < now,
      link: workLink(p.id, w.id),
    });
  }
  for (const m of activeModules()) for (const source of m.taskSources ?? []) tasks.push(...(await source(db, user, projectRows, now)));
  return tasks;
}

/** Rows with `message` are rendered in the reader's language; older rows keep their stored text. */
function toNotificationDto(r: typeof notifications.$inferSelect, lang: string): NotificationDto {
  return {
    id: r.id,
    projectId: r.projectId,
    kind: r.kind,
    title: r.message?.title ? render(lang, r.message.title) : r.title,
    body: r.message?.body ? render(lang, r.message.body) : r.body,
    link: r.link,
    readAt: r.readAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  };
}
