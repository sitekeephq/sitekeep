/**
 * Review chains on top of the pure engine (engine.ts stays untouched): custom outcome codes,
 * stage deadlines and "stop on revise", per-file chain status, attribute-resolved assignees and
 * pattern rendering. No database access here.
 */
import {
  OUTCOME_SEVERITY,
  effectiveStages,
  outcomeLabel,
  renderPattern,
  resolveAttributeAssignees,
  stageIndexOfStep,
  validateName,
  type ChainCellDto,
  type FinalOutcomeMap,
  type NamingStandard,
  type OutcomeCode,
  type ReviewChainConfig,
  type WorkflowAssignee,
  type WorkflowStatus,
  type WorkflowStep,
} from "@sitekeep/shared";
import { DEFAULT_LANGUAGE, labelFor, tFor } from "../i18n/index.js";
import { stepDueDate, type StepSubmission } from "./engine.js";

/** The parts of a template snapshot the chain logic reads. */
export interface ChainTemplate {
  steps: WorkflowStep[];
  finalOutcomes: FinalOutcomeMap;
  chain?: ReviewChainConfig;
}

// ---- Outcomes -------------------------------------------------------------------------------

/** A submission with the codes the reviewer picked (custom or base) next to their base codes. */
export interface ChainSubmission extends StepSubmission {
  codes: Record<string, string>;
}

export interface CombinedOutcome {
  base: OutcomeCode;
  code: string;
}

/**
 * Step result per item, like engine.combineStepOutcomes but keeping the picked code:
 * "any" → the first submission decides; "all" → the most severe kind wins (first one on ties).
 */
export function combineChainOutcomes(step: WorkflowStep, submissions: readonly ChainSubmission[]): Record<string, CombinedOutcome> {
  const used = step.rule === "any" ? submissions.slice(0, 1) : submissions;
  const out: Record<string, CombinedOutcome> = {};
  for (const s of used)
    for (const [item, base] of Object.entries(s.outcomes)) {
      const cur = out[item];
      if (!cur || OUTCOME_SEVERITY[base] > OUTCOME_SEVERITY[cur.base]) out[item] = { base, code: s.codes[item] ?? base };
    }
  return out;
}

/** True when a file with this result leaves the chain (its stage is set to stop on revise / reject). */
export function stopsChain(t: ChainTemplate, stepIndex: number, base: OutcomeCode): boolean {
  const stages = t.chain?.stages;
  if (!stages?.length) return false;
  const stage = stages[t.steps[stepIndex]?.stage ?? 0];
  return stage?.onRevise === "stop" && (base === "revise_resubmit" || base === "rejected");
}

/** Final label of a file: the custom label of the deciding step's code, unless finalOutcomes remapped it. */
export function finalLabelOf(t: ChainTemplate, stepIndex: number, code: string | undefined, base: OutcomeCode, final: OutcomeCode | null): string | null {
  if (!final || final !== base || !code) return null;
  const step = t.steps[stepIndex];
  return step?.outcomeOptions?.some((o) => o.code === code) ? outcomeLabel(step, code) : null;
}

// ---- Deadlines ------------------------------------------------------------------------------

/**
 * Due dates when the instance enters `to` (coming from `from`, null at start). A new stage
 * starts its own clock; the step due date never goes past the stage deadline.
 */
export function enterStep(
  t: ChainTemplate,
  from: number | null,
  to: number,
  now: Date,
  currentStageDue: Date | null,
): { stepDueAt: Date | null; stageDueAt: Date | null } {
  const step = t.steps[to]!;
  const stepDue = stepDueDate(now, step.days);
  const stages = t.chain?.stages;
  if (!stages?.length) return { stepDueAt: stepDue, stageDueAt: null };
  const stageNo = step.stage ?? 0;
  const sameStage = from !== null && (t.steps[from]?.stage ?? 0) === stageNo;
  const stageDue = sameStage ? currentStageDue : stepDueDate(now, stages[stageNo]?.days ?? 0);
  const due = stepDue && stageDue ? (stepDue < stageDue ? stepDue : stageDue) : (stepDue ?? stageDue);
  return { stepDueAt: due, stageDueAt: stageDue };
}

// ---- Chain status ---------------------------------------------------------------------------

export interface ChainInstanceState {
  status: WorkflowStatus;
  stepIndex: number;
  stepDueAt: Date | null;
  stageDueAt?: Date | null;
}

export interface ChainFileState {
  stepResults: Record<string, OutcomeCode>;
  stepCodes?: Record<string, string> | null;
  stoppedAtStep?: number | null;
}

/** Per-stage status of one file: Tasarımcı ✓ → Yüklenici ✓ → Müşavir ⧗ → İdare ·. */
export function fileChain(
  t: ChainTemplate,
  inst: ChainInstanceState,
  rf: ChainFileState,
  now = new Date(),
  lang: string = DEFAULT_LANGUAGE,
): ChainCellDto[] {
  const stages = effectiveStages(t.steps, t.chain?.stages);
  const cells: ChainCellDto[] = [];
  const origin = t.chain?.originParty;
  if (origin) cells.push({ name: labelFor(lang, "reviewParty", origin), party: origin, state: "done", outcome: null, label: null });
  const stopped = rf.stoppedAtStep ?? null;
  const judged = (i: number) => rf.stepResults[String(i)];
  const labelAt = (i: number) => outcomeLabel(t.steps[i], rf.stepCodes?.[String(i)] ?? judged(i), lang);
  for (const st of stages) {
    const base = { name: st.name, party: st.party, outcome: null, label: null } as const;
    const last = [...st.steps].reverse().find((i) => judged(i));
    if (stopped !== null && st.steps.includes(stopped)) {
      cells.push({ ...base, state: "returned", outcome: judged(stopped) ?? null, label: labelAt(stopped) });
      continue;
    }
    if (stopped !== null && st.steps[0]! > stopped) {
      cells.push({ ...base, state: "skipped" });
      continue;
    }
    if (st.steps.every((i) => judged(i))) {
      cells.push({ ...base, state: "done", outcome: judged(last!) ?? null, label: labelAt(last!) });
      continue;
    }
    if (inst.status === "running" && st.steps.includes(inst.stepIndex)) {
      const due = inst.stageDueAt ?? inst.stepDueAt;
      const stepDue = inst.stepDueAt;
      cells.push({
        ...base,
        state: "current",
        dueAt: due?.toISOString() ?? null,
        overdue: !!stepDue && stepDue.getTime() < now.getTime(),
      });
      continue;
    }
    cells.push({ ...base, state: inst.status === "running" ? "pending" : "skipped" });
  }
  return cells;
}

/** True when the template defines stages (the chain view adds something over the step columns). */
export function hasStages(t: ChainTemplate): boolean {
  return !!t.chain?.stages?.length;
}

export { stageIndexOfStep, effectiveStages };

// ---- File fields ----------------------------------------------------------------------------

/**
 * Values a pattern or an attribute rule can use for one file: naming standard fields parsed
 * from the name (fields that parse correctly), overridden by the file's attributes.
 */
export function fileFieldValues(
  name: string,
  attributes: Readonly<Record<string, string>>,
  standard: NamingStandard | null,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (standard) for (const f of validateName(standard, name).fields) if (f.ok && f.value) out[f.field] = f.value;
  for (const [k, v] of Object.entries(attributes)) if (v?.trim()) out[k] = v.trim();
  return out;
}

/** Built-in fields for review number patterns. */
export function builtinFields(projectCode: string, now: Date): Record<string, string> {
  return {
    Proje: projectCode,
    Yıl: String(now.getFullYear()),
    Ay: String(now.getMonth() + 1).padStart(2, "0"),
    Gün: String(now.getDate()).padStart(2, "0"),
  };
}

export interface FileFields {
  name: string;
  values: Record<string, string>;
}

const assigneeKey = (list: readonly WorkflowAssignee[]) =>
  list
    .map((a) => `${a.type}:${a.id}`)
    .sort()
    .join(",");

/**
 * Resolves "by_attribute" assignee rules for the files of one review. Every file must resolve,
 * and to the same assignees; otherwise problems list the files per group (the start is refused).
 */
export function resolveAssigneeRules(
  steps: readonly WorkflowStep[],
  files: readonly FileFields[],
  lang: string = DEFAULT_LANGUAGE,
): { steps: WorkflowStep[]; problems: string[] } {
  const t = tFor(lang);
  const problems: string[] = [];
  const out = steps.map((step) => {
    const rule = step.assigneeRule;
    if (!rule) return step;
    const groups = new Map<string, { assignees: WorkflowAssignee[]; files: string[]; values: Set<string> }>();
    const unresolved: string[] = [];
    for (const f of files) {
      const value = f.values[rule.attribute];
      const list = resolveAttributeAssignees(rule, value);
      if (!list) {
        unresolved.push(value ? `${f.name} (${value})` : f.name);
        continue;
      }
      const key = assigneeKey(list);
      const g = groups.get(key) ?? { assignees: list, files: [], values: new Set<string>() };
      g.files.push(f.name);
      g.values.add(value?.trim() || "—");
      groups.set(key, g);
    }
    if (unresolved.length) {
      problems.push(t("workflow:errors.attributeUnmapped", { step: step.name, attribute: rule.attribute, files: unresolved.join(", ") }));
      return step;
    }
    if (groups.size > 1) {
      const text = [...groups.values()].map((g) => `${[...g.values].join("/")} → ${g.files.join(", ")}`).join("; ");
      problems.push(t("workflow:errors.attributeGroups", { step: step.name, attribute: rule.attribute, groups: text }));
      return step;
    }
    const g = [...groups.values()][0];
    if (!g) return step;
    const seen = new Set(step.assignees.map((a) => `${a.type}:${a.id}`));
    const extra = g.assignees.filter((a) => !seen.has(`${a.type}:${a.id}`));
    return { ...step, assignees: [...step.assignees, ...extra], resolvedBy: { attribute: rule.attribute, values: [...g.values] } };
  });
  return { steps: out, problems };
}

/**
 * Prefix of the review number (counter token kept) for a set of files. Every file must fill
 * every field and give the same prefix.
 */
export function resolveNamePrefix(
  pattern: string,
  files: readonly FileFields[],
  builtins: Record<string, string>,
  lang: string = DEFAULT_LANGUAGE,
): { prefix: string | null; problems: string[] } {
  const t = tFor(lang);
  const problems: string[] = [];
  const prefixes = new Map<string, string[]>();
  const sets = files.length ? files : [{ name: "", values: {} }];
  for (const f of sets) {
    const r = renderPattern(pattern, { ...builtins, ...f.values });
    if (r.unresolved.length) {
      const fields = r.unresolved.map((x) => `{${x}}`).join(", ");
      problems.push(
        f.name
          ? t("workflow:errors.reviewNumberFieldsMissingFile", { fields, file: f.name })
          : t("workflow:errors.reviewNumberFieldsMissing", { fields }),
      );
      continue;
    }
    prefixes.set(r.text, [...(prefixes.get(r.text) ?? []), f.name]);
  }
  if (problems.length) return { prefix: null, problems };
  if (prefixes.size > 1) {
    const text = [...prefixes.entries()].map(([p, names]) => `${p} → ${names.join(", ")}`).join("; ");
    return { prefix: null, problems: [t("workflow:errors.reviewNumberPrefixes", { groups: text })] };
  }
  return { prefix: [...prefixes.keys()][0]!, problems };
}
