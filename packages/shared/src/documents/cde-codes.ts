/**
 * ISO 19650 suitability (status) and revision codes per version (ISO 19650-2 §5.1.7, UK National
 * Annex; docs/features/CDE_STATES.md "Codes"). Pure rules shared by the server guard, the
 * live-data migration and the web inputs.
 *
 * Profiles (D-1):
 * - `iso_uk_na`: WIP → S0 with P01.01-style revisions; Shared → S1–S4 with P01; Published →
 *   A1…An, B1…Bn, CR with C01. Archived keeps whatever the publication had. S5–S7 are not used.
 * - `legacy_r`: R00, R01 … in any state; suitability codes are not tied to a state.
 * - `custom`: the ISO revisions with the project's own suitability list.
 * - `letter_rev`: letter revisions A, B … Z, then AA, AB … ZZ (projects imported from Autodesk
 *   Forma / ACC) in any state; suitability codes are not tied to a state.
 *
 * A project may override the suitability list (`suitability_codes`) in any profile; an entry
 * without states is allowed everywhere. A folder without a state accepts any code of the profile.
 */
import type { CdeCodeScheme, CdeState, CdeSuitabilityCode } from "./cde.js";

/** A suitability code or a family of them ("A" → A1, A2 …). */
interface SuitabilityRule {
  /** Exact code ("S2", "CR") or the family letter when `family` is set. */
  code: string;
  /** A1…An: the code is the letter followed by a positive number. */
  family?: boolean;
  /** Where the code may be used; missing or empty: any state. */
  states?: readonly CdeState[];
  description?: string;
}

/** Revision forms. */
export type CdeRevisionForm = "wip" | "preliminary" | "contractual" | "legacy" | "letter";

export interface CdeCodeProfile {
  scheme: CdeCodeScheme;
  suitability: readonly SuitabilityRule[];
  /** Revision forms allowed per state; `any` is used for a folder without a state. */
  revisions: Record<CdeState | "any", readonly CdeRevisionForm[]>;
  /** The project overrides the suitability list. */
  customSuitability: boolean;
}

const ISO_REVISIONS: CdeCodeProfile["revisions"] = {
  wip: ["wip"],
  shared: ["preliminary"],
  published: ["contractual"],
  archived: ["wip", "preliminary", "contractual"],
  any: ["wip", "preliminary", "contractual"],
};

const ISO_SUITABILITY: readonly SuitabilityRule[] = [
  { code: "S0", states: ["wip", "archived"], description: "Work in progress" },
  { code: "S1", states: ["shared", "archived"], description: "Suitable for coordination" },
  { code: "S2", states: ["shared", "archived"], description: "Suitable for information" },
  { code: "S3", states: ["shared", "archived"], description: "Suitable for review and comment" },
  { code: "S4", states: ["shared", "archived"], description: "Suitable for stage approval" },
  { code: "A", family: true, states: ["published", "archived"], description: "Authorized and accepted (stage n)" },
  { code: "B", family: true, states: ["published", "archived"], description: "Partially authorized and accepted, with comments" },
  { code: "CR", states: ["published", "archived"], description: "As constructed record" },
];

/** ISO 19650 UK National Annex profile (the default). */
export const ISO_UK_NA: CdeCodeProfile = {
  scheme: "iso_uk_na",
  suitability: ISO_SUITABILITY,
  revisions: ISO_REVISIONS,
  customSuitability: false,
};

/** Legacy profile: R00, R01 … in any state, no S/A split. */
export const LEGACY_R: CdeCodeProfile = {
  scheme: "legacy_r",
  suitability: ISO_SUITABILITY.map(({ states: _states, ...r }) => r),
  revisions: { wip: ["legacy"], shared: ["legacy"], published: ["legacy"], archived: ["legacy"], any: ["legacy"] },
  customSuitability: false,
};

/**
 * Letter revisions (Autodesk Forma / ACC): A, B … Z, then AA, AB … ZZ, in any state; the
 * suitability codes are those of the ISO list without a state (a project may override the list).
 */
export const LETTER_REV: CdeCodeProfile = {
  scheme: "letter_rev",
  suitability: LEGACY_R.suitability,
  revisions: { wip: ["letter"], shared: ["letter"], published: ["letter"], archived: ["letter"], any: ["letter"] },
  customSuitability: false,
};

const BASE_PROFILES: Partial<Record<CdeCodeScheme, CdeCodeProfile>> = { legacy_r: LEGACY_R, letter_rev: LETTER_REV };

/** The profile of a project: its scheme plus its own suitability list, when it has one. */
export function codeProfile(settings: { codeScheme: CdeCodeScheme; suitabilityCodes?: readonly CdeSuitabilityCode[] | null }): CdeCodeProfile {
  const base = BASE_PROFILES[settings.codeScheme] ?? ISO_UK_NA;
  const own = settings.suitabilityCodes?.filter((c) => normaliseSuitability(c.code));
  if (own?.length)
    return {
      ...base,
      scheme: settings.codeScheme,
      suitability: own.map((c) => ({ code: normaliseSuitability(c.code)!, states: c.states, description: c.description })),
      customSuitability: true,
    };
  return { ...base, scheme: settings.codeScheme };
}

// ---------------------------------------------------------------------------------------------
// Normalising

/**
 * "s2" → "S2", "S2 · For information" → "S2", "A" → "A1", "B" → "B1" (OpenCDE and older
 * attribute values), "a01" → "A1". Empty → null.
 */
export function normaliseSuitability(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const token = String(raw)
    .normalize("NFC")
    .trim()
    .split(/[\s·:–—]+/)[0]!
    .replace(/[İı]/g, "I")
    .toUpperCase();
  if (!token) return null;
  if (token === "A" || token === "B") return `${token}1`;
  const fam = /^([AB])0*([1-9]\d*)$/.exec(token);
  if (fam) return `${fam[1]}${fam[2]}`;
  return token;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** A letter revision: A … Z, AA … ZZ. */
const LETTER = /^[A-Z]{1,2}$/;

/** A → 1, Z → 26, AA → 27 … ZZ → 702; 0 for anything else. */
export function letterIndex(rev: string | null | undefined): number {
  if (!rev || !LETTER.test(rev)) return 0;
  return [...rev].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0);
}

/** 1 → A, 26 → Z, 27 → AA … 702 → ZZ; null outside 1–702. */
export function letterRevision(index: number): string | null {
  if (!Number.isInteger(index) || index < 1 || index > 702) return null;
  let n = index;
  let out = "";
  while (n > 0) {
    out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/**
 * Revision text in its canonical form: "p1" → "P01", "P1.2" → "P01.02", "c 1" → "C01",
 * "Rev 3" / "r3" → "R03"; in the legacy profile a bare number is an R revision ("3" → "R03");
 * "Rev b" / "rev. B" → "B" (a letter revision, in any profile; in the letter profile also a bare
 * "b"). Anything else is returned trimmed and upper-cased (and then fails validation). Empty → null.
 */
export function normaliseRevision(raw: string | null | undefined, profile?: CdeCodeProfile): string | null {
  if (raw === null || raw === undefined) return null;
  const t = String(raw)
    .normalize("NFC")
    .trim()
    .replace(/[İı]/g, "I")
    .toUpperCase();
  if (!t) return null;
  const spaced = t.replace(/\s+/g, "");
  const compact = spaced.replace(/^REV(?:ISION|IZYON)?[.\-:]?/, "");
  const hadRev = compact !== spaced;
  let m = /^([PC])[-]?(\d{1,3})(?:\.(\d{1,3}))?$/.exec(compact);
  if (m) return `${m[1]}${pad(Number(m[2]))}${m[3] !== undefined ? `.${pad(Number(m[3]))}` : ""}`;
  m = /^R[-]?(\d{1,3})$/.exec(compact);
  if (m) return `R${pad(Number(m[1]))}`;
  if ((hadRev || profile?.scheme === "legacy_r") && /^\d{1,3}$/.test(compact)) return `R${pad(Number(compact))}`;
  if ((hadRev || profile?.scheme === "letter_rev") && LETTER.test(compact)) return compact;
  return t;
}

/** Form of a canonical revision, or null when it is none of the known forms. */
export function revisionForm(rev: string): CdeRevisionForm | null {
  if (/^P\d{2,3}\.\d{2,3}$/.test(rev)) return "wip";
  if (/^P\d{2,3}$/.test(rev)) return "preliminary";
  if (/^C\d{2,3}$/.test(rev)) return "contractual";
  if (/^R\d{2,3}$/.test(rev)) return "legacy";
  if (LETTER.test(rev)) return "letter";
  return null;
}

// ---------------------------------------------------------------------------------------------
// Rules

const stateKey = (state: CdeState | null | undefined): CdeState | "any" => state ?? "any";

function ruleFor(profile: CdeCodeProfile, code: string): SuitabilityRule | undefined {
  return profile.suitability.find((r) => (r.family ? new RegExp(`^${r.code}[1-9]\\d*$`).test(code) : r.code === code));
}

const inState = (rule: SuitabilityRule, state: CdeState | null | undefined) =>
  !state || !rule.states?.length || rule.states.includes(state);

/** Is the code one of the profile's (in any state)? */
export function isKnownSuitability(profile: CdeCodeProfile, code: string | null | undefined): boolean {
  const c = normaliseSuitability(code);
  return !!c && !!ruleFor(profile, c);
}

/** Is the revision one of the profile's forms (in any state)? */
export function isKnownRevision(profile: CdeCodeProfile, rev: string | null | undefined): boolean {
  const r = normaliseRevision(rev, profile);
  const form = r ? revisionForm(r) : null;
  return !!form && profile.revisions.any.includes(form);
}

/**
 * Suitability codes offered in a state, in order (families shown as their first members:
 * A1, A2, A3). A folder without a state offers every code.
 */
export function allowedSuitability(profile: CdeCodeProfile, state: CdeState | null | undefined): string[] {
  const out: string[] = [];
  for (const r of profile.suitability) {
    if (!inState(r, state)) continue;
    if (r.family) out.push(`${r.code}1`, `${r.code}2`, `${r.code}3`);
    else out.push(r.code);
  }
  return out;
}

/** Revision forms allowed in a state. */
export function allowedRevisionForms(profile: CdeCodeProfile, state: CdeState | null | undefined): readonly CdeRevisionForm[] {
  return profile.revisions[stateKey(state)];
}

/** The suitability a new document gets by default in a state (WIP: S0), or null. */
export function defaultSuitability(profile: CdeCodeProfile, state: CdeState | null | undefined): string | null {
  if (state !== "wip") return null;
  return allowedSuitability(profile, state).includes("S0") ? "S0" : null;
}

export type CdeCodeErrorKind = "suitabilityUnknown" | "suitabilityState" | "revisionFormat" | "revisionState";

export interface CdeCodeError {
  field: "suitabilityCode" | "revisionCode";
  kind: CdeCodeErrorKind;
  /** The normalised value. */
  value: string;
  /** Allowed values / forms in the state, for the message. */
  allowed: string;
}

export interface CdeCodeValues {
  suitabilityCode?: string | null;
  revisionCode?: string | null;
}

/** Example of each revision form, for messages. */
export const REVISION_FORM_EXAMPLES: Record<CdeRevisionForm, string> = {
  wip: "P01.01",
  preliminary: "P01",
  contractual: "C01",
  legacy: "R00",
  letter: "A",
};

/**
 * Normalises the codes and checks them against the profile and the state. A missing or empty
 * code is not checked (null stays null).
 */
export function validateCodes(
  profile: CdeCodeProfile,
  state: CdeState | null | undefined,
  codes: CdeCodeValues,
): { ok: boolean; codes: { suitabilityCode: string | null; revisionCode: string | null }; errors: CdeCodeError[] } {
  const errors: CdeCodeError[] = [];
  const suitabilityCode = normaliseSuitability(codes.suitabilityCode);
  const revisionCode = normaliseRevision(codes.revisionCode, profile);
  if (suitabilityCode) {
    const rule = ruleFor(profile, suitabilityCode);
    const allowed = allowedSuitability(profile, state)
      .filter((c) => !/^[AB][23]$/.test(c))
      .map((c) => (/^[AB]1$/.test(c) && !profile.customSuitability ? `${c[0]}1…${c[0]}n` : c))
      .join(", ");
    if (!rule) errors.push({ field: "suitabilityCode", kind: "suitabilityUnknown", value: suitabilityCode, allowed });
    else if (!inState(rule, state)) errors.push({ field: "suitabilityCode", kind: "suitabilityState", value: suitabilityCode, allowed });
  }
  if (revisionCode) {
    const form = revisionForm(revisionCode);
    const forms = allowedRevisionForms(profile, state);
    const allowed = forms.map((f) => REVISION_FORM_EXAMPLES[f]).join(", ");
    if (!form || !profile.revisions.any.includes(form)) errors.push({ field: "revisionCode", kind: "revisionFormat", value: revisionCode, allowed });
    else if (!forms.includes(form)) errors.push({ field: "revisionCode", kind: "revisionState", value: revisionCode, allowed });
  }
  return { ok: errors.length === 0, codes: { suitabilityCode, revisionCode }, errors };
}

// ---------------------------------------------------------------------------------------------
// Revision sequence

const num = (s: string) => Number(s);

/** Highest major number of the given prefix among earlier revisions ("P03.02" counts as P03). */
function highest(history: readonly (string | null | undefined)[], prefix: "P" | "C" | "R", withMinorOnly = false): number {
  let max = 0;
  for (const h of history) {
    if (!h) continue;
    const m = new RegExp(`^${prefix}(\\d{2,3})(\\.\\d{2,3})?$`).exec(h);
    if (!m || (withMinorOnly && !m[2])) continue;
    max = Math.max(max, num(m[1]!));
  }
  return max;
}

/**
 * The revision a version gets when it is stored in `toState`, coming from `fromState` with the
 * `current` revision (null: a new document). `history` holds the earlier revisions of the same
 * document (container), so a new preliminary or contractual revision never reuses a number.
 *
 * ISO profile: P01.01 → P01.02 (WIP), WIP → Shared P01.03 → P01 (or the next free P0n),
 * Shared → Shared P01 → P02, → Published C01, then C02 …; back to WIP from P0n or C0n starts
 * the next preliminary revision (P02.01). Archived keeps the revision.
 * Legacy profile: R00 for a new document, R00 → R01 for a new version in the same state; a state
 * change keeps the revision. Letter profile: the same with A, A → B … Z → AA … ZZ (then none).
 */
export function nextRevision(
  profile: CdeCodeProfile,
  current: string | null | undefined,
  fromState: CdeState | null | undefined,
  toState: CdeState | null | undefined,
  history: readonly (string | null | undefined)[] = [],
): string | null {
  const cur = normaliseRevision(current, profile);
  const all = [...history.map((h) => normaliseRevision(h, profile)), cur];
  if (toState === "archived") return cur;

  if (profile.scheme === "letter_rev") {
    const top = Math.max(0, ...all.map(letterIndex));
    if (!cur || !letterIndex(cur)) return letterRevision(top + 1);
    if (fromState !== toState) return cur;
    return letterRevision(Math.max(top, letterIndex(cur)) + 1);
  }

  if (profile.scheme === "legacy_r") {
    const m = cur ? /^R(\d{2,3})$/.exec(cur) : null;
    if (!m) return `R${pad(highest(all, "R") + (cur || all.some(Boolean) ? 1 : 0))}`;
    if (fromState !== toState) return cur;
    return `R${pad(num(m[1]!) + 1)}`;
  }

  const form = cur ? revisionForm(cur) : null;
  const wip = cur ? /^P(\d{2,3})\.(\d{2,3})$/.exec(cur) : null;
  const nextP = () => highest(all, "P") + 1;

  // A folder without a state: the next revision of the same form.
  if (!toState) {
    if (!cur || !form) return null;
    if (wip) return `P${pad(num(wip[1]!))}.${pad(num(wip[2]!) + 1)}`;
    if (form === "preliminary") return `P${pad(nextP())}`;
    if (form === "contractual") return `C${pad(highest(all, "C") + 1)}`;
    return null;
  }

  switch (toState) {
    case "wip": {
      if (wip) return `P${pad(num(wip[1]!))}.${pad(num(wip[2]!) + 1)}`;
      // From P0n or C0n (or nothing): the next preliminary revision starts.
      return `P${pad(nextP())}.01`;
    }
    case "shared": {
      // WIP P01.03 → P01, unless P01 was shared already: then the next free number.
      const used = new Set(all.filter((h): h is string => !!h && /^P\d{2,3}$/.test(h)).map((h) => num(h.slice(1))));
      if (wip) {
        const major = num(wip[1]!);
        return `P${pad(used.has(major) ? Math.max(...used) + 1 : major)}`;
      }
      return `P${pad((used.size ? Math.max(...used) : 0) + 1)}`;
    }
    case "published":
      return `C${pad(highest(all, "C") + 1)}`;
  }
  return null;
}

/** First revision of a new document in a state (P01.01, P01, C01; R00; A). */
export function initialRevision(profile: CdeCodeProfile, state: CdeState | null | undefined): string | null {
  return nextRevision(profile, null, null, state ?? null);
}

// ---------------------------------------------------------------------------------------------
// API shapes

/** GET /projects/:pid/folders/:fid/cde/codes: what the web needs to offer and check codes. */
export interface CdeFolderCodesDto {
  codeScheme: CdeCodeScheme;
  suitabilityCodes: CdeSuitabilityCode[] | null;
  enforceTransitions: boolean;
  /** The folder's state (its own or inherited); null: none. */
  state: CdeState | null;
}

/** Body of PATCH /projects/:pid/versions/:vid/codes (a missing field keeps its value, null clears it). */
export interface CdeVersionCodesInput {
  suitabilityCode?: string | null;
  revisionCode?: string | null;
  /** Required outside WIP (an administrator's override). */
  reason?: string;
}

/** A legacy attribute value the migration could not turn into a code. */
export interface CdeUnmappedCodeDto {
  fileId: string;
  versionId: string;
  name: string;
  folderId: string;
  field: "suitabilityCode" | "revisionCode";
  /** The attribute value as written. */
  value: string;
  /**
   * `unknown`: not a code of the profile; `state`: a code of the profile that does not fit the
   * folder's state, while the project enforces the rules.
   */
  reason?: "unknown" | "state";
}

/**
 * Result of POST /projects/:pid/cde/codes/apply: the legacy attribute values of the project's
 * current versions mapped into empty codes under its current profile.
 */
export interface CdeApplyCodesReportDto {
  scheme: CdeCodeScheme;
  /** Versions that got at least one code. */
  versionsMapped: number;
  /** Codes stored (suitability and revision counted separately). */
  codesMapped: number;
  /** Of these, codes that do not fit the folder's state (stored: the project does not enforce the rules). */
  outOfState: number;
  /** Values still not converted. */
  unmapped: number;
  /** Values that left the unmapped list ("cde.migration_unmapped") in this run. */
  resolved: number;
  /** The unmapped list was cut at its limit. */
  truncated: boolean;
}

/**
 * A code that does not fit the folder's state, stored anyway because the project does not enforce
 * the ISO 19650 rules (D-8): returned beside the result so the interface can warn.
 */
export interface CdeCodeWarningDto extends CdeCodeError {
  state: CdeState | null;
  /** The warning in the reader's language. */
  message: string;
}
