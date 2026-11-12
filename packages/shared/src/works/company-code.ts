/** Company code normalization used by work numbering. */
import { SHARED_DEFAULT_LANGUAGE, sharedText } from "../platform/i18n.js";

const TR_ASCII: Record<string, string> = { Ç: "C", Ğ: "G", İ: "I", Ö: "O", Ş: "S", Ü: "U" };

/**
 * Turkish-aware upper case folded to ASCII, for codes in numbers: "giden-yazı" → "GIDEN-YAZI",
 * "Özgün İnşaat" → "OZGUN INSAAT". Other accents are dropped ("é" → "E").
 */
export function asciiUpper(text: string): string {
  return text
    .normalize("NFC")
    .toLocaleUpperCase("tr-TR")
    .replace(/[ÇĞİÖŞÜ]/g, (c) => TR_ASCII[c]!)
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
}

/** Company short codes: 2–8 upper-case ASCII letters or digits, e.g. "PAS", "HLL", "IBB1". */
export const COMPANY_CODE_RE = /^[A-Z0-9]{2,8}$/;

/** A typed company code normalised for storage ("hll " → "HLL", "İbb" → "IBB"); empty → null. */
export function normalizeCompanyCode(input: string | null | undefined): string | null {
  const code = asciiUpper(input ?? "").replace(/\s+/g, "");
  return code || null;
}

/** A company code while it is typed: ASCII upper case letters and digits, at most 8. */
export function companyCodeInput(input: string): string {
  return asciiUpper(input).replace(/[^A-Z0-9]/g, "").slice(0, 8);
}

/** Problem with a (normalised) company code, or null when it is valid. */
export function companyCodeProblem(code: string, lang: string = SHARED_DEFAULT_LANGUAGE): string | null {
  return COMPANY_CODE_RE.test(code) ? null : sharedText(lang, "companyCode.invalid");
}

/** Short code for a company name in numbers: ASCII letters and digits only, upper case (Turkish aware). */
export function numberCode(name: string | null | undefined, fallback = "X"): string {
  if (!name) return fallback;
  const code = asciiUpper(name).replace(/[^0-9A-Z]/g, "");
  return code.slice(0, 12) || fallback;
}

/** Code of a company in numbers: its short code, else derived from its name, else `fallback`. */
export function companyNumberCode(code: string | null | undefined, name: string | null | undefined, fallback = "X"): string {
  const c = code ? asciiUpper(code).replace(/[^0-9A-Z]/g, "") : "";
  return c || numberCode(name, fallback);
}
