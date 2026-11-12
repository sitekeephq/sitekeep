/**
 * Pure workflow engine: who may act on a step, when a step is complete, how outcomes of
 * several reviewers combine and what comes next. No database access here; the service
 * layer loads rows, calls these functions and writes the result.
 */
import {
  OUTCOME_SEVERITY,
  type FinalOutcomeMap,
  type OutcomeCode,
  type WorkflowAssignee,
  type WorkflowStatus,
  type WorkflowStep,
} from "@sitekeep/shared";
import { DEFAULT_LANGUAGE, tFor } from "../i18n/index.js";

/** The acting user as seen by the engine. */
export interface ActorContext {
  userId: string;
  /** Company the user represents in the project. */
  companyId: string | null;
  isProjectAdmin: boolean;
  /** The user started this workflow instance. */
  isStarter: boolean;
  /** Project roles (teams) the user holds. */
  roleIds?: readonly string[];
}

export function assigneeMatches(a: WorkflowAssignee, actor: ActorContext): boolean {
  switch (a.type) {
    case "user":
      return a.id === actor.userId;
    case "company":
      return !!actor.companyId && a.id === actor.companyId;
    case "role":
      return (
        (a.id === "project_admin" && actor.isProjectAdmin) ||
        (a.id === "starter" && actor.isStarter) ||
        !!actor.roleIds?.includes(a.id)
      );
    default:
      return false;
  }
}

/** True when the actor is one of the step's assignees. */
export function isAssignee(step: WorkflowStep, actor: ActorContext): boolean {
  return step.assignees.some((a) => assigneeMatches(a, actor));
}

/**
 * Group assignees (companies, teams, project admins) the actor answers for: "ekip adına onay".
 * Direct user entries and "starter" are personal and not listed.
 */
export function onBehalfOf(step: WorkflowStep, actor: ActorContext): WorkflowAssignee[] {
  return step.assignees.filter(
    (a) => a.type !== "user" && !(a.type === "role" && a.id === "starter") && assigneeMatches(a, actor),
  );
}

export interface StepSubmission {
  actor: ActorContext;
  /** Outcome per item (e.g. review file id). */
  outcomes: Record<string, OutcomeCode>;
}

/**
 * Rule "any": the first submission completes the step.
 * Rule "all": every assignee entry needs at least one submission from a matching user
 * (a company entry is satisfied by any one member of that company).
 */
export function isStepComplete(step: WorkflowStep, submissions: readonly StepSubmission[]): boolean {
  if (!submissions.length) return false;
  if (step.rule === "any") return true;
  return step.assignees.every((a) => submissions.some((s) => assigneeMatches(a, s.actor)));
}

/** Assignee entries still waiting for an answer. */
export function pendingAssignees(step: WorkflowStep, submissions: readonly StepSubmission[]): WorkflowAssignee[] {
  if (step.rule === "any") return submissions.length ? [] : [...step.assignees];
  return step.assignees.filter((a) => !submissions.some((s) => assigneeMatches(a, s.actor)));
}

export function worstOutcome(codes: readonly OutcomeCode[]): OutcomeCode | null {
  let worst: OutcomeCode | null = null;
  for (const c of codes) if (worst === null || OUTCOME_SEVERITY[c] > OUTCOME_SEVERITY[worst]) worst = c;
  return worst;
}

/**
 * Step result per item. With "any" the first submission decides; with "all" the worst
 * outcome given by any reviewer wins (one rejection rejects the file).
 */
export function combineStepOutcomes(
  step: WorkflowStep,
  submissions: readonly StepSubmission[],
): Record<string, OutcomeCode> {
  if (!submissions.length) return {};
  const used = step.rule === "any" ? submissions.slice(0, 1) : submissions;
  const byItem = new Map<string, OutcomeCode[]>();
  for (const s of used)
    for (const [item, code] of Object.entries(s.outcomes)) byItem.set(item, [...(byItem.get(item) ?? []), code]);
  const out: Record<string, OutcomeCode> = {};
  for (const [item, codes] of byItem) out[item] = worstOutcome(codes)!;
  return out;
}

/** Applies the template's final mapping to the result of the last step. */
export function finalOutcome(code: OutcomeCode | null | undefined, map: FinalOutcomeMap): OutcomeCode | null {
  if (!code) return null;
  return map[code] ?? code;
}

/**
 * Final status per item: the outcome of the latest step that judged the item, mapped
 * through finalOutcomes. Items nobody judged get null (not approved).
 */
export function finalOutcomes(
  stepResults: Record<string, Record<string, OutcomeCode>>,
  items: readonly string[],
  map: FinalOutcomeMap,
): Record<string, OutcomeCode | null> {
  const steps = Object.keys(stepResults)
    .map(Number)
    .sort((a, b) => b - a);
  const out: Record<string, OutcomeCode | null> = {};
  for (const item of items) {
    let code: OutcomeCode | null = null;
    for (const s of steps) {
      const c = stepResults[String(s)]?.[item];
      if (c) {
        code = c;
        break;
      }
    }
    out[item] = finalOutcome(code, map);
  }
  return out;
}

export interface Advance {
  status: WorkflowStatus;
  stepIndex: number;
  /** True when the instance moved to a new step or finished. */
  moved: boolean;
}

/** State after a submission on step `stepIndex`. */
export function advance(steps: readonly WorkflowStep[], stepIndex: number, stepComplete: boolean): Advance {
  if (!stepComplete) return { status: "running", stepIndex, moved: false };
  if (stepIndex + 1 >= steps.length) return { status: "completed", stepIndex, moved: true };
  return { status: "running", stepIndex: stepIndex + 1, moved: true };
}

/** Due date of a step started at `from`; 0 days = no due date. Calendar days. */
export function stepDueDate(from: Date, days: number): Date | null {
  if (!days || days <= 0) return null;
  const d = new Date(from.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

/** Same as stepDueDate but skips Saturdays and Sundays. */
export function addBusinessDays(from: Date, days: number): Date | null {
  if (!days || days <= 0) return null;
  const d = new Date(from.getTime());
  let left = days;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) left--;
  }
  return d;
}

/** Problems in a template definition (empty when valid). */
export function checkTemplate(steps: readonly WorkflowStep[], lang: string = DEFAULT_LANGUAGE): string[] {
  const t = tFor(lang);
  const problems: string[] = [];
  if (!steps.length) problems.push(t("workflow:errors.noSteps"));
  steps.forEach((s, i) => {
    const step = i + 1;
    if (!s.name.trim()) problems.push(t("workflow:errors.stepNameEmpty", { step }));
    if (!s.assignees.length) problems.push(t("workflow:errors.stepNoAssignee", { step }));
    if (!s.outcomes.length) problems.push(t("workflow:errors.stepNoOutcome", { step }));
    const keys = s.assignees.map((a) => `${a.type}:${a.id}`);
    if (new Set(keys).size !== keys.length) problems.push(t("workflow:errors.stepDuplicateAssignee", { step }));
  });
  return problems;
}
