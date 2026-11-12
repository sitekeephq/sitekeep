/**
 * Typed file attributes, modelled on Forma Docs custom attributes: a project defines
 * attributes (text, list, date, number), folders bind them, and bindings apply to every
 * subfolder. Values are stored as strings on the file (dates as YYYY-MM-DD).
 * Keys without a definition stay free-form.
 */
import { SHARED_DEFAULT_LANGUAGE, sharedText } from "../platform/i18n.js";

export const ATTRIBUTE_TYPES = ["text", "list", "date", "number"] as const;
export type AttributeType = (typeof ATTRIBUTE_TYPES)[number];

export const ATTRIBUTE_TYPE_LABELS_TR: Record<AttributeType, string> = {
  text: "Metin",
  list: "Açılır Liste",
  date: "Tarih",
  number: "Sayı",
};

export interface AttributeDefinition {
  name: string;
  type: AttributeType;
  /** Allowed values of a list attribute. */
  options?: string[];
  required?: boolean;
}

export interface AttributeDefinitionDto extends AttributeDefinition {
  id: string;
  projectId: string;
  options: string[];
  required: boolean;
  createdAt: string;
}

/** A definition that applies to a folder, directly or through an ancestor. */
export interface EffectiveAttributeDto extends AttributeDefinitionDto {
  /** Nearest folder (the folder itself or an ancestor) the definition is bound to. */
  boundFolderId: string;
  inherited: boolean;
}

export interface AttributeError {
  name: string;
  message: string;
}

export const ATTRIBUTE_TEXT_MAX = 1000;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NUMBER_RE = /^-?\d+([.,]\d+)?$/;

export function isValidDate(value: string): boolean {
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

/** Checks one value against its definition; returns a message in `lang` or null. */
export function checkAttributeValue(def: AttributeDefinition, raw: string, lang: string = SHARED_DEFAULT_LANGUAGE): string | null {
  const value = raw.trim();
  if (!value) return def.required ? sharedText(lang, "attributes.required", { name: def.name }) : null;
  switch (def.type) {
    case "list":
      if (!(def.options ?? []).includes(value))
        return sharedText(lang, "attributes.notAnOption", { name: def.name, value, options: (def.options ?? []).join(", ") || "—" });
      return null;
    case "date":
      return isValidDate(value) ? null : sharedText(lang, "attributes.date", { name: def.name, value });
    case "number":
      return NUMBER_RE.test(value) ? null : sharedText(lang, "attributes.number", { name: def.name, value });
    default:
      return value.length > ATTRIBUTE_TEXT_MAX ? sharedText(lang, "attributes.tooLong", { name: def.name, max: ATTRIBUTE_TEXT_MAX }) : null;
  }
}

/**
 * Validates attribute values against the definitions that apply to a folder.
 * - Values for keys without a definition are accepted as they are (free-form).
 * - `partial`: only the given keys are checked (used when editing one attribute); a required
 *   attribute is reported only when it is given empty.
 */
export function validateAttributes(
  defs: readonly AttributeDefinition[],
  values: Readonly<Record<string, string>>,
  options: { partial?: boolean; lang?: string } = {},
): AttributeError[] {
  const lang = options.lang ?? SHARED_DEFAULT_LANGUAGE;
  const errors: AttributeError[] = [];
  for (const def of defs) {
    const has = Object.prototype.hasOwnProperty.call(values, def.name);
    if (!has) {
      if (def.required && !options.partial) errors.push({ name: def.name, message: sharedText(lang, "attributes.required", { name: def.name }) });
      continue;
    }
    const message = checkAttributeValue(def, String(values[def.name] ?? ""), lang);
    if (message) errors.push({ name: def.name, message });
  }
  return errors;
}

/** Problems in a definition itself (empty name, list without options, duplicate options). */
export function checkAttributeDefinition(def: AttributeDefinition, lang: string = SHARED_DEFAULT_LANGUAGE): string[] {
  const problems: string[] = [];
  if (!def.name.trim()) problems.push(sharedText(lang, "attributes.definition.nameEmpty"));
  if (def.type === "list") {
    const opts = (def.options ?? []).map((o) => o.trim());
    if (!opts.length) problems.push(sharedText(lang, "attributes.definition.noOptions"));
    if (opts.some((o) => !o)) problems.push(sharedText(lang, "attributes.definition.emptyOption"));
    if (new Set(opts).size !== opts.length) problems.push(sharedText(lang, "attributes.definition.duplicateOption"));
  }
  return problems;
}

/**
 * Case folding for search that treats the Turkish dotted/dotless I family as one letter
 * (İ, I, ı, i → i), so "kiriş", "KIRIŞ" and "kırış" all match.
 */
export function foldTr(value: string): string {
  return value
    .normalize("NFC")
    .replace(/[İIı]/g, "i")
    .toLocaleLowerCase("tr-TR")
    .replace(/i̇/g, "i");
}
