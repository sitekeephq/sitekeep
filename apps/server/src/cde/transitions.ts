/**
 * ISO 19650 state transitions (ISO-1, docs/features/CDE_STATES.md "Transitions"): which write may
 * bring a document into a state. Only when the project enforces the rules (`enforce_transitions`,
 * D-8); otherwise every function here allows everything, so existing projects behave as before.
 *
 *   direct upload into a state   the transition (upload → state) must be `direct`
 *   move between two states      the transition (from → to) must be `direct`; `review` needs an
 *                                approved review, `auto` is done by the system only, a missing
 *                                pair or `forbidden` is refused
 *   review start                 the transition (source → target) must be `review`, with the
 *                                workflow the table names (review-start.ts)
 *
 * Project administrators get no silent bypass: they use the override route (transition-routes.ts),
 * which needs a reason and is audited as `cde.override`.
 */
import { eq, inArray } from "drizzle-orm";
import { DEFAULT_CDE_TRANSITIONS, type CdeState, type CdeTransitionDto } from "@sitekeep/shared";
import type { Db } from "../db/index.js";
import { cdeTransitions, projectCdeSettings, workflowTemplates } from "../db/schema.js";
import type { FolderTree } from "../core/security/access.js";
import { forbidden } from "../core/platform/http.js";
import { msg, type Msg } from "../i18n/index.js";
import { cdeStateOf } from "./state.js";

export interface TransitionRules {
  enforce: boolean;
  transitions: CdeTransitionDto[];
  archiveFolderId: string | null;
  /** Names of the workflow templates the table points at (for messages). */
  workflowNames: Map<string, string>;
}

const OFF: TransitionRules = { enforce: false, transitions: [], archiveFolderId: null, workflowNames: new Map() };

/** The project's transition rules; one query when the project does not enforce them. */
export async function loadTransitionRules(db: Db, projectId: string): Promise<TransitionRules> {
  const [row] = await db
    .select({ enforce: projectCdeSettings.enforceTransitions, archiveFolderId: projectCdeSettings.archiveFolderId })
    .from(projectCdeSettings)
    .where(eq(projectCdeSettings.projectId, projectId));
  if (!row?.enforce) return { ...OFF, archiveFolderId: row?.archiveFolderId ?? null };
  const rows = await db.select().from(cdeTransitions).where(eq(cdeTransitions.projectId, projectId));
  // An enforced project without a table uses the ISO 19650 default (D-7).
  if (!rows.length) return { enforce: true, transitions: [...DEFAULT_CDE_TRANSITIONS], archiveFolderId: row.archiveFolderId ?? null, workflowNames: new Map() };
  const transitions: CdeTransitionDto[] = rows.map((t) => ({
    fromState: t.fromState ?? null,
    toState: t.toState,
    mode: t.mode,
    workflowTemplateId: t.workflowTemplateId ?? null,
    requireReason: t.requireReason,
  }));
  const ids = [...new Set(transitions.map((t) => t.workflowTemplateId).filter((id): id is string => !!id))];
  const workflowNames = new Map<string, string>();
  if (ids.length)
    for (const w of await db.select({ id: workflowTemplates.id, name: workflowTemplates.name }).from(workflowTemplates).where(inArray(workflowTemplates.id, ids)))
      workflowNames.set(w.id, w.name);
  return { enforce: true, transitions, archiveFolderId: row.archiveFolderId ?? null, workflowNames };
}

/** The row of a pair, or null (a pair without a row is forbidden while enforcement is on). */
export function findTransition(rules: TransitionRules, from: CdeState | null, to: CdeState): CdeTransitionDto | null {
  return rules.transitions.find((t) => (t.fromState ?? null) === from && t.toState === to) ?? null;
}

/** The folder that gives `folderId` its state (itself or the nearest ancestor with one). */
export function stateFolderOf(tree: FolderTree, folderId: string): string | null {
  if (!tree.byId.has(folderId)) return null;
  for (const id of tree.ancestry(folderId).reverse()) if (tree.byId.get(id)?.state) return id;
  return null;
}

const stateMsg = (s: CdeState | null): Msg => msg(`cde:codes.states.${s ?? "none"}`);

/** "the review workflow "Ekip İçi Kontrol"" or "an approved review". */
export function workflowMsg(rules: TransitionRules, t: CdeTransitionDto | null): Msg {
  const name = t?.workflowTemplateId ? rules.workflowNames.get(t.workflowTemplateId) : null;
  return name ? msg("cde:transitions.namedWorkflow", { name }) : msg("cde:transitions.anyReview");
}

/**
 * Why a direct write (a new file, a new version, a manual copy, a module import) into a folder in
 * `state` is refused, or null. Allowed when the transition (upload → state) is `direct`.
 */
export function directWriteRefusal(rules: TransitionRules, state: CdeState | null): Msg | null {
  if (!rules.enforce || !state) return null;
  if (findTransition(rules, null, state)?.mode === "direct") return null;
  // Name the way in: a review transition into this state (the first one of the table).
  const review = rules.transitions.find((t) => t.toState === state && t.mode === "review" && t.fromState);
  if (review)
    return msg("cde:transitions.uploadNeedsReview", {
      state: stateMsg(state),
      from: stateMsg(review.fromState),
      workflow: workflowMsg(rules, review),
    });
  return msg("cde:transitions.uploadForbidden", { state: stateMsg(state) });
}

/**
 * Why moving a document from `from` to `to` is refused, or null. A move inside one state is no
 * transition; leaving the CDE (a folder without a state) is allowed from WIP only.
 */
export function moveRefusal(rules: TransitionRules, from: CdeState | null, to: CdeState | null): Msg | null {
  if (!rules.enforce || from === to) return null;
  if (to === null) return from === "wip" ? null : msg("cde:transitions.leaveForbidden", { from: stateMsg(from) });
  if (from === null) return directWriteRefusal(rules, to);
  const t = findTransition(rules, from, to);
  const params = { from: stateMsg(from), to: stateMsg(to) };
  switch (t?.mode) {
    case "direct":
      return null;
    case "review":
      return msg("cde:transitions.moveNeedsReview", { ...params, workflow: workflowMsg(rules, t) });
    case "auto":
      return msg("cde:transitions.moveAutomatic", params);
    default:
      return msg("cde:transitions.moveForbidden", params);
  }
}

/** Gate of a folder under the transition rules: the message and the folder carrying the state. */
export async function cdeWriteGate(db: Db, tree: FolderTree, folderId: string): Promise<{ message: Msg; byFolderId: string | null } | null> {
  const state = cdeStateOf(tree, folderId);
  if (!state) return null;
  const projectId = tree.byId.get(folderId)?.projectId;
  if (!projectId) return null;
  const refusal = directWriteRefusal(await loadTransitionRules(db, projectId), state);
  return refusal ? { message: refusal, byFolderId: stateFolderOf(tree, folderId) } : null;
}

/** Throws 403 when the rules refuse a direct write into the folder. */
export async function assertCdeDirectWrite(db: Db, tree: FolderTree, folderId: string): Promise<void> {
  const gate = await cdeWriteGate(db, tree, folderId);
  if (gate) throw forbidden(gate.message);
}
