/**
 * AI data minimisation: personal data is replaced with placeholders before a prompt goes to a
 * model outside the network (and to local models too with "Yerel modelde de maskele").
 *
 *   e-posta        ali.veli@firma.com.tr            → [E-POSTA_1]
 *   telefon        +90 532 123 45 67, 0212 555 12 34 → [TELEFON_1]
 *   TC kimlik no   11 digits with a valid checksum   → [TCKN_1]
 *   IBAN (TR)      TR33 0006 1005 1978 6457 8413 26  → [IBAN_1]
 *   kişi           project members' full names        → [Proje Müdürü (Poyraz)]
 *
 * The mapping lives in memory for one model call only (one Redactor per call): the answer's
 * placeholders are put back before it is shown to the same user. Nothing is stored.
 */

export type RedactionKind = "eposta" | "telefon" | "tckn" | "iban" | "kisi";

export interface RedactPerson {
  /** Full name as written in the user list ("Ayşe Demir"). */
  name: string;
  /** Role and company shown instead ("Proje Müdürü (Poyraz)"). */
  label: string;
}

const CODES: Record<Exclude<RedactionKind, "kisi">, string> = {
  eposta: "E-POSTA",
  telefon: "TELEFON",
  tckn: "TCKN",
  iban: "IBAN",
};

/** TC kimlik numarası: 11 digits, first not 0, digits 10 and 11 are checksums. */
export function isValidTckn(value: string): boolean {
  if (!/^[1-9]\d{10}$/.test(value)) return false;
  const d = [...value].map(Number);
  const odd = d[0]! + d[2]! + d[4]! + d[6]! + d[8]!;
  const even = d[1]! + d[3]! + d[5]! + d[7]!;
  if ((((odd * 7 - even) % 10) + 10) % 10 !== d[9]) return false;
  return d.slice(0, 10).reduce((a, b) => a + b, 0) % 10 === d[10];
}

const IBAN_TR = /\bTR\s?\d{2}(?:\s?\d{4}){5}\s?\d{2}\b/gi;
const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/gu;
const TCKN = /(?<![\p{N}])[1-9]\d{10}(?![\p{N}])/gu;
/**
 * Turkish numbers: optional +90 / 0090 / 0 prefix, area code (2xx–5xx, may be in parentheses with
 * its 0), then 3-2-2 digits with optional spaces, dots or dashes. Without a prefix only mobile
 * numbers (5xx) count, so other 10-digit codes are left alone.
 */
const PHONE = /(?<![\p{L}\p{N}+])((?:\+|00)\s?90[\s.-]?|0[\s.-]?)?(\(\s*0?\s*[2-5]\d{2}\s*\)|[2-5]\d{2})[\s.-]?(\d{3})[\s.-]?(\d{2})[\s.-]?(\d{2})(?![\p{N}])/gu;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A pattern for a name that ignores case the Turkish way (I/ı, İ/i) and spacing. */
function namePattern(name: string): RegExp {
  const parts = name
    .trim()
    .split(/\s+/)
    .map((word) =>
      [...word]
        .map((c) => {
          const v = new Set([c, c.toLocaleLowerCase("tr"), c.toLocaleUpperCase("tr"), c.toLowerCase(), c.toUpperCase()]);
          return v.size > 1 ? `[${[...v].map(escapeRe).join("")}]` : escapeRe(c);
        })
        .join(""),
    );
  return new RegExp(`(?<![\\p{L}\\p{N}])${parts.join("\\s+")}(?![\\p{L}\\p{N}])`, "gu");
}

/** Placeholder-safe label: no brackets, quotes or backslashes. */
function cleanLabel(label: string): string {
  return label.replace(/[[\]"\\]/g, "").replace(/\s+/g, " ").trim() || "Proje Üyesi"; // i18n-ok: redaction placeholder in text sent to the AI model
}

export class Redactor {
  readonly counts: Record<RedactionKind, number> = { eposta: 0, telefon: 0, tckn: 0, iban: 0, kisi: 0 };
  /** Normalised original → placeholder. */
  private readonly byValue = new Map<string, string>();
  /** Placeholder → original (first spelling seen). */
  private readonly byPlaceholder = new Map<string, string>();
  private readonly numbers: Record<Exclude<RedactionKind, "kisi">, number> = { eposta: 0, telefon: 0, tckn: 0, iban: 0 };
  private readonly people: { re: RegExp; label: string; key: string }[];
  private readonly labelUse = new Map<string, number>();

  constructor(people: RedactPerson[] = []) {
    // Only full names (two words or more): a single word ("Yönetici", "Admin") is too common.
    const seen = new Set<string>();
    this.people = people
      .filter((p) => p.name.trim().split(/\s+/).length >= 2)
      .sort((a, b) => b.name.length - a.name.length)
      .filter((p) => {
        const key = p.name.trim().toLocaleLowerCase("tr").replace(/\s+/g, " ");
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((p) => ({ re: namePattern(p.name), label: cleanLabel(p.label), key: `kisi:${p.name.trim().toLocaleLowerCase("tr").replace(/\s+/g, " ")}` }));
  }

  /** Number of replacements so far. */
  get total(): number {
    return Object.values(this.counts).reduce((a, b) => a + b, 0);
  }

  private coded(kind: Exclude<RedactionKind, "kisi">, key: string, original: string): string {
    this.counts[kind]++;
    const known = this.byValue.get(key);
    if (known) return known;
    const ph = `[${CODES[kind]}_${++this.numbers[kind]}]`;
    this.byValue.set(key, ph);
    this.byPlaceholder.set(ph, original);
    return ph;
  }

  private person(key: string, label: string, original: string): string {
    this.counts.kisi++;
    const known = this.byValue.get(key);
    if (known) return known;
    const n = (this.labelUse.get(label) ?? 0) + 1;
    this.labelUse.set(label, n);
    const ph = n === 1 ? `[${label}]` : `[${label} ${n}]`;
    this.byValue.set(key, ph);
    this.byPlaceholder.set(ph, original);
    return ph;
  }

  /** Replaces personal data in one text. */
  redact(text: string): string {
    if (!text) return text;
    let out = text.replace(IBAN_TR, (m) => this.coded("iban", `iban:${m.replace(/\s/g, "").toUpperCase()}`, m));
    out = out.replace(EMAIL, (m) => this.coded("eposta", `eposta:${m.toLowerCase()}`, m));
    out = out.replace(TCKN, (m) => (isValidTckn(m) ? this.coded("tckn", `tckn:${m}`, m) : m));
    out = out.replace(PHONE, (m, prefix: string | undefined, area: string) => {
      const inParens = area.startsWith("(");
      const areaDigits = area.replace(/\D/g, "").replace(/^0/, "");
      if (!prefix && !(inParens && /\(\s*0/.test(area)) && !areaDigits.startsWith("5")) return m;
      const digits = m.replace(/\D/g, "").slice(-10);
      return this.coded("telefon", `telefon:${digits}`, m);
    });
    for (const p of this.people) out = out.replace(p.re, (m) => this.person(p.key, p.label, m));
    return out;
  }

  /** Redacts every string inside a JSON-like value (tool call arguments). */
  redactDeep<T>(value: T): T {
    return mapStrings(value, (s) => this.redact(s));
  }

  /** Puts the originals back into a model answer. */
  restore(text: string): string {
    if (!text || !this.byPlaceholder.size) return text;
    let out = text;
    const entries = [...this.byPlaceholder.entries()].sort((a, b) => b[0].length - a[0].length);
    for (const [ph, original] of entries) out = out.split(ph).join(original);
    // Models sometimes drop the brackets of coded placeholders: E-POSTA_1 → original.
    for (const [ph, original] of entries) {
      const core = /^\[([A-Z-]+_\d+)\]$/.exec(ph)?.[1];
      if (core) out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}_\\[-])${escapeRe(core)}(?![\\p{N}])`, "gu"), original);
    }
    return out;
  }

  restoreDeep<T>(value: T): T {
    return mapStrings(value, (s) => this.restore(s));
  }
}

function mapStrings<T>(value: T, fn: (s: string) => string): T {
  if (typeof value === "string") return fn(value) as T;
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = mapStrings(v, fn);
    return out as T;
  }
  return value;
}

/** One-shot helper: redacted text and counts. */
export function redactText(text: string, people: RedactPerson[] = []): { text: string; counts: Record<RedactionKind, number> } {
  const r = new Redactor(people);
  return { text: r.redact(text), counts: { ...r.counts } };
}
