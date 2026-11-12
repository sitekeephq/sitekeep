/** Template validation for review chains (stages, custom outcomes, attribute rules, patterns). */
import { z } from "zod";
import {
  OUTCOME_KINDS,
  REVIEW_PARTIES,
  baseCodesOf,
  checkPattern,
  type ReviewChainConfig,
  type ReviewStage,
  type WorkflowAssignee,
  type WorkflowStep,
} from "@sitekeep/shared";
import { FolderTree } from "../core/security/access.js";
import type { Db } from "../db/index.js";
import { DEFAULT_LANGUAGE, tFor } from "../i18n/index.js";

export function chainStepFields<A = WorkflowAssignee>(assigneeSchema: z.ZodType<A>) {
  return {
    outcomeOptions: z
      .array(
        z.object({
          code: z.string().trim().min(1).max(40),
          label: z.string().trim().min(1).max(120),
          kind: z.enum(OUTCOME_KINDS),
        }),
      )
      .max(20)
      .optional(),
    stage: z.number().int().min(0).max(19).optional(),
    assigneeRule: z
      .object({
        type: z.literal("by_attribute"),
        attribute: z.string().trim().min(1).max(100),
        map: z.record(z.string().trim().min(1).max(200), z.array(assigneeSchema).min(1).max(50)),
        fallback: z.array(assigneeSchema).max(50).optional(),
      })
      .optional(),
    requiredAttributes: z.array(z.string().trim().min(1).max(100)).max(30).optional(),
    // Form flows: items this step fills / signs and where a rejection goes.
    formFields: z.array(z.string().trim().regex(/^[A-Za-z0-9_-]{1,40}$/)).max(100).optional(),
    returnTo: z.number().int().min(0).max(19).nullable().optional(),
  };
}

/** Form flow options of a workflow template (kind "form"). */
export function formFlowShape<A = WorkflowAssignee>(assigneeSchema: z.ZodType<A>) {
  return z
    .object({
      fillers: z.array(assigneeSchema).max(50).optional(),
      notifyOnApproved: z.array(assigneeSchema).max(50).optional(),
      notifyOnReturned: z.array(assigneeSchema).max(50).optional(),
    })
    .optional();
}

/** Chain parts shared by workflow templates and project templates (everything but the copy target). */
export const chainBaseShape = {
  stages: z
    .array(
      z.object({
        name: z.string().trim().max(120).default(""),
        party: z.enum(REVIEW_PARTIES),
        days: z.number().int().min(0).max(365).default(0),
        onRevise: z.enum(["stop", "continue"]).default("continue"),
      }),
    )
    .max(20)
    .optional(),
  originParty: z.enum(REVIEW_PARTIES).nullable().optional(),
  namePattern: z.string().trim().max(200).nullable().optional(),
};

const plainAssignee = z.object({ type: z.enum(["user", "company", "role"]), id: z.string().min(1).max(64) });

export const chainSchema = z
  .object({
    ...chainBaseShape,
    form: formFlowShape(plainAssignee),
    copyTarget: z
      .object({
        folderId: z.string().uuid().nullable(),
        pattern: z.string().trim().max(300).default(""),
        onUnresolved: z.enum(["fail", "base"]).optional(),
      })
      .nullable()
      .optional(),
  })
  .default({});

type ParsedStep = Omit<WorkflowStep, "resolvedBy">;

/**
 * Normalises the review-chain parts of a template: custom outcome options define the base codes,
 * empty optional parts are dropped, stages must be in order and own at least one step.
 */
export async function normaliseChainTemplate(
  db: Db,
  projectId: string,
  rawSteps: readonly ParsedStep[],
  rawChain: z.infer<typeof chainSchema>,
  lang: string = DEFAULT_LANGUAGE,
): Promise<{ steps: WorkflowStep[]; chain: ReviewChainConfig; problems: string[] }> {
  const t = tFor(lang);
  const problems: string[] = [];
  const stages = rawChain.stages?.length ? (rawChain.stages as ReviewStage[]) : undefined;
  const steps = rawSteps.map((s, i) => {
    const step: WorkflowStep = { name: s.name, assignees: s.assignees, rule: s.rule, days: s.days, outcomes: s.outcomes };
    const n = i + 1;
    if (s.outcomeOptions?.length) {
      const codes = s.outcomeOptions.map((o) => o.code);
      if (new Set(codes).size !== codes.length) problems.push(t("workflow:errors.stepDuplicateOutcome", { step: n }));
      step.outcomeOptions = s.outcomeOptions;
      step.outcomes = baseCodesOf(s.outcomeOptions);
    }
    if (stages) {
      const k = s.stage ?? 0;
      if (k >= stages.length) problems.push(t("workflow:errors.stepStageUndefined", { step: n, stage: k + 1 }));
      step.stage = k;
    }
    if (s.assigneeRule) {
      if (!Object.keys(s.assigneeRule.map).length && !s.assigneeRule.fallback?.length)
        problems.push(t("workflow:errors.stepAttributeRuleEmpty", { step: n }));
      step.assigneeRule = s.assigneeRule;
    }
    if (s.requiredAttributes?.length) step.requiredAttributes = [...new Set(s.requiredAttributes)];
    if (s.formFields?.length) step.formFields = [...new Set(s.formFields)];
    if (s.returnTo !== undefined && s.returnTo !== null) {
      if (s.returnTo >= i) problems.push(t("workflow:errors.stepReturnToLater", { step: n }));
      step.returnTo = s.returnTo;
    }
    return step;
  });
  const owners = new Map<string, number>();
  steps.forEach((s, i) => {
    for (const f of s.formFields ?? []) {
      if (owners.has(f)) problems.push(t("workflow:errors.fieldTwoSteps", { field: f, first: owners.get(f)! + 1, second: i + 1 }));
      else owners.set(f, i);
    }
  });
  if (stages) {
    stages.forEach((_, k) => {
      if (!steps.some((s) => s.stage === k)) problems.push(t("workflow:errors.stageWithoutSteps", { stage: k + 1 }));
    });
    for (let i = 1; i < steps.length; i++)
      if ((steps[i]!.stage ?? 0) < (steps[i - 1]!.stage ?? 0)) {
        problems.push(t("workflow:errors.stepsStageOrder"));
        break;
      }
  }
  const chain: ReviewChainConfig = {};
  if (stages) chain.stages = stages;
  const form = rawChain.form;
  if (form) {
    const f: NonNullable<ReviewChainConfig["form"]> = {};
    if (form.fillers?.length) f.fillers = form.fillers as WorkflowAssignee[];
    if (form.notifyOnApproved?.length) f.notifyOnApproved = form.notifyOnApproved as WorkflowAssignee[];
    if (form.notifyOnReturned?.length) f.notifyOnReturned = form.notifyOnReturned as WorkflowAssignee[];
    if (Object.keys(f).length) chain.form = f;
  }
  if (rawChain.originParty) chain.originParty = rawChain.originParty;
  if (rawChain.namePattern) {
    problems.push(...checkPattern(rawChain.namePattern, "name", lang).map((p) => t("workflow:errors.numberPattern", { problem: p })));
    chain.namePattern = rawChain.namePattern;
  }
  const ct = rawChain.copyTarget;
  if (ct && (ct.folderId || ct.pattern)) {
    if (ct.pattern) problems.push(...checkPattern(ct.pattern, "path", lang).map((p) => t("workflow:errors.targetFolderPattern", { problem: p })));
    if (ct.folderId) {
      const tree = await FolderTree.load(db, projectId);
      if (!tree.byId.has(ct.folderId)) problems.push(t("workflow:errors.copyTargetMissing"));
    }
    chain.copyTarget = { folderId: ct.folderId, pattern: ct.pattern, ...(ct.onUnresolved ? { onUnresolved: ct.onUnresolved } : {}) };
  }
  return { steps, chain, problems: [...new Set(problems)] };
}

/** Direct assignees plus every assignee an attribute rule can resolve to (for id validation). */
export function withRuleAssignees(step: WorkflowStep): WorkflowStep {
  const rule = step.assigneeRule;
  if (!rule) return step;
  const seen = new Set(step.assignees.map((a) => `${a.type}:${a.id}`));
  const extra = [...Object.values(rule.map).flat(), ...(rule.fallback ?? [])].filter((a) => {
    const k = `${a.type}:${a.id}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { ...step, assignees: [...step.assignees, ...extra] };
}
