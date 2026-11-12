/**
 * Workflow participants of works: reviewers of an RFI / submittal step see the work even when
 * their company is neither the sender nor an addressee (e.g. HLL and ZRT in CNS → HLL → ZRT).
 * Kept apart from service.ts so the visibility check has no import cycle with the workflow code.
 */
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import type { ProjectAccess } from "../core/security/access.js";
import type { Db } from "../db/index.js";
import { workRevisions, workflowInstances, works } from "../db/schema.js";
import { isAssignee } from "../workflow/engine.js";
import { actorFor, memberWithRoles } from "../workflow/service.js";

export const SUBJECT_WORK_REVISION = "work_revision";

/**
 * Ids of works (of the project, optionally limited to `workIds`) whose workflow lists the caller
 * as an assignee in any step or that the caller started.
 */
export async function participantWorkIds(db: Db, a: ProjectAccess, workIds?: string[]): Promise<Set<string>> {
  if (workIds && !workIds.length) return new Set();
  const rows = await db
    .select({ workId: workRevisions.workId, i: workflowInstances })
    .from(workRevisions)
    .innerJoin(works, eq(works.id, workRevisions.workId))
    .innerJoin(workflowInstances, eq(workflowInstances.id, workRevisions.workflowInstanceId))
    .where(
      and(
        eq(works.projectId, a.project.id),
        isNotNull(workRevisions.workflowInstanceId),
        workIds ? inArray(workRevisions.workId, workIds) : undefined,
      ),
    );
  const out = new Set<string>();
  if (!rows.length) return out;
  const member = await memberWithRoles(db, a.project.id, a.user.id);
  for (const r of rows) {
    if (out.has(r.workId)) continue;
    const actor = actorFor(a.user, member, r.i.startedBy);
    if (actor.isStarter || r.i.template.steps.some((s) => isAssignee(s, actor))) out.add(r.workId);
  }
  return out;
}
