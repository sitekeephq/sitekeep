/**
 * Suitability and revision codes of a version (ISO 19650-2 §5.1.7, UK NA; D-1;
 * docs/features/CDE_STATES.md "Codes"). The rules are the pure ones of
 * packages/shared/src/documents/cde-codes.ts; this file applies them to the project's profile and
 * the folder's state.
 *
 * - `checkVersionCodes` is the `checkCodes` guard (guards.ts delegates here), called by addVersion
 *   and the approved review copy.
 * - `legacyCodeInputs` / `acceptedLegacyCodes` lift the free attributes older clients write
 *   ("Uygunluk", "Uygunluk Kodu", "Revizyon") into the structured fields.
 */
import { eq } from "drizzle-orm";
import {
  DEFAULT_CDE_SETTINGS,
  codeProfile,
  defaultSuitability,
  nextRevision,
  normaliseRevision,
  normaliseSuitability,
  validateCodes,
  type CdeCodeError,
  type CdeCodeProfile,
  type CdeCodeWarningDto,
  type CdeSettingsDto,
  type CdeState,
} from "@sitekeep/shared";
import { FolderTree } from "../core/security/access.js";
import type { Db } from "../db/index.js";
import { projectCdeSettings } from "../db/schema.js";
import { HttpError } from "../core/platform/http.js";
import { msg, render, type Msg } from "../i18n/index.js";
import { isRevisionAttribute } from "../docintel/revision.js";
import type { CdeCodes, CodesCheck } from "./guards.js";
import { cdeStateOf } from "./state.js";

/** Attribute names that held the suitability code before codes were stored per version. */
export const LEGACY_SUITABILITY_KEYS = ["Uygunluk Kodu", "Uygunluk"] as const; // i18n-ok: attribute names (data)

export type CodeSettings = Pick<CdeSettingsDto, "codeScheme" | "suitabilityCodes" | "enforceTransitions">;

/** The code settings of a project (defaults without a row). */
export async function loadCodeSettings(db: Db, projectId: string): Promise<CodeSettings> {
  const [row] = await db
    .select({
      codeScheme: projectCdeSettings.codeScheme,
      suitabilityCodes: projectCdeSettings.suitabilityCodes,
      enforceTransitions: projectCdeSettings.enforceTransitions,
    })
    .from(projectCdeSettings)
    .where(eq(projectCdeSettings.projectId, projectId));
  return row
    ? { codeScheme: row.codeScheme, suitabilityCodes: row.suitabilityCodes ?? null, enforceTransitions: row.enforceTransitions }
    : { codeScheme: DEFAULT_CDE_SETTINGS.codeScheme, suitabilityCodes: null, enforceTransitions: false };
}

/** The message of a code error, in the reader's language later. */
export function codeErrorMsg(profile: CdeCodeProfile, state: CdeState | null, e: CdeCodeError): Msg {
  return msg(`cde:codes.errors.${e.kind}`, {
    value: e.value,
    allowed: e.allowed || "—",
    state: msg(`cde:codes.states.${state ?? "none"}`),
    scheme: msg(`cde:codes.schemes.${profile.scheme}`),
  });
}

/** 400 with the first code error; `details.errors` lists all of them (field, kind, value). */
export function codeError(profile: CdeCodeProfile, state: CdeState | null, errors: CdeCodeError[]): HttpError {
  return new HttpError(400, "cde_codes", codeErrorMsg(profile, state, errors[0]!), { errors });
}

/** A code that does not fit the state, kept because the project does not enforce the rules. */
export interface CodeWarning extends CdeCodeError {
  state: CdeState | null;
  /** The message, rendered later in the reader's language. */
  msg: Msg;
}

/** Codes of a version plus the warnings about them (none when the project enforces the rules: it refuses). */
export interface CheckedCodes extends CdeCodes {
  /** Missing for the review copy, so its callers can spread the result into a row. */
  warnings?: CodeWarning[];
}

/** Warnings as the API returns them, in the reader's language. */
export function warningDtos(lang: string, warnings: readonly CodeWarning[] | undefined): CdeCodeWarningDto[] {
  return (warnings ?? []).map(({ msg: m, ...w }) => ({ ...w, message: render(lang, m) }));
}

/** The state of the folder the version is stored in. */
async function stateOf(db: Db, input: Pick<CodesCheck, "projectId" | "folderId" | "tree" | "state">): Promise<CdeState | null> {
  if (input.state !== undefined) return input.state;
  const tree = input.tree ?? (await FolderTree.load(db, input.projectId));
  return cdeStateOf(tree, input.folderId);
}

const same = (a: string | null | undefined, b: string | null | undefined) => (a ?? null) === (b ?? null);

/**
 * The `checkCodes` guard. Codes asked for are normalised ("s2" → "S2", OpenCDE "A" → "A1") and
 * checked against the project's profile in the folder's state. A code that does not fit is refused
 * (400) only when the project enforces the ISO 19650 rules (`enforceTransitions`, D-8); otherwise
 * it is stored as given and returned as a warning, so existing projects and clients keep working.
 * A code that equals the previous version's is not checked again (grandfathered data).
 *
 * When the project enforces the ISO 19650 rules (`enforceTransitions`, D-8) and the folder has a
 * state, a version stored without codes gets them: the suitability of the previous version when it
 * still fits the state, else the state's default (WIP: S0); the next revision of the sequence
 * (P01.01 → P01.02; R00 → R01).
 *
 * The approved review copy (system work) carries its source's codes unchecked; the transition
 * rules (ISO-1) decide what a copy becomes.
 */
export async function checkVersionCodes(db: Db, input: CodesCheck): Promise<CheckedCodes> {
  const requested = {
    suitabilityCode: normaliseSuitability(input.requested.suitabilityCode),
    revisionCode: input.requested.revisionCode ?? null,
  };
  const settings = await loadCodeSettings(db, input.projectId);
  const profile = codeProfile(settings);
  if (input.source === "review_copy")
    return { suitabilityCode: requested.suitabilityCode, revisionCode: normaliseRevision(requested.revisionCode, profile) };
  // Nothing asked for and nothing to fill in: no folder state needed.
  if (!requested.suitabilityCode && !requested.revisionCode && !settings.enforceTransitions) return { suitabilityCode: null, revisionCode: null, warnings: [] };
  const state = await stateOf(db, input);
  const previous = input.previous ?? null;
  const check = validateCodes(profile, state, requested);
  const errors = check.errors.filter((e) => !same(e.value, previous?.[e.field]));
  if (errors.length && settings.enforceTransitions) throw codeError(profile, state, errors);
  const warnings = errors.map((e) => ({ ...e, state, msg: codeErrorMsg(profile, state, e) }));
  let { suitabilityCode, revisionCode } = check.codes;

  if (settings.enforceTransitions && state) {
    if (!suitabilityCode) {
      const kept = previous?.suitabilityCode && validateCodes(profile, state, { suitabilityCode: previous.suitabilityCode }).ok;
      suitabilityCode = kept ? previous!.suitabilityCode : defaultSuitability(profile, state);
    }
    if (!revisionCode) revisionCode = nextRevision(profile, previous?.revisionCode ?? null, state, state);
  }
  return { suitabilityCode, revisionCode, warnings };
}

/** Raw suitability / revision values in attributes, by the names older clients use. */
export function legacyCodeInputs(attributes: Record<string, string> | null | undefined): Partial<CdeCodes> {
  const out: Partial<CdeCodes> = {};
  if (!attributes) return out;
  for (const k of LEGACY_SUITABILITY_KEYS) {
    const v = attributes[k]?.trim();
    if (v) {
      out.suitabilityCode = v;
      break;
    }
  }
  const revKey = Object.keys(attributes).find((k) => isRevisionAttribute(k) && attributes[k]?.trim());
  if (revKey) out.revisionCode = attributes[revKey]!.trim();
  return out;
}

/**
 * The legacy attribute values of an upload to be stored as the version's codes, normalised: codes
 * of the project's profile; when the project enforces the rules, only those that fit the folder's
 * state. Other values stay attributes only and never refuse the upload (uploads, OpenCDE and
 * modules keep working as before). A code that does not fit the state of a project that does not
 * enforce the rules is stored and warned about by the guard.
 */
export async function acceptedLegacyCodes(
  db: Db,
  input: Pick<CodesCheck, "projectId" | "folderId" | "tree" | "state">,
  attributes: Record<string, string> | null | undefined,
): Promise<Partial<CdeCodes>> {
  const raw = legacyCodeInputs(attributes);
  if (!raw.suitabilityCode && !raw.revisionCode) return {};
  const settings = await loadCodeSettings(db, input.projectId);
  const profile = codeProfile(settings);
  const state = settings.enforceTransitions ? await stateOf(db, input) : null;
  const out: Partial<CdeCodes> = {};
  for (const field of ["suitabilityCode", "revisionCode"] as const) {
    if (!raw[field]) continue;
    // Not enforced: any code of the profile (state null = every state).
    const r = validateCodes(profile, state, { [field]: raw[field] });
    if (r.ok && r.codes[field]) out[field] = r.codes[field];
  }
  return out;
}
