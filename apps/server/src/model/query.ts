/**
 * "Modele sor" query engine: a validated ModelQuery (JSON, never code) runs over one version's
 * element index, or over the changed elements of a comparison. Plain TypeScript, deterministic.
 */
import { z } from "zod";
import {
  MODEL_AGG_OPS,
  MODEL_CHANGE_KINDS,
  MODEL_QUERY_MAX_ELEMENTS,
  MODEL_QUERY_MAX_FILTERS,
  MODEL_QUERY_OPS,
  foldPlain,
  ifcClassLabel,
  modelFieldLabel,
  modelQueryChips,
  type ModelChangeKind,
  type ModelQuery,
  type ModelQueryElement,
  type ModelQueryFilter,
  type ModelQueryResultDto,
} from "@sitekeep/shared";
import { builtinField, compactFold, type BuiltinField, type ElementView, type ModelIndex } from "./model-index.js";
import { DEFAULT_LANGUAGE, intlLocale, labelFor, msg, render, tFor } from "../i18n/index.js";

const field = z.string().trim().min(1).max(120);
const scalar = z.union([z.string().max(200), z.number(), z.boolean()]);

export const modelQuerySchema = z
  .object({
    classes: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
    storeys: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
    filters: z
      .array(z.object({ field, op: z.enum(MODEL_QUERY_OPS), value: scalar.optional() }).strict())
      .max(MODEL_QUERY_MAX_FILTERS)
      .optional(),
    groupBy: z.array(field).max(2).optional(),
    aggregate: z.object({ op: z.enum(MODEL_AGG_OPS), field: field.optional() }).strict().optional(),
    change: z.array(z.enum(MODEL_CHANGE_KINDS)).max(3).optional(),
    limit: z.number().int().min(1).max(MODEL_QUERY_MAX_ELEMENTS).optional(),
  })
  .strict()
  .superRefine((q, ctx) => {
    (q.filters ?? []).forEach((f, i) => {
      if (f.op !== "exists" && f.op !== "missing" && (f.value === undefined || f.value === ""))
        ctx.addIssue({ code: "custom", path: ["filters", i, "value"], message: render(DEFAULT_LANGUAGE, msg("model:errors.valueRequired", { op: f.op })) });
    });
    if (q.aggregate && q.aggregate.op !== "count" && !q.aggregate.field)
      ctx.addIssue({ code: "custom", path: ["aggregate", "field"], message: render(DEFAULT_LANGUAGE, msg("model:errors.fieldRequired", { op: q.aggregate.op })) });
  });

/** Drops empty parts so stored / compared queries look the same. */
export function normalizeQuery(q: ModelQuery): ModelQuery {
  const out: ModelQuery = {};
  if (q.change?.length) out.change = [...new Set(q.change)];
  if (q.classes?.length) out.classes = [...new Set(q.classes)];
  if (q.storeys?.length) out.storeys = [...new Set(q.storeys)];
  if (q.filters?.length) out.filters = q.filters.map((f) => (f.op === "exists" || f.op === "missing" ? { field: f.field, op: f.op } : f));
  if (q.groupBy?.length) out.groupBy = q.groupBy;
  if (q.aggregate && !(q.aggregate.op === "count" && !q.aggregate.field)) out.aggregate = q.aggregate;
  if (q.limit) out.limit = q.limit;
  return out;
}

export interface Candidate {
  index: ModelIndex;
  guid: string;
  versionId?: string;
  modelName?: string;
  change?: ModelChangeKind;
}

const MAX_GUIDS = 20_000;
const MAX_TABLE_ROWS = 200;
const DEFAULT_LIMIT = 200;

type Scalar = string | number | boolean;

function toNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const m = /^(-?\d+(?:\.\d+)?)\s*(mm|cm|m|m2|m²|m3|m³|kg|adet)?$/i.exec(v.trim().replace(",", "."));
    return m ? Number(m[1]) : null;
  }
  return null;
}

const TRUE_WORDS = new Set(["true", "evet", "yes", "1", "t", "dogru", "var", "e"]);
const FALSE_WORDS = new Set(["false", "hayir", "no", "0", "f", "yanlis", "yok", "h"]);

function toBool(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const f = foldPlain(v);
    if (TRUE_WORDS.has(f)) return true;
    if (FALSE_WORDS.has(f)) return false;
  }
  return null;
}

/** Equality: numbers within 1e-6, booleans by meaning, text ignoring case, spaces and dashes. */
export function looseEquals(actual: Scalar, expected: Scalar): boolean {
  if (typeof actual === "boolean" || typeof expected === "boolean") {
    const a = toBool(actual);
    const b = toBool(expected);
    if (a !== null && b !== null) return a === b;
  }
  const an = toNumber(actual);
  const bn = toNumber(expected);
  if (an !== null && bn !== null) return Math.abs(an - bn) < 1e-6;
  return compactFold(String(actual)) === compactFold(String(expected));
}

function compareOp(actual: Scalar, op: ModelQueryFilter["op"], expected: Scalar | undefined): boolean {
  if (expected === undefined) return false;
  switch (op) {
    case "=":
      return looseEquals(actual, expected);
    case "!=":
      return !looseEquals(actual, expected);
    case "contains":
      return compactFold(String(actual)).includes(compactFold(String(expected)));
    default: {
      const a = toNumber(actual);
      const b = toNumber(expected);
      if (a === null || b === null) return false;
      return op === ">" ? a > b : op === "<" ? a < b : op === ">=" ? a >= b : a <= b;
    }
  }
}

/** "IfcWall" matches IfcWall, IfcWallStandardCase, "wall", "duvar". */
export function classMatcher(wanted: string): (cls: string) => boolean {
  const w = foldPlain(wanted).replace(/\s+/g, "");
  const bare = w.startsWith("ifc") ? w.slice(3) : w;
  return (cls: string) => {
    const c = cls.toLowerCase();
    const cb = c.startsWith("ifc") ? c.slice(3) : c;
    if (cb === bare || cb === `${bare}standardcase` || cb === `${bare}elementedcase`) return true;
    return compactFold(ifcClassLabel(cls)) === compactFold(wanted);
  };
}

export interface Ctx {
  warnings: Set<string>;
  /** Language of the warnings (the reader's); default: the installation's. */
  lang?: string;
}

const warn = (ctx: Ctx) => tFor(ctx.lang ?? DEFAULT_LANGUAGE);

type FieldGetter = (el: ElementView, c: Candidate) => Scalar[];

/** Values of a field on an element (several for a property name that occurs in more than one set). */
function getter(field: string, ctx: Ctx): FieldGetter {
  const b: BuiltinField | null = builtinField(field);
  if (b) {
    return (el, c) => {
      const v =
        b === "class" ? el.cls
        : b === "storey" ? el.storey
        : b === "type" ? el.type
        : b === "name" ? el.name
        : b === "material" ? el.material
        : b === "globalId" ? el.guid
        : (c.change ?? null);
      return v === null || v === undefined ? [] : [v];
    };
  }
  const perIndex = new Map<ModelIndex, number[]>();
  return (el, c) => {
    let keys = perIndex.get(c.index);
    if (!keys) {
      const r = c.index.resolveKeys(field);
      keys = r.keys;
      perIndex.set(c.index, keys);
      if (!keys.length && c.index.detailed) ctx.warnings.add(warn(ctx)("model:warnings.propertyMissing", { field }));
      else if (r.approximate)
        ctx.warnings.add(warn(ctx)("model:warnings.propertyApprox", { field, keys: keys.map((k) => c.index.key(k)).slice(0, 4).join(", ") }));
    }
    return c.index.values(el, keys);
  };
}

function storeyMatcher(storeys: string[], candidates: Candidate[], ctx: Ctx): (el: ElementView) => boolean {
  const names = new Set<string>();
  for (const idx of new Set(candidates.map((c) => c.index))) for (const n of idx.storeyNames()) names.add(n);
  const chosen = new Set<string>();
  for (const s of storeys) {
    const exact = [...names].filter((n) => compactFold(n) === compactFold(s));
    const partial = exact.length ? exact : [...names].filter((n) => compactFold(n).includes(compactFold(s)) || compactFold(s).includes(compactFold(n)));
    if (!partial.length) ctx.warnings.add(warn(ctx)("model:warnings.storeyMissing", { storey: s, storeys: [...names].slice(0, 12).join(", ") || "—" }));
    partial.forEach((n) => chosen.add(compactFold(n)));
  }
  return (el) => el.storey !== null && chosen.has(compactFold(el.storey));
}

function unitOf(field: string | null | undefined): string | null {
  if (!field) return null;
  const f = field.toLowerCase();
  if (/area|alan/.test(f)) return "m²";
  if (/volume|hacim/.test(f)) return "m³";
  if (/weight|mass|agirlik/.test(f)) return "kg";
  if (/length|width|height|depth|thickness|perimeter|uzunluk|genislik|yukseklik|kalinlik/.test(f)) return "m";
  return null;
}

export function formatNumber(n: number, lang = DEFAULT_LANGUAGE): string {
  return n.toLocaleString(intlLocale(lang), { maximumFractionDigits: Math.abs(n) >= 100 ? 1 : 2 });
}

export interface Matched {
  c: Candidate;
  el: ElementView;
}

/** Elements of the scope that pass the classes, storeys, change kinds and filters of a query. */
export function matchCandidates(
  candidates: Candidate[],
  query: ModelQuery,
  scope: { compareFrom?: string },
  ctx: Ctx = { warnings: new Set() },
): Matched[] {
  if (candidates.some((c) => !c.index.detailed) && (query.storeys?.length || query.filters?.length || query.groupBy?.length || query.aggregate))
    ctx.warnings.add(warn(ctx)("model:warnings.oldIndex"));
  const classTests = (query.classes ?? []).map(classMatcher);
  const storeyTest = query.storeys?.length ? storeyMatcher(query.storeys, candidates, ctx) : null;
  const filters = (query.filters ?? []).map((f) => ({ f, get: getter(f.field, ctx) }));
  const changeSet = query.change?.length ? new Set(query.change) : null;
  if (changeSet && !scope.compareFrom) ctx.warnings.add(warn(ctx)("model:warnings.changeFilterIgnored"));

  const matched: Matched[] = [];
  for (const c of candidates) {
    if (changeSet && scope.compareFrom && (!c.change || !changeSet.has(c.change))) continue;
    const el = c.index.element(c.guid);
    if (!el) continue;
    if (classTests.length && !classTests.some((t) => t(el.cls))) continue;
    if (storeyTest && !storeyTest(el)) continue;
    let ok = true;
    for (const { f, get } of filters) {
      const vals = get(el, c);
      const present = vals.filter((v) => String(v).trim() !== "");
      if (f.op === "exists") ok = present.length > 0;
      else if (f.op === "missing") ok = present.length === 0;
      else if (f.op === "!=") ok = !present.some((v) => looseEquals(v, f.value as Scalar));
      else ok = present.some((v) => compareOp(v, f.op, f.value));
      if (!ok) break;
    }
    if (ok) matched.push({ c, el });
  }
  return matched;
}

/** First value of a field on a matched element (report rows, list columns). */
export function fieldValue(field: string, m: Matched, ctx: Ctx = { warnings: new Set() }): Scalar | null {
  return getter(field, ctx)(m.el, m.c)[0] ?? null;
}

/** First numeric value of a field on an element. */
export function numericValue(field: string, m: Matched): number | null {
  for (const v of getter(field, { warnings: new Set() })(m.el, m.c)) {
    const n = toNumber(v);
    if (n !== null) return n;
  }
  return null;
}

/** Runs a query. `candidates` are the elements in scope (a whole version or the changed elements). */
export function executeModelQuery(
  candidates: Candidate[],
  rawQuery: ModelQuery,
  scope: { versionId: string; compareFrom?: string },
  lang = DEFAULT_LANGUAGE,
): ModelQueryResultDto {
  const query = normalizeQuery(rawQuery);
  const ctx: Ctx = { warnings: new Set(), lang };
  const matched = matchCandidates(candidates, query, scope, ctx);

  // Aggregate value per element.
  const agg = query.aggregate && query.aggregate.op !== "count" ? query.aggregate : null;
  const aggGet = agg?.field ? getter(agg.field, ctx) : null;
  const numberOf = (m: Matched): number | null => {
    if (!aggGet) return null;
    for (const v of aggGet(m.el, m.c)) {
      const n = toNumber(v);
      if (n !== null) return n;
    }
    return null;
  };
  const reduce = (list: Matched[]): number | null => {
    if (!agg) return null;
    const nums = list.map(numberOf).filter((n): n is number => n !== null);
    if (!nums.length) return null;
    if (agg.op === "sum") return nums.reduce((a, b) => a + b, 0);
    if (agg.op === "avg") return nums.reduce((a, b) => a + b, 0) / nums.length;
    if (agg.op === "min") return Math.min(...nums);
    return Math.max(...nums);
  };
  const unit = unitOf(agg?.field);

  // Table: grouped counts (and aggregate per group).
  let table: ModelQueryResultDto["table"] = null;
  if (query.groupBy?.length) {
    const getters = query.groupBy.map((g) => getter(g, ctx));
    const groups = new Map<string, { parts: string[]; list: typeof matched; order: number }>();
    for (const m of matched) {
      const parts = getters.map((g) => {
        const v = g(m.el, m.c)[0];
        return v === undefined || v === null || v === "" ? "—" : String(v);
      });
      const key = JSON.stringify(parts);
      let grp = groups.get(key);
      if (!grp) groups.set(key, (grp = { parts, list: [], order: m.el.storeyIdx }));
      grp.list.push(m);
    }
    const byStorey = query.groupBy.some((g) => builtinField(g) === "storey");
    const rows = [...groups.values()].sort((a, b) =>
      byStorey ? a.order - b.order || b.list.length - a.list.length : b.list.length - a.list.length,
    );
    table = {
      columns: [
        ...query.groupBy.map((g) => ({ key: g, label: modelFieldLabel(g, lang) })),
        { key: "count", label: labelFor(lang, "modelAgg", "count") },
        ...(agg ? [{ key: "value", label: `${labelFor(lang, "modelAgg", agg.op)} ${modelFieldLabel(agg.field ?? "", lang)}${unit ? ` (${unit})` : ""}` }] : []),
      ],
      rows: rows.slice(0, MAX_TABLE_ROWS).map((g) => {
        const v = reduce(g.list);
        return [
          ...g.parts.map((p, i) => (builtinField(query.groupBy![i]!) === "class" && p !== "—" ? ifcClassLabel(p, lang) : p)),
          g.list.length,
          ...(agg ? [v === null ? null : Math.round(v * 1000) / 1000] : []),
        ];
      }),
    };
    if (rows.length > MAX_TABLE_ROWS) ctx.warnings.add(warn(ctx)("model:warnings.tableTruncated", { max: MAX_TABLE_ROWS, count: rows.length }));
  }

  const aggValue = reduce(matched);
  if (agg && matched.length && aggValue === null) ctx.warnings.add(warn(ctx)("model:warnings.noNumericValue", { field: agg.field }));

  matched.sort(
    (a, b) =>
      a.el.storeyIdx - b.el.storeyIdx ||
      a.el.cls.localeCompare(b.el.cls) ||
      (a.el.name ?? "").localeCompare(b.el.name ?? "", "tr") ||
      a.el.guid.localeCompare(b.el.guid),
  );
  const limit = query.limit ?? DEFAULT_LIMIT;
  const valueField = agg?.field ?? query.filters?.find((f) => f.op !== "missing")?.field;
  const valueGet = valueField ? getter(valueField, ctx) : null;
  const elements: ModelQueryElement[] = matched.slice(0, limit).map(({ c, el }) => {
    const out: ModelQueryElement = {
      guid: el.guid,
      expressId: el.expressId,
      class: el.cls,
      name: el.name,
      storey: el.storey,
      type: el.type,
    };
    if (c.versionId) out.versionId = c.versionId;
    if (c.modelName) out.modelName = c.modelName;
    if (valueGet) out.value = valueGet(el, c)[0] ?? null;
    if (c.change) out.change = c.change;
    return out;
  });

  const inNew = matched.filter((m) => m.c.change !== "removed");
  const removed = matched.filter((m) => m.c.change === "removed");
  const byVersionMap = new Map<string, string[]>();
  for (const m of inNew.slice(0, MAX_GUIDS)) {
    const vid = m.c.versionId;
    if (!vid) continue;
    let list = byVersionMap.get(vid);
    if (!list) byVersionMap.set(vid, (list = []));
    list.push(m.el.guid);
  }
  const result: ModelQueryResultDto = {
    versionId: scope.versionId,
    ...(scope.compareFrom ? { compareFrom: scope.compareFrom } : {}),
    query,
    total: candidates.length,
    count: matched.length,
    guids: inNew.slice(0, MAX_GUIDS).map((m) => m.el.guid),
    // Federated scope: always, even when every match is in one model (the viewer paints that model).
    ...(byVersionMap.size > 0 && { byVersion: [...byVersionMap.entries()].map(([versionId, guids]) => ({ versionId, guids })) }),
    removedGuids: removed.slice(0, MAX_GUIDS).map((m) => m.el.guid),
    elements,
    more: Math.max(0, matched.length - elements.length),
    table,
    aggregate: agg ? { op: agg.op, field: agg.field ?? null, value: aggValue === null ? null : Math.round(aggValue * 1000) / 1000, unit } : null,
    answer: "",
    warnings: [...ctx.warnings],
  };
  result.answer = describeResult(result, !!scope.compareFrom, lang);
  return result;
}

/** One paragraph from the numbers (fast, no AI, cannot hallucinate), in the reader's language. */
export function describeResult(r: ModelQueryResultDto, comparing: boolean, lang = DEFAULT_LANGUAGE): string {
  const t = tFor(lang);
  const locale = intlLocale(lang);
  const q = r.query;
  const what = q.classes?.length ? q.classes.map((c) => ifcClassLabel(c, lang).toLocaleLowerCase(locale)).join(" / ") : t("model:answer.element");
  const conditions = modelQueryChips(q, lang)
    .filter((c) => c.part === "filter")
    .map((c) => c.text);
  // "Değişikliklerde (silinen) · Kat 1: 3 kapı bulundu (FireRating ≠ EI60)."
  const head = [
    comparing
      ? q.change?.length
        ? t("model:answer.inChangesKinds", { kinds: q.change.map((c) => labelFor(lang, "modelChange", c).toLocaleLowerCase(locale)).join(", ") })
        : t("model:answer.inChanges")
      : null,
    q.storeys?.length ? q.storeys.join(", ") : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const prefix = head ? `${head}: ` : "";
  const cond = conditions.length ? ` (${conditions.join(", ")})` : "";
  const parts: string[] = [];
  if (!r.count) parts.push(t("model:answer.noneFound", { prefix, what, cond }));
  else parts.push(t("model:answer.found", { prefix, n: formatNumber(r.count, lang), what, cond }));
  if (r.aggregate && r.aggregate.value !== null)
    parts.push(
      `${labelFor(lang, "modelAgg", r.aggregate.op)} ${modelFieldLabel(r.aggregate.field ?? "", lang)}: ${formatNumber(r.aggregate.value, lang)}${r.aggregate.unit ? ` ${r.aggregate.unit}` : ""}.`,
    );
  if (r.table?.rows.length && r.table.rows.length > 1) {
    const top = r.table.rows
      .slice(0, 6)
      .map((row) => `${row.slice(0, q.groupBy!.length).join(" / ")}: ${row[q.groupBy!.length]}`)
      .join(", ");
    parts.push(t("model:answer.distribution", { top: `${top}${r.table.rows.length > 6 ? " …" : ""}` }));
  }
  if (comparing && r.count) {
    const byKind: Record<string, number> = {};
    for (const e of r.elements) if (e.change) byKind[e.change] = (byKind[e.change] ?? 0) + 1;
    if (!r.more && Object.keys(byKind).length > 1)
      parts.push(
        Object.entries(byKind)
          .map(([k, n]) => `${n} ${labelFor(lang, "modelChange", k).toLocaleLowerCase(locale)}`)
          .join(", ") + ".",
      );
  }
  const text = parts.join(" ");
  return text.charAt(0).toLocaleUpperCase(locale) + text.slice(1);
}

/** Every element of a version as query candidates. */
export function versionCandidates(index: ModelIndex, meta?: { versionId?: string; modelName?: string }): Candidate[] {
  return index.guids.map((guid) => ({ index, guid, ...(meta?.versionId && { versionId: meta.versionId }), ...(meta?.modelName && { modelName: meta.modelName }) }));
}
