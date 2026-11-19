/**
 * Texts of the built-in work types in the reader's language (docs/architecture/i18n.md §8.2).
 *
 * Built-in types are seeded into every project in Turkish (data, ensureBuiltInTypes). A type
 * name, field label, field help or status label that is still the seeded default is shown in the
 * reader's language from the "workTypeText" label table; anything the admin changed stays as
 * written. Status keys ("acik", "kapandi") never change, only their labels.
 */
import { ALL_BUILT_IN_WORK_TYPES } from "./build-works.js";
import { defaultStatuses, type WorkFieldDef, type WorkStatusDef } from "./work-catalog.js";
import { labelText } from "../platform/i18n.js";
import { seededText } from "../platform/seeded-text.js";

interface TypeText {
  name: string;
  fields: Record<string, string>;
  help: Record<string, string>;
  statuses: Record<string, string>;
}

/** Turkish texts of the built-in types by type key (the seeded defaults): label table "workTypeText". */
export const WORK_TYPE_TEXT_LABELS_TR: Record<string, TypeText> = Object.fromEntries(
  ALL_BUILT_IN_WORK_TYPES.map((t) => [
    t.key,
    {
      name: t.name,
      fields: Object.fromEntries(t.fields.map((f) => [f.key, f.label])),
      help: Object.fromEntries(t.fields.filter((f) => f.help).map((f) => [f.key, f.help!])),
      statuses: Object.fromEntries((t.statuses ?? defaultStatuses(t.category)).map((s) => [s.key, s.label])),
    },
  ]),
);

/**
 * Status labels by key alone (label table "workStatus"), for places without a type: report
 * filters over all works. The first built-in type's label of a key wins ("kapandi" → "Kapandı").
 */
export const WORK_STATUS_LABELS_TR: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  for (const t of ALL_BUILT_IN_WORK_TYPES) for (const s of t.statuses ?? defaultStatuses(t.category)) out[s.key] ??= s.label;
  return out;
})();

/** Seeded list options of the built-in fields: "typeKey/fieldKey" → options. */
const DEFAULT_OPTIONS = new Map<string, readonly string[]>(
  ALL_BUILT_IN_WORK_TYPES.flatMap((t) => t.fields.filter((f) => f.options?.length).map((f) => [`${t.key}/${f.key}`, f.options!] as const)),
);

/** The label of a field value for display: the option's label in the reader's language when the type carries one. */
export function fieldValueLabel(field: Pick<WorkFieldDef, "optionLabels"> | undefined, value: string): string {
  return field?.optionLabels?.[value] ?? value;
}

/** The fields of a stored work type this module reads and may replace. */
export interface LocalizableWorkType {
  key: string;
  name: string;
  builtIn: boolean;
  fields: WorkFieldDef[];
  statuses: WorkStatusDef[];
  settings: { seededName?: string; seededLabels?: Record<string, string> };
}

const isTurkish = (lang: string) => lang.toLowerCase().startsWith("tr");

/** One text of a built-in type in `lang`, or null when the table has none. */
function typeText(lang: string, path: string): string | null {
  const v = labelText(lang, "workTypeText", path);
  return v && v !== path ? v : null;
}

/**
 * A stored work type with its seeded default texts in `lang`. Turkish, custom types and texts the
 * admin changed are returned as stored. Returns the same object when nothing changes.
 */
export function localizedWorkType<T extends LocalizableWorkType>(t: T, lang: string): T {
  if (!t.builtIn || isTurkish(lang)) return t;
  const tr = WORK_TYPE_TEXT_LABELS_TR[t.key];
  if (!tr) return t;
  const seeded = t.settings?.seededLabels ?? {};
  // A stored text is the seeded default when it equals the current default or what the seeder last wrote.
  const isDefault = (stored: string, current: string | undefined, remembered: string | undefined) =>
    stored === current || (remembered !== undefined && stored === remembered);
  let changed = false;
  const pick = (stored: string, current: string | undefined, remembered: string | undefined, path: string) => {
    if (!isDefault(stored, current, remembered)) return stored;
    const text = typeText(lang, path);
    if (text === null || text === stored) return stored;
    changed = true;
    return text;
  };
  const name = pick(t.name, tr.name, t.settings?.seededName, `${t.key}.name`);
  const fields = t.fields.map((f) => {
    const label = pick(f.label, tr.fields[f.key], seeded[`f:${f.key}`], `${t.key}.fields.${f.key}`);
    const help = f.help !== undefined ? pick(f.help, tr.help[f.key], undefined, `${t.key}.help.${f.key}`) : undefined;
    // Seeded options keep their stored value; their label is shown in `lang`.
    const defaults = DEFAULT_OPTIONS.get(`${t.key}/${f.key}`);
    const optionLabels: Record<string, string> = {};
    if (defaults && !f.optionLabels)
      for (const o of f.options ?? []) {
        const text = defaults.includes(o) ? seededText(o, lang) : o;
        if (text !== o) optionLabels[o] = text;
      }
    const hasLabels = Object.keys(optionLabels).length > 0;
    if (hasLabels) changed = true;
    return label === f.label && help === f.help && !hasLabels
      ? f
      : { ...f, label, ...(help !== undefined && { help }), ...(hasLabels && { optionLabels }) };
  });
  const statuses = t.statuses.map((s) => {
    const label = pick(s.label, tr.statuses[s.key], seeded[`s:${s.key}`], `${t.key}.statuses.${s.key}`);
    return label === s.label ? s : { ...s, label };
  });
  return changed ? { ...t, name, fields, statuses } : t;
}
