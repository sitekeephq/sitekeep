/**
 * Detail extras of works with a workflow or of build categories (revisions, ball in court, children,
 * meeting data), the works a caller sees and the workflow state of works (registers, reports).
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import { canEditWork, canSeeWork, type WorkBuildDto } from "@sitekeep/shared";
import { userNames, type ProjectAccess } from "../core/security/access.js";
import type { Db } from "../db/index.js";
import { workRevisions, workflowInstances, works } from "../db/schema.js";
import { DEFAULT_LANGUAGE } from "../i18n/index.js";
import { projectMemberRows } from "../workflow/service.js";
import { meetingDataOf } from "./meeting-data.js";
import { participantWorkIds } from "./participants.js";
import { isClosed, projectTypes, toSummary, viewerOf, type TypeRow, type WorkRow } from "./service.js";
import { ballInCourt, flowDto, loadFlowRows, nameBook, revisionDto, revisionsOf, runsWorkflow } from "./workflow.js";

const BUILD_CATEGORIES = new Set(["rfi", "submittal", "submittal_package", "meeting", "action"]);

export function hasBuildExtras(type: TypeRow): boolean {
  return BUILD_CATEGORIES.has(type.category) || runsWorkflow(type);
}

/** Works of the project the caller sees (incl. workflow participants), with their types. */
export async function visibleWorks(db: Db, a: ProjectAccess, filter?: (t: TypeRow) => boolean) {
  const types = await projectTypes(db, a.project.id);
  const rows = await db.select().from(works).where(eq(works.projectId, a.project.id)).orderBy(asc(works.createdAt));
  const viewer = viewerOf(a);
  const picked = rows.filter((w) => {
    const t = types.find((x) => x.id === w.typeId);
    return t && (!filter || filter(t));
  });
  const hidden = picked.filter((w) => !canSeeWork(w, viewer)).map((w) => w.id);
  const extra = await participantWorkIds(db, a, hidden);
  return {
    types,
    list: picked
      .filter((w) => canSeeWork(w, viewer) || extra.has(w.id))
      .map((w) => ({ w, t: types.find((x) => x.id === w.typeId)! })),
  };
}

// ---- Detail -------------------------------------------------------------------------------------

export async function buildDetail(db: Db, a: ProjectAccess, work: WorkRow, type: TypeRow, lang: string = DEFAULT_LANGUAGE): Promise<WorkBuildDto | null> {
  if (!hasBuildExtras(type)) return null;
  const revs = await revisionsOf(db, work.id);
  const { instances, actions } = await loadFlowRows(db, revs);
  const n = await nameBook(db, a.project.id, instances, actions, lang);
  const revisions = revs.map((r) => revisionDto(r, instances.find((i) => i.id === r.workflowInstanceId), actions, n));
  const last = revs.at(-1);
  const lastInstance = last ? instances.find((i) => i.id === last.workflowInstanceId) : undefined;
  const workflow = last && lastInstance ? await flowDto(db, a, work, type, last, lastInstance, actions, n) : null;
  const members = await projectMemberRows(db, a.project.id);
  const types = await projectTypes(db, a.project.id);
  const viewer = viewerOf(a);
  const childRows = await db.select().from(works).where(eq(works.parentWorkId, work.id)).orderBy(asc(works.createdAt));
  const [parentRow] = work.parentWorkId ? await db.select().from(works).where(eq(works.id, work.parentWorkId)) : [];
  const meeting = type.category === "meeting" ? meetingDataOf(work) : null;
  const carriedIds = meeting?.carriedActionIds ?? [];
  const carriedRows = carriedIds.length ? await db.select().from(works).where(inArray(works.id, carriedIds)) : [];
  const names = await userNames(db, [...childRows, ...carriedRows, ...(parentRow ? [parentRow] : [])].map((x) => x.createdBy));
  const summary = (w: WorkRow) => toSummary(w, types.find((t) => t.id === w.typeId)!, names);
  const editable = canEditWork(work, viewer);
  const running = last?.status === "running";
  const flows = runsWorkflow(type);
  return {
    category: type.category,
    rev: typeof work.data.rev === "number" ? work.data.rev : (last?.rev ?? 0),
    ballInCourt: ballInCourt(work, type, lastInstance, members),
    canSubmit:
      editable &&
      !running &&
      (flows
        ? work.status === "taslak" || work.status === "revize"
        : type.category === "submittal_package" && childRows.some((c) => c.status === "taslak" || c.status === "revize")),
    canRevise:
      editable &&
      type.category === "submittal" &&
      !!last &&
      last.status === "decided" &&
      (last.outcome === "revise_resubmit" || last.outcome === "rejected") &&
      work.status !== "taslak",
    canCancel: editable && flows && !isClosed(type, work.status) && type.statuses.some((s) => s.key === "iptal"),
    workflow,
    revisions,
    officialResponse:
      [...revs].reverse().find((r) => r.response)?.response ?? (typeof work.fields.resmi_cevap === "string" ? work.fields.resmi_cevap : null),
    children: childRows.filter((c) => canSeeWork(c, viewer) || editable).map(summary),
    parent: parentRow ? summary(parentRow) : null,
    meeting,
    carried: carriedRows.map(summary),
  };
}

export async function flowState(db: Db, workIds: string[]) {
  const revs = workIds.length
    ? await db.select().from(workRevisions).where(inArray(workRevisions.workId, workIds)).orderBy(asc(workRevisions.rev))
    : [];
  const ids = revs.map((r) => r.workflowInstanceId).filter((x): x is string => !!x);
  const instances = ids.length ? await db.select().from(workflowInstances).where(inArray(workflowInstances.id, ids)) : [];
  const lastOf = (wid: string) => revs.filter((r) => r.workId === wid).at(-1);
  return {
    revs,
    last: lastOf,
    first: (wid: string) => revs.find((r) => r.workId === wid),
    instanceOf: (wid: string) => {
      const r = lastOf(wid);
      return r ? instances.find((i) => i.id === r.workflowInstanceId) : undefined;
    },
  };
}
