import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  WORK_DUE_SOON_DAYS,
  WORK_STATUS,
  canSeeWork,
  isWorkAddressee,
  type MyTaskDto,
  type TodayDto,
  type TodayWorkDto,
  type WorkViewer,
} from "@sitekeep/shared";
import { tokenAllowsProject, userNames } from "../../core/security/access.js";
import { projectMembers, projects, workReceipts, workTypes, works } from "../../db/schema.js";
import { addDaysIso, isClosed, toSummary, todayIso, workLink } from "../service.js";
import type { WorksRouteContext } from "./route-helpers.js";

export function registerWorkTodayRoutes(r: WorksRouteContext) {
  const { api, db } = r;

  api.get("/me/today", async (req): Promise<TodayDto> => {
    const user = req.user!;
    const memberships = await db.select().from(projectMembers).where(eq(projectMembers.userId, user.id));
    const projectRows = (
      user.isAdmin
        ? await db.select().from(projects).where(eq(projects.archived, false))
        : memberships.length
          ? await db.select().from(projects)
              .where(and(inArray(projects.id, memberships.map((m) => m.projectId)), eq(projects.archived, false)))
          : []
    ).filter((p) => tokenAllowsProject(user, p.id));
    const today = todayIso();
    const soon = addDaysIso(today, WORK_DUE_SOON_DAYS);
    const out: TodayDto = {
      assigned: [],
      awaitingReply: [],
      toReceive: [],
      dueSoon: [],
      overdue: [],
      tasks: [],
      newVersions: null,
      counts: { assigned: 0, awaitingReply: 0, toReceive: 0, dueSoon: 0, overdue: 0, tasks: 0, total: 0 },
    };
    if (projectRows.length) {
      const pids = projectRows.map((p) => p.id);
      const rows = await db
        .select({ w: works, t: workTypes })
        .from(works)
        .innerJoin(workTypes, eq(workTypes.id, works.typeId))
        .where(inArray(works.projectId, pids))
        .orderBy(asc(works.dueDate), desc(works.createdAt));
      const receipts = rows.length
        ? await db.select().from(workReceipts).where(inArray(workReceipts.workId, rows.map((x) => x.w.id)))
        : [];
      const names = await userNames(db, rows.map((x) => x.w.createdBy));
      for (const { w, t } of rows) {
        const m = memberships.find((x) => x.projectId === w.projectId);
        const viewer: WorkViewer = {
          userId: user.id,
          companyId: m?.companyId ?? user.companyId ?? null,
          isProjectAdmin: user.isAdmin || !!m?.isProjectAdmin,
        };
        if (!canSeeWork(w, viewer) || isClosed(t, w.status)) continue;
        const p = projectRows.find((x) => x.id === w.projectId)!;
        const dto: TodayWorkDto = {
          ...toSummary(w, t, names, today),
          projectCode: p.code,
          projectName: p.name,
          link: workLink(p.id, w.id),
        };
        const sent = w.status !== WORK_STATUS.draft;
        const actionRecipient = !!viewer.companyId && w.toCompanyIds.includes(viewer.companyId);
        const mine = w.assigneeUserId === user.id;
        const received = !!viewer.companyId && receipts.some((x) => x.workId === w.id && x.companyId === viewer.companyId);
        if (mine) out.assigned.push(dto);
        if (sent && actionRecipient && w.replyRequired && (w.status === WORK_STATUS.sent || w.status === WORK_STATUS.received))
          out.awaitingReply.push(dto);
        if (w.status === WORK_STATUS.sent && isWorkAddressee(w, viewer) && !received) out.toReceive.push(dto);
        const responsible = mine || (sent && actionRecipient) || (w.createdBy === user.id && !w.assigneeUserId);
        if (responsible && w.dueDate) {
          if (w.dueDate < today) out.overdue.push(dto);
          else if (w.dueDate <= soon) out.dueSoon.push(dto);
        }
      }
    }
    out.tasks = await myTasks(req.headers);
    out.counts = {
      assigned: out.assigned.length,
      awaitingReply: out.awaitingReply.length,
      toReceive: out.toReceive.length,
      dueSoon: out.dueSoon.length,
      overdue: out.overdue.length,
      tasks: out.tasks.length,
      total: 0,
    };
    const unique = new Set([...out.assigned, ...out.awaitingReply, ...out.toReceive, ...out.dueSoon, ...out.overdue].map((w) => w.id));
    out.counts.total = unique.size + out.tasks.length;
    return out;
  });

  async function myTasks(headers: Record<string, string | string[] | undefined>): Promise<MyTaskDto[]> {
    const pass: Record<string, string> = {};
    for (const h of ["authorization", "cookie"] as const) if (typeof headers[h] === "string") pass[h] = headers[h] as string;
    const res = await api.inject({ method: "GET", url: "/api/v1/my-tasks", headers: pass });
    return res.statusCode === 200 ? (res.json() as MyTaskDto[]) : [];
  }
}
