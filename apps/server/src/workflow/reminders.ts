/**
 * Due-date reminders for running review steps: "termin yaklaşıyor" one day before the due date and
 * "termin geçti" once it has passed. Each is sent once per instance and step (workflow_reminders).
 * Runs from a timer in the server process (startDueReminders) or directly with a fake clock in tests.
 */
import { and, eq, inArray, isNotNull, lte } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { DEFAULT_LANGUAGE, intlLocale, msg } from "../i18n/index.js";
import { reviewMarks, reviewFiles, reviews, workflowInstances, workflowReminders } from "../db/schema.js";
import { notify, projectMemberRows, resolveAssigneeUsers } from "./service.js";
import { SUBJECT_REVIEW, reviewLabel, reviewLink } from "./reviews.js";
import { activeModules } from "../app/modules.js";
import { runWorkDueReminders } from "../works/workflow.js";

const DAY = 24 * 60 * 60 * 1000;

export interface ReminderResult {
  dueSoon: number;
  overdue: number;
}

export async function runDueReminders(db: Db, now: Date = new Date()): Promise<ReminderResult> {
  const result: ReminderResult = { dueSoon: 0, overdue: 0 };
  const rows = await db
    .select({ i: workflowInstances, r: reviews })
    .from(workflowInstances)
    .innerJoin(reviews, and(eq(workflowInstances.subjectType, SUBJECT_REVIEW), eq(reviews.id, workflowInstances.subjectId)))
    .where(
      and(
        eq(workflowInstances.status, "running"),
        isNotNull(workflowInstances.stepDueAt),
        lte(workflowInstances.stepDueAt, new Date(now.getTime() + DAY)),
      ),
    );
  for (const { i, r } of rows) {
    const due = i.stepDueAt!;
    const kind = due.getTime() <= now.getTime() ? "overdue" : "due_soon";
    // Once per step and kind; an overdue step that never got "due soon" only gets "overdue".
    const inserted = await db
      .insert(workflowReminders)
      .values({ instanceId: i.id, stepIndex: i.stepIndex, kind, sentAt: now })
      .onConflictDoNothing()
      .returning();
    if (!inserted.length) continue;
    const step = i.template.steps[i.stepIndex]!;
    const members = await projectMemberRows(db, r.projectId);
    const answered = await answeredUsers(db, r.id, i.stepIndex);
    const pending = resolveAssigneeUsers(step.assignees, members, i.startedBy).filter((u) => !answered.has(u));
    const date = due.toLocaleDateString(intlLocale(DEFAULT_LANGUAGE));
    if (kind === "due_soon") {
      await notify(db, pending, {
        projectId: r.projectId,
        kind: "review.due_soon",
        title: msg("workflow:notifications.stepDueSoon", { review: reviewLabel(r), step: step.name }),
        body: msg("workflow:notifications.due", { date }),
        link: reviewLink(r.projectId, r.id),
      });
      result.dueSoon++;
    } else {
      await notify(db, [...pending, r.createdBy], {
        projectId: r.projectId,
        kind: "review.overdue",
        title: msg("workflow:notifications.stepOverdue", { review: reviewLabel(r), step: step.name }),
        body: msg("workflow:notifications.due", { date }),
        link: reviewLink(r.projectId, r.id),
      });
      result.overdue++;
    }
  }
  // Works (RFI, submittal) run on the same engine; their steps get the same reminders.
  const w = await runWorkDueReminders(db, now);
  result.dueSoon += w.dueSoon;
  result.overdue += w.overdue;
  for (const m of activeModules()) {
    if (!m.reminders) continue;
    const r = await m.reminders(db, now);
    result.dueSoon += r.dueSoon;
    result.overdue += r.overdue;
  }
  return result;
}

async function answeredUsers(db: Db, reviewId: string, stepIndex: number): Promise<Set<string>> {
  const rfs = await db.select({ id: reviewFiles.id }).from(reviewFiles).where(eq(reviewFiles.reviewId, reviewId));
  if (!rfs.length) return new Set();
  const marks = await db
    .select({ userId: reviewMarks.userId })
    .from(reviewMarks)
    .where(
      and(
        inArray(
          reviewMarks.reviewFileId,
          rfs.map((x) => x.id),
        ),
        eq(reviewMarks.stepIndex, stepIndex),
      ),
    );
  return new Set(marks.map((m) => m.userId));
}

/** Runs the reminders now and then every `intervalMs` (default 15 minutes). Returns a stop function. */
export function startDueReminders(
  db: Db,
  opts: { intervalMs?: number; log?: (msg: string, extra?: unknown) => void } = {},
): () => void {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await runDueReminders(db);
    } catch (err) {
      opts.log?.("due reminders failed", err instanceof Error ? err.message : err);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), opts.intervalMs ?? 15 * 60_000);
  void tick();
  return () => clearInterval(timer);
}
