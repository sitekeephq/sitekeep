import { checkAttributeValue, resolveOutcomeOption, type OutcomeCode } from "@sitekeep/shared";
import { and, eq, inArray } from "drizzle-orm";
import { audit } from "../core/platform/audit.js";
import { badRequest, conflict, forbidden, notFound } from "../core/platform/http.js";
import type { ProjectAccess } from "../core/security/access.js";
import type { Db } from "../db/index.js";
import { DEFAULT_LANGUAGE, intlLocale, msg, tFor } from "../i18n/index.js";
import {
  attributeDefinitions,
  files,
  projectMembers,
  reviewFiles,
  reviewMarks,
  users,
  workflowActions,
  workflowInstances,
} from "../db/schema.js";
import {
  combineChainOutcomes,
  enterStep,
  finalLabelOf,
  stopsChain,
  type ChainSubmission,
} from "./chain.js";
import { advance, finalOutcomes, isAssignee, isStepComplete, onBehalfOf, worstOutcome } from "./engine.js";
import { copyApprovedFiles } from "./review-finalization.js";
import {
  SUBJECT_REVIEW,
  reviewLabel,
  reviewLink,
  type InstanceRow,
  type ReviewCtx,
  type ReviewRow,
  type SubmitInput,
} from "./review-types.js";
import {
  actorFor,
  emitWorkflowEvent,
  memberWithRoles,
  notify,
  projectMemberRows,
  resolveAssigneeUsers,
  withRoleIds,
} from "./service.js";

type ReviewFileRow = typeof reviewFiles.$inferSelect;

interface AttributeChange {
  fileId: string;
  name: string;
  from: Record<string, string>;
  to: Record<string, string>;
}

export interface Evaluation {
  instance: InstanceRow;
  stepCompleted: boolean;
  completedStepIndex: number;
  finished: boolean;
  /** Files sent back to the originator in this evaluation. */
  stopped: ReviewFileRow[];
}

/** Files still in the chain (not sent back by a stop stage). */
function activeFiles(rfs: ReviewFileRow[]): ReviewFileRow[] {
  return rfs.filter((rf) => rf.stoppedAtStep === null || rf.stoppedAtStep === undefined);
}

export async function submitStep(ctx: ReviewCtx, a: ProjectAccess, review: ReviewRow, input: SubmitInput) {
  const { db } = ctx;
  const changes: AttributeChange[] = [];
  const result = await db.transaction(async (tx) => {
    const [instance] = await tx
      .select()
      .from(workflowInstances)
      .where(and(eq(workflowInstances.subjectType, SUBJECT_REVIEW), eq(workflowInstances.subjectId, review.id)))
      .for("update");
    if (!instance) throw notFound(msg("workflow:entities.review"));
    if (instance.status !== "running") throw conflict(msg("workflow:errors.reviewNotOpen"));
    const step = instance.template.steps[instance.stepIndex]!;
    const member = await memberWithRoles(tx, a.project.id, a.user.id);
    const actor = actorFor(a.user, member, instance.startedBy);
    if (!isAssignee(step, actor)) throw forbidden(msg("workflow:errors.stepNotAssigned"));
    const behalf = onBehalfOf(step, actor);

    const rfs = await tx.select().from(reviewFiles).where(eq(reviewFiles.reviewId, review.id));
    const active = activeFiles(rfs);
    const already = await tx
      .select({ id: reviewMarks.id })
      .from(reviewMarks)
      .where(
        and(
          inArray(
            reviewMarks.reviewFileId,
            rfs.map((r) => r.id),
          ),
          eq(reviewMarks.stepIndex, instance.stepIndex),
          eq(reviewMarks.userId, a.user.id),
        ),
      );
    if (already.length) throw conflict(msg("workflow:errors.stepAlreadyAnswered"));

    const given = new Map(input.files.map((f) => [f.reviewFileId, f]));
    const picked = new Map<string, { base: OutcomeCode; code: string }>();
    const t = tFor(ctx.lang ?? DEFAULT_LANGUAGE);
    const problems: string[] = [];
    for (const rf of active) {
      const g = given.get(rf.id);
      if (!g) {
        problems.push(t("workflow:errors.outcomePerFile"));
        continue;
      }
      const opt = resolveOutcomeOption(step, g.outcome);
      if (!opt) problems.push(t("workflow:errors.outcomeNotAllowed", { outcome: g.outcome }));
      else picked.set(rf.id, { base: opt.base, code: opt.code });
    }
    for (const k of given.keys()) {
      if (active.some((r) => r.id === k)) continue;
      problems.push(rfs.some((r) => r.id === k) ? t("workflow:errors.fileReturned") : t("workflow:errors.fileNotInReview"));
    }

    const required = step.requiredAttributes ?? [];
    const fileRows = required.length
      ? await tx
          .select()
          .from(files)
          .where(
            inArray(
              files.id,
              active.map((rf) => rf.fileId),
            ),
          )
      : [];
    if (required.length) {
      const defs = await tx
        .select()
        .from(attributeDefinitions)
        .where(and(eq(attributeDefinitions.projectId, a.project.id), inArray(attributeDefinitions.name, required)));
      for (const rf of active) {
        const file = fileRows.find((f) => f.id === rf.fileId)!;
        const values = input.attributes?.[rf.id] ?? {};
        const next = { ...file.attributes };
        for (const name of required) {
          const v = (values[name] ?? file.attributes[name] ?? "").trim();
          const def = defs.find((d) => d.name === name);
          const message = def ? checkAttributeValue({ ...def, required: true }, v, ctx.lang ?? DEFAULT_LANGUAGE) : v ? null : t("workflow:errors.attributeRequired", { name });
          if (message) problems.push(t("workflow:errors.fileProblem", { file: file.name, problem: message }));
          else next[name] = v;
        }
        const changed = required.filter((n) => (file.attributes[n] ?? "") !== (next[n] ?? ""));
        if (changed.length)
          changes.push({
            fileId: file.id,
            name: file.name,
            from: Object.fromEntries(changed.map((n) => [n, file.attributes[n] ?? ""])),
            to: Object.fromEntries(changed.map((n) => [n, next[n]!])),
          });
      }
    }
    if (problems.length) {
      const unique = [...new Set(problems)];
      throw badRequest(unique.join(" "), unique);
    }

    for (const c of changes) {
      const file = fileRows.find((f) => f.id === c.fileId)!;
      await tx
        .update(files)
        .set({ attributes: { ...file.attributes, ...c.to } })
        .where(eq(files.id, c.fileId));
    }

    const now = new Date();
    await tx.insert(reviewMarks).values(
      active.map((rf) => ({
        reviewFileId: rf.id,
        stepIndex: instance.stepIndex,
        userId: a.user.id,
        outcome: picked.get(rf.id)!.base,
        optionCode: picked.get(rf.id)!.code,
        comment: given.get(rf.id)!.comment?.trim() || null,
        at: now,
      })),
    );
    await tx.insert(workflowActions).values({
      instanceId: instance.id,
      stepIndex: instance.stepIndex,
      kind: "submit",
      userId: a.user.id,
      outcome: worstOutcome(active.map((rf) => picked.get(rf.id)!.base)),
      comment: input.comment?.trim() || null,
      details: {
        files: active.length,
        ...(behalf.length ? { onBehalfOf: behalf } : {}),
        ...(changes.length ? { attributes: changes.length } : {}),
      },
      at: now,
    });
    return evaluateReview(tx, review, instance, rfs, a.user.id);
  });
  for (const c of changes)
    await audit(db, {
      projectId: review.projectId,
      userId: a.user.id,
      action: "file.attributes_updated",
      targetType: "file",
      targetId: c.fileId,
      details: {
        name: c.name,
        from: c.from,
        to: c.to,
        reviewId: review.id,
        reviewNumber: review.number,
        stepIndex: result.completedStepIndex,
      },
    });
  await afterEvaluate(ctx, review, result, a.user.id);
  return result;
}

/** Re-checks the current step and moves the instance forward when it is complete. */
export async function evaluateReview(
  tx: Db,
  review: ReviewRow,
  instance: InstanceRow,
  rfs: ReviewFileRow[],
  actorId: string | null,
): Promise<Evaluation> {
  const stepIndex = instance.stepIndex;
  const tpl = instance.template;
  const step = tpl.steps[stepIndex]!;
  const active = activeFiles(rfs);
  const submissions = await stepSubmissions(tx, review.projectId, instance, active);
  const complete = isStepComplete(step, submissions);
  if (!complete) return { instance, stepCompleted: false, completedStepIndex: stepIndex, finished: false, stopped: [] };

  const now = new Date();
  const combined = combineChainOutcomes(step, submissions);
  const stopped: ReviewFileRow[] = [];
  for (const rf of active) {
    const c = combined[rf.id];
    if (!c) continue;
    const stepResults = { ...rf.stepResults, [String(stepIndex)]: c.base };
    const stepCodes = { ...(rf.stepCodes ?? {}), [String(stepIndex)]: c.code };
    const patch: Partial<ReviewFileRow> = { stepResults, stepCodes };
    if (stopsChain(tpl, stepIndex, c.base)) {
      const final = finalOutcomes({ [String(stepIndex)]: { [rf.id]: c.base } }, [rf.id], tpl.finalOutcomes)[rf.id] ?? null;
      Object.assign(patch, {
        stoppedAtStep: stepIndex,
        finalStatus: final,
        finalLabel: finalLabelOf(tpl, stepIndex, c.code, c.base, final),
        decidedAt: now,
      });
      stopped.push(rf);
    }
    Object.assign(rf, patch);
    await tx.update(reviewFiles).set(patch).where(eq(reviewFiles.id, rf.id));
  }
  await tx.insert(workflowActions).values({
    instanceId: instance.id,
    stepIndex,
    kind: "step_completed",
    userId: null,
    details: {
      results: Object.fromEntries(Object.entries(combined).map(([k, v]) => [k, v.base])),
      codes: Object.fromEntries(Object.entries(combined).map(([k, v]) => [k, v.code])),
      by: actorId,
      ...(stopped.length ? { returned: stopped.map((rf) => rf.id) } : {}),
    },
    at: now,
  });
  const stillActive = activeFiles(rfs);
  const next = advance(tpl.steps, stepIndex, true);
  if (next.status === "running" && stillActive.length) {
    const due = enterStep(tpl, stepIndex, next.stepIndex, now, instance.stageDueAt ?? null);
    const [updated] = await tx
      .update(workflowInstances)
      .set({
        stepIndex: next.stepIndex,
        stepStartedAt: now,
        stepDueAt: due.stepDueAt,
        stageDueAt: due.stageDueAt,
        updatedAt: now,
      })
      .where(eq(workflowInstances.id, instance.id))
      .returning();
    return { instance: updated!, stepCompleted: true, completedStepIndex: stepIndex, finished: false, stopped };
  }

  const finals = finalOutcomes(
    Object.fromEntries(
      tpl.steps.map((_, i) => [
        String(i),
        Object.fromEntries(stillActive.filter((rf) => rf.stepResults[String(i)]).map((rf) => [rf.id, rf.stepResults[String(i)]!])),
      ]),
    ),
    stillActive.map((rf) => rf.id),
    tpl.finalOutcomes,
  );
  for (const rf of stillActive) {
    const decided = Object.keys(rf.stepResults)
      .map(Number)
      .sort((x, y) => y - x)[0];
    const final = finals[rf.id] ?? null;
    const finalLabel =
      decided === undefined
        ? null
        : finalLabelOf(tpl, decided, rf.stepCodes?.[String(decided)], rf.stepResults[String(decided)]!, final);
    await tx.update(reviewFiles).set({ finalStatus: final, finalLabel, decidedAt: now }).where(eq(reviewFiles.id, rf.id));
  }
  const [updated] = await tx
    .update(workflowInstances)
    .set({ status: "completed", completedAt: now, stepDueAt: null, stageDueAt: null, updatedAt: now })
    .where(eq(workflowInstances.id, instance.id))
    .returning();
  await tx.insert(workflowActions).values({
    instanceId: instance.id,
    stepIndex,
    kind: "completed",
    userId: null,
    details: { finals, ...(stillActive.length < rfs.length ? { returned: rfs.length - stillActive.length } : {}) },
    at: now,
  });
  return { instance: updated!, stepCompleted: true, completedStepIndex: stepIndex, finished: true, stopped };
}

/** Notifications, audit and approved-file copying after the transaction has committed. */
export async function afterEvaluate(ctx: ReviewCtx, review: ReviewRow, ev: Evaluation, actorId: string | null) {
  const { db } = ctx;
  if (!ev.stepCompleted) return;
  const step = ev.instance.template.steps[ev.completedStepIndex]!;
  await audit(db, {
    projectId: review.projectId,
    userId: actorId,
    action: "review.step_completed",
    targetType: "review",
    targetId: review.id,
    details: { number: review.number, name: review.name, step: step.name, stepIndex: ev.completedStepIndex },
  });
  const link = reviewLink(review.projectId, review.id);
  if (ev.stopped.length) {
    const names = await fileNames(db, ev.stopped);
    await audit(db, {
      projectId: review.projectId,
      userId: actorId,
      action: "review.files_returned",
      targetType: "review",
      targetId: review.id,
      details: { number: review.number, step: step.name, stepIndex: ev.completedStepIndex, files: names },
    });
    await notify(db, [review.createdBy], {
      projectId: review.projectId,
      kind: "review.returned",
      title: msg("workflow:notifications.filesReturned", { review: reviewLabel(review), count: ev.stopped.length, step: step.name }),
      body: names.join(", "),
      link,
    });
  }
  if (!ev.finished) {
    await notify(db, [review.createdBy], {
      projectId: review.projectId,
      kind: "review.step_completed",
      title: msg("workflow:notifications.stepCompleted", { review: reviewLabel(review), step: step.name }),
      link,
    });
    await notifyStepAssignees(db, review, ev.instance);
    return;
  }
  const copy = await copyApprovedFiles(ctx, review, actorId);
  await audit(db, {
    projectId: review.projectId,
    userId: actorId,
    action: "review.completed",
    targetType: "review",
    targetId: review.id,
    details: { number: review.number, name: review.name, ...copy },
  });
  const participants = await participantUsers(db, review, ev.instance);
  await notify(db, [review.createdBy, ...participants], {
    projectId: review.projectId,
    kind: "review.completed",
    title: msg("workflow:notifications.reviewCompleted", { review: reviewLabel(review) }),
    body: msg(
      copy.copied && copy.failed
        ? "workflow:notifications.reviewCompletedCopiedFailed"
        : copy.copied
          ? "workflow:notifications.reviewCompletedCopied"
          : copy.failed
            ? "workflow:notifications.reviewCompletedFailed"
            : "workflow:notifications.reviewCompletedBody",
      { approved: copy.approved, copied: copy.copied, failed: copy.failed },
    ),
    link,
  });
  await emitWorkflowEvent(db, {
    type: "completed",
    kind: ev.instance.kind,
    projectId: review.projectId,
    subjectType: SUBJECT_REVIEW,
    subjectId: review.id,
    instanceId: ev.instance.id,
    templateId: ev.instance.templateId,
    actorId,
  });
}

async function fileNames(db: Db, rfs: ReviewFileRow[]): Promise<string[]> {
  if (!rfs.length) return [];
  const rows = await db
    .select({ id: files.id, name: files.name })
    .from(files)
    .where(
      inArray(
        files.id,
        rfs.map((r) => r.fileId),
      ),
    );
  return rfs.map((rf) => rows.find((r) => r.id === rf.fileId)?.name ?? "?");
}

async function stepSubmissions(
  tx: Db,
  projectId: string,
  instance: InstanceRow,
  rfs: ReviewFileRow[],
): Promise<ChainSubmission[]> {
  if (!rfs.length) return [];
  const marks = await tx
    .select()
    .from(reviewMarks)
    .where(
      and(
        inArray(
          reviewMarks.reviewFileId,
          rfs.map((r) => r.id),
        ),
        eq(reviewMarks.stepIndex, instance.stepIndex),
      ),
    );
  const byUser = new Map<string, { at: number; outcomes: Record<string, OutcomeCode>; codes: Record<string, string> }>();
  for (const m of marks) {
    const cur = byUser.get(m.userId) ?? { at: m.at.getTime(), outcomes: {}, codes: {} };
    cur.at = Math.min(cur.at, m.at.getTime());
    cur.outcomes[m.reviewFileId] = m.outcome;
    cur.codes[m.reviewFileId] = m.optionCode ?? m.outcome;
    byUser.set(m.userId, cur);
  }
  const ids = [...byUser.keys()];
  if (!ids.length) return [];
  const userRows = await tx.select().from(users).where(inArray(users.id, ids));
  const memberRows = await withRoleIds(
    tx,
    await tx
      .select()
      .from(projectMembers)
      .where(and(eq(projectMembers.projectId, projectId), inArray(projectMembers.userId, ids))),
  );
  return [...byUser.entries()]
    .sort((x, y) => x[1].at - y[1].at)
    .map(([uid, v]) => {
      const user = userRows.find((r) => r.id === uid)!;
      const member = memberRows.find((r) => r.userId === uid);
      return { actor: actorFor(user, member, instance.startedBy), outcomes: v.outcomes, codes: v.codes };
    });
}

export async function notifyStepAssignees(db: Db, review: ReviewRow, instance: InstanceRow) {
  const step = instance.template.steps[instance.stepIndex]!;
  const members = await projectMemberRows(db, review.projectId);
  const userIds = resolveAssigneeUsers(step.assignees, members, instance.startedBy);
  await notify(db, userIds, {
    projectId: review.projectId,
    kind: "review.assigned",
    title: msg("workflow:notifications.stepAssigned", { review: reviewLabel(review), step: step.name }),
    body: instance.stepDueAt
      ? msg("workflow:notifications.due", { date: instance.stepDueAt.toLocaleDateString(intlLocale(DEFAULT_LANGUAGE)) })
      : null,
    link: reviewLink(review.projectId, review.id),
  });
}

async function participantUsers(db: Db, review: ReviewRow, instance: InstanceRow): Promise<string[]> {
  const acted = await db
    .select({ userId: workflowActions.userId })
    .from(workflowActions)
    .where(and(eq(workflowActions.instanceId, instance.id), eq(workflowActions.kind, "submit")));
  return acted.map((r) => r.userId).filter((x): x is string => !!x && x !== review.createdBy);
}
