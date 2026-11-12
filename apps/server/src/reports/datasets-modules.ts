/**
 * Report datasets of the other modules: reviews (with per-file outcomes and step durations of every
 * workflow), forms, locations, schedules, clash coordination, document comparisons and specification
 * registers. Each is loaded with the caller's permissions, using the same visibility rules as the
 * module's own list endpoint.
 */
import { and, asc, eq, inArray, isNull, ne } from "drizzle-orm";
import {
  OUTCOME_LABELS_TR,
  SUBMITTAL_KINDS,
  WORKFLOW_ROLE_LABELS_TR,
  WORKFLOW_STATUS_LABELS_TR,
  splitExtension,
  type ReportRow,
  type WorkflowStep,
} from "@sitekeep/shared";
import {
  docComparisons,
  fileVersions,
  files,
  issues,
  locationLinks,
  locations,
  projectRoles,
  reviewFiles,
  reviews,
  specRegisters,
  workRevisions,
  workflowActions,
  workflowInstances,
} from "../db/schema.js";
import { compareFlags } from "../doccompare/text-diff.js";
import { canSee as canSeeReview } from "../workflow/review-access.js";
import { locationPaths } from "../locations/paths.js";
import { SUBJECT_REVIEW, type InstanceRow, type ReviewRow } from "../workflow/reviews.js";
import { actorFor, folderGate, memberWithRoles } from "../workflow/service.js";
import { workBase } from "./datasets-works.js";
import { labelFor, msg } from "../i18n/index.js";
import { fileVisibility, folderInfo, iso, labelValues, reportDatasets, type FolderInfo, type ReportContext } from "./datasets.js";
import { dayKey } from "./engine.js";
import { capability } from "../sdk/capabilities.js";

const DAY_MS = 86_400_000;
const days = (from: Date, to: Date) => Math.round(((to.getTime() - from.getTime()) / DAY_MS) * 10) / 10;
const SUBJECT_VALUES = {
  review: msg("reports:values.subject.review"),
  rfi: msg("reports:values.subject.rfi"),
  submittal: msg("reports:values.subject.submittal"),
  form: msg("reports:values.subject.form"),
  work: msg("reports:values.subject.work"),
};
const STEP_STATUS_VALUES = {
  running: msg("reports:values.stepStatus.running"),
  done: msg("reports:values.stepStatus.done"),
  cancelled: msg("reports:values.stepStatus.cancelled"),
};
const COMPARE_STATUS_VALUES = {
  running: msg("reports:values.compareStatus.running"),
  done: msg("reports:values.compareStatus.done"),
  failed: msg("reports:values.compareStatus.failed"),
};
const KIND_VALUES: Record<string, string> = Object.fromEntries(SUBMITTAL_KINDS.map((k) => [k.code, k.label]));

// ---- Reviews (shared load) --------------------------------------------------------------------------

interface VisibleReview {
  r: ReviewRow;
  i: InstanceRow;
}

/** Reviews the caller sees (admins, the starter and every step assignee — as the İncelemeler list). */
function visibleReviews(ctx: ReportContext): Promise<VisibleReview[]> {
  return ctx.memo("reviews:visible", async () => {
    const rows = await ctx.db
      .select({ r: reviews, i: workflowInstances })
      .from(reviews)
      .innerJoin(workflowInstances, and(eq(workflowInstances.subjectType, SUBJECT_REVIEW), eq(workflowInstances.subjectId, reviews.id)))
      .where(eq(reviews.projectId, ctx.access.project.id))
      .orderBy(asc(reviews.number));
    const member = await memberWithRoles(ctx.db, ctx.access.project.id, ctx.access.user.id);
    return rows.filter(({ r, i }) => canSeeReview(ctx.access, actorFor(ctx.access.user, member, i.startedBy), r, i));
  });
}

reportDatasets.register("reviews", {
  label: msg("reports:datasets.reviews.label"),
  description: msg("reports:datasets.reviews.description"),
  module: "reviews",
  sources: ["reviews", "workflow", "files", "members"],
  fields: {
    number: { type: "number", label: msg("reports:datasets.reviews.fields.number") },
    name: { type: "string", label: msg("reports:datasets.reviews.fields.name") },
    code: { type: "string", label: msg("reports:datasets.reviews.fields.code") },
    workflow: { type: "string", label: msg("reports:datasets.reviews.fields.workflow") },
    status: { type: "string", label: msg("reports:datasets.reviews.fields.status"), values: labelValues("workflowStatus", WORKFLOW_STATUS_LABELS_TR) },
    isOpen: { type: "boolean", label: msg("reports:datasets.reviews.fields.isOpen") },
    currentStep: { type: "string", label: msg("reports:datasets.reviews.fields.currentStep"), description: msg("reports:datasets.reviews.hints.currentStep") },
    stepNo: { type: "number", label: msg("reports:datasets.reviews.fields.stepNo"), description: msg("reports:datasets.reviews.hints.stepNo") },
    stepCount: { type: "number", label: msg("reports:datasets.reviews.fields.stepCount") },
    stepDueAt: { type: "date", label: msg("reports:datasets.reviews.fields.stepDueAt") },
    overdue: { type: "boolean", label: msg("reports:datasets.reviews.fields.overdue"), description: msg("reports:datasets.reviews.hints.overdue") },
    daysInStep: { type: "number", label: msg("reports:datasets.reviews.fields.daysInStep") },
    totalDays: { type: "number", label: msg("reports:datasets.reviews.fields.totalDays"), description: msg("reports:datasets.reviews.hints.totalDays") },
    fileCount: { type: "number", label: msg("reports:datasets.reviews.fields.fileCount") },
    approvedCount: { type: "number", label: msg("reports:datasets.reviews.fields.approvedCount") },
    reviseCount: { type: "number", label: msg("reports:datasets.reviews.fields.reviseCount") },
    rejectedCount: { type: "number", label: msg("reports:datasets.reviews.fields.rejectedCount") },
    targetFolder: { type: "string", label: msg("reports:datasets.reviews.fields.targetFolder") },
    gated: { type: "boolean", label: msg("reports:datasets.reviews.fields.gated"), description: msg("reports:datasets.reviews.hints.gated") },
    startedBy: { type: "string", label: msg("reports:datasets.reviews.fields.startedBy") },
    startedByCompany: { type: "string", label: msg("reports:datasets.reviews.fields.startedByCompany") },
    startedAt: { type: "date", label: msg("reports:datasets.reviews.fields.startedAt") },
    completedAt: { type: "date", label: msg("reports:datasets.reviews.fields.completedAt") },
  },
  async load(ctx) {
    const list = await visibleReviews(ctx);
    const ids = list.map((x) => x.r.id);
    const rfs = ids.length ? await ctx.db.select().from(reviewFiles).where(inArray(reviewFiles.reviewId, ids)) : [];
    const people = await ctx.people();
    await people.ensure(list.map((x) => x.r.createdBy));
    const tree = await ctx.tree();
    const folders = new Map<string, FolderInfo>();
    const gates = new Map<string, boolean>();
    for (const x of list) {
      const fid = x.r.targetFolderId;
      if (fid && tree.byId.has(fid) && !gates.has(fid)) gates.set(fid, (await folderGate(ctx.db, tree, fid)).gated);
    }
    return list.map(({ r, i }) => {
      const mine = rfs.filter((f) => f.reviewId === r.id);
      const running = i.status === "running";
      const step = i.template.steps[i.stepIndex];
      const fid = r.targetFolderId && tree.byId.has(r.targetFolderId) ? r.targetFolderId : null;
      const final = (codes: string[]) => mine.filter((f) => f.finalStatus && codes.includes(f.finalStatus)).length;
      return {
        number: r.number,
        name: r.name,
        code: r.code,
        workflow: i.template.name,
        status: i.status,
        isOpen: running,
        currentStep: running ? (step?.name ?? null) : null,
        stepNo: running ? i.stepIndex + 1 : null,
        stepCount: i.template.steps.length,
        stepDueAt: running ? iso(i.stepDueAt) : null,
        overdue: running && !!i.stepDueAt && i.stepDueAt < ctx.now,
        daysInStep: running ? days(i.stepStartedAt, ctx.now) : null,
        totalDays: days(i.createdAt, i.completedAt ?? ctx.now),
        fileCount: mine.length,
        approvedCount: final(["approved", "approved_with_comments", "reviewed"]),
        reviseCount: final(["revise_resubmit"]),
        rejectedCount: final(["rejected"]),
        targetFolder: fid ? folderInfo(tree, fid, folders).path : null,
        gated: fid ? (gates.get(fid) ?? false) : false,
        startedBy: people.name(r.createdBy),
        startedByCompany: people.company(r.createdBy),
        startedAt: iso(i.createdAt),
        completedAt: iso(i.completedAt),
      };
    });
  },
});

reportDatasets.register("review_files", {
  label: msg("reports:datasets.reviewFiles.label"),
  description: msg("reports:datasets.reviewFiles.description"),
  module: "reviews",
  sources: ["reviews", "workflow", "files"],
  fields: {
    review: { type: "number", label: msg("reports:datasets.reviewFiles.fields.review") },
    reviewName: { type: "string", label: msg("reports:datasets.reviewFiles.fields.reviewName") },
    reviewStatus: { type: "string", label: msg("reports:datasets.reviewFiles.fields.reviewStatus"), values: labelValues("workflowStatus", WORKFLOW_STATUS_LABELS_TR) },
    file: { type: "string", label: msg("reports:datasets.reviewFiles.fields.file") },
    extension: { type: "string", label: msg("reports:datasets.reviewFiles.fields.extension") },
    folderPath: { type: "string", label: msg("reports:datasets.reviewFiles.fields.folderPath") },
    version: { type: "number", label: msg("reports:datasets.reviewFiles.fields.version") },
    outcome: { type: "string", label: msg("reports:datasets.reviewFiles.fields.outcome"), values: labelValues("outcome", OUTCOME_LABELS_TR), description: msg("reports:datasets.reviewFiles.hints.outcome") },
    outcomeLabel: { type: "string", label: msg("reports:datasets.reviewFiles.fields.outcomeLabel"), description: msg("reports:datasets.reviewFiles.hints.outcomeLabel") },
    decided: { type: "boolean", label: msg("reports:datasets.reviewFiles.fields.decided") },
    decidedAt: { type: "date", label: msg("reports:datasets.reviewFiles.fields.decidedAt") },
    stoppedAtStep: { type: "number", label: msg("reports:datasets.reviewFiles.fields.stoppedAtStep"), description: msg("reports:datasets.reviewFiles.hints.stoppedAtStep") },
    copied: { type: "boolean", label: msg("reports:datasets.reviewFiles.fields.copied") },
  },
  async load(ctx) {
    const list = await visibleReviews(ctx);
    const ids = list.map((x) => x.r.id);
    if (!ids.length) return [];
    const rows = await ctx.db
      .select({ rf: reviewFiles, f: files, v: fileVersions })
      .from(reviewFiles)
      .innerJoin(files, eq(files.id, reviewFiles.fileId))
      .innerJoin(fileVersions, eq(fileVersions.id, reviewFiles.fileVersionId))
      .where(inArray(reviewFiles.reviewId, ids));
    const tree = await ctx.tree();
    const folders = new Map<string, FolderInfo>();
    const byId = new Map(list.map((x) => [x.r.id, x]));
    return rows.map(({ rf, f, v }) => {
      const x = byId.get(rf.reviewId)!;
      const src = tree.byId.has(rf.sourceFolderId) ? rf.sourceFolderId : tree.byId.has(f.folderId) ? f.folderId : null;
      return {
        review: x.r.number,
        reviewName: x.r.name,
        reviewStatus: x.i.status,
        file: f.name,
        extension: splitExtension(f.name).extension.toLowerCase(),
        folderPath: src ? folderInfo(tree, src, folders).path : null,
        version: v.version,
        outcome: rf.finalStatus,
        outcomeLabel: rf.finalLabel ?? (rf.finalStatus ? labelFor(ctx.lang, "outcome", rf.finalStatus) : null),
        decided: !!rf.finalStatus,
        decidedAt: iso(rf.decidedAt),
        stoppedAtStep: rf.stoppedAtStep === null ? null : rf.stoppedAtStep + 1,
        copied: !!rf.copiedVersionId,
      };
    });
  },
});

// ---- Workflow steps: "kim ne kadar bekletti" ------------------------------------------------------------

reportDatasets.register("workflow_steps", {
  label: msg("reports:datasets.workflowSteps.label"),
  description: msg("reports:datasets.workflowSteps.description"),
  module: "reviews",
  sources: ["workflow", "reviews", "works", "forms", "members"],
  fields: {
    subjectType: { type: "string", label: msg("reports:datasets.workflowSteps.fields.subjectType"), values: SUBJECT_VALUES },
    subject: { type: "string", label: msg("reports:datasets.workflowSteps.fields.subject"), description: msg("reports:datasets.workflowSteps.hints.subject") },
    workflow: { type: "string", label: msg("reports:datasets.workflowSteps.fields.workflow") },
    stepNo: { type: "number", label: msg("reports:datasets.workflowSteps.fields.stepNo"), description: msg("reports:datasets.workflowSteps.hints.stepNo") },
    stepName: { type: "string", label: msg("reports:datasets.workflowSteps.fields.stepName") },
    responsible: { type: "string", label: msg("reports:datasets.workflowSteps.fields.responsible"), description: msg("reports:datasets.workflowSteps.hints.responsible") },
    responsibleCompany: { type: "string", label: msg("reports:datasets.workflowSteps.fields.responsibleCompany") },
    status: { type: "string", label: msg("reports:datasets.workflowSteps.fields.status"), values: STEP_STATUS_VALUES },
    outcome: { type: "string", label: msg("reports:datasets.workflowSteps.fields.outcome"), values: labelValues("outcome", OUTCOME_LABELS_TR) },
    startedAt: { type: "date", label: msg("reports:datasets.workflowSteps.fields.startedAt") },
    endedAt: { type: "date", label: msg("reports:datasets.workflowSteps.fields.endedAt"), description: msg("reports:datasets.workflowSteps.hints.endedAt") },
    days: { type: "number", label: msg("reports:datasets.workflowSteps.fields.days"), description: msg("reports:datasets.workflowSteps.hints.days") },
    dueAt: { type: "date", label: msg("reports:datasets.workflowSteps.fields.dueAt") },
    late: { type: "boolean", label: msg("reports:datasets.workflowSteps.fields.late"), description: msg("reports:datasets.workflowSteps.hints.late") },
  },
  async load(ctx) {
    const pid = ctx.access.project.id;
    // Progress payment approvals are reported by the hakedisler dataset.
    const instances = await ctx.db
      .select()
      .from(workflowInstances)
      .where(and(eq(workflowInstances.projectId, pid), ne(workflowInstances.subjectType, "progress_payment")));
    if (!instances.length) return [];
    // Visible subjects, with the same rules as their lists.
    const reviewsSeen = new Map((await visibleReviews(ctx)).map((x) => [x.r.id, x.r]));
    const worksSeen = await workBase(ctx);
    const revIds = instances.filter((i) => i.subjectType === "work_revision").map((i) => i.subjectId);
    const revs = revIds.length ? await ctx.db.select({ id: workRevisions.id, workId: workRevisions.workId, rev: workRevisions.rev }).from(workRevisions).where(inArray(workRevisions.id, revIds)) : [];
    const workOfRev = new Map(revs.map((r) => [r.id, r]));
    const workById = new Map(worksSeen.map((b) => [b.w.id, b]));
    const formIds = instances.filter((i) => i.subjectType === "form").map((i) => i.subjectId);
    const formRows = formIds.length ? ((await capability("field.forms")?.list(ctx.db, { projectId: pid, ids: formIds })) ?? []) : [];
    const formById = new Map(formRows.map((f) => [f.id, f]));

    const subjectOf = (i: InstanceRow): { type: string; label: string } | null => {
      if (i.subjectType === SUBJECT_REVIEW) {
        const r = reviewsSeen.get(i.subjectId);
        return r ? { type: "review", label: `#${r.number} ${r.name}` } : null;
      }
      if (i.subjectType === "work_revision") {
        const rv = workOfRev.get(i.subjectId);
        const b = rv ? workById.get(rv.workId) : undefined;
        if (!b) return null;
        const type = b.t.category === "rfi" ? "rfi" : b.t.category === "submittal" ? "submittal" : "work";
        return { type, label: rv!.rev > 0 ? `${b.w.number} Rev ${rv!.rev}` : b.w.number };
      }
      if (i.subjectType === "form") {
        const f = formById.get(i.subjectId);
        return f ? { type: "form", label: f.number } : null;
      }
      return ctx.access.isProjectAdmin ? { type: "work", label: i.template.name } : null;
    };
    const shown = instances.map((i) => ({ i, s: subjectOf(i) })).filter((x): x is { i: InstanceRow; s: { type: string; label: string } } => !!x.s);
    if (!shown.length) return [];
    const actions = await ctx.db
      .select()
      .from(workflowActions)
      .where(inArray(workflowActions.instanceId, shown.map((x) => x.i.id)))
      .orderBy(asc(workflowActions.at));
    const roles = await ctx.db.select({ id: projectRoles.id, name: projectRoles.name }).from(projectRoles).where(eq(projectRoles.projectId, pid));
    const roleName = new Map(roles.map((r) => [r.id, r.name]));
    const people = await ctx.people();
    await people.ensure(shown.flatMap((x) => [x.i.startedBy, ...x.i.template.steps.flatMap((s) => s.assignees.filter((a) => a.type === "user").map((a) => a.id))]));

    const who = (step: WorkflowStep | undefined, startedBy: string) => {
      const names: string[] = [];
      let company: string | null = null;
      for (const a of step?.assignees ?? []) {
        if (a.type === "user") {
          names.push(people.name(a.id) ?? "?");
          company ??= people.company(a.id);
        } else if (a.type === "company") {
          const n = people.companyName(a.id);
          names.push(n ?? "?");
          company ??= n;
        } else if (a.id === "starter") {
          names.push(people.name(startedBy) ?? labelFor(ctx.lang, "workflowRole", "starter"));
          company ??= people.company(startedBy);
        } else names.push(a.id in WORKFLOW_ROLE_LABELS_TR ? labelFor(ctx.lang, "workflowRole", a.id) : roleName.get(a.id) ?? "?");
      }
      return { responsible: names.join(", ") || null, company };
    };

    const out: ReportRow[] = [];
    for (const { i, s } of shown) {
      const mine = actions.filter((x) => x.instanceId === i.id);
      const steps = i.template.steps;
      const row = (stepIndex: number, start: Date, end: Date | null, status: keyof typeof STEP_STATUS_VALUES, outcome: string | null) => {
        const step = steps[stepIndex];
        const due = step?.days ? new Date(start.getTime() + step.days * DAY_MS) : null;
        const w = who(step, i.startedBy);
        out.push({
          subjectType: s.type,
          subject: s.label,
          workflow: i.template.name,
          stepNo: stepIndex + 1,
          stepName: step?.name ?? null,
          responsible: w.responsible,
          responsibleCompany: w.company,
          status,
          outcome,
          startedAt: iso(start),
          endedAt: iso(end),
          days: days(start, end ?? ctx.now),
          dueAt: iso(status === "running" ? (i.stepDueAt ?? due) : due),
          late: (() => {
            const d = status === "running" ? (i.stepDueAt ?? due) : due;
            return !!d && (end ?? ctx.now) > d;
          })(),
        });
      };
      let cur = mine.find((x) => x.kind === "start")?.at ?? i.createdAt;
      for (const a of mine) {
        if (a.kind !== "step_completed") continue;
        row(a.stepIndex, cur, a.at, "done", a.outcome);
        cur = a.at;
      }
      if (i.status === "running") row(i.stepIndex, i.stepStartedAt > cur ? i.stepStartedAt : cur, null, "running", null);
      else if (i.status === "cancelled") {
        const c = mine.find((x) => x.kind === "cancel");
        row(i.stepIndex, cur, c?.at ?? i.completedAt ?? i.updatedAt, "cancelled", null);
      }
    }
    return out;
  },
});

// ---- Locations ---------------------------------------------------------------------------------------------

reportDatasets.register("locations", {
  label: msg("reports:datasets.locations.label"),
  description: msg("reports:datasets.locations.description"),
  module: "locations",
  sources: ["locations", "forms", "issues"],
  fields: {
    name: { type: "string", label: msg("reports:datasets.locations.fields.name") },
    code: { type: "string", label: msg("reports:datasets.locations.fields.code") },
    type: { type: "string", label: msg("reports:datasets.locations.fields.type"), description: msg("reports:datasets.locations.hints.type") },
    path: { type: "string", label: msg("reports:datasets.locations.fields.path") },
    level: { type: "number", label: msg("reports:datasets.locations.fields.level"), description: msg("reports:datasets.locations.hints.level") },
    parent: { type: "string", label: msg("reports:datasets.locations.fields.parent") },
    kmStart: { type: "number", label: msg("reports:datasets.locations.fields.kmStart") },
    kmEnd: { type: "number", label: msg("reports:datasets.locations.fields.kmEnd") },
    formCount: { type: "number", label: msg("reports:datasets.locations.fields.formCount") },
    openFormCount: { type: "number", label: msg("reports:datasets.locations.fields.openFormCount") },
    failedItemCount: { type: "number", label: msg("reports:datasets.locations.fields.failedItemCount"), description: msg("reports:datasets.locations.hints.failedItemCount") },
    issueCount: { type: "number", label: msg("reports:datasets.locations.fields.issueCount") },
    openIssueCount: { type: "number", label: msg("reports:datasets.locations.fields.openIssueCount") },
  },
  async load(ctx) {
    const pid = ctx.access.project.id;
    const rows = await ctx.db.select().from(locations).where(eq(locations.projectId, pid));
    if (!rows.length) return [];
    const byId = new Map(rows.map((r) => [r.id, r]));
    const paths = await locationPaths(ctx.db, pid);
    const links = await ctx.db.select().from(locationLinks).where(eq(locationLinks.projectId, pid));
    const formRows = ((await capability("field.forms")?.list(ctx.db, { projectId: pid })) ?? []).map((f) => ({ id: f.id, status: f.status, failed: f.failedCount }));
    const issueRows = await ctx.db.select({ id: issues.id, status: issues.status }).from(issues).where(eq(issues.projectId, pid));
    const formById = new Map(formRows.map((f) => [f.id, f]));
    const issueById = new Map(issueRows.map((i) => [i.id, i]));
    const level = (id: string) => {
      let n = 0;
      for (let cur = byId.get(id); cur && n < 50; cur = cur.parentId ? byId.get(cur.parentId) : undefined) n++;
      return n;
    };
    return rows.map((l) => {
      const mine = links.filter((x) => x.locationId === l.id);
      const fs = mine.filter((x) => x.kind === "form").map((x) => formById.get(x.targetId)).filter((x) => !!x);
      const is = mine.filter((x) => x.kind === "issue").map((x) => issueById.get(x.targetId)).filter((x) => !!x);
      return {
        name: l.name,
        code: l.code,
        type: l.type,
        path: paths.get(l.id) ?? l.name,
        level: level(l.id),
        parent: l.parentId ? (byId.get(l.parentId)?.name ?? null) : null,
        kmStart: l.kmStart,
        kmEnd: l.kmEnd,
        formCount: fs.length,
        openFormCount: fs.filter((f) => f!.status !== "closed").length,
        failedItemCount: fs.reduce((a, f) => a + (f!.failed ?? 0), 0),
        issueCount: is.length,
        openIssueCount: is.filter((i) => i!.status !== "closed").length,
      };
    });
  },
});

// ---- Document comparisons -------------------------------------------------------------------------------------------

reportDatasets.register("doc_comparisons", {
  label: msg("reports:datasets.docComparisons.label"),
  description: msg("reports:datasets.docComparisons.description"),
  module: "doccompare",
  sources: ["doccompare", "files"],
  fields: {
    file: { type: "string", label: msg("reports:datasets.docComparisons.fields.file") },
    extension: { type: "string", label: msg("reports:datasets.docComparisons.fields.extension") },
    folderPath: { type: "string", label: msg("reports:datasets.docComparisons.fields.folderPath") },
    fromVersion: { type: "number", label: msg("reports:datasets.docComparisons.fields.fromVersion") },
    toVersion: { type: "number", label: msg("reports:datasets.docComparisons.fields.toVersion") },
    fromRevision: { type: "string", label: msg("reports:datasets.docComparisons.fields.fromRevision") },
    toRevision: { type: "string", label: msg("reports:datasets.docComparisons.fields.toRevision") },
    status: { type: "string", label: msg("reports:datasets.docComparisons.fields.status"), values: COMPARE_STATUS_VALUES },
    identical: { type: "boolean", label: msg("reports:datasets.docComparisons.fields.identical") },
    contentChanged: { type: "boolean", label: msg("reports:datasets.docComparisons.fields.contentChanged"), description: msg("reports:datasets.docComparisons.hints.contentChanged") },
    pagesChanged: { type: "number", label: msg("reports:datasets.docComparisons.fields.pagesChanged") },
    added: { type: "number", label: msg("reports:datasets.docComparisons.fields.added") },
    removed: { type: "number", label: msg("reports:datasets.docComparisons.fields.removed") },
    changed: { type: "number", label: msg("reports:datasets.docComparisons.fields.changed") },
    antetChanges: { type: "number", label: msg("reports:datasets.docComparisons.fields.antetChanges"), description: msg("reports:datasets.docComparisons.hints.antetChanges") },
    warningCount: { type: "number", label: msg("reports:datasets.docComparisons.fields.warningCount"), description: msg("reports:datasets.docComparisons.hints.warningCount") },
    hasWarnings: { type: "boolean", label: msg("reports:datasets.docComparisons.fields.hasWarnings") },
    warnings: { type: "string", label: msg("reports:datasets.docComparisons.fields.warnings") },
    createdBy: { type: "string", label: msg("reports:datasets.docComparisons.fields.createdBy") },
    createdAt: { type: "date", label: msg("reports:datasets.docComparisons.fields.createdAt") },
  },
  async load(ctx) {
    const pid = ctx.access.project.id;
    const rows = await ctx.db.select().from(docComparisons).where(eq(docComparisons.projectId, pid));
    if (!rows.length) return [];
    const vids = [...new Set(rows.flatMap((r) => [r.fromVersionId, r.toVersionId]))];
    const vs = await ctx.db
      .select({ v: fileVersions, f: files })
      .from(fileVersions)
      .innerJoin(files, eq(files.id, fileVersions.fileId))
      .where(and(inArray(fileVersions.id, vids), eq(files.projectId, pid), isNull(files.deletedAt)));
    const byVid = new Map(vs.map((x) => [x.v.id, x]));
    const tree = await ctx.tree();
    const visible = fileVisibility(tree, ctx.access);
    const folders = new Map<string, FolderInfo>();
    const people = await ctx.people();
    await people.ensure(rows.map((r) => r.createdBy));
    const out: ReportRow[] = [];
    for (const r of rows) {
      const a = byVid.get(r.fromVersionId);
      const b = byVid.get(r.toVersionId);
      if (!a || !b || !visible(a.f) || !visible(b.f)) continue;
      const res = r.result;
      const flags = res ? compareFlags(res, r.regions ?? null).filter((f) => f.severity === "warn") : [];
      out.push({
        file: b.f.name,
        extension: splitExtension(b.f.name).extension.toLowerCase(),
        folderPath: folderInfo(tree, b.f.folderId, folders).path,
        fromVersion: a.v.version,
        toVersion: b.v.version,
        fromRevision: res?.revisionA ?? null,
        toRevision: res?.revisionB ?? null,
        status: r.status,
        identical: res ? res.identical : null,
        contentChanged: res ? res.contentChanged : null,
        pagesChanged: res?.totals.pages ?? null,
        added: res?.totals.added ?? null,
        removed: res?.totals.removed ?? null,
        changed: res?.totals.changed ?? null,
        antetChanges: res ? res.antet.length : null,
        warningCount: flags.length,
        hasWarnings: flags.length > 0,
        warnings: flags.map((f) => f.message).join(" · ") || null,
        createdBy: people.name(r.createdBy),
        createdAt: iso(r.createdAt),
      });
    }
    return out;
  },
});

// ---- Specification registers --------------------------------------------------------------------------------------------

reportDatasets.register("spec_registers", {
  label: msg("reports:datasets.specRegisters.label"),
  description: msg("reports:datasets.specRegisters.description"),
  module: "spec",
  sources: ["docintel", "files"],
  fields: {
    file: { type: "string", label: msg("reports:datasets.specRegisters.fields.file") },
    version: { type: "number", label: msg("reports:datasets.specRegisters.fields.version") },
    sectionCode: { type: "string", label: msg("reports:datasets.specRegisters.fields.sectionCode") },
    sectionTitle: { type: "string", label: msg("reports:datasets.specRegisters.fields.sectionTitle") },
    description: { type: "string", label: msg("reports:datasets.specRegisters.fields.description"), description: msg("reports:datasets.specRegisters.hints.description") },
    kind: { type: "string", label: msg("reports:datasets.specRegisters.fields.kind"), values: KIND_VALUES },
    discipline: { type: "string", label: msg("reports:datasets.specRegisters.fields.discipline") },
    page: { type: "number", label: msg("reports:datasets.specRegisters.fields.page") },
    excluded: { type: "boolean", label: msg("reports:datasets.specRegisters.fields.excluded") },
    usedAi: { type: "boolean", label: msg("reports:datasets.specRegisters.fields.usedAi") },
    updatedAt: { type: "date", label: msg("reports:datasets.specRegisters.fields.updatedAt") },
  },
  async load(ctx) {
    const pid = ctx.access.project.id;
    const regs = await ctx.db
      .select({ r: specRegisters, v: fileVersions, f: files })
      .from(specRegisters)
      .innerJoin(fileVersions, eq(fileVersions.id, specRegisters.versionId))
      .innerJoin(files, eq(files.id, fileVersions.fileId))
      .where(and(eq(specRegisters.projectId, pid), isNull(files.deletedAt)));
    const tree = await ctx.tree();
    const visible = fileVisibility(tree, ctx.access);
    const out: ReportRow[] = [];
    for (const { r, v, f } of regs) {
      if (!visible(f)) continue;
      for (const it of r.items) {
        out.push({
          file: f.name,
          version: v.version,
          sectionCode: it.sectionCode ?? null,
          sectionTitle: it.sectionTitle ?? null,
          description: it.description,
          kind: it.type ? it.type.toLocaleUpperCase("tr-TR") : null,
          discipline: it.discipline ?? null,
          page: it.page ?? null,
          excluded: !!it.excluded,
          usedAi: r.usedAi,
          updatedAt: iso(r.updatedAt),
        });
      }
    }
    return out;
  },
});

/** "today" of a report context (exported for tests). */
export const reportToday = (ctx: Pick<ReportContext, "now" | "timeZone">) => dayKey(ctx.now, ctx.timeZone)!;
