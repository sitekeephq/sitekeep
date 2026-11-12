/**
 * "Yapay zekâ ile onar" helpers: a saved query whose field was renamed or removed is fixed by a
 * field mapping (old name → new name, or null to drop what used it) applied to the ORIGINAL query,
 * so filters, grouping, output names, sort and limit stay exactly as the user saved them. A small
 * local model only has to pick a field name, not rewrite the query.
 */
import type { ReportGroupBy, ReportQuerySpec } from "@sitekeep/shared";
import { fieldInfo, type FieldSource } from "./engine.js";

const groupField = (g: ReportGroupBy) => (typeof g === "string" ? g : g.field);

/** Every field name a query refers to (filters, groupBy, metrics, fields; sort only for raw rows). */
export function referencedFields(spec: ReportQuerySpec): string[] {
  const out = new Set<string>();
  for (const f of spec.filters ?? []) out.add(f.field);
  for (const g of spec.groupBy ?? []) out.add(groupField(g));
  for (const m of spec.metrics ?? []) if (m.field) out.add(m.field);
  for (const f of spec.fields ?? []) out.add(f);
  if (!spec.groupBy?.length && !spec.metrics?.length) for (const s of spec.sort ?? []) out.add(s.field);
  return [...out];
}

/** Fields of a query that the dataset no longer has. */
export function missingFields(spec: ReportQuerySpec, src: FieldSource): string[] {
  return referencedFields(spec).filter((f) => !fieldInfo(src, f));
}

/**
 * Renames fields in a query; a null target removes the filters, groupings, metrics, columns and
 * sorts that used the field. Metric output names ("as") are kept, so the dashboard HTML still finds
 * its columns.
 */
export function applyFieldMap(spec: ReportQuerySpec, map: Record<string, string | null>): ReportQuerySpec {
  const has = (f: string) => Object.prototype.hasOwnProperty.call(map, f);
  const to = (f: string) => (has(f) ? map[f]! : f);
  const keep = (f: string) => !has(f) || map[f] !== null;
  const out: ReportQuerySpec = { ...spec };
  if (spec.filters) out.filters = spec.filters.filter((f) => keep(f.field)).map((f) => ({ ...f, field: to(f.field) }));
  if (spec.groupBy)
    out.groupBy = spec.groupBy
      .filter((g) => keep(groupField(g)))
      .map((g) => (typeof g === "string" ? to(g) : { ...g, field: to(g.field) }));
  if (spec.metrics)
    out.metrics = spec.metrics
      .filter((m) => !m.field || keep(m.field))
      .map((m) => {
        if (!m.field || !has(m.field)) return m;
        // Keep the old default output name ("sum_oldField") so the HTML still reads it.
        return { ...m, field: to(m.field), as: m.as ?? `${m.op}_${m.field}`.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 60) };
      });
  if (spec.fields) out.fields = spec.fields.filter(keep).map(to);
  // Sorted columns: raw fields and grouped fields are renamed with them; metric outputs keep their names.
  if (spec.sort) out.sort = spec.sort.filter((s) => keep(s.field)).map((s) => ({ ...s, field: to(s.field) }));
  return out;
}
