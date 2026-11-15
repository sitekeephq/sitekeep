/**
 * ISO-1: what a review does to the state of its files (docs/features/CDE_STATES.md "Transitions").
 *   planReviewTransition  review start / preview: the transition must be a `review` of the table
 *                         (with the workflow it names) when the project enforces the rules; the
 *                         suitability the copies get and the proposed revision per file
 *   copyCodesFor          approved copy: the target version's codes (enforced projects)
 *   reviewSuitability     the suitability chosen at the start (stored in the start action)
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  allowedSuitability,
  codeProfile,
  nextRevision,
  normaliseSuitability,
  validateCodes,
  type CdeCodeProfile,
  type CdeState,
  type ReviewCdePlanDto,
} from "@sitekeep/shared";
import type { Db } from "../db/index.js";
import { fileVersions, files, workflowActions, workflowInstances } from "../db/schema.js";
import type { FolderTree } from "../core/security/access.js";
import { msg, render } from "../i18n/index.js";
import { codeErrorMsg, loadCodeSettings } from "./codes.js";
import { cdeStateOf } from "./state.js";
import { findTransition, loadTransitionRules, workflowMsg } from "./transitions.js";

const stateMsg = (s: CdeState | null) => msg(`cde:codes.states.${s ?? "none"}`);

/** Revisions of every version of the given documents (containers), for nextRevision. */
export async function containerRevisions(db: Db, containerIds: readonly string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!containerIds.length) return out;
  const rows = await db
    .select({ containerId: files.containerId, rev: fileVersions.revisionCode })
    .from(fileVersions)
    .innerJoin(files, eq(files.id, fileVersions.fileId))
    .where(and(inArray(files.containerId, [...new Set(containerIds)]), isNull(files.deletedAt)));
  for (const r of rows) if (r.rev) out.set(r.containerId, [...(out.get(r.containerId) ?? []), r.rev]);
  return out;
}

/** The suitability a copy gets in `toState`: the chosen one, else the source's when it fits, else the first allowed. */
export function copySuitability(
  profile: CdeCodeProfile,
  toState: CdeState,
  chosen: string | null | undefined,
  source: string | null | undefined,
): string | null {
  for (const c of [chosen, source]) {
    const code = normaliseSuitability(c);
    if (code && validateCodes(profile, toState, { suitabilityCode: code }).ok) return code;
  }
  return allowedSuitability(profile, toState)[0] ?? null;
}

interface PlanRow {
  files: typeof files.$inferSelect;
  file_versions: typeof fileVersions.$inferSelect;
}

/**
 * Checks a review start against the transition table and works out the codes. `problems` are
 * reported (rendered in `lang`) only when the project enforces the rules (D-8).
 */
export async function planReviewTransition(
  db: Db,
  input: {
    projectId: string;
    tree: FolderTree;
    templateId: string;
    rows: readonly PlanRow[];
    targetFolderId: string | null;
    targetSuitability?: string | null;
    lang: string;
  },
): Promise<{ plan: ReviewCdePlanDto | null; problems: string[] }> {
  const toState = input.targetFolderId ? cdeStateOf(input.tree, input.targetFolderId) : null;
  if (!toState) return { plan: null, problems: [] };
  const rules = await loadTransitionRules(db, input.projectId);
  const settings = await loadCodeSettings(db, input.projectId);
  const profile = codeProfile(settings);
  const problems: string[] = [];
  const history = await containerRevisions(db, input.rows.map((r) => r.files.containerId));
  let required: string | null = null;
  const filesOut: ReviewCdePlanDto["files"] = [];
  const reported = new Set<string>();
  for (const r of input.rows) {
    const fromState = cdeStateOf(input.tree, r.files.folderId);
    const t = fromState === toState ? null : findTransition(rules, fromState, toState);
    if (t?.workflowTemplateId) required = t.workflowTemplateId;
    if (rules.enforce && fromState !== toState) {
      const key = `${fromState}>${toState}`;
      if (!t || (t.mode !== "review" && t.mode !== "direct")) {
        if (!reported.has(key)) problems.push(render(input.lang, msg("cde:transitions.reviewNotAllowed", { from: stateMsg(fromState), to: stateMsg(toState) })));
        reported.add(key);
      } else if (t.mode === "review" && t.workflowTemplateId && t.workflowTemplateId !== input.templateId) {
        if (!reported.has(key))
          problems.push(
            render(input.lang, msg("cde:transitions.reviewWrongWorkflow", { from: stateMsg(fromState), to: stateMsg(toState), workflow: workflowMsg(rules, t) })),
          );
        reported.add(key);
      }
    }
    filesOut.push({
      versionId: r.file_versions.id,
      fromState,
      mode: fromState === toState ? null : (t?.mode ?? null),
      currentRevision: r.file_versions.revisionCode ?? null,
      proposedRevision: rules.enforce
        ? nextRevision(profile, r.file_versions.revisionCode, fromState, toState, history.get(r.files.containerId) ?? [])
        : (r.file_versions.revisionCode ?? null),
    });
  }
  const chosen = input.targetSuitability?.trim() || null;
  if (chosen && rules.enforce) {
    const check = validateCodes(profile, toState, { suitabilityCode: chosen });
    if (!check.ok) problems.push(render(input.lang, codeErrorMsg(profile, toState, check.errors[0]!)));
  }
  const first = input.rows[0]?.file_versions.suitabilityCode ?? null;
  return {
    plan: {
      enforce: rules.enforce,
      toState,
      requiredWorkflowTemplateId: required,
      allowedSuitability: allowedSuitability(profile, toState),
      suitabilityCode: rules.enforce ? copySuitability(profile, toState, chosen, first) : (normaliseSuitability(chosen) ?? first),
      files: filesOut,
    },
    problems,
  };
}

/** The suitability chosen when the review started (start action details), or null. */
export async function reviewSuitability(db: Db, reviewId: string): Promise<string | null> {
  const [row] = await db
    .select({ details: workflowActions.details })
    .from(workflowActions)
    .innerJoin(workflowInstances, eq(workflowInstances.id, workflowActions.instanceId))
    .where(and(eq(workflowInstances.subjectType, "review"), eq(workflowInstances.subjectId, reviewId), eq(workflowActions.kind, "start")));
  const v = row?.details?.targetSuitability;
  return typeof v === "string" ? v : null;
}

/** Codes of an approved copy in `toState` of an enforced project: suitability and the next revision. */
export function copyCodesFor(
  profile: CdeCodeProfile,
  toState: CdeState,
  fromState: CdeState | null,
  chosen: string | null,
  src: { suitabilityCode: string | null; revisionCode: string | null },
  history: readonly string[],
): { suitabilityCode: string | null; revisionCode: string | null } {
  return {
    suitabilityCode: copySuitability(profile, toState, chosen, src.suitabilityCode),
    revisionCode: nextRevision(profile, src.revisionCode, fromState, toState, history),
  };
}
