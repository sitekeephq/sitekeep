/**
 * Report query engine: filters, grouping (with date buckets), metrics, sorting and limits
 * over rows a dataset loaded with the caller's permissions. Plain TypeScript over
 * project-scale data; correctness over cleverness.
 */
import type {
  ReportFieldType,
  ReportFilter,
  ReportGroupBy,
  ReportMetric,
  ReportQuerySpec,
  ReportRow,
  ReportScalar,
} from "@sitekeep/shared";
import { DEFAULT_LANGUAGE, tFor, type Msg, type MsgKey, type MsgParam } from "../i18n/index.js";

export interface FieldInfo {
  type: ReportFieldType;
  label: string | Msg;
}

/** What the engine needs to know about a dataset. */
export interface FieldSource {
  fields: Record<string, FieldInfo>;
  dynamicPrefix?: string;
  dynamicType?: ReportFieldType;
}

export interface ExecOptions {
  now: Date;
  /** IANA time zone used for day/week/month keys and relative dates. */
  timeZone: string;
}

export const DEFAULT_LIMIT = 1000;

export function fieldInfo(src: FieldSource, name: string): FieldInfo | undefined {
  if (Object.prototype.hasOwnProperty.call(src.fields, name)) return src.fields[name];
  if (src.dynamicPrefix && name.startsWith(src.dynamicPrefix) && name.length > src.dynamicPrefix.length)
    return { type: src.dynamicType ?? "string", label: name.slice(src.dynamicPrefix.length) };
  return undefined;
}

const groupField = (g: ReportGroupBy) => (typeof g === "string" ? g : g.field);
const groupBucket = (g: ReportGroupBy) => (typeof g === "string" ? undefined : g.bucket);
export const metricName = (m: ReportMetric) => m.as ?? (m.op === "count" && !m.field ? "count" : `${m.op}_${m.field}`);

const isAggregated = (spec: ReportQuerySpec) => !!(spec.groupBy?.length || spec.metrics?.length);

/**
 * Semantic checks against the dataset's fields. Returns messages in `lang` (empty = valid).
 * `brief`: for a dashboard viewer — without the spec path ("filters[0]: ") and the field list.
 */
export function checkSpec(
  spec: ReportQuerySpec,
  src: FieldSource,
  lang: string = DEFAULT_LANGUAGE,
  opts: { brief?: boolean } = {},
): string[] {
  const t = tFor(lang);
  const errors: string[] = [];
  const push = (where: string | null, key: MsgKey, params?: Record<string, MsgParam>) => {
    const problem = t(key, params);
    errors.push(where && !opts.brief ? t("reports:validation.at", { where, problem }) : problem);
  };
  const known = Object.keys(src.fields).join(", ");
  const need = (name: string, where: string): FieldInfo | undefined => {
    const f = fieldInfo(src, name);
    if (!f) {
      const near = similarField(name, Object.keys(src.fields));
      const p = { dataset: spec.dataset, field: name, similar: near, fields: known };
      if (opts.brief) push(null, near ? "reports:validation.unknownFieldSimilarBrief" : "reports:validation.unknownFieldBrief", p);
      else push(where, near ? "reports:validation.unknownFieldSimilar" : "reports:validation.unknownField", p);
    }
    return f;
  };

  for (const [i, flt] of (spec.filters ?? []).entries()) {
    const where = `filters[${i}]`;
    const f = need(flt.field, where);
    if (!f) continue;
    const v = flt.value;
    if (flt.op === "in") {
      if (!Array.isArray(v)) push(where, "reports:validation.inNeedsArray");
    } else if (flt.op === "between") {
      if (!Array.isArray(v) || v.length !== 2) push(where, "reports:validation.betweenNeedsPair");
    } else if (flt.op === "isNull") {
      if (v !== undefined && typeof v !== "boolean") push(where, "reports:validation.isNullNeedsBoolean");
    } else if (Array.isArray(v)) {
      push(where, "reports:validation.singleValue", { op: flt.op });
    } else if (v === undefined) {
      push(where, "reports:validation.valueMissing");
    }
    if (flt.op === "contains" && f.type !== "string") push(where, "reports:validation.containsNeedsText");
    if (["gt", "gte", "lt", "lte", "between"].includes(flt.op) && f.type === "boolean")
      push(where, "reports:validation.notOnBoolean", { op: flt.op });
  }

  const outputs: string[] = [];
  for (const [i, g] of (spec.groupBy ?? []).entries()) {
    const f = need(groupField(g), `groupBy[${i}]`);
    if (f && groupBucket(g) && f.type !== "date")
      push(`groupBy[${i}]`, "reports:validation.bucketNeedsDate", { field: groupField(g), type: f.type });
    outputs.push(groupField(g));
  }
  for (const [i, m] of (spec.metrics ?? []).entries()) {
    const where = `metrics[${i}]`;
    if (m.op !== "count" && !m.field) push(where, "reports:validation.fieldRequired", { op: m.op });
    if (m.field) {
      const f = need(m.field, where);
      if (f && (m.op === "sum" || m.op === "avg") && f.type !== "number")
        push(where, "reports:validation.needsNumber", { op: m.op, field: m.field, type: f.type });
      if (f && (m.op === "min" || m.op === "max") && f.type !== "number" && f.type !== "date")
        push(where, "reports:validation.needsNumberOrDate", { op: m.op });
    }
    outputs.push(metricName(m));
  }
  const dup = outputs.find((o, i) => outputs.indexOf(o) !== i);
  if (dup) push(null, "reports:validation.duplicateOutput", { column: dup });

  if (!isAggregated(spec)) for (const f of spec.fields ?? []) need(f, "fields");

  // Grouping without metrics counts rows.
  if (isAggregated(spec) && !spec.metrics?.length) outputs.push("count");
  for (const [i, s] of (spec.sort ?? []).entries()) {
    if (isAggregated(spec)) {
      if (!outputs.includes(s.field))
        push(`sort[${i}]`, "reports:validation.notAnOutput", { field: s.field, outputs: outputs.join(", ") });
    } else need(s.field, `sort[${i}]`);
  }
  return errors;
}

/** The known field closest to a missing one (renamed fields: "dueAt" → "dueDate", "company" → "assigneeCompany"). */
export function similarField(name: string, known: string[]): string | null {
  const low = name.toLowerCase();
  let best: string | null = null;
  let bestScore = Infinity;
  for (const k of known) {
    const kl = k.toLowerCase();
    if (kl === low) return k;
    const contains = kl.includes(low) || low.includes(kl);
    const d = editDistance(low, kl);
    const score = contains ? Math.min(d, 2) : d;
    if (score < bestScore) {
      bestScore = score;
      best = k;
    }
  }
  return best !== null && bestScore <= Math.max(2, Math.floor(name.length / 3)) ? best : null;
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length]!;
}

// ---- Dates ----------------------------------------------------------------------------

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const formatters = new Map<string, Intl.DateTimeFormat>();

/** 'YYYY-MM-DD' of a date value in the time zone. */
export function dayKey(value: ReportScalar | Date, timeZone: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string" && DATE_ONLY.test(value)) return value;
  const d = value instanceof Date ? value : new Date(typeof value === "number" ? value : String(value));
  if (Number.isNaN(d.getTime())) return null;
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    formatters.set(timeZone, f);
  }
  return f.format(d);
}

function addDays(key: string, days: number): string {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function addMonths(key: string, months: number): string {
  const [y, m, day] = key.split("-").map(Number) as [number, number, number];
  const d = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString().slice(0, 10);
}

export function bucketKey(value: ReportScalar, bucket: "day" | "week" | "month", timeZone: string): string | null {
  const key = dayKey(value, timeZone);
  if (!key) return null;
  if (bucket === "day") return key;
  if (bucket === "month") return key.slice(0, 7);
  // ISO week, keyed by its Monday.
  const dow = new Date(`${key}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(key, -((dow + 6) % 7));
}

type DateOperand = { kind: "day"; key: string } | { kind: "ts"; ms: number };

/**
 * Date filter values: 'YYYY-MM-DD' (whole day), an ISO timestamp, or relative values
 * 'today', 'yesterday', 'now', '-7d', '+2w', '-3m', '-1y'.
 */
export function resolveDate(value: ReportScalar, o: ExecOptions): DateOperand | null {
  if (value === null || value === undefined || typeof value === "boolean") return null;
  const s = String(value).trim();
  const today = dayKey(o.now, o.timeZone)!;
  if (s === "today") return { kind: "day", key: today };
  if (s === "yesterday") return { kind: "day", key: addDays(today, -1) };
  if (s === "now") return { kind: "ts", ms: o.now.getTime() };
  const rel = /^([+-]\d{1,4})([dwmy])$/.exec(s);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2];
    const key = unit === "d" ? addDays(today, n) : unit === "w" ? addDays(today, n * 7) : addMonths(today, unit === "m" ? n : n * 12);
    return { kind: "day", key };
  }
  if (DATE_ONLY.test(s)) return { kind: "day", key: s };
  if (/^\d{4}-\d{2}$/.test(s)) return { kind: "day", key: `${s}-01` };
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : { kind: "ts", ms };
}

// ---- Filtering ------------------------------------------------------------------------

type Comparable = string | number;

function compare(a: Comparable, b: Comparable): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

function lowerTr(s: string) {
  return s.toLocaleLowerCase("tr");
}

function makePredicate(f: ReportFilter, info: FieldInfo, o: ExecOptions): (row: ReportRow) => boolean {
  const get = (row: ReportRow) => row[f.field] ?? null;
  const isEmpty = (v: ReportScalar | undefined) => v === null || v === undefined || v === "";

  if (f.op === "isNull") {
    const wantNull = f.value !== false;
    return (row) => isEmpty(get(row)) === wantNull;
  }

  // Normalises a row value and a filter value to comparable forms for this field type.
  let toRow: (v: ReportScalar) => Comparable | boolean | null;
  let toArg: (v: ReportScalar) => Comparable | boolean | null;
  if (info.type === "number") {
    toRow = (v) => (isEmpty(v) || Number.isNaN(Number(v)) ? null : Number(v));
    toArg = toRow;
  } else if (info.type === "boolean") {
    const b = (v: ReportScalar) => (isEmpty(v) ? null : v === true || v === "true" || v === 1 || v === "1");
    toRow = b;
    toArg = b;
  } else if (info.type === "date") {
    // Every filter value decides whether rows compare by day or by timestamp.
    const operands = (Array.isArray(f.value) ? f.value : [f.value ?? null]).map((v) => resolveDate(v, o));
    const byDay = operands.every((x) => !x || x.kind === "day");
    toRow = (v) => {
      if (isEmpty(v)) return null;
      if (byDay) return dayKey(v, o.timeZone);
      const ms = Date.parse(String(v));
      return Number.isNaN(ms) ? null : ms;
    };
    toArg = (v) => {
      const r = resolveDate(v, o);
      if (!r) return null;
      if (byDay) return r.kind === "day" ? r.key : dayKey(new Date(r.ms), o.timeZone);
      return r.kind === "ts" ? r.ms : Date.parse(`${r.key}T00:00:00Z`);
    };
  } else {
    toRow = (v) => (isEmpty(v) ? null : String(v));
    toArg = (v) => (v === null || v === undefined ? null : String(v));
  }

  const val = f.value;
  switch (f.op) {
    case "eq": {
      const arg = toArg(val as ReportScalar);
      return (row) => toRow(get(row)) === arg;
    }
    case "neq": {
      const arg = toArg(val as ReportScalar);
      return (row) => toRow(get(row)) !== arg;
    }
    case "in": {
      const set = new Set((Array.isArray(val) ? val : [val as ReportScalar]).map((v) => toArg(v)));
      return (row) => set.has(toRow(get(row)));
    }
    case "contains": {
      const needle = lowerTr(String(val ?? ""));
      return (row) => {
        const v = get(row);
        return !isEmpty(v) && lowerTr(String(v)).includes(needle);
      };
    }
    case "between": {
      const [lo, hi] = (Array.isArray(val) ? val : []).map((v) => toArg(v)) as (Comparable | null)[];
      return (row) => {
        const v = toRow(get(row));
        if (v === null || typeof v === "boolean") return false;
        return (lo == null || compare(v, lo) >= 0) && (hi == null || compare(v, hi) <= 0);
      };
    }
    default: {
      const arg = toArg(val as ReportScalar);
      const test = { gt: (c: number) => c > 0, gte: (c: number) => c >= 0, lt: (c: number) => c < 0, lte: (c: number) => c <= 0 }[
        f.op as "gt" | "gte" | "lt" | "lte"
      ];
      return (row) => {
        const v = toRow(get(row));
        if (v === null || arg === null || typeof v === "boolean" || typeof arg === "boolean") return false;
        return test(compare(v, arg));
      };
    }
  }
}

// ---- Execution ------------------------------------------------------------------------

const MAX_FILLED_BUCKETS = 1000;

function nextBucket(key: string, bucket: "day" | "week" | "month"): string {
  if (bucket === "month") return addMonths(`${key}-01`, 1).slice(0, 7);
  return addDays(key, bucket === "week" ? 7 : 1);
}

/** Bucket keys between the first and last bucket (widened to date filters on the field). */
function missingBuckets(
  groups: Map<string, { keys: ReportScalar[] }>,
  field: string,
  bucket: "day" | "week" | "month",
  spec: ReportQuerySpec,
  o: ExecOptions,
): string[] {
  const present = new Set([...groups.values()].map((g) => g.keys[0]).filter((k): k is string => typeof k === "string"));
  let lo: string | null = null;
  let hi: string | null = null;
  const widen = (v: ReportScalar | undefined, side: "lo" | "hi") => {
    const d = v === undefined ? null : resolveDate(v, o);
    const day = d ? (d.kind === "day" ? d.key : dayKey(new Date(d.ms), o.timeZone)) : null;
    const k = day ? bucketKey(day, bucket, o.timeZone) : null;
    if (!k) return;
    if (side === "lo" && (!lo || k < lo)) lo = k;
    if (side === "hi" && (!hi || k > hi)) hi = k;
  };
  let openEnded = false; // "since X" without an end date
  for (const f of spec.filters ?? []) {
    if (f.field !== field) continue;
    if (f.op === "gte" || f.op === "gt") {
      widen(f.value as ReportScalar, "lo");
      openEnded = true;
    }
    if (f.op === "lte" || f.op === "lt") widen(f.value as ReportScalar, "hi");
    if (f.op === "between" && Array.isArray(f.value)) {
      widen(f.value[0], "lo");
      widen(f.value[1], "hi");
    }
  }
  const hasEnd = hi !== null;
  for (const k of present) {
    if (!lo || k < lo) lo = k;
    if (!hi || k > hi) hi = k;
  }
  if (openEnded && !hasEnd) widen(o.now.toISOString(), "hi");
  if (!lo || !hi) return [];
  const out: string[] = [];
  for (let k: string = lo, n = 0; k <= hi && n < MAX_FILLED_BUCKETS; k = nextBucket(k, bucket), n++)
    if (!present.has(k)) out.push(k);
  return out;
}

function sortValue(v: ReportScalar | undefined): Comparable | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  return v;
}

function sortRows(rows: ReportRow[], sort: { field: string; dir?: "asc" | "desc" }[]) {
  const collator = new Intl.Collator("tr", { numeric: true });
  rows.sort((a, b) => {
    for (const s of sort) {
      const x = sortValue(a[s.field]);
      const y = sortValue(b[s.field]);
      if (x === y) continue;
      if (x === null) return 1; // nulls last
      if (y === null) return -1;
      const c = typeof x === "number" && typeof y === "number" ? x - y : collator.compare(String(x), String(y));
      if (c !== 0) return s.dir === "desc" ? -c : c;
    }
    return 0;
  });
}

function metricValue(m: ReportMetric, rows: ReportRow[], info: FieldInfo | undefined): ReportScalar {
  if (m.op === "count") {
    if (!m.field) return rows.length;
    return rows.filter((r) => r[m.field!] !== null && r[m.field!] !== undefined && r[m.field!] !== "").length;
  }
  const values = rows.map((r) => r[m.field!]).filter((v) => v !== null && v !== undefined && v !== "");
  if (info?.type === "date") {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => Date.parse(String(a)) - Date.parse(String(b)) || compare(String(a), String(b)));
    return m.op === "min" ? sorted[0]! : sorted[sorted.length - 1]!;
  }
  const nums = values.map(Number).filter((n) => Number.isFinite(n));
  switch (m.op) {
    case "sum":
      return round(nums.reduce((a, b) => a + b, 0));
    case "avg":
      return nums.length ? round(nums.reduce((a, b) => a + b, 0) / nums.length) : null;
    case "min":
      return nums.length ? Math.min(...nums) : null;
    case "max":
      return nums.length ? Math.max(...nums) : null;
  }
}

const round = (n: number) => Math.round(n * 10_000) / 10_000;

/** Runs a (checked) spec over dataset rows. */
export function executeSpec(rows: ReportRow[], spec: ReportQuerySpec, src: FieldSource, o: ExecOptions): ReportRow[] {
  let out = rows;
  for (const f of spec.filters ?? []) {
    const pred = makePredicate(f, fieldInfo(src, f.field)!, o);
    out = out.filter(pred);
  }

  if (isAggregated(spec)) {
    const groupBy = spec.groupBy ?? [];
    const metrics = spec.metrics?.length ? spec.metrics : [{ op: "count" as const }];
    const groups = new Map<string, { keys: ReportScalar[]; rows: ReportRow[] }>();
    for (const row of out) {
      const keys = groupBy.map((g) => {
        const v = row[groupField(g)] ?? null;
        const b = groupBucket(g);
        return b ? bucketKey(v, b, o.timeZone) : v === "" ? null : v;
      });
      const k = JSON.stringify(keys);
      let grp = groups.get(k);
      if (!grp) groups.set(k, (grp = { keys, rows: [] }));
      grp.rows.push(row);
    }
    if (!groupBy.length && !groups.size) groups.set("[]", { keys: [], rows: [] });
    // One date bucket: add the empty buckets inside the data/filter range (charts need them).
    const only = groupBy.length === 1 ? groupBy[0]! : undefined;
    const bucket = only ? groupBucket(only) : undefined;
    if (only && bucket) {
      for (const key of missingBuckets(groups, groupField(only), bucket, spec, o))
        groups.set(JSON.stringify([key]), { keys: [key], rows: [] });
    }
    out = [...groups.values()].map((grp) => {
      const r: ReportRow = {};
      groupBy.forEach((g, i) => (r[groupField(g)] = grp.keys[i] ?? null));
      for (const m of metrics) r[metricName(m)] = metricValue(m, grp.rows, m.field ? fieldInfo(src, m.field) : undefined);
      return r;
    });
    const sort = spec.sort?.length
      ? spec.sort
      : groupBy.some((g) => groupBucket(g))
        ? groupBy.map((g) => ({ field: groupField(g), dir: "asc" as const }))
        : [{ field: metricName(metrics[0]!), dir: "desc" as const }];
    sortRows(out, sort);
  } else {
    if (spec.sort?.length) {
      out = [...out];
      sortRows(out, spec.sort);
    }
    if (spec.fields?.length) {
      const cols = spec.fields;
      out = out.map((r) => Object.fromEntries(cols.map((c) => [c, r[c] ?? null])));
    }
  }
  return out.slice(0, spec.limit ?? DEFAULT_LIMIT);
}
