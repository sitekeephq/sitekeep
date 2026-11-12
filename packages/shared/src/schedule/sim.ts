/**
 * 4D / 5D simulation (docs/features/4D_5D.md): rules that link IFC elements to activities (4D) and to
 * cost items (5D), playback status and progress at a date, cost summaries and cash flow.
 * Rules run over the server-side element index (storey, IFC class, properties, name); the
 * browser never loads geometry to build them.
 */
import { addDays, daysBetween, type ActivityDates } from "./schedule.js";
import { ifcClassLabel } from "../coordination/model-query.js";
import { sharedText, SHARED_DEFAULT_LANGUAGE } from "../platform/i18n.js";

/** Planned = baseline dates only; actual = reported progress up to the data date, then the current plan. */
export type SimMode = "planned" | "actual";

export const SIM_MODE_LABELS_TR: Record<SimMode, string> = {
  planned: "Planlanan",
  actual: "Gerçekleşen",
};

// ---------------------------------------------------------------------------------------------
// Rules

/**
 * Element selection of a rule. Every given part must hold (AND). A property rule with
 * `equalsTarget` maps each element to the activity (or cost item) whose code / WBS equals the
 * property value: one rule links the whole model.
 */
export interface RuleMatch {
  /** IFC classes ("IfcSlab" also matches IfcSlabStandardCase). */
  classes?: string[];
  /** Storey names (exact, else partial match). */
  storeys?: string[];
  /** Element name contains (case and Turkish letters ignored). */
  nameContains?: string;
  property?: {
    /** Property name ("WBS", "Pset_X.AssemblyCode"). */
    key: string;
    op?: "=" | "contains";
    value?: string;
    /** Value must equal the target's code (activity or cost item) or the activity's WBS. */
    equalsTarget?: "code" | "wbs";
  };
}

export const RULE_TARGET_LABELS_TR: Record<"code" | "wbs", string> = {
  code: "Faaliyet Kodu",
  wbs: "İş Kırılımı (WBS)",
};

/** "Kat: Kat 2 · Sınıf: Döşeme · Ad içerir "perde" · WBS = faaliyet kodu" */
export function ruleMatchLabel(m: RuleMatch, target: "activity" | "cost" = "activity", lang: string = SHARED_DEFAULT_LANGUAGE): string {
  const parts: string[] = [];
  if (m.storeys?.length) parts.push(sharedText(lang, "sim.rule.storeys", { value: m.storeys.join(", ") }));
  if (m.classes?.length) parts.push(sharedText(lang, "sim.rule.classes", { value: m.classes.map((c) => ifcClassLabel(c, lang)).join(", ") }));
  if (m.nameContains) parts.push(sharedText(lang, "sim.rule.nameContains", { value: m.nameContains }));
  const p = m.property;
  if (p) {
    if (p.equalsTarget)
      parts.push(sharedText(lang, `sim.rule.${target === "cost" ? "equalsCostCode" : p.equalsTarget === "wbs" ? "equalsActivityWbs" : "equalsActivityCode"}`, { key: p.key }));
    else if (p.value !== undefined && p.value !== "")
      parts.push(sharedText(lang, p.op === "contains" ? "sim.rule.propertyContains" : "sim.rule.propertyEquals", { key: p.key, value: p.value }));
    else parts.push(sharedText(lang, "sim.rule.propertyExists", { key: p.key }));
  }
  return parts.join(" · ") || sharedText(lang, "sim.rule.allElements");
}

export interface RulePreviewRowDto {
  /** Stored rule id, or null for a draft. */
  id: string | null;
  index: number;
  label: string;
  /** Elements the rule selects. */
  matched: number;
  /** Targets (activities / cost items) that got elements. */
  targets: number;
  /** Property values without a matching target (equalsTarget rules), first few. */
  unknownValues: string[];
  warnings: string[];
  /** Cost rules: amount and elements without the base quantity. */
  amount?: number;
  missing?: number;
}

export interface RulePreviewDto {
  versionId: string;
  modelElements: number;
  /** Distinct elements selected by any rule. */
  matchedElements: number;
  targets: number;
  /** Elements that go to more than one target. */
  multiTarget: number;
  rules: RulePreviewRowDto[];
}

// ---------------------------------------------------------------------------------------------
// 5D cost

export const COST_UNITS = ["m", "m²", "m³", "adet", "kg", "ton"] as const;

export type CostUnit = (typeof COST_UNITS)[number];

export interface CostLineDto {
  guid: string;
  ruleId: string;
  itemCode: string;
  itemDescription: string;
  unit: CostUnit;
  /** Quantity after the multiplier; null when the element has no such base quantity. */
  quantity: number | null;
  unitPrice: number;
  amount: number;
  currency: string;
  activityCodes: string[];
}

/** Per element totals of one model version for the "Maliyet" colour mode. */
export interface ElementCostsDto {
  versionId: string;
  currency: string;
  total: number;
  max: number;
  /** GlobalId → amount. */
  elements: Record<string, number>;
  /** Elements without a base quantity. */
  missing: string[];
}

export interface CashflowPointDto {
  date: string;
  /** Cumulative planned cost (baseline dates). */
  planned: number;
  /** Cumulative forecast (actual up to the data date, then the current dates). */
  forecast: number;
  /** Cumulative earned cost up to the data date; null after it. */
  actual: number | null;
}

export interface CashflowDto {
  scheduleId: string | null;
  dataDate: string | null;
  step: "day" | "week" | "month";
  currency: string;
  total: number;
  /** Cost tied to dated activities (spread over time). */
  scheduled: number;
  /** Cost without an activity (not in the curve). */
  unscheduled: number;
  points: CashflowPointDto[];
}

/** Share (0…1) of [start, finish] (inclusive days) elapsed at the end of `t`. */
export function elapsedShare(start: string, finish: string, t: string): number {
  if (t < start) return 0;
  if (t >= finish) return 1;
  return Math.min(1, Math.max(0, (daysBetween(start, t) + 1) / (daysBetween(start, finish) + 1)));
}

/**
 * Earned % at `t`: the reported % spread linearly from the actual start to the actual finish
 * (or the data date `ref`).
 */
export function earnedPercentAt(a: ActivityDates, t: string, ref: string): number {
  const pct = a.percentComplete ?? 0;
  if (pct <= 0) return 0;
  if (a.actualFinish && a.actualFinish <= t) return pct;
  const start = a.actualStart ?? a.start;
  if (!start) return t >= ref ? pct : 0;
  const end = a.actualFinish ?? (ref >= start ? ref : start);
  return pct * elapsedShare(start, end, t);
}

/** Forecast share (0…1) at `t`: earned up to the data date, then the rest along the current dates. */
export function forecastShareAt(a: ActivityDates, t: string, ref: string): number {
  if (t <= ref) return earnedPercentAt(a, t, ref) / 100;
  const done = earnedPercentAt(a, ref, ref) / 100;
  if (!a.start || !a.finish) return done;
  const restStart = a.start > ref ? a.start : addDays(ref, 1);
  const rest = a.finish < restStart ? 1 : elapsedShare(restStart, a.finish, t);
  return done + (1 - done) * rest;
}
