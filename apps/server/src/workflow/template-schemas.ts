import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  OUTCOME_CODES,
  WORKFLOW_KINDS,
  WORKFLOW_ROLES,
  type WorkflowAssignee,
  type WorkflowStep,
} from "@sitekeep/shared";
import type { Db } from "../db/index.js";
import { companies, projectMembers, projectRoles } from "../db/schema.js";
import { isUuid } from "../core/security/access.js";
import { badRequest } from "../core/platform/http.js";
import { DEFAULT_LANGUAGE, tFor } from "../i18n/index.js";
import { checkTemplate } from "./engine.js";
import { chainSchema, chainStepFields, normaliseChainTemplate, withRuleAssignees } from "./chain-template.js";

const outcome = z.enum(OUTCOME_CODES);
const assigneeSchema = z.object({ type: z.enum(["user", "company", "role"]), id: z.string().min(1).max(64) });

export const stepSchema = z.object({
  name: z.string().trim().min(1).max(120),
  assignees: z.array(assigneeSchema).max(50),
  rule: z.enum(["any", "all"]),
  days: z.number().int().min(0).max(365),
  outcomes: z.array(outcome).max(OUTCOME_CODES.length).default([]),
  ...chainStepFields(assigneeSchema),
});

export const workflowTemplateBodySchema = z.object({
  kind: z.enum(WORKFLOW_KINDS).default("review"),
  name: z.string().trim().min(1).max(200),
  steps: z.array(stepSchema).min(1).max(20),
  finalOutcomes: z.partialRecord(outcome, outcome).default({}),
  chain: chainSchema,
});

/** Normalised template body; throws 400 listing every problem (chain rules, assignees, folders). */
export async function parseTemplateBody(db: Db, projectId: string, raw: unknown, extraProblems: string[] = [], lang: string = DEFAULT_LANGUAGE) {
  const body = workflowTemplateBodySchema.parse(raw);
  const t = await normaliseChainTemplate(db, projectId, body.steps, body.chain, lang);
  const f = t.chain.form;
  await checkSteps(
    db,
    projectId,
    t.steps,
    [...t.problems, ...extraProblems],
    [...(f?.fillers ?? []), ...(f?.notifyOnApproved ?? []), ...(f?.notifyOnReturned ?? [])],
    lang,
  );
  return {
    kind: body.kind,
    name: body.name,
    steps: t.steps,
    finalOutcomes: body.finalOutcomes,
    chainConfig: t.chain,
  };
}

/** Assignees must be project members, existing companies, built-in roles or project roles. */
export async function checkSteps(
  db: Db,
  projectId: string,
  rawSteps: WorkflowStep[],
  extraProblems: string[] = [],
  extraAssignees: WorkflowAssignee[] = [],
  lang: string = DEFAULT_LANGUAGE,
): Promise<void> {
  const tr = tFor(lang);
  const steps = rawSteps.map(withRuleAssignees);
  const problems = [...checkTemplate(steps, lang), ...extraProblems];
  const all = [...steps.flatMap((s) => s.assignees), ...extraAssignees];
  const userIds = all.filter((x) => x.type === "user").map((x) => x.id);
  const companyIds = all.filter((x) => x.type === "company").map((x) => x.id);
  const roleIds = all.filter((x) => x.type === "role").map((x) => x.id);
  if (userIds.some((x) => !isUuid(x)) || companyIds.some((x) => !isUuid(x))) problems.push(tr("workflow:errors.invalidAssigneeId"));
  else {
    if (userIds.length) {
      const rows = await db
        .select({ id: projectMembers.userId })
        .from(projectMembers)
        .where(and(eq(projectMembers.projectId, projectId), inArray(projectMembers.userId, userIds)));
      const ok = new Set(rows.map((r) => r.id));
      if (userIds.some((x) => !ok.has(x))) problems.push(tr("workflow:errors.assigneeNotMember"));
    }
    if (companyIds.length) {
      const rows = await db.select({ id: companies.id }).from(companies).where(inArray(companies.id, companyIds));
      const ok = new Set(rows.map((r) => r.id));
      if (companyIds.some((x) => !ok.has(x))) problems.push(tr("workflow:errors.assigneeCompanyMissing"));
    }
  }
  const customRoles = roleIds.filter((r) => !(WORKFLOW_ROLES as readonly string[]).includes(r));
  if (customRoles.length) {
    const valid = customRoles.every(isUuid);
    const rows = valid
      ? await db
          .select({ id: projectRoles.id })
          .from(projectRoles)
          .where(and(eq(projectRoles.projectId, projectId), inArray(projectRoles.id, customRoles)))
      : [];
    const ok = new Set(rows.map((r) => r.id));
    if (customRoles.some((r) => !ok.has(r))) problems.push(tr("workflow:errors.unknownRole"));
  }
  if (problems.length) throw badRequest(problems.join(" "), problems);
}
