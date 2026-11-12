/** Work number pattern validation and rendering. */
import type { WorkFieldDef } from "./work-catalog.js";
import type { WorkFieldValues } from "./work-fields.js";
import { asciiUpper, companyNumberCode, numberCode } from "./company-code.js";
import { SHARED_DEFAULT_LANGUAGE, sharedText } from "../platform/i18n.js";

// ---- Numbering ------------------------------------------------------------------------------

export interface NumberingContext {
  projectCode: string;
  typeKey: string;
  /** Sender company name (code derived from it when `fromCode` is empty). */
  fromCompany?: string | null;
  /** Sender company short code (companies.code); preferred over the name. */
  fromCode?: string | null;
  /** First "to" company name. */
  toCompany?: string | null;
  /** First "to" company short code. */
  toCode?: string | null;
  date: Date;
  /** Field tokens ({Disiplin}, {Tür}, {Bölüm}…): folded field key / label → value (see workTokenValues). */
  values?: Record<string, string>;
  /** Title used by {Konu}. */
  subject?: string | null;
}

/** Counter token: {0000} → 4 digits. Only one counter per pattern. */
const COUNTER_RE = /\{(0+)\}/;
const TOKEN_RE = /\{([^{}]+)\}/g;

/** Pattern tokens (syntax, not translated) and the message key of their description. */
const NUMBERING_TOKENS: [string, string][] = [
  ["{Proje}", "project"],
  ["{Tip}", "type"],
  ["{Gönderen}", "sender"], // i18n-ok: pattern token
  ["{Alıcı}", "recipient"], // i18n-ok: pattern token
  ["{YYYY}", "year"],
  ["{YY}", "year2"],
  ["{MM}", "month"],
  ["{0000}", "sequence"],
  ["{Disiplin}, {Tür}…", "fields"], // i18n-ok: pattern tokens
  ["{Konu}", "subject"],
];

/** Pattern tokens with their description in `lang`: [["{Proje}", "project code"], …]. */
export function numberingTokens(lang: string = SHARED_DEFAULT_LANGUAGE): [string, string][] {
  return NUMBERING_TOKENS.map(([token, key]) => [token, sharedText(lang, `workNumbering.tokens.${key}`)]);
}

/** Tokens that never take part in the counter scope (a subject would give every work its own counter). */
const SCOPE_FREE_TOKENS = new Set(["konu"]);

/** Code of a list value: "M - Mekanik" → "M"; other values unchanged. */
export function listCode(value: string): string {
  const m = /^\s*(\S.*?)\s+[-–—]\s+/.exec(value);
  return (m ? m[1]! : value).trim();
}

/** A field value as it appears in a number: no spaces or separators, upper case, at most 20 characters. */
export function tokenCode(value: string): string {
  const code = asciiUpper(value)
    .replace(/\s+/g, "")
    .replace(/[^0-9A-Z.]/g, "");
  return code.slice(0, 20) || "X";
}

/** {Konu}: the title as words joined by "-", letters and digits only, at most 40 characters. */
export function subjectSlug(title: string | null | undefined): string {
  const words = (title ?? "")
    .split(/\s+/)
    .map((w) => w.replace(/[^0-9A-Za-zÇĞİÖŞÜçğıöşü]/g, ""))
    .filter(Boolean);
  let out = "";
  for (const w of words) {
    const next = out ? `${out}-${w}` : w;
    if (next.length > 40) break;
    out = next;
  }
  return out || "X";
}

/** Folded token / field name: Turkish-aware lower case without spaces, "-" and "_". */
export function foldToken(s: string): string {
  return s
    .normalize("NFC")
    .replace(/[İIı]/g, "i")
    .toLocaleLowerCase("tr-TR")
    .replace(/i̇/g, "i")
    .replace(/[\s_-]+/g, "");
}

/** Values of a type's fields for numbering tokens, keyed by folded key and label (empty → "X"). */
export function workTokenValues(defs: readonly WorkFieldDef[], values: WorkFieldValues): Record<string, string> {
  const out: Record<string, string> = {};
  for (const d of defs) {
    const v = values[d.key];
    const raw = v === undefined || v === null || v === "" ? "" : String(v);
    const code = raw ? tokenCode(d.type === "list" ? listCode(raw) : raw) : "X";
    out[foldToken(d.key)] = code;
    out[foldToken(d.label)] = code;
  }
  return out;
}

/** Problems in a numbering pattern (empty when valid). Field tokens are allowed when `fields` define them. */
export function checkNumberingPattern(pattern: string, fields: readonly WorkFieldDef[] = [], lang: string = SHARED_DEFAULT_LANGUAGE): string[] {
  const out: string[] = [];
  if (!pattern.trim()) return [sharedText(lang, "workNumbering.empty")];
  const counters = pattern.match(/\{0+\}/g) ?? [];
  if (counters.length !== 1) out.push(sharedText(lang, "workNumbering.counter"));
  const known = new Set(["Proje", "Tip", "Gönderen", "Alıcı", "YYYY", "YY", "MM", "Konu"]); // i18n-ok: pattern tokens
  const fieldKeys = new Set(fields.flatMap((f) => [foldToken(f.key), foldToken(f.label)]));
  for (const m of pattern.matchAll(TOKEN_RE)) {
    const t = m[1]!;
    if (!/^0+$/.test(t) && !known.has(t) && !fieldKeys.has(foldToken(t))) out.push(sharedText(lang, "workNumbering.unknownToken", { token: `{${t}}` }));
  }
  return out;
}

function fillTokens(pattern: string, ctx: NumberingContext): string {
  const y = ctx.date.getFullYear();
  return pattern.replace(TOKEN_RE, (all, t: string) => {
    switch (t) {
      case "Proje":
        return ctx.projectCode;
      case "Tip":
        return asciiUpper(ctx.typeKey);
      case "Gönderen": // i18n-ok: pattern token
        // No sender company (e.g. a user without a company): the project code stands in.
        return companyNumberCode(ctx.fromCode, ctx.fromCompany, numberCode(ctx.projectCode));
      case "Alıcı": // i18n-ok: pattern token
        return companyNumberCode(ctx.toCode, ctx.toCompany);
      case "YYYY":
        return String(y);
      case "YY":
        return String(y).slice(-2);
      case "MM":
        return String(ctx.date.getMonth() + 1).padStart(2, "0");
      case "Konu":
        return subjectSlug(ctx.subject);
      default:
        if (/^0+$/.test(t)) return all;
        return ctx.values?.[foldToken(t)] ?? all;
    }
  });
}

/**
 * Counter scope: the pattern with every token except the counter filled in. Works whose scope
 * is equal share one counter, so "{Proje}-{Gönderen}-{YYYY}-{000}" restarts per sender and year.
 */
export function numberingScope(pattern: string, ctx: NumberingContext): string {
  const scoped = pattern.replace(TOKEN_RE, (all, t: string) => (SCOPE_FREE_TOKENS.has(foldToken(t)) ? "" : all));
  return fillTokens(scoped, ctx).replace(COUNTER_RE, "#");
}

export function renderWorkNumber(pattern: string, ctx: NumberingContext, seq: number): string {
  return fillTokens(pattern, ctx).replace(COUNTER_RE, (_all, zeros: string) => String(seq).padStart(zeros.length, "0"));
}
