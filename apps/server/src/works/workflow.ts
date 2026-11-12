/**
 * Works that drive their own workflow (RFI, submittal item, any type with a default workflow
 * template): submit → workflow instance on a work revision → reviewers answer with an outcome,
 * a comment and (RFI) the official response → the final outcome kind sets the work status.
 *
 * Reuses the engine (assignees, roles, on-behalf, step rules), chain helpers (custom outcomes,
 * stages, deadlines) and the service helpers (members, notifications, events). Answers are stored
 * as workflow_actions ("submit"), so no extra marks table is needed.
 */
import { and, asc, desc, eq, inArray, isNotNull, lte } from "drizzle-orm";
import {
  OUTCOME_CODE_KIND,
  OUTCOME_KIND_CODE,
  RFI_ANSWER_OPTIONS,
  SUBMITTAL_ANSWER_OPTIONS,
  WORKFLOW_ROLE_LABELS_TR,
  allowedWorkOptions,
  isApprovedOutcome,
  baseCodesOf,
  foldToken,
  listCode,
  resolveAttributeAssignees,
  rollupPackageStatus,
  stepOutcomeOptions,
  type OutcomeCode,
  type OutcomeKind,
  type OutcomeOption,
  type WorkAnswerDto,
  type WorkCategory,
  type WorkFlowDto,
  type WorkFlowStepDto,
  type WorkRevisionDto,
  type WorkflowAssignee,
  type WorkflowKind,
  type WorkflowStep,
  resolveModules,
} from "@sitekeep/shared";
import type { ProjectAccess } from "../core/security/access.js";
import { audit } from "../core/platform/audit.js";
import type { Db } from "../db/index.js";
import {
  companies,
  fileVersions,
  files,
  projectMembers as projectMemberRowsTable,
  projectRoles,
  projects,
  users,
  workflowTemplateWorkOptions,
  workLinks,
  workRevisions,
  workTypes,
  workflowActions,
  workflowInstances,
  workflowReminders,
  workflowTemplates,
  works,
  type TemplateSnapshot,
} from "../db/schema.js";
import { badRequest, conflict, forbidden, notFound } from "../core/platform/http.js";
import { DEFAULT_LANGUAGE, intlLocale, labelFor, msg, profileLanguage, tFor } from "../i18n/index.js";
import { advance, isAssignee, isStepComplete, onBehalfOf, type ActorContext } from "../workflow/engine.js";
import { combineChainOutcomes, enterStep, finalLabelOf, type ChainSubmission } from "../workflow/chain.js";
import {
  actorFor,
  emitWorkflowEvent,
  memberWithRoles,
  notify,
  projectMemberRows,
  resolveAssigneeUsers,
  withRoleIds,
  type Member,
} from "../workflow/service.js";
import { SUBJECT_WORK_REVISION } from "./participants.js";
import {
  addDaysIso,
  addEvent,
  cancelLetter,
  createWork,
  isClosed,
  projectTypes,
  requireEdit,
  sendWork,
  statusDef,
  todayIso,
  workLink,
  type TypeRow,
  type WorkRow,
  type WorksCtx,
} from "./service.js";

export type RevisionRow = typeof workRevisions.$inferSelect;
type InstanceRow = typeof workflowInstances.$inferSelect;
type ActionRow = typeof workflowActions.$inferSelect;

/** Single item key used for the engine's per-item outcome maps. */
const ITEM = "work";

/** Categories whose works run a workflow even without a default template (one-step answer). */
const FLOW_CATEGORIES = new Set<WorkCategory>(["rfi", "submittal"]);
/** Categories that never run a workflow themselves. */
const NO_FLOW_CATEGORIES = new Set<WorkCategory>(["submittal_package", "meeting", "action", "transmittal", "correspondence"]);

export function runsWorkflow(type: TypeRow): boolean {
  if (NO_FLOW_CATEGORIES.has(type.category)) return false;
  return FLOW_CATEGORIES.has(type.category) || !!type.defaultWorkflowTemplateId;
}

function workflowKind(category: WorkCategory): WorkflowKind {
  return category === "rfi" ? "rfi" : category === "submittal" ? "submittal" : "review";
}

const DEFAULT_OUTCOME_STATUS: Record<OutcomeKind, string> = {
  approved: "kapandi",
  approved_with_comments: "kapandi",
  info: "kapandi",
  revise: "taslak",
  rejected: "kapandi",
};

function outcomeStatus(type: TypeRow, kind: OutcomeKind): string {
  const want = type.settings.outcomeStatus?.[kind] ?? DEFAULT_OUTCOME_STATUS[kind];
  if (type.statuses.some((s) => s.key === want)) return want;
  return type.statuses.find((s) => s.closed)?.key ?? want;
}

function submittedStatus(type: TypeRow): string {
  const want = type.settings.submittedStatus ?? (type.category === "rfi" ? "acik" : "incelemede");
  if (type.statuses.some((s) => s.key === want)) return want;
  return type.statuses.find((s) => s.key !== "taslak" && !s.closed)?.key ?? "acik";
}

// ---- Template -----------------------------------------------------------------------------------

/** One-step answer by the action recipients (or the assignee) when the type has no template. */
function syntheticTemplate(work: WorkRow, type: TypeRow): TemplateSnapshot | null {
  const assignees: WorkflowAssignee[] = work.toCompanyIds.map((id) => ({ type: "company" as const, id }));
  if (work.assigneeUserId) assignees.push({ type: "user", id: work.assigneeUserId });
  if (!assignees.length) return null;
  const options = type.category === "rfi" ? RFI_ANSWER_OPTIONS : SUBMITTAL_ANSWER_OPTIONS;
  return {
    templateId: null,
    name: type.category === "rfi" ? "Bilgi Talebi Cevabı" : "İnceleme", // i18n-ok: template name stored in the snapshot
    steps: [
      {
        name: type.category === "rfi" ? "Cevap" : "İnceleme", // i18n-ok: step name stored in the snapshot
        assignees,
        rule: "any",
        days: type.settings.dueDays ?? 0,
        outcomes: baseCodesOf(options),
        outcomeOptions: options,
      },
    ],
    finalOutcomes: {},
  };
}

/** "by_attribute" rules read the work's fields (key or label; list values also by code). */
export function resolveWorkSteps(
  steps: readonly WorkflowStep[],
  type: TypeRow,
  work: WorkRow,
  lang: string = DEFAULT_LANGUAGE,
): { steps: WorkflowStep[]; problems: string[] } {
  const t = tFor(lang);
  const problems: string[] = [];
  const out = steps.map((step) => {
    const rule = step.assigneeRule;
    let resolved = step;
    if (rule) {
      const def = type.fields.find((f) => foldToken(f.key) === foldToken(rule.attribute) || foldToken(f.label) === foldToken(rule.attribute));
      const raw = def ? work.fields[def.key] : undefined;
      const value = raw === undefined || raw === null ? "" : String(raw);
      const list = resolveAttributeAssignees(rule, value) ?? (value ? resolveAttributeAssignees(rule, listCode(value)) : null);
      if (!list)
        problems.push(
          value
            ? t("works:errors.attributeUnmappedValue", { step: step.name, attribute: rule.attribute, value })
            : t("works:errors.attributeUnmapped", { step: step.name, attribute: rule.attribute }),
        );
      else {
        const seen = new Set(step.assignees.map((x) => `${x.type}:${x.id}`));
        resolved = {
          ...step,
          assignees: [...step.assignees, ...list.filter((x) => !seen.has(`${x.type}:${x.id}`))],
          resolvedBy: { attribute: rule.attribute, values: [value || "—"] },
        };
      }
    }
    if (!resolved.assignees.length && !problems.length) problems.push(t("works:errors.stepNoAssignee", { step: step.name }));
    return resolved;
  });
  return { steps: out, problems };
}

async function snapshotFor(db: Db, work: WorkRow, type: TypeRow, lang: string = DEFAULT_LANGUAGE): Promise<TemplateSnapshot> {
  if (type.defaultWorkflowTemplateId) {
    const [t] = await db.select().from(workflowTemplates).where(eq(workflowTemplates.id, type.defaultWorkflowTemplateId));
    if (t && !t.archivedAt) {
      const r = resolveWorkSteps(t.steps, type, work, lang);
      if (r.problems.length) throw badRequest(r.problems.join(" "), r.problems);
      return { templateId: t.id, name: t.name, steps: r.steps, finalOutcomes: t.finalOutcomes, chain: t.chainConfig };
    }
  }
  const s = syntheticTemplate(work, type);
  if (!s) throw badRequest(msg("works:errors.noDefaultWorkflow"));
  return s;
}

// ---- Queries ------------------------------------------------------------------------------------

export async function revisionsOf(db: Db, workId: string): Promise<RevisionRow[]> {
  return db.select().from(workRevisions).where(eq(workRevisions.workId, workId)).orderBy(asc(workRevisions.rev));
}

async function attachmentsOf(db: Db, workId: string) {
  const links = await db
    .select({ v: fileVersions, f: files })
    .from(workLinks)
    .innerJoin(fileVersions, eq(fileVersions.id, workLinks.targetId))
    .innerJoin(files, eq(files.id, fileVersions.fileId))
    .where(and(eq(workLinks.workId, workId), eq(workLinks.kind, "file_version"), eq(workLinks.role, "ek")));
  return links.map((l) => ({ versionId: l.v.id, name: l.f.name, version: l.v.version }));
}

/** Answers given in a step, oldest first, as engine submissions. */
async function stepSubmissions(tx: Db, projectId: string, instance: InstanceRow): Promise<ChainSubmission[]> {
  const acts = await tx
    .select()
    .from(workflowActions)
    .where(
      and(
        eq(workflowActions.instanceId, instance.id),
        eq(workflowActions.stepIndex, instance.stepIndex),
        eq(workflowActions.kind, "submit"),
      ),
    )
    .orderBy(asc(workflowActions.at));
  const ids = [...new Set(acts.map((x) => x.userId).filter((x): x is string => !!x))];
  if (!ids.length) return [];
  const userRows = await tx.select().from(users).where(inArray(users.id, ids));
  const memberRows = await withRoleIds(
    tx,
    await tx.select().from(projectMemberRowsTable).where(and(eq(projectMemberRowsTable.projectId, projectId), inArray(projectMemberRowsTable.userId, ids))),
  );
  return acts
    .filter((x) => x.userId && x.outcome)
    .map((x) => {
      const u = userRows.find((r) => r.id === x.userId)!;
      const m = memberRows.find((r) => r.userId === x.userId);
      const code = String((x.details as { code?: string } | null)?.code ?? x.outcome);
      return { actor: actorFor(u, m, instance.startedBy), outcomes: { [ITEM]: x.outcome! }, codes: { [ITEM]: code } };
    });
}

// ---- Submit -------------------------------------------------------------------------------------

export interface FlowCtx {
  db: Db;
}

/**
 * Starts the work's workflow: a new revision (0, 1, 2…) with its own workflow instance. A
 * package submits its draft items instead.
 */
export async function submitWork(db: Db, a: ProjectAccess, work: WorkRow, type: TypeRow, comment: string | null): Promise<void> {
  requireEdit(work, a);
  if (type.category === "submittal_package") {
    const items = await db
      .select({ w: works, t: workTypes })
      .from(works)
      .innerJoin(workTypes, eq(workTypes.id, works.typeId))
      .where(eq(works.parentWorkId, work.id));
    const ready = items.filter((x) => (x.w.status === "taslak" || x.w.status === "revize") && runsWorkflow(x.t));
    if (!ready.length) throw badRequest(msg("works:errors.packageNoDraftItems"));
    for (const x of ready) await submitWork(db, a, x.w, x.t, comment);
    await addEvent(db, work.id, "submitted", a.user.id, `${ready.length} kalem onaya gönderildi` /* i18n-ok: event message stored as data */, { items: ready.map((x) => x.w.id) });
    return;
  }
  if (!runsWorkflow(type)) throw badRequest(msg("works:errors.typeNotSubmitted"));
  if (work.status !== "taslak" && work.status !== "revize") throw conflict(msg("works:errors.onlyDraftOrReviseSubmitted"));
  const revs = await revisionsOf(db, work.id);
  const last = revs.at(-1);
  if (last?.status === "running") throw conflict(msg("works:errors.workflowRunning"));
  const snapshot = await snapshotFor(db, work, type, profileLanguage(a.user));
  const rev = last ? last.rev + 1 : 0;
  const attachments = await attachmentsOf(db, work.id);
  const now = new Date();
  const due = enterStep(snapshot, null, 0, now, null);
  const status = submittedStatus(type);
  const dueDays = type.settings.dueDays ?? 0;
  const dueDate = dueDays > 0 && (rev > 0 || !work.dueDate) ? addDaysIso(todayIso(now), dueDays) : work.dueDate;

  const { revision, instance } = await db.transaction(async (tx) => {
    const [revision] = await tx
      .insert(workRevisions)
      .values({ workId: work.id, rev, fields: work.fields, attachments, comment, submittedBy: a.user.id, submittedAt: now })
      .returning();
    const [instance] = await tx
      .insert(workflowInstances)
      .values({
        projectId: a.project.id,
        kind: workflowKind(type.category),
        templateId: snapshot.templateId,
        template: snapshot,
        subjectType: SUBJECT_WORK_REVISION,
        subjectId: revision!.id,
        stepIndex: 0,
        status: "running",
        stepStartedAt: now,
        stepDueAt: due.stepDueAt,
        stageDueAt: due.stageDueAt,
        startedBy: a.user.id,
      })
      .returning();
    await tx.update(workRevisions).set({ workflowInstanceId: instance!.id }).where(eq(workRevisions.id, revision!.id));
    await tx.insert(workflowActions).values({
      instanceId: instance!.id,
      stepIndex: 0,
      kind: "start",
      userId: a.user.id,
      comment,
      details: { workId: work.id, rev, template: snapshot.name },
      at: now,
    });
    const [updated] = await tx
      .update(works)
      .set({
        status,
        workflowInstanceId: instance!.id,
        sentAt: work.sentAt ?? now,
        dueDate,
        data: { ...work.data, rev },
        closedAt: null,
        updatedAt: now,
      })
      .where(and(eq(works.id, work.id), inArray(works.status, ["taslak", "revize"])))
      .returning();
    if (!updated) throw conflict(msg("works:errors.changedMeanwhile"));
    return { revision: revision!, instance: instance! };
  });
  await addEvent(db, work.id, "submitted", a.user.id, comment, { rev, template: snapshot.name, revisionId: revision.id });
  await audit(db, {
    projectId: a.project.id,
    userId: a.user.id,
    action: "work.submitted",
    targetType: "work",
    targetId: work.id,
    details: { number: work.number, rev, template: snapshot.name },
  });
  await notifyStep(db, work, instance);
  if (work.parentWorkId) await rollupParent(db, work.parentWorkId, a.user.id);
}

async function notifyStep(db: Db, work: WorkRow, instance: InstanceRow) {
  const step = instance.template.steps[instance.stepIndex]!;
  const members = await projectMemberRows(db, work.projectId);
  await notify(db, resolveAssigneeUsers(step.assignees, members, instance.startedBy), {
    projectId: work.projectId,
    kind: "work.assigned",
    title: msg("works:notifications.stepAssigned", { number: work.number, title: work.title, step: step.name }),
    body: instance.stepDueAt
      ? msg("works:notifications.due", { date: instance.stepDueAt.toLocaleDateString(intlLocale(DEFAULT_LANGUAGE)) })
      : null,
    link: workLink(work.projectId, work.id),
  });
}

// ---- Respond ------------------------------------------------------------------------------------

export interface RespondInput {
  outcome: string;
  comment?: string | null;
  /** Official response (required for RFI answers). */
  response?: string | null;
}

function stopsWork(t: TemplateSnapshot, stepIndex: number, base: OutcomeCode): boolean {
  if (base !== "revise_resubmit" && base !== "rejected") return false;
  const stages = t.chain?.stages;
  const stage = stages?.length ? stages[t.steps[stepIndex]?.stage ?? 0] : undefined;
  // Works go back to the submitter on revise / reject unless the stage says "continue".
  return stage?.onRevise !== "continue";
}

async function runningRevision(db: Db, workId: string): Promise<RevisionRow | undefined> {
  const [r] = await db
    .select()
    .from(workRevisions)
    .where(and(eq(workRevisions.workId, workId), eq(workRevisions.status, "running")))
    .orderBy(desc(workRevisions.rev))
    .limit(1);
  return r;
}

/** `lang`: language of the default outcome labels (stored with an answer: the installation's). */
export function optionsFor(step: WorkflowStep, type: TypeRow, work: WorkRow, lang: string = DEFAULT_LANGUAGE): OutcomeOption[] {
  return allowedWorkOptions(stepOutcomeOptions(step, lang), type.category, work.fields);
}

/** A reviewer answers the current step; completes / advances / finishes the workflow. */
export async function respondWork(db: Db, a: ProjectAccess, work: WorkRow, type: TypeRow, input: RespondInput): Promise<void> {
  const revision = await runningRevision(db, work.id);
  if (!revision?.workflowInstanceId) throw conflict(msg("works:errors.noRunningWorkflow"));
  const comment = input.comment?.trim() || null;
  const response = input.response?.trim() || null;
  const result = await db.transaction(async (tx) => {
    const [instance] = await tx
      .select()
      .from(workflowInstances)
      .where(eq(workflowInstances.id, revision.workflowInstanceId!))
      .for("update");
    if (!instance || instance.status !== "running") throw conflict(msg("works:errors.workflowNotOpen"));
    const step = instance.template.steps[instance.stepIndex]!;
    const member = await memberWithRoles(tx, a.project.id, a.user.id);
    const actor = actorFor(a.user, member, instance.startedBy);
    if (!isAssignee(step, actor)) throw forbidden(msg("works:errors.stepNotAssigned"));
    const [already] = await tx
      .select({ id: workflowActions.id })
      .from(workflowActions)
      .where(
        and(
          eq(workflowActions.instanceId, instance.id),
          eq(workflowActions.stepIndex, instance.stepIndex),
          eq(workflowActions.kind, "submit"),
          eq(workflowActions.userId, a.user.id),
        ),
      );
    if (already) throw conflict(msg("works:errors.stepAlreadyAnswered"));
    const opt = optionsFor(step, type, work).find((o) => o.code === input.outcome);
    if (!opt) throw badRequest(msg("works:errors.outcomeNotAllowed", { outcome: input.outcome }));
    if (type.category === "rfi" && (opt.kind === "approved" || opt.kind === "approved_with_comments" || opt.kind === "info") && !response)
      throw badRequest(msg("works:errors.rfiResponseRequired"));
    const base = OUTCOME_KIND_CODE[opt.kind];
    const behalf = onBehalfOf(step, actor);
    const now = new Date();
    await tx.insert(workflowActions).values({
      instanceId: instance.id,
      stepIndex: instance.stepIndex,
      kind: "submit",
      userId: a.user.id,
      outcome: base,
      comment,
      details: { code: opt.code, label: opt.label, response, ...(behalf.length ? { onBehalfOf: behalf } : {}) },
      at: now,
    });

    const subs = await stepSubmissions(tx, a.project.id, instance);
    if (!isStepComplete(step, subs)) return { finished: false, moved: false, instance, label: opt.label };
    const combined = combineChainOutcomes(step, subs)[ITEM]!;
    await tx.insert(workflowActions).values({
      instanceId: instance.id,
      stepIndex: instance.stepIndex,
      kind: "step_completed",
      userId: null,
      details: { result: combined.base, code: combined.code, by: a.user.id },
      at: now,
    });
    const tpl = instance.template;
    const next = advance(tpl.steps, instance.stepIndex, true);
    if (next.status === "running" && !stopsWork(tpl, instance.stepIndex, combined.base)) {
      const due = enterStep(tpl, instance.stepIndex, next.stepIndex, now, instance.stageDueAt ?? null);
      const [moved] = await tx
        .update(workflowInstances)
        .set({ stepIndex: next.stepIndex, stepStartedAt: now, stepDueAt: due.stepDueAt, stageDueAt: due.stageDueAt, updatedAt: now })
        .where(eq(workflowInstances.id, instance.id))
        .returning();
      return { finished: false, moved: true, instance: moved!, label: opt.label };
    }

    // Finished: final outcome → revision decided, work status from the outcome kind.
    const final: OutcomeCode = tpl.finalOutcomes[combined.base] ?? combined.base;
    const stepDef = tpl.steps[instance.stepIndex]!;
    const label =
      finalLabelOf(tpl, instance.stepIndex, combined.code, combined.base, final) ??
      (final === combined.base ? stepOutcomeOptions(stepDef, DEFAULT_LANGUAGE).find((o) => o.code === combined.code)?.label : null) ??
      (final === "reviewed" && type.category === "submittal" ? "Görüldü" : labelFor(DEFAULT_LANGUAGE, "outcome", final)); // i18n-ok: outcome label stored as data
    const answers = await tx
      .select()
      .from(workflowActions)
      .where(and(eq(workflowActions.instanceId, instance.id), eq(workflowActions.kind, "submit")))
      .orderBy(asc(workflowActions.at));
    const official =
      [...answers].reverse().map((x) => (x.details as { response?: string | null } | null)?.response).find((x) => !!x) ?? null;
    const [done] = await tx
      .update(workflowInstances)
      .set({ status: "completed", completedAt: now, stepDueAt: null, stageDueAt: null, updatedAt: now })
      .where(eq(workflowInstances.id, instance.id))
      .returning();
    await tx.insert(workflowActions).values({
      instanceId: instance.id,
      stepIndex: instance.stepIndex,
      kind: "completed",
      userId: null,
      details: { final, code: combined.code, label },
      at: now,
    });
    await tx
      .update(workRevisions)
      .set({ status: "decided", outcome: final, outcomeCode: combined.code, outcomeLabel: label, response: official, decidedAt: now })
      .where(eq(workRevisions.id, revision.id));
    const status = outcomeStatus(type, OUTCOME_CODE_KIND[final]);
    const fields =
      official && type.fields.some((f) => f.key === "resmi_cevap") ? { ...work.fields, resmi_cevap: official } : work.fields;
    await tx
      .update(works)
      .set({ status, fields, closedAt: isClosed(type, status) ? now : null, updatedAt: now })
      .where(eq(works.id, work.id));
    return { finished: true, moved: true, instance: done!, label, final, status };
  });

  await addEvent(db, work.id, "responded", a.user.id, comment, { label: result.label, rev: revision.rev, ...(response ? { response } : {}) });
  await audit(db, {
    projectId: a.project.id,
    userId: a.user.id,
    action: "work.responded",
    targetType: "work",
    targetId: work.id,
    details: { number: work.number, rev: revision.rev, outcome: input.outcome },
  });
  const link = workLink(work.projectId, work.id);
  if (result.finished) {
    await addEvent(db, work.id, "decided", null, result.label, { rev: revision.rev, outcome: result.final, status: result.status });
    const actors = await db
      .select({ userId: workflowActions.userId })
      .from(workflowActions)
      .where(and(eq(workflowActions.instanceId, result.instance.id), eq(workflowActions.kind, "submit")));
    await notify(
      db,
      [work.createdBy, ...(work.assigneeUserId ? [work.assigneeUserId] : []), ...actors.map((x) => x.userId!).filter(Boolean)].filter(
        (u) => u !== a.user.id,
      ),
      { projectId: work.projectId, kind: "work.decided", title: `${work.number} "${work.title}": ${result.label}`, link },
    );
    await emitWorkflowEvent(db, {
      type: "completed",
      kind: result.instance.kind,
      projectId: work.projectId,
      subjectType: SUBJECT_WORK_REVISION,
      subjectId: revision.id,
      instanceId: result.instance.id,
      templateId: result.instance.templateId,
      actorId: a.user.id,
    });
    if (work.parentWorkId) await rollupParent(db, work.parentWorkId, a.user.id);
  } else if (result.moved) {
    await notifyStep(db, work, result.instance);
  }
}

// ---- Revise / cancel ----------------------------------------------------------------------------

/** "Revize et": opens the next revision of the same work (status back to taslak, history kept). */
export async function reviseWork(db: Db, a: ProjectAccess, work: WorkRow, type: TypeRow): Promise<void> {
  requireEdit(work, a);
  const revs = await revisionsOf(db, work.id);
  const last = revs.at(-1);
  if (!last || last.status !== "decided" || (last.outcome !== "revise_resubmit" && last.outcome !== "rejected"))
    throw conflict(msg("works:errors.reviseNotAllowed"));
  if (!type.statuses.some((s) => s.key === "taslak")) throw badRequest(msg("works:errors.noDraftStatus"));
  const rev = last.rev + 1;
  const [updated] = await db
    .update(works)
    .set({ status: "taslak", data: { ...work.data, rev }, closedAt: null, updatedAt: new Date() })
    .where(and(eq(works.id, work.id), eq(works.status, work.status)))
    .returning();
  if (!updated) throw conflict(msg("works:errors.changedMeanwhile"));
  await addEvent(db, work.id, "revised", a.user.id, `Rev ${rev} hazırlanıyor` /* i18n-ok: event message stored as data */, { rev, from: work.status });
  if (work.parentWorkId) await rollupParent(db, work.parentWorkId, a.user.id);
}

/** Cancels the running workflow (if any) and sets the work to "iptal". */
export async function cancelWork(db: Db, a: ProjectAccess, work: WorkRow, type: TypeRow, comment: string | null): Promise<void> {
  // Letters: anything not archived or cancelled yet can be cancelled (answered ones too).
  if (type.category === "correspondence") {
    await cancelLetter(db, a, work, type, comment);
    return;
  }
  requireEdit(work, a);
  if (isClosed(type, work.status)) throw conflict(msg("works:errors.closedNotCancelled"));
  const target = type.statuses.find((s) => s.key === "iptal") ? "iptal" : null;
  if (!target) throw badRequest(msg("works:errors.noCancelStatus"));
  const revision = await runningRevision(db, work.id);
  const now = new Date();
  await db.transaction(async (tx) => {
    if (revision?.workflowInstanceId) {
      await tx
        .update(workflowInstances)
        .set({ status: "cancelled", completedAt: now, stepDueAt: null, stageDueAt: null, updatedAt: now })
        .where(eq(workflowInstances.id, revision.workflowInstanceId));
      await tx.insert(workflowActions).values({ instanceId: revision.workflowInstanceId, stepIndex: 0, kind: "cancel", userId: a.user.id, comment, at: now });
      await tx.update(workRevisions).set({ status: "cancelled", decidedAt: now }).where(eq(workRevisions.id, revision.id));
    }
    await tx.update(works).set({ status: target, closedAt: now, updatedAt: now }).where(eq(works.id, work.id));
  });
  await addEvent(db, work.id, "cancelled", a.user.id, comment, { from: work.status });
  await audit(db, { projectId: a.project.id, userId: a.user.id, action: "work.cancelled", targetType: "work", targetId: work.id, details: { number: work.number } });
  if (work.parentWorkId) await rollupParent(db, work.parentWorkId, a.user.id);
}

// ---- Package roll-up ----------------------------------------------------------------------------

/** Recomputes a package's status from its items. */
export async function rollupParent(db: Db, parentId: string, actorId: string | null): Promise<void> {
  const [row] = await db
    .select({ w: works, t: workTypes })
    .from(works)
    .innerJoin(workTypes, eq(workTypes.id, works.typeId))
    .where(eq(works.id, parentId));
  if (!row || row.t.category !== "submittal_package") return;
  const items = await db.select({ status: works.status }).from(works).where(eq(works.parentWorkId, parentId));
  const next = rollupPackageStatus(items.map((i) => i.status));
  if (next === row.w.status || !row.t.statuses.some((s) => s.key === next)) return;
  const now = new Date();
  await db
    .update(works)
    .set({ status: next, closedAt: isClosed(row.t, next) ? now : null, updatedAt: now })
    .where(eq(works.id, parentId));
  await addEvent(db, parentId, "status", actorId, "Kalemlerden güncellendi" /* i18n-ok: event message stored as data */, { from: row.w.status, to: next });
}

// ---- DTOs ---------------------------------------------------------------------------------------

export interface NameBook {
  users: Map<string, string>;
  companies: Map<string, string>;
  roles: Map<string, string>;
  /** The reader's language (outcome and role labels). */
  lang: string;
}

export async function nameBook(db: Db, projectId: string, instances: InstanceRow[], actions: ActionRow[], lang: string = DEFAULT_LANGUAGE): Promise<NameBook> {
  const userIds = new Set<string>();
  const companyIds = new Set<string>();
  for (const i of instances)
    for (const s of i.template.steps)
      for (const x of s.assignees) (x.type === "user" ? userIds : x.type === "company" ? companyIds : new Set()).add(x.id);
  for (const x of actions) if (x.userId) userIds.add(x.userId);
  for (const i of instances) userIds.add(i.startedBy);
  const u = userIds.size ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, [...userIds])) : [];
  const c = companyIds.size
    ? await db.select({ id: companies.id, name: companies.name }).from(companies).where(inArray(companies.id, [...companyIds]))
    : [];
  const r = await db.select({ id: projectRoles.id, name: projectRoles.name }).from(projectRoles).where(eq(projectRoles.projectId, projectId));
  return {
    users: new Map(u.map((x) => [x.id, x.name])),
    companies: new Map(c.map((x) => [x.id, x.name])),
    roles: new Map([
      ...Object.keys(WORKFLOW_ROLE_LABELS_TR).map((k) => [k, labelFor(lang, "workflowRole", k)] as [string, string]),
      ...r.map((x) => [x.id, x.name] as [string, string]),
    ]),
    lang,
  };
}

function assigneeName(x: WorkflowAssignee, n: NameBook): string {
  if (x.type === "user") return n.users.get(x.id) ?? "?";
  if (x.type === "company") return n.companies.get(x.id) ?? "?";
  return n.roles.get(x.id) ?? x.id;
}

/** Step list of one instance with answers, results and states. */
export function flowSteps(instance: InstanceRow, actions: ActionRow[], n: NameBook, now = new Date()): WorkFlowStepDto[] {
  const tpl = instance.template;
  const mine = actions.filter((x) => x.instanceId === instance.id);
  const completedAt = mine.find((x) => x.kind === "completed")?.stepIndex;
  return tpl.steps.map((s, i) => {
    const answers: WorkAnswerDto[] = mine
      .filter((x) => x.kind === "submit" && x.stepIndex === i && x.userId && x.outcome)
      .map((x) => {
        const d = (x.details ?? {}) as { code?: string; label?: string; response?: string | null; onBehalfOf?: WorkflowAssignee[] };
        return {
          userId: x.userId!,
          userName: n.users.get(x.userId!),
          code: d.code ?? x.outcome!,
          label: d.label ?? labelFor(n.lang, "outcome", x.outcome!),
          kind: OUTCOME_CODE_KIND[x.outcome!],
          comment: x.comment,
          response: d.response ?? null,
          onBehalfOf: (d.onBehalfOf ?? []).map((b) => assigneeName(b, n)),
          at: x.at.toISOString(),
        };
      });
    const done = mine.find((x) => x.kind === "step_completed" && x.stepIndex === i);
    const d = (done?.details ?? null) as { result?: OutcomeCode; code?: string } | null;
    const result = d?.result
      ? {
          code: d.code ?? d.result,
          label: stepOutcomeOptions(s, n.lang).find((o) => o.code === d.code)?.label ?? answers.find((x) => x.code === d.code)?.label ?? labelFor(n.lang, "outcome", d.result),
          kind: OUTCOME_CODE_KIND[d.result],
        }
      : null;
    let state: WorkFlowStepDto["state"] = "pending";
    if (result) state = result.kind === "revise" || result.kind === "rejected" ? "returned" : "done";
    else if (instance.status === "running" && i === instance.stepIndex) state = "current";
    else if (instance.status !== "running") state = "skipped";
    if (state === "returned" && completedAt === undefined && instance.status === "running") state = "done";
    const dueAt = state === "current" ? (instance.stepDueAt?.toISOString() ?? null) : null;
    return {
      index: i,
      name: s.name,
      assignees: s.assignees.map((x) => assigneeName(x, n)),
      rule: s.rule,
      state,
      dueAt,
      overdue: state === "current" && !!instance.stepDueAt && instance.stepDueAt.getTime() < now.getTime(),
      answers,
      result,
    };
  });
}

export async function loadFlowRows(db: Db, revs: RevisionRow[]) {
  const ids = revs.map((r) => r.workflowInstanceId).filter((x): x is string => !!x);
  const instances = ids.length ? await db.select().from(workflowInstances).where(inArray(workflowInstances.id, ids)) : [];
  const actions = ids.length
    ? await db.select().from(workflowActions).where(inArray(workflowActions.instanceId, ids)).orderBy(asc(workflowActions.at))
    : [];
  return { instances, actions };
}

export function revisionDto(r: RevisionRow, instance: InstanceRow | undefined, actions: ActionRow[], n: NameBook): WorkRevisionDto {
  return {
    id: r.id,
    rev: r.rev,
    status: r.status,
    submittedAt: r.submittedAt.toISOString(),
    submittedBy: r.submittedBy,
    submittedByName: n.users.get(r.submittedBy),
    comment: r.comment,
    decidedAt: r.decidedAt?.toISOString() ?? null,
    outcome: r.outcome ?? null,
    outcomeKind: r.outcome ? OUTCOME_CODE_KIND[r.outcome] : null,
    outcomeLabel: r.outcomeLabel,
    response: r.response,
    attachments: r.attachments,
    steps: instance ? flowSteps(instance, actions, n) : [],
  };
}

/** Current workflow of a work as seen by the caller (can act, options, acting for). */
export async function flowDto(
  db: Db,
  a: ProjectAccess,
  work: WorkRow,
  type: TypeRow,
  revision: RevisionRow,
  instance: InstanceRow,
  actions: ActionRow[],
  n: NameBook,
): Promise<WorkFlowDto> {
  const step = instance.template.steps[instance.stepIndex];
  let canAct = false;
  let options: OutcomeOption[] = [];
  let actingFor: string[] = [];
  if (instance.status === "running" && step) {
    const member = await memberWithRoles(db, a.project.id, a.user.id);
    const actor: ActorContext = actorFor(a.user, member, instance.startedBy);
    const answered = actions.some(
      (x) => x.instanceId === instance.id && x.kind === "submit" && x.stepIndex === instance.stepIndex && x.userId === a.user.id,
    );
    canAct = isAssignee(step, actor) && !answered;
    if (canAct) {
      options = optionsFor(step, type, work, n.lang);
      actingFor = onBehalfOf(step, actor).map((x) => assigneeName(x, n));
    }
  }
  return {
    instanceId: instance.id,
    revisionId: revision.id,
    rev: revision.rev,
    status: instance.status,
    stepIndex: instance.stepIndex,
    templateName: instance.template.name,
    steps: flowSteps(instance, actions, n),
    canAct,
    options,
    actingFor,
    needsResponse: type.category === "rfi",
  };
}

/**
 * "Ball in court": companies that have to act now. Running → the current step's company
 * assignees and the companies of its user / team assignees; sent back → the submitter's company.
 */
export function ballInCourt(work: WorkRow, type: TypeRow, instance: InstanceRow | undefined, members: readonly Member[]): string[] {
  if (isClosed(type, work.status)) return [];
  if (instance?.status === "running") {
    const step = instance.template.steps[instance.stepIndex];
    if (!step) return [];
    const out = new Set(step.assignees.filter((x) => x.type === "company").map((x) => x.id));
    for (const uid of resolveAssigneeUsers(
      step.assignees.filter((x) => x.type !== "company"),
      members,
      instance.startedBy,
    )) {
      const c = members.find((m) => m.userId === uid)?.companyId;
      if (c) out.add(c);
    }
    return [...out];
  }
  if (type.category === "action") return work.toCompanyIds;
  const back = work.status === "revize" || (work.status === "taslak" && !!instance);
  if (back || work.status === "cevaplandi") return [work.fromCompanyId ?? work.ownerCompanyId].filter((x): x is string => !!x);
  return [];
}

// ---- Reminders ----------------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;

/** Due-date reminders for running work steps (same once-per-step rule as reviews). */
export async function runWorkDueReminders(db: Db, now: Date): Promise<{ dueSoon: number; overdue: number }> {
  const out = { dueSoon: 0, overdue: 0 };
  const rows = await db
    .select({ i: workflowInstances, w: works })
    .from(workflowInstances)
    .innerJoin(workRevisions, and(eq(workflowInstances.subjectType, SUBJECT_WORK_REVISION), eq(workRevisions.id, workflowInstances.subjectId)))
    .innerJoin(works, eq(works.id, workRevisions.workId))
    .where(
      and(
        eq(workflowInstances.status, "running"),
        isNotNull(workflowInstances.stepDueAt),
        lte(workflowInstances.stepDueAt, new Date(now.getTime() + DAY)),
      ),
    );
  for (const { i, w } of rows) {
    const due = i.stepDueAt!;
    const kind = due.getTime() <= now.getTime() ? "overdue" : "due_soon";
    const inserted = await db
      .insert(workflowReminders)
      .values({ instanceId: i.id, stepIndex: i.stepIndex, kind, sentAt: now })
      .onConflictDoNothing()
      .returning();
    if (!inserted.length) continue;
    const step = i.template.steps[i.stepIndex]!;
    const members = await projectMemberRows(db, w.projectId);
    const answered = await db
      .select({ userId: workflowActions.userId })
      .from(workflowActions)
      .where(and(eq(workflowActions.instanceId, i.id), eq(workflowActions.stepIndex, i.stepIndex), eq(workflowActions.kind, "submit")));
    const done = new Set(answered.map((x) => x.userId));
    const pending = resolveAssigneeUsers(step.assignees, members, i.startedBy).filter((u) => !done.has(u));
    await notify(db, kind === "overdue" ? [...pending, w.createdBy] : pending, {
      projectId: w.projectId,
      kind: kind === "overdue" ? "work.overdue" : "work.due_soon",
      title: msg(kind === "overdue" ? "works:notifications.stepOverdue" : "works:notifications.stepDueSoon", { number: w.number, step: step.name }),
      body: msg("works:notifications.due", { date: due.toLocaleDateString(intlLocale(DEFAULT_LANGUAGE)) }),
      link: workLink(w.projectId, w.id),
    });
    if (kind === "overdue") out.overdue++;
    else out.dueSoon++;
  }
  return out;
}

export { statusDef, notFound };

// ---- Work workflow → transmittal ------------------------------------------------------------------

/**
 * Mirrors the review → transmittal automation for works: when a work workflow that used a
 * template with "otomatik transmittal" completes, a transmittal with the revision's attachments
 * goes back to the submitter (or the configured companies). Replaces the separate letter +
 * transmittal + Excel list records of the Forma practice with one flow.
 */
export function workAutoTransmittalListener(ctx: WorksCtx) {
  return async (e: import("../workflow/service.js").WorkflowEvent): Promise<void> => {
    if (e.type !== "completed" || e.subjectType !== SUBJECT_WORK_REVISION || !e.templateId) return;
    const { db } = ctx;
    const [opts] = await db.select().from(workflowTemplateWorkOptions).where(eq(workflowTemplateWorkOptions.templateId, e.templateId));
    if (!opts?.autoTransmittal) return;
    const [revision] = await db.select().from(workRevisions).where(eq(workRevisions.id, e.subjectId));
    if (!revision) return;
    if (opts.include === "approved" && !isApprovedOutcome(revision.outcome)) return;
    const [work] = await db.select().from(works).where(eq(works.id, revision.workId));
    const [project] = await db.select().from(projects).where(eq(projects.id, e.projectId));
    if (!work || !project || !revision.attachments.length) return;
    // Module off (Proje Ayarları → Modüller): no new transmittal.
    if (!resolveModules(project.settings?.modules).transmittals) return;
    const types = await projectTypes(db, project.id);
    const type = types.find((t) => t.key === "transmittal" && !t.archivedAt) ?? types.find((t) => t.category === "transmittal" && !t.archivedAt);
    if (!type) return;
    const actorId = e.actorId ?? work.createdBy;
    const member = await memberWithRoles(db, project.id, actorId);
    const [actor] = await db.select().from(users).where(eq(users.id, actorId));
    const sender = member?.companyId ?? actor?.companyId ?? null;
    const submitter = work.fromCompanyId ?? work.ownerCompanyId;
    const to = [...new Set(opts.recipientCompanyIds.length ? opts.recipientCompanyIds : submitter ? [submitter] : [])];
    const fields: Record<string, string> = {};
    if (type.fields.some((f) => f.key === "amac")) fields.amac = opts.purpose;
    if (type.fields.some((f) => f.key === "not")) fields.not = `${work.number} Rev ${revision.rev}: ${revision.outcomeLabel ?? ""}`.trim();
    const tr = await createWork(
      db,
      null,
      project,
      type,
      { userId: actorId, companyId: sender },
      {
        title: `${work.number} ${work.title}`.slice(0, 300),
        fields,
        fromCompanyId: sender,
        toCompanyIds: to,
        links: [
          { kind: "work", targetId: work.id, role: "kaynak" },
          ...revision.attachments.map((x) => ({ kind: "file_version" as const, targetId: x.versionId, role: "ek" as const })),
        ],
      },
      `${work.number} akışı tamamlanınca otomatik oluşturuldu`, // i18n-ok: event message stored as data
    );
    await addEvent(db, work.id, "linked", null, `Gönderim formu: ${tr.number}` /* i18n-ok: event message stored as data */, { transmittalId: tr.id });
    if (opts.send && to.length) await sendWork(ctx, project, tr, type, actorId, { channel: "cde" });
  };
}
