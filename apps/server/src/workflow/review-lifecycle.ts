import type { WorkflowAssignee, WorkflowStep } from "@sitekeep/shared";
import { and, eq } from "drizzle-orm";
import { audit } from "../core/platform/audit.js";
import { conflict, forbidden, notFound } from "../core/platform/http.js";
import type { ProjectAccess } from "../core/security/access.js";
import type { Db } from "../db/index.js";
import { msg } from "../i18n/index.js";
import { reviewFiles, workflowActions, workflowInstances } from "../db/schema.js";
import { afterEvaluate, evaluateReview, notifyStepAssignees } from "./review-engine.js";
import {
  SUBJECT_REVIEW,
  reviewLabel,
  reviewLink,
  type InstanceRow,
  type ReviewCtx,
  type ReviewRow,
} from "./review-types.js";
import { notify, projectMemberRows, resolveAssigneeUsers } from "./service.js";

export async function loadInstance(db: Db, reviewId: string): Promise<InstanceRow> {
  const [instance] = await db
    .select()
    .from(workflowInstances)
    .where(and(eq(workflowInstances.subjectType, SUBJECT_REVIEW), eq(workflowInstances.subjectId, reviewId)));
  if (!instance) throw notFound(msg("workflow:entities.review"));
  return instance;
}

export async function cancelReview(ctx: ReviewCtx, a: ProjectAccess, review: ReviewRow, comment: string | null) {
  const { db } = ctx;
  const instance = await loadInstance(db, review.id);
  if (!a.isProjectAdmin && review.createdBy !== a.user.id)
    throw forbidden(msg("workflow:errors.cancelNotAllowed"));
  if (instance.status !== "running") throw conflict(msg("workflow:errors.reviewNotOpen"));
  const now = new Date();
  await db
    .update(workflowInstances)
    .set({ status: "cancelled", completedAt: now, stepDueAt: null, stageDueAt: null, updatedAt: now })
    .where(eq(workflowInstances.id, instance.id));
  await db.insert(workflowActions).values({
    instanceId: instance.id,
    stepIndex: instance.stepIndex,
    kind: "cancel",
    userId: a.user.id,
    comment,
  });
  await audit(db, {
    projectId: review.projectId,
    userId: a.user.id,
    action: "review.cancelled",
    targetType: "review",
    targetId: review.id,
    details: { number: review.number, name: review.name },
  });
  const members = await projectMemberRows(db, review.projectId);
  const step = instance.template.steps[instance.stepIndex]!;
  await notify(
    db,
    [review.createdBy, ...resolveAssigneeUsers(step.assignees, members, instance.startedBy)].filter((u) => u !== a.user.id),
    {
      projectId: review.projectId,
      kind: "review.cancelled",
      title: msg("workflow:notifications.reviewCancelled", { review: reviewLabel(review) }),
      body: comment,
      link: reviewLink(review.projectId, review.id),
    },
  );
}

export async function reassignStep(
  ctx: ReviewCtx,
  a: ProjectAccess,
  review: ReviewRow,
  assignees: WorkflowAssignee[],
  checkSteps: (steps: WorkflowStep[]) => Promise<void>,
) {
  const { db } = ctx;
  if (!a.isProjectAdmin) throw forbidden(msg("workflow:errors.reassignNotAllowed"));
  const before = await loadInstance(db, review.id);
  if (before.status !== "running") throw conflict(msg("workflow:errors.reviewNotOpen"));
  const steps = before.template.steps.map((step, index) => {
    if (index !== before.stepIndex) return step;
    const { assigneeRule: _rule, resolvedBy: _by, ...rest } = step;
    return { ...rest, assignees };
  });
  await checkSteps(steps);
  const result = await db.transaction(async (tx) => {
    const [instance] = await tx
      .update(workflowInstances)
      .set({ template: { ...before.template, steps }, updatedAt: new Date() })
      .where(eq(workflowInstances.id, before.id))
      .returning();
    await tx.insert(workflowActions).values({
      instanceId: before.id,
      stepIndex: before.stepIndex,
      kind: "reassign",
      userId: a.user.id,
      details: { from: before.template.steps[before.stepIndex]!.assignees, to: assignees },
    });
    const rfs = await tx.select().from(reviewFiles).where(eq(reviewFiles.reviewId, review.id));
    return evaluateReview(tx, review, instance!, rfs, a.user.id);
  });
  await audit(db, {
    projectId: review.projectId,
    userId: a.user.id,
    action: "review.reassigned",
    targetType: "review",
    targetId: review.id,
    details: { number: review.number, stepIndex: before.stepIndex, assignees },
  });
  if (result.stepCompleted) await afterEvaluate(ctx, review, result, a.user.id);
  else await notifyStepAssignees(db, review, result.instance);
  return result;
}
