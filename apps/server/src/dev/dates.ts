/**
 * Dev-only date writes. The API stamps every record with "now" (creation, sending, workflow step
 * starts and due dates), so realistic history — letters from last month, reviews whose step is
 * overdue — is made by moving a record's timestamps after it was created through the API.
 * Only the developer tools call this (CDE_DEV_TOOLS=1, test/demo projects).
 */
import { moduleTable } from "../app/modules.js";
import { eq, inArray, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { Db } from "../db/index.js";
import {
  issues,
  reviewFiles,
  reviews,
  workEvents,
  workLinks,
  workReceipts,
  workRevisions,
  workflowActions,
  workflowInstances,
  works,
} from "../db/schema.js";
import { dayOffset } from "./random.js";

const plus = (col: AnyPgColumn, sec: number): SQL => sql`${col} + (${sec}::double precision * interval '1 second')`;

async function shiftInstances(db: Db, ids: string[], sec: number): Promise<void> {
  if (!ids.length || !sec) return;
  await db
    .update(workflowInstances)
    .set({
      createdAt: plus(workflowInstances.createdAt, sec),
      updatedAt: plus(workflowInstances.updatedAt, sec),
      stepStartedAt: plus(workflowInstances.stepStartedAt, sec),
      stepDueAt: plus(workflowInstances.stepDueAt, sec),
      stageDueAt: plus(workflowInstances.stageDueAt, sec),
      completedAt: plus(workflowInstances.completedAt, sec),
    } as never)
    .where(inArray(workflowInstances.id, ids));
  await db.update(workflowActions).set({ at: plus(workflowActions.at, sec) } as never).where(inArray(workflowActions.instanceId, ids));
}

function shiftIso(v: unknown, sec: number): unknown {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(v)) return v;
  return new Date(new Date(v).getTime() + sec * 1000).toISOString();
}

/** Moves every timestamp of a work (and its events, links, receipts, revisions and workflow) by `sec`. */
export async function shiftWork(db: Db, workId: string, sec: number): Promise<void> {
  if (!sec) return;
  const [w] = await db.select({ delivery: works.delivery, wf: works.workflowInstanceId }).from(works).where(eq(works.id, workId));
  if (!w) return;
  const delivery = w.delivery ? { ...w.delivery, sentAt: shiftIso(w.delivery.sentAt, sec) as string | null, updatedAt: shiftIso(w.delivery.updatedAt, sec) as string | null } : null;
  await db
    .update(works)
    .set({
      createdAt: plus(works.createdAt, sec),
      updatedAt: plus(works.updatedAt, sec),
      sentAt: plus(works.sentAt, sec),
      closedAt: plus(works.closedAt, sec),
      ...(delivery && { delivery }),
    } as never)
    .where(eq(works.id, workId));
  await db.update(workEvents).set({ at: plus(workEvents.at, sec) } as never).where(eq(workEvents.workId, workId));
  await db.update(workLinks).set({ createdAt: plus(workLinks.createdAt, sec) } as never).where(eq(workLinks.workId, workId));
  await db.update(workReceipts).set({ receivedAt: plus(workReceipts.receivedAt, sec) } as never).where(eq(workReceipts.workId, workId));
  const revs = await db.select({ wf: workRevisions.workflowInstanceId }).from(workRevisions).where(eq(workRevisions.workId, workId));
  await db
    .update(workRevisions)
    .set({ submittedAt: plus(workRevisions.submittedAt, sec), decidedAt: plus(workRevisions.decidedAt, sec) } as never)
    .where(eq(workRevisions.workId, workId));
  const ids = [...new Set([w.wf, ...revs.map((r) => r.wf)].filter((x): x is string => !!x))];
  await shiftInstances(db, ids, sec);
}

export async function shiftIssue(db: Db, id: string, sec: number): Promise<void> {
  if (!sec) return;
  await db.update(issues).set({ createdAt: plus(issues.createdAt, sec), updatedAt: plus(issues.updatedAt, sec) } as never).where(eq(issues.id, id));
}

async function instancesOf(db: Db, subjectType: string, id: string): Promise<string[]> {
  const rows = await db
    .select({ id: workflowInstances.id })
    .from(workflowInstances)
    .where(sql`${workflowInstances.subjectType} = ${subjectType} and ${workflowInstances.subjectId} = ${id}`);
  return rows.map((r) => r.id);
}

export async function shiftReview(db: Db, id: string, sec: number): Promise<void> {
  if (!sec) return;
  await db.update(reviews).set({ createdAt: plus(reviews.createdAt, sec) } as never).where(eq(reviews.id, id));
  await db.update(reviewFiles).set({ decidedAt: plus(reviewFiles.decidedAt, sec) } as never).where(eq(reviewFiles.reviewId, id));
  await shiftInstances(db, await instancesOf(db, "review", id), sec);
}

export async function shiftForm(db: Db, id: string, sec: number): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const forms = moduleTable<any>("field", "forms"); // Field's table, when installed
  if (!sec || !forms) return;
  const [f] = await db.select({ createdAt: forms.createdAt }).from(forms).where(eq(forms.id, id));
  if (!f) return;
  const created = new Date(f.createdAt.getTime() + sec * 1000);
  await db
    .update(forms)
    .set({
      createdAt: plus(forms.createdAt, sec),
      updatedAt: plus(forms.updatedAt, sec),
      submittedAt: plus(forms.submittedAt, sec),
      closedAt: plus(forms.closedAt, sec),
      formDate: dayOffset(0, created),
    } as never)
    .where(eq(forms.id, id));
  await shiftInstances(db, await instancesOf(db, "form", id), sec);
}

/** Sets the running step's due date of a review or form (overdue when in the past). */
export async function setStepDue(db: Db, subjectType: "review" | "form", id: string, due: Date): Promise<void> {
  const ids = await instancesOf(db, subjectType, id);
  if (!ids.length) return;
  await db
    .update(workflowInstances)
    .set({ stepDueAt: due, stageDueAt: sql`case when ${workflowInstances.stageDueAt} is null then null else ${due.toISOString()}::timestamptz end` } as never)
    .where(inArray(workflowInstances.id, ids));
}

/** Running workflow instance ids of works (their current step due dates move with the work's due date). */
export async function setWorkDue(db: Db, workId: string, dueDate: string): Promise<void> {
  const [w] = await db.select({ wf: works.workflowInstanceId }).from(works).where(eq(works.id, workId));
  await db.update(works).set({ dueDate }).where(eq(works.id, workId));
  if (w?.wf)
    await db
      .update(workflowInstances)
      .set({ stepDueAt: new Date(`${dueDate}T17:00:00`) })
      .where(sql`${workflowInstances.id} = ${w.wf} and ${workflowInstances.status} = 'running'`);
}

export const DAY_SEC = 86_400;
