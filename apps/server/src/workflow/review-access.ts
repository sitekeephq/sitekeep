import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { reviews, workflowActions } from "../db/schema.js";
import { notFound } from "../core/platform/http.js";
import { msg } from "../i18n/index.js";
import { isUuid, type ProjectAccess } from "../core/security/access.js";
import { isAssignee, type ActorContext } from "./engine.js";
import { loadInstance, type InstanceRow, type ReviewRow } from "./reviews.js";
import { actorFor, memberWithRoles } from "./service.js";

/** Project admins, the starter and anyone assigned to any step see a review. */
export function canSee(a: ProjectAccess, actor: ActorContext, r: ReviewRow, i: InstanceRow): boolean {
  if (a.isProjectAdmin || r.createdBy === a.user.id) return true;
  return i.template.steps.some((s) => isAssignee(s, actor));
}

export async function loadVisibleReview(db: Db, a: ProjectAccess, rid: string): Promise<ReviewRow> {
  if (!isUuid(rid)) throw notFound(msg("workflow:entities.review"));
  const [review] = await db.select().from(reviews).where(and(eq(reviews.id, rid), eq(reviews.projectId, a.project.id)));
  if (!review) throw notFound(msg("workflow:entities.review"));
  const instance = await loadInstance(db, review.id);
  const member = await memberWithRoles(db, a.project.id, a.user.id);
  if (!canSee(a, actorFor(a.user, member, instance.startedBy), review, instance)) throw notFound(msg("workflow:entities.review"));
  return review;
}

/** Instances where the user already submitted the current step. */
export async function submittedNow(db: Db, instances: InstanceRow[], userId: string): Promise<Set<string>> {
  const running = instances.filter((i) => i.status === "running");
  if (!running.length) return new Set();
  const rows = await db
    .select({ instanceId: workflowActions.instanceId, stepIndex: workflowActions.stepIndex })
    .from(workflowActions)
    .where(
      and(
        inArray(
          workflowActions.instanceId,
          running.map((i) => i.id),
        ),
        eq(workflowActions.kind, "submit"),
        eq(workflowActions.userId, userId),
      ),
    );
  const out = new Set<string>();
  for (const i of running) if (rows.some((r) => r.instanceId === i.id && r.stepIndex === i.stepIndex)) out.add(i.id);
  return out;
}
