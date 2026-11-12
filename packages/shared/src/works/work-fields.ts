/** Custom work field values and validation. */
import type { WorkFieldDef } from "./work-catalog.js";
import { SHARED_DEFAULT_LANGUAGE, sharedText } from "../platform/i18n.js";

// ---- Fields ---------------------------------------------------------------------------------

export type WorkFieldValues = Record<string, string | number | boolean | null>;

/** Problems with field values (empty when valid). `partial` skips required checks. */
export function validateWorkFields(defs: readonly WorkFieldDef[], values: WorkFieldValues, partial = false, lang: string = SHARED_DEFAULT_LANGUAGE): string[] {
  const out: string[] = [];
  const byKey = new Map(defs.map((d) => [d.key, d]));
  for (const key of Object.keys(values)) if (!byKey.has(key)) out.push(sharedText(lang, "workFields.unknown", { key }));
  for (const d of defs) {
    const v = values[d.key];
    const empty = v === undefined || v === null || v === "";
    if (empty) {
      if (d.required && !partial) out.push(sharedText(lang, "workFields.required", { label: d.label }));
      continue;
    }
    switch (d.type) {
      case "number":
        if (typeof v !== "number" || !Number.isFinite(v)) out.push(sharedText(lang, "workFields.number", { label: d.label }));
        break;
      case "boolean":
        if (typeof v !== "boolean") out.push(sharedText(lang, "workFields.boolean", { label: d.label }));
        break;
      case "date":
        if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) out.push(sharedText(lang, "workFields.date", { label: d.label }));
        break;
      case "list":
        if (typeof v !== "string" || !(d.options ?? []).includes(v)) out.push(sharedText(lang, "workFields.list", { label: d.label }));
        break;
      default:
        if (typeof v !== "string") out.push(sharedText(lang, "workFields.text", { label: d.label }));
        else if (v.length > 20000) out.push(sharedText(lang, "workFields.tooLong", { label: d.label }));
    }
  }
  return out;
}

/** Problems in a type's field list (empty when valid). */
export function checkWorkFieldDefs(defs: readonly WorkFieldDef[], lang: string = SHARED_DEFAULT_LANGUAGE): string[] {
  const out: string[] = [];
  const keys = new Set<string>();
  defs.forEach((d, i) => {
    const n = i + 1;
    if (!/^[a-z][a-z0-9_-]{0,39}$/.test(d.key)) out.push(sharedText(lang, "workFields.def.key", { n }));
    if (keys.has(d.key)) out.push(sharedText(lang, "workFields.def.duplicateKey", { n, key: d.key }));
    keys.add(d.key);
    if (!d.label.trim()) out.push(sharedText(lang, "workFields.def.labelEmpty", { n }));
    if (d.type === "list" && !(d.options ?? []).filter((o) => o.trim()).length) out.push(sharedText(lang, "workFields.def.noOptions", { n }));
  });
  return out;
}
