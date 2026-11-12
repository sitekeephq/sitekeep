/**
 * Tiered review chains (PKF/MBE analysis, roadmap #4, #5, #7):
 * - party-labelled custom outcomes ("İDARE ŞARTLI ONAYLANDI") that map to an engine kind,
 * - stages (tiers) owned by a party with their own duration and "stop on revise" rule,
 * - assignees resolved from a file attribute / naming field (one template for all disciplines),
 * - smart copy target paths and review numbers built from naming / attribute fields.
 *
 * Everything here is optional on top of the base workflow vocabulary in workflow.ts; templates
 * without these fields behave exactly as before.
 */
import {
  OUTCOME_LABELS_TR,
  OUTCOME_SEVERITY,
  type OutcomeCode,
  type WorkflowAssignee,
} from "./workflow-primitives.js";
import { SHARED_DEFAULT_LANGUAGE, labelText, sharedText } from "../platform/i18n.js";

type ReviewChainStep = {
  name: string;
  outcomes: OutcomeCode[];
  outcomeOptions?: OutcomeOption[];
  stage?: number;
};

// ---- Custom outcomes ------------------------------------------------------------------------

/** What an outcome means to the engine. Labels are free; the kind drives the logic. */
export const OUTCOME_KINDS = ["approved", "approved_with_comments", "info", "revise", "rejected"] as const;
export type OutcomeKind = (typeof OUTCOME_KINDS)[number];

export const OUTCOME_KIND_LABELS_TR: Record<OutcomeKind, string> = {
  approved: "Onay",
  approved_with_comments: "Şartlı / Notlu Onay",
  info: "Bilgi (görüldü)",
  revise: "Revize (iade)",
  rejected: "Red",
};

/** The base outcome code each kind is stored as (approval status, severity, copy rule). */
export const OUTCOME_KIND_CODE: Record<OutcomeKind, OutcomeCode> = {
  approved: "approved",
  approved_with_comments: "approved_with_comments",
  info: "reviewed",
  revise: "revise_resubmit",
  rejected: "rejected",
};

export const OUTCOME_CODE_KIND: Record<OutcomeCode, OutcomeKind> = {
  approved: "approved",
  approved_with_comments: "approved_with_comments",
  reviewed: "info",
  revise_resubmit: "revise",
  rejected: "rejected",
};

/** One answer a reviewer can pick in a step, e.g. { code: "IDR-B", label: "İDARE ŞARTLI ONAYLANDI", kind: "approved_with_comments" }. */
export interface OutcomeOption {
  code: string;
  label: string;
  kind: OutcomeKind;
}

/** Options of a step: its custom list, or the base codes with their default labels (in `lang`). */
export function stepOutcomeOptions(step: Pick<ReviewChainStep, "outcomes" | "outcomeOptions">, lang: string = SHARED_DEFAULT_LANGUAGE): OutcomeOption[] {
  if (step.outcomeOptions?.length) return step.outcomeOptions;
  return step.outcomes.map((c) => ({ code: c, label: labelText(lang, "outcome", c), kind: OUTCOME_CODE_KIND[c] }));
}

/** The option a submitted code stands for in this step, or null when it is not allowed. */
export function resolveOutcomeOption(
  step: Pick<ReviewChainStep, "outcomes" | "outcomeOptions">,
  code: string,
): (OutcomeOption & { base: OutcomeCode }) | null {
  const opt = stepOutcomeOptions(step).find((o) => o.code === code);
  return opt ? { ...opt, base: OUTCOME_KIND_CODE[opt.kind] } : null;
}

/** Display label of a code given in a step (falls back to the base label in `lang` or the code). */
export function outcomeLabel(
  step: Pick<ReviewChainStep, "outcomes" | "outcomeOptions"> | undefined,
  code: string | null | undefined,
  lang: string = SHARED_DEFAULT_LANGUAGE,
): string | null {
  if (!code) return null;
  const opt = step?.outcomeOptions?.find((o) => o.code === code);
  if (opt) return opt.label;
  return Object.hasOwn(OUTCOME_LABELS_TR, code) ? labelText(lang, "outcome", code) : code;
}

export function kindSeverity(kind: OutcomeKind): number {
  return OUTCOME_SEVERITY[OUTCOME_KIND_CODE[kind]];
}

/** Base outcome codes used by a list of options (kept in WorkflowStep.outcomes for older clients). */
export function baseCodesOf(options: readonly OutcomeOption[]): OutcomeCode[] {
  const order: OutcomeCode[] = ["approved", "approved_with_comments", "reviewed", "revise_resubmit", "rejected"];
  const used = new Set(options.map((o) => OUTCOME_KIND_CODE[o.kind]));
  return order.filter((c) => used.has(c));
}

// ---- Parties and stages ---------------------------------------------------------------------

export const REVIEW_PARTIES = ["designer", "contractor", "consultant", "client", "other"] as const;
export type ReviewParty = (typeof REVIEW_PARTIES)[number];

export const REVIEW_PARTY_LABELS_TR: Record<ReviewParty, string> = {
  designer: "Tasarımcı",
  contractor: "Yüklenici",
  consultant: "Müşavir",
  client: "İdare",
  other: "Diğer",
};

/**
 * Default party-labelled outcome list, as used in MBE (onay / şartlı / iade / red / bilgi):
 * "İDARE ŞARTLI ONAYLANDI". The labels are written into the template in `lang` (the author's).
 */
export function partyOutcomeOptions(
  party: ReviewParty,
  kinds: readonly OutcomeKind[] = ["approved", "approved_with_comments", "revise", "rejected"],
  lang: string = SHARED_DEFAULT_LANGUAGE,
): OutcomeOption[] {
  const letter: Record<OutcomeKind, string> = { approved: "A", approved_with_comments: "B", info: "I", revise: "C", rejected: "D" };
  const codePrefix = { designer: "TAS-", contractor: "YUK-", consultant: "MUS-", client: "IDR-", other: "" }[party];
  return kinds.map((k) => {
    const outcome = sharedText(lang, `chains.partyOutcome.${k}`);
    return {
      code: `${codePrefix}${letter[k]}`,
      label: party === "other" ? outcome : sharedText(lang, "chains.partyOutcomeLabel", { party: sharedText(lang, `chains.partyPrefix.${party}`), outcome }),
      kind: k,
    };
  });
}

export type StageReviseRule = "stop" | "continue";

export const STAGE_REVISE_LABELS_TR: Record<StageReviseRule, string> = {
  stop: "Revize/red alan dosya zinciri durdurur, başlatana iade edilir",
  continue: "Revize/red alsa da sonraki kademeye geçer",
};

/** A tier of the chain (e.g. "Yüklenici", 7 days). Steps join a stage with WorkflowStep.stage. */
export interface ReviewStage {
  name: string;
  party: ReviewParty;
  /** Calendar days for the whole stage, counted from its first step; 0 = no stage limit. */
  days: number;
  /** What happens to a file that gets a revise / reject kind in this stage. */
  onRevise: StageReviseRule;
}

// ---- Attribute-resolved assignees -----------------------------------------------------------

/**
 * Step assignees chosen by a file field, so one template serves every discipline:
 * { type: "by_attribute", attribute: "Disiplin", map: { S: [{ type: "company", id }] } }.
 * The field is read from the file attributes first, then from the naming standard fields of
 * the file name. Resolved when the review starts; every file of one review must resolve to the
 * same assignees (otherwise the start is refused and lists the groups).
 */
export interface AttributeAssigneeRule {
  type: "by_attribute";
  attribute: string;
  map: Record<string, WorkflowAssignee[]>;
  /** Used when the file value is missing or not in the map. */
  fallback?: WorkflowAssignee[];
}

/** Assignees for one value of the rule; null when it cannot be resolved. */
export function resolveAttributeAssignees(rule: AttributeAssigneeRule, value: string | null | undefined): WorkflowAssignee[] | null {
  const v = value?.trim();
  if (v && rule.map[v]?.length) return rule.map[v]!;
  if (rule.fallback?.length) return rule.fallback;
  return null;
}

// ---- Patterns (copy target path, review number) ---------------------------------------------

/** Copy rule of a template: base folder + sub path from file fields, e.g. "{Bölge}/{Disiplin}/{Tip}". */
export interface CopyTargetRule {
  folderId: string | null;
  pattern: string;
  /** "fail": a file with a missing field is not copied (default); "base": it lands in the base folder. */
  onUnresolved?: "fail" | "base";
}

/** Form flows: who may fill a form of the template and who is told about the result. */
export interface FormFlowConfig {
  /** Who may start (fill) a form of the template; empty = every project member. */
  fillers?: WorkflowAssignee[];
  /** Told when the form is approved ("onaylanınca müşavire bilgi gider"). */
  notifyOnApproved?: WorkflowAssignee[];
  /** Told when the form goes back to the filler. */
  notifyOnReturned?: WorkflowAssignee[];
}

/** Template-level chain options (workflow_templates.chain_config). */
export interface ReviewChainConfig {
  stages?: ReviewStage[];
  /** Party that starts the chain; shown as the first, already completed link ("Tasarımcı ✓"). */
  originParty?: ReviewParty | null;
  /** Review number pattern, e.g. "{Proje}-{Tip}-{0000}"; the counter is unique per resolved prefix. */
  namePattern?: string | null;
  copyTarget?: CopyTargetRule | null;
  /** Form flows (workflow kind "form"). */
  form?: FormFlowConfig;
}

const FIELD_RE = /\{([^{}]+)\}/g;
const COUNTER_RE = /^0+$/;

/** Field names used by a pattern (counter tokens like {0000} excluded). */
export function patternFields(pattern: string): string[] {
  const out: string[] = [];
  for (const m of pattern.matchAll(FIELD_RE)) {
    const name = m[1]!.trim();
    if (!COUNTER_RE.test(name) && !out.includes(name)) out.push(name);
  }
  return out;
}

export interface RenderedPattern {
  text: string;
  unresolved: string[];
}

/**
 * Replaces {Field} with values. Counter tokens ({0000}) are kept as they are; use
 * applyCounter afterwards. Unresolved fields stay as "{Field}" and are listed.
 */
export function renderPattern(pattern: string, values: Readonly<Record<string, string | undefined>>): RenderedPattern {
  const unresolved: string[] = [];
  const text = pattern.replace(FIELD_RE, (whole, raw: string) => {
    const name = raw.trim();
    if (COUNTER_RE.test(name)) return whole;
    const v = values[name]?.trim();
    if (!v) {
      if (!unresolved.includes(name)) unresolved.push(name);
      return whole;
    }
    return v;
  });
  return { text, unresolved };
}

/** Digits of the counter token ({0000} → 4), or 0 when the pattern has none. */
export function counterDigits(pattern: string): number {
  for (const m of pattern.matchAll(FIELD_RE)) if (COUNTER_RE.test(m[1]!.trim())) return m[1]!.trim().length;
  return 0;
}

/** Replaces the counter token with the zero-padded number. */
export function applyCounter(text: string, n: number): string {
  return text.replace(/\{(0+)\}/, (_, zeros: string) => String(n).padStart(zeros.length, "0"));
}

/** Folder path segments of a rendered target pattern (empty segments dropped, unsafe characters replaced). */
export function pathSegments(text: string): string[] {
  return text
    .split("/")
    .map((s) => s.replace(/[\\:*?"<>|]/g, "_").trim())
    .filter((s) => s && s !== "." && s !== "..");
}

/** Problems in a pattern itself. */
export function checkPattern(pattern: string, kind: "path" | "name", lang: string = SHARED_DEFAULT_LANGUAGE): string[] {
  const problems: string[] = [];
  if (!pattern.trim()) problems.push(sharedText(lang, "chains.pattern.empty"));
  const opens = (pattern.match(/\{/g) ?? []).length;
  const closes = (pattern.match(/\}/g) ?? []).length;
  if (opens !== closes) problems.push(sharedText(lang, "chains.pattern.braces"));
  const counters = [...pattern.matchAll(FIELD_RE)].filter((m) => COUNTER_RE.test(m[1]!.trim())).length;
  if (kind === "name" && counters !== 1) problems.push(sharedText(lang, "chains.pattern.counter"));
  if (kind === "path" && counters) problems.push(sharedText(lang, "chains.pattern.noCounter"));
  if (kind === "path" && pattern.includes("..")) problems.push(sharedText(lang, "chains.pattern.dotDot"));
  return problems;
}

// ---- Chain status ---------------------------------------------------------------------------

export type ChainCellState = "done" | "current" | "pending" | "returned" | "skipped";

export interface ChainCellDto {
  name: string;
  party: ReviewParty | null;
  state: ChainCellState;
  /** Base outcome of the stage (last judged step), when done or returned. */
  outcome: OutcomeCode | null;
  label: string | null;
  /** Current stage only. */
  dueAt?: string | null;
  overdue?: boolean;
}

/** Stages as a flat list: configured stages, or one stage per step for plain templates. */
export interface EffectiveStage {
  name: string;
  party: ReviewParty | null;
  days: number;
  onRevise: StageReviseRule;
  steps: number[];
}

export function effectiveStages(steps: readonly ReviewChainStep[], stages: readonly ReviewStage[] | undefined): EffectiveStage[] {
  if (!stages?.length) return steps.map((s, i) => ({ name: s.name, party: null, days: 0, onRevise: "continue", steps: [i] }));
  const out: EffectiveStage[] = stages.map((s) => ({ name: s.name || REVIEW_PARTY_LABELS_TR[s.party], party: s.party, days: s.days, onRevise: s.onRevise, steps: [] }));
  steps.forEach((s, i) => {
    const k = s.stage ?? 0;
    (out[k] ?? out[out.length - 1]!).steps.push(i);
  });
  return out.filter((s) => s.steps.length);
}

/** Stage index (in effectiveStages) of a step. */
export function stageIndexOfStep(stages: readonly EffectiveStage[], stepIndex: number): number {
  return stages.findIndex((s) => s.steps.includes(stepIndex));
}

function cellSymbol(c: ChainCellDto): string {
  switch (c.state) {
    case "current":
      return "⧗";
    case "pending":
      return "·";
    case "skipped":
      return "–";
    case "returned":
      return "✗";
    default:
      if (c.outcome === "reviewed") return "ℹ";
      if (c.outcome === "revise_resubmit" || c.outcome === "rejected") return "✗";
      return "✓";
  }
}

/** "Tasarımcı ✓ → Yüklenici ✓ → Müşavir ⧗ → İdare ·" or, compact, "T✓ Y✓ M⧗ İ·". */
export function chainText(cells: readonly ChainCellDto[], compact = false): string {
  if (compact) return cells.map((c) => `${c.name.trim().charAt(0).toLocaleUpperCase("tr-TR")}${cellSymbol(c)}`).join(" ");
  return cells.map((c) => `${c.name} ${cellSymbol(c)}`).join(" → ");
}

export { cellSymbol as chainCellSymbol };
