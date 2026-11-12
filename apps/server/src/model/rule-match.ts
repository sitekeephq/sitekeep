/**
 * Rule engine shared by 4D link rules and 5D cost rules: a RuleMatch (storey, IFC class, property,
 * name) runs over one version's element index through the "Modele sor" matcher. A rule targets a
 * fixed activity / cost item, or (property.equalsTarget) the target whose code or WBS equals the
 * element's property value.
 */
import { z } from "zod";
import type { ModelQuery, ModelQueryFilter, RuleMatch, RulePreviewDto, RulePreviewRowDto } from "@sitekeep/shared";
import { compactFold, type ElementView, type ModelIndex } from "../model/model-index.js";
import { matchCandidates, versionCandidates, type Ctx } from "../model/query.js";
import { defaultTranslate, type Translate } from "../i18n/index.js";

export const ruleMatchSchema = z
  .object({
    classes: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
    storeys: z.array(z.string().trim().min(1).max(120)).max(50).optional(),
    nameContains: z.string().trim().max(200).optional(),
    property: z
      .object({
        key: z.string().trim().min(1).max(120),
        op: z.enum(["=", "contains"]).optional(),
        value: z.string().trim().max(200).optional(),
        equalsTarget: z.enum(["code", "wbs"]).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** Drops empty parts so stored rules look the same however they were written. */
export function normalizeMatch(m: RuleMatch): RuleMatch {
  const out: RuleMatch = {};
  const classes = [...new Set((m.classes ?? []).map((c) => c.trim()).filter(Boolean))];
  const storeys = [...new Set((m.storeys ?? []).map((s) => s.trim()).filter(Boolean))];
  if (classes.length) out.classes = classes;
  if (storeys.length) out.storeys = storeys;
  if (m.nameContains?.trim()) out.nameContains = m.nameContains.trim();
  if (m.property?.key.trim()) {
    const p = m.property;
    out.property = { key: p.key.trim() };
    if (p.equalsTarget) out.property.equalsTarget = p.equalsTarget;
    else if (p.value?.trim()) {
      out.property.op = p.op === "contains" ? "contains" : "=";
      out.property.value = p.value.trim();
    }
  }
  return out;
}

export function isEmptyMatch(m: RuleMatch): boolean {
  return !m.classes?.length && !m.storeys?.length && !m.nameContains && !m.property;
}

/** The rule as a "Modele sor" query: classes, storeys and name / property filters. */
export function ruleQuery(m: RuleMatch): ModelQuery {
  const filters: ModelQueryFilter[] = [];
  if (m.nameContains) filters.push({ field: "name", op: "contains", value: m.nameContains });
  const p = m.property;
  if (p) {
    if (p.equalsTarget || p.value === undefined || p.value === "") filters.push({ field: p.key, op: "exists" });
    else filters.push({ field: p.key, op: p.op === "contains" ? "contains" : "=", value: p.value });
  }
  const q: ModelQuery = {};
  if (m.classes?.length) q.classes = m.classes;
  if (m.storeys?.length) q.storeys = m.storeys;
  if (filters.length) q.filters = filters;
  return q;
}

export interface RuleTarget {
  /** Id the caller uses (activity code, cost item id). */
  key: string;
  code: string;
  /** Second code the property may equal (activity WBS path, cost item poz code). */
  alt?: string | null;
}

export interface RuleInput {
  id: string | null;
  /** Fixed target key; null for an equalsTarget rule. */
  target: string | null;
  match: RuleMatch;
  label: string;
}

export interface RuleResult {
  /** GlobalId → target keys. */
  assigned: Map<string, string[]>;
  unknownValues: string[];
  warnings: string[];
}

export interface Evaluation {
  rules: RuleResult[];
  /** Target key → GlobalIds (union of all rules). */
  byTarget: Map<string, Set<string>>;
}

/** Elements selected by a rule (before target lookup). */
export function matchRule(index: ModelIndex, m: RuleMatch, ctx: Ctx = { warnings: new Set() }): ElementView[] {
  return matchCandidates(versionCandidates(index), ruleQuery(m), {}, ctx).map((x) => x.el);
}

/** Runs rules over an index. `targets` resolve equalsTarget rules and check fixed targets. */
export function evaluateRules(index: ModelIndex, rules: RuleInput[], targets: RuleTarget[], translate: Translate = defaultTranslate()): Evaluation {
  const byCode = new Map<string, string>();
  const byAlt = new Map<string, string>();
  for (const t of targets) {
    const c = compactFold(t.code);
    if (c && !byCode.has(c)) byCode.set(c, t.key);
    const a = t.alt ? compactFold(t.alt) : "";
    if (a && !byAlt.has(a)) byAlt.set(a, t.key);
  }
  const known = new Set(targets.map((t) => t.key));
  const byTarget = new Map<string, Set<string>>();
  const add = (key: string, guid: string) => {
    let s = byTarget.get(key);
    if (!s) byTarget.set(key, (s = new Set()));
    s.add(guid);
  };

  const results = rules.map((rule): RuleResult => {
    const ctx: Ctx = { warnings: new Set() };
    const assigned = new Map<string, string[]>();
    const unknown = new Set<string>();
    if (!index.detailed) ctx.warnings.add(translate("sim:warnings.oldIndex"));
    const els = matchRule(index, rule.match, ctx);
    const p = rule.match.property;
    if (p?.equalsTarget) {
      const keys = index.resolveKeys(p.key).keys;
      const map = p.equalsTarget === "wbs" ? byAlt : byCode;
      for (const el of els) {
        const vals = index.values(el, keys);
        const hits = new Set<string>();
        for (const v of vals) {
          const k = map.get(compactFold(String(v)));
          if (k) hits.add(k);
        }
        if (hits.size) {
          assigned.set(el.guid, [...hits]);
          hits.forEach((k) => add(k, el.guid));
        } else if (vals.length && unknown.size < 50) unknown.add(String(vals[0]));
      }
    } else if (rule.target !== null) {
      if (!known.has(rule.target)) ctx.warnings.add(translate("sim:warnings.targetNotFound", { target: rule.target }));
      else
        for (const el of els) {
          assigned.set(el.guid, [rule.target]);
          add(rule.target, el.guid);
        }
    } else ctx.warnings.add(translate("sim:warnings.noTarget"));
    if (!els.length) ctx.warnings.add(translate("sim:warnings.noMatches"));
    return { assigned, unknownValues: [...unknown].slice(0, 10), warnings: [...ctx.warnings] };
  });
  return { rules: results, byTarget };
}

/** Counts per rule for the "Önizle" step. */
export function previewRules(
  index: ModelIndex,
  versionId: string,
  rules: RuleInput[],
  targets: RuleTarget[],
  translate: Translate = defaultTranslate(),
): RulePreviewDto {
  const ev = evaluateRules(index, rules, targets, translate);
  const perGuid = new Map<string, Set<string>>();
  for (const [key, guids] of ev.byTarget)
    for (const g of guids) {
      let s = perGuid.get(g);
      if (!s) perGuid.set(g, (s = new Set()));
      s.add(key);
    }
  const rows: RulePreviewRowDto[] = rules.map((r, i) => {
    const res = ev.rules[i]!;
    const t = new Set<string>();
    for (const keys of res.assigned.values()) keys.forEach((k) => t.add(k));
    return { id: r.id, index: i, label: r.label, matched: res.assigned.size, targets: t.size, unknownValues: res.unknownValues, warnings: res.warnings };
  });
  return {
    versionId,
    modelElements: index.size,
    matchedElements: perGuid.size,
    targets: ev.byTarget.size,
    multiTarget: [...perGuid.values()].filter((s) => s.size > 1).length,
    rules: rows,
  };
}
