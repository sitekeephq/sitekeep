/**
 * File naming standards, modelled on Forma Docs naming standards (ISO 19650 style):
 * an ordered list of fields joined by one delimiter, each field either a fixed list
 * of codes, free text or a number. The extension is not part of the name.
 *
 * Example (ZAVM): ZAVM-PAS-ZZ-S-B1-0204-RP-MC-0001
 *
 * Forma-style extras:
 * - list codes may contain the delimiter (İBB "Metro Kodlama Sistemi": ALAN = "SKP1-A") when the
 *   standard sets `allowDelimiterInCodes`; names are parsed by matching codes with backtracking,
 *   not by a plain split;
 * - number fields may have a variable length (`minDigits`/`maxDigits`, e.g. 2–3 digits);
 * - fields with `inName: false` are "metadata" fields (Revizyon, Pafta adı): they belong to the
 *   standard as attributes but are not part of the name.
 */
import { SHARED_DEFAULT_LANGUAGE, sharedText } from "../platform/i18n.js";

export interface NamingValue {
  code: string;
  description?: string;
}

interface FieldBase {
  name: string;
  /** false = metadata field: kept with the standard (e.g. as an attribute) but not part of the name. */
  inName?: boolean;
}

export type NumberField = FieldBase & {
  type: "number";
  /** Fixed length; also the default for minDigits/maxDigits. */
  digits: number;
  minDigits?: number;
  maxDigits?: number;
};

export type NamingField =
  | (FieldBase & { type: "list"; values: NamingValue[] })
  | (FieldBase & { type: "text"; minLength?: number; maxLength?: number })
  | NumberField;

export interface NamingStandard {
  name: string;
  delimiter: string;
  fields: NamingField[];
  /**
   * When true, text after the last field is allowed, separated by the delimiter or a
   * space (e.g. "ZAVM-...-0001-Temel Kazısı"). Off by default, as in Forma.
   */
  allowSuffix?: boolean;
  /** Allows list codes that contain the delimiter (e.g. "SKP1-A" with "-"). Off by default. */
  allowDelimiterInCodes?: boolean;
}

export interface FieldResult {
  field: string;
  value: string | null;
  ok: boolean;
  message?: string;
}

export interface NamingResult {
  ok: boolean;
  baseName: string;
  /** One entry per name field (metadata fields with inName: false are not listed). */
  fields: FieldResult[];
  errors: string[];
  /** Field name → value, filled when the name is valid. */
  values?: Record<string, string>;
}

/** Splits "a.b.ifc" into base "a.b" and extension "ifc". */
export function splitExtension(fileName: string): { base: string; extension: string } {
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0) return { base: fileName, extension: "" };
  return { base: fileName.slice(0, dot), extension: fileName.slice(dot + 1) };
}

/** Fields that make up the name, in order (metadata fields excluded). */
export function nameFields(standard: NamingStandard): NamingField[] {
  return standard.fields.filter((f) => f.inName !== false);
}

/** Allowed digit count range of a number field. */
export function digitRange(field: NumberField): { min: number; max: number } {
  const min = field.minDigits ?? field.digits;
  const max = field.maxDigits ?? Math.max(field.digits, min);
  return { min, max };
}

/**
 * Parses a file name into field values (name fields only), e.g. to fill attributes from the
 * name. Returns null when the name does not match the standard. Codes containing the delimiter
 * and variable-length numbers are resolved by trying the alternatives (longest first) with
 * backtracking.
 */
export function parseName(standard: NamingStandard, fileName: string): Record<string, string> | null {
  const { base } = splitExtension(fileName.trim());
  const values = match(standard, base);
  if (!values) return null;
  return Object.fromEntries(nameFields(standard).map((f, i) => [f.name, values[i]!]));
}

/** `lang`: language of the error messages. */
export function validateName(standard: NamingStandard, fileName: string, lang: string = SHARED_DEFAULT_LANGUAGE): NamingResult {
  const { base } = splitExtension(fileName.trim());
  const fields = nameFields(standard);
  const matched = match(standard, base);
  if (matched) {
    return {
      ok: true,
      baseName: base,
      fields: fields.map((f, i) => ({ field: f.name, value: matched[i]!, ok: true })),
      errors: [],
      values: Object.fromEntries(fields.map((f, i) => [f.name, matched[i]!])),
    };
  }
  return diagnose(standard, base, lang);
}

// ---- Matching -------------------------------------------------------------------------------

/** Candidate values of a field at `pos` (longest first), without checking what follows. */
function candidates(field: NamingField, base: string, pos: number, delimiter: string): string[] {
  switch (field.type) {
    case "list": {
      const out = field.values.map((v) => v.code).filter((c) => c && base.startsWith(c, pos));
      return [...new Set(out)].sort((a, b) => b.length - a.length);
    }
    case "number": {
      const { min, max } = digitRange(field);
      let end = pos;
      while (end < base.length && end - pos < max && base[end]! >= "0" && base[end]! <= "9") end++;
      const out: string[] = [];
      for (let len = end - pos; len >= Math.max(min, 1); len--) out.push(base.slice(pos, pos + len));
      return out;
    }
    case "text": {
      const next = base.indexOf(delimiter, pos);
      const value = base.slice(pos, next < 0 ? base.length : next);
      return value ? [value] : [];
    }
  }
}

/** Values of the name fields in order, or null when the name does not match. */
function match(standard: NamingStandard, base: string): string[] | null {
  const fields = nameFields(standard);
  const d = standard.delimiter;
  const n = fields.length;
  if (!n || !d) return null;
  const failed = new Set<string>();

  const step = (i: number, pos: number): string[] | null => {
    const key = `${i}:${pos}`;
    if (failed.has(key)) return null;
    const field = fields[i]!;
    for (const raw of candidates(field, base, pos, d)) {
      const end = pos + raw.length;
      if (i < n - 1) {
        if (base[end] !== d) continue;
        if (!checkField(field, raw).ok) continue;
        const rest = step(i + 1, end + d.length);
        if (rest) return [raw, ...rest];
        continue;
      }
      // Last field: the name ends here, or (allowSuffix) a suffix follows after the delimiter or
      // a space ("0001-Açıklama", "0001 Açıklama").
      let value = raw;
      if (end !== base.length) {
        if (!standard.allowSuffix) continue;
        if (field.type !== "text" && base[end] !== d && base[end] !== " ") continue;
      }
      if (standard.allowSuffix && field.type === "text") {
        const space = value.indexOf(" ");
        if (space > 0) value = value.slice(0, space);
      }
      if (checkField(field, value).ok) return [value];
    }
    failed.add(key);
    return null;
  };

  return step(0, 0);
}

/**
 * Explains why a name does not match. Codes containing the delimiter are taken greedily,
 * other fields are split at the delimiter (the same messages as a plain split for standards
 * without such codes).
 */
function diagnose(standard: NamingStandard, base: string, lang: string): NamingResult {
  const fields = nameFields(standard);
  const d = standard.delimiter;
  const n = fields.length;
  const values: (string | null)[] = [];
  let pos = 0;
  let exhausted = false;
  for (let i = 0; i < n; i++) {
    if (exhausted) {
      values.push(null);
      continue;
    }
    const field = fields[i]!;
    let value: string | null = null;
    if (field.type === "list" && d) {
      const long = candidates(field, base, pos, d).find((c) => {
        if (!c.includes(d)) return false;
        const after = base[pos + c.length];
        return after === undefined || after === d || (i === n - 1 && after === " ");
      });
      if (long) value = long;
    }
    if (value === null) {
      const next = d ? base.indexOf(d, pos) : -1;
      value = base.slice(pos, next < 0 ? base.length : next);
    }
    values.push(value);
    pos += value.length;
    if (pos >= base.length) exhausted = true;
    else pos += d.length; // skip the delimiter
  }
  const rest = exhausted ? "" : base.slice(pos);
  const extra = rest ? rest.split(d).length : 0;
  const partCount = values.filter((v) => v !== null).length + extra;

  const errors: string[] = [];
  if (partCount < n || (partCount > n && !standard.allowSuffix)) {
    errors.push(sharedText(lang, "naming.partCount", { expected: n, count: partCount, delimiter: d }));
  }
  const results: FieldResult[] = fields.map((field, i) => {
    let value = values[i] ?? null;
    if (value !== null && i === n - 1 && standard.allowSuffix) {
      const space = value.indexOf(" ");
      if (space > 0) value = value.slice(0, space);
    }
    const r = checkField(field, value, lang);
    if (!r.ok && r.message) errors.push(sharedText(lang, "naming.fieldProblem", { field: field.name, problem: r.message }));
    return r;
  });
  if (!errors.length) errors.push(sharedText(lang, "naming.noMatch"));
  return { ok: false, baseName: base, fields: results, errors };
}

function checkField(field: NamingField, value: string | null, lang: string = SHARED_DEFAULT_LANGUAGE): FieldResult {
  const base = { field: field.name, value };
  if (value === null || value === "") return { ...base, ok: false, message: sharedText(lang, "naming.field.missing") };
  switch (field.type) {
    case "list": {
      const ok = field.values.some((v) => v.code === value);
      return ok ? { ...base, ok } : { ...base, ok, message: sharedText(lang, "naming.field.notAllowed", { value }) };
    }
    case "number": {
      const { min, max } = digitRange(field);
      const ok = new RegExp(`^\\d{${min},${max}}$`).test(value);
      const label = min === max ? `${min}` : `${min}–${max}`;
      return ok ? { ...base, ok } : { ...base, ok, message: sharedText(lang, "naming.field.digits", { digits: label }) };
    }
    case "text": {
      if (field.minLength !== undefined && value.length < field.minLength)
        return { ...base, ok: false, message: sharedText(lang, "naming.field.minLength", { count: field.minLength }) };
      if (field.maxLength !== undefined && value.length > field.maxLength)
        return { ...base, ok: false, message: sharedText(lang, "naming.field.maxLength", { count: field.maxLength }) };
      return { ...base, ok: true };
    }
  }
}

/** Structural check of a standard before it is saved. Returns error messages. */
export function checkStandard(standard: NamingStandard, lang: string = SHARED_DEFAULT_LANGUAGE): string[] {
  const errors: string[] = [];
  const d = standard.delimiter;
  if (!standard.name?.trim()) errors.push(sharedText(lang, "naming.standard.nameEmpty"));
  if (!d || d.length !== 1) errors.push(sharedText(lang, "naming.standard.delimiter"));
  if (!standard.fields?.length) errors.push(sharedText(lang, "naming.standard.noFields"));
  else if (!standard.fields.some((f) => f.inName !== false)) errors.push(sharedText(lang, "naming.standard.noNameField"));
  const names = new Set<string>();
  for (const f of standard.fields ?? []) {
    if (!f.name?.trim()) errors.push(sharedText(lang, "naming.standard.fieldNameEmpty"));
    if (names.has(f.name)) errors.push(sharedText(lang, "naming.standard.duplicateField", { field: f.name }));
    names.add(f.name);
    if (f.type === "list") {
      if (!f.values?.length) errors.push(sharedText(lang, "naming.standard.emptyList", { field: f.name }));
      for (const v of f.values ?? []) {
        if (!d || !v.code.includes(d)) continue;
        if (!standard.allowDelimiterInCodes) errors.push(sharedText(lang, "naming.standard.codeHasDelimiter", { field: f.name, code: v.code }));
        else if (v.code.startsWith(d) || v.code.endsWith(d))
          errors.push(sharedText(lang, "naming.standard.codeDelimiterEdge", { field: f.name, code: v.code }));
      }
    }
    if (f.type === "number") {
      if (!(f.digits >= 1 && f.digits <= 12)) errors.push(sharedText(lang, "naming.standard.digits", { field: f.name }));
      else {
        const { min, max } = digitRange(f);
        if (!(min >= 1 && max <= 12 && min <= max))
          errors.push(sharedText(lang, "naming.standard.digitRange", { field: f.name }));
      }
    }
  }
  return errors;
}
