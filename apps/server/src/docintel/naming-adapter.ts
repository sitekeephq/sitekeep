/**
 * Thin adapter over the naming standard API in @sitekeep/shared. Document intelligence only talks
 * to the standard through these functions, so the coming naming extensions (codes containing the
 * delimiter, variable-length numbers, fields with `inName: false`, parseName()) can be switched
 * on here without touching the suggestion logic.
 */
import { validateName, splitExtension, type NamingField, type NamingResult, type NamingStandard } from "@sitekeep/shared";

export type { NamingField, NamingStandard };

/** Fields that are written into the file name (future `inName: false` fields are attributes). */
export function nameFields(standard: NamingStandard): NamingField[] {
  return standard.fields.filter((f) => (f as { inName?: boolean }).inName !== false);
}

/** Fields that are kept as attributes only (none until the naming branch adds `inName: false`). */
export function attributeOnlyFields(standard: NamingStandard): NamingField[] {
  return standard.fields.filter((f) => (f as { inName?: boolean }).inName === false);
}

/** Allowed digit counts of a number field (fixed `digits` today; min/max later). */
export function numberDigits(field: NamingField): { min: number; max: number } {
  const f = field as { digits?: number; minDigits?: number; maxDigits?: number };
  const d = f.digits ?? 1;
  return { min: f.minDigits ?? d, max: f.maxDigits ?? d };
}

/** Pads or rejects a number for a number field ("204" → "0204" for four digits). */
export function fitNumber(field: NamingField, raw: string): string | null {
  const digits = raw.replace(/^0+(?=\d)/, "");
  if (!/^\d+$/.test(digits)) return null;
  const { min, max } = numberDigits(field);
  if (digits.length > max) return null;
  return digits.padStart(min, "0");
}

/** `lang`: language of the error messages. */
export function validate(standard: NamingStandard, fileName: string, lang?: string): NamingResult {
  return validateName(standard, fileName, lang);
}

/**
 * Values of the name's fields by field name; only fields that passed validation are returned.
 * (Uses validateName's per-field results; parseName() replaces this when it exists.)
 */
export function parseFields(standard: NamingStandard, fileName: string): Record<string, string> {
  const r = validateName(standard, fileName);
  const out: Record<string, string> = {};
  for (const f of r.fields) if (f.ok && f.value) out[f.field] = f.value;
  return out;
}

/** Joins field values into a file name; null when a field of the name has no value. */
export function composeName(standard: NamingStandard, values: Record<string, string | null | undefined>, extension: string): string | null {
  const parts: string[] = [];
  for (const f of nameFields(standard)) {
    const v = values[f.name];
    if (!v) return null;
    parts.push(v);
  }
  const base = parts.join(standard.delimiter);
  return extension ? `${base}.${extension}` : base;
}

export function extensionOf(fileName: string): string {
  return splitExtension(fileName).extension;
}
