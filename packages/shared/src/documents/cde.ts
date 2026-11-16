/**
 * ISO 19650 common data environment (CDE): project settings, state transitions and the document
 * status flags shared by the server and the web app (docs/features/CDE_STATES.md).
 *
 * The CDE state of a document is the state of the folder it lives in (`folders.state`: WIP,
 * Shared, Published, Archived). A document moves between states through a transition; the project
 * decides per transition whether it is a direct move, needs a review, happens automatically or is
 * forbidden. Enforcement is switched on per project (`enforceTransitions`).
 */
import type { FolderState } from "../core/types.js";

/** The four ISO 19650 states, in order. */
export const CDE_STATES = ["wip", "shared", "published", "archived"] as const satisfies readonly FolderState[];
export type CdeState = (typeof CDE_STATES)[number];

/**
 * How a document may go from one state to another:
 * - `direct`: an upload or move by anyone with the folder right;
 * - `review`: only through an approved review (the workflow template, when set);
 * - `auto`: the system does it (archive on a newer publication, back to WIP on rejection);
 * - `forbidden`: never. A pair that has no row is forbidden too.
 */
export const CDE_TRANSITION_MODES = ["direct", "review", "auto", "forbidden"] as const;
export type CdeTransitionMode = (typeof CDE_TRANSITION_MODES)[number];

/** Revision and suitability code profile of a project (D-1). */
export const CDE_CODE_SCHEMES = ["iso_uk_na", "legacy_r", "custom"] as const;
export type CdeCodeScheme = (typeof CDE_CODE_SCHEMES)[number];

/** Who sees a task team's WIP folders: the folder grants as set, or the owning team only (D-3, D-4). */
export const CDE_WIP_POLICIES = ["grants", "team_only"] as const;
export type CdeWipPolicy = (typeof CDE_WIP_POLICIES)[number];

/**
 * Status flag of a document beside its state (D-2): `returned` (a rejected WIP original),
 * `superseded` (a newer publication replaced it), `withdrawn` (a rejected Shared copy).
 */
export const CDE_FILE_STATUSES = ["returned", "superseded", "withdrawn"] as const;
export type CdeFileStatus = (typeof CDE_FILE_STATUSES)[number];

/** Project role kinds: a plain role or an ISO 19650 task team (D-4). */
export const PROJECT_ROLE_KINDS = ["role", "task_team"] as const;
export type ProjectRoleKind = (typeof PROJECT_ROLE_KINDS)[number];

/** A suitability code of a custom profile ("S2" → "Suitable for information"). */
export interface CdeSuitabilityCode {
  code: string;
  description?: string;
  /** The states the code may be used in; empty or missing: any. */
  states?: CdeState[];
}

/** Revision rules of a custom profile (kept open: filled by the codes work, ISO-2). */
export interface CdeRevisionRules {
  /** Pattern of preliminary revisions, e.g. "P{00}.{00}". */
  preliminary?: string;
  /** Pattern of contractual revisions, e.g. "C{00}". */
  contractual?: string;
  [key: string]: unknown;
}

export interface CdeTransitionDto {
  /** null: a direct upload (a new document arriving in `toState`). */
  fromState: CdeState | null;
  toState: CdeState;
  mode: CdeTransitionMode;
  /** The review workflow template a `review` transition runs (null: any approved review). */
  workflowTemplateId: string | null;
  /** The person must give a reason (stored in the audit log). */
  requireReason: boolean;
}

export interface CdeSettingsDto {
  projectId: string;
  enforceTransitions: boolean;
  codeScheme: CdeCodeScheme;
  /** Custom profile only; null: the scheme's built-in codes. */
  suitabilityCodes: CdeSuitabilityCode[] | null;
  revisionRules: CdeRevisionRules | null;
  /** Root of the archive (D-10, "04-ARCHIVED"); null: not set. */
  archiveFolderId: string | null;
  /** Naming standard that defines the document code (unique code register, D-5). */
  containerStandardId: string | null;
  wipPolicy: CdeWipPolicy;
  adminSeesWip: boolean;
  transitions: CdeTransitionDto[];
  /** null: never saved (the defaults are shown). */
  updatedAt: string | null;
}

/** Body of `PUT /projects/:pid/cde/settings`: every field optional; `transitions` replaces the table. */
export type CdeSettingsInput = Partial<Omit<CdeSettingsDto, "projectId" | "updatedAt">>;

/** Settings of a project that has no row yet (and of every project before the CDE work). */
export const DEFAULT_CDE_SETTINGS: Omit<CdeSettingsDto, "projectId" | "updatedAt"> = {
  enforceTransitions: false,
  codeScheme: "iso_uk_na",
  suitabilityCodes: null,
  revisionRules: null,
  archiveFolderId: null,
  containerStandardId: null,
  wipPolicy: "grants",
  adminSeesWip: true,
  transitions: [],
};

/** A transition in a project template: the review workflow is named, not referenced by id. */
export interface TemplateCdeTransition {
  from: CdeState | null;
  to: CdeState;
  mode: CdeTransitionMode;
  /** Name of a workflow in the same template. */
  workflow?: string;
  requireReason?: boolean;
}

/** The `"cde"` block of a project template; applied when a project is created from it. */
export interface TemplateCdeSettings {
  codeScheme?: CdeCodeScheme;
  enforceTransitions?: boolean;
  wipPolicy?: CdeWipPolicy;
  adminSeesWip?: boolean;
  /** Path of the archive folder, e.g. "04-ARCHIVED (Arşiv)". */
  archiveFolder?: string;
  transitions?: TemplateCdeTransition[];
  /**
   * Name of a naming standard of the template: the project's Document Code Standard
   * (`container_standard_id`), so document codes are unique from WIP on.
   */
  containerStandard?: string;
  /**
   * Task teams by slot (ISO-5, D-4). When given, exactly these slots get a task team (when a company
   * is mapped to them); `lead` marks the lead appointed party's team. Absent: one team per mapped slot.
   */
  taskTeams?: TemplateTaskTeam[];
}

/** A task team of a project template: the team of the company mapped to `slot`. */
export interface TemplateTaskTeam {
  slot: string;
  /** The lead appointed party's team. */
  lead?: boolean;
}

/** Key of a transition (the null state written as "upload"), e.g. "upload>wip", "wip>shared". */
export function cdeTransitionKey(from: CdeState | null, to: CdeState): string {
  return `${from ?? "upload"}>${to}`;
}

/**
 * What a review does to the ISO 19650 state of its files (ISO-1), returned by the review preview
 * (`POST /projects/:pid/reviews/preview`, field `cde`): the transition, the suitability the
 * approved copies get and the revision proposed per file. Null when the target has no state.
 */
export interface ReviewCdePlanDto {
  /** The project enforces the transitions; otherwise the copy keeps the source's codes. */
  enforce: boolean;
  toState: CdeState;
  /** The workflow template the transition table asks for (null: any review). */
  requiredWorkflowTemplateId: string | null;
  /** Suitability codes allowed in the target state. */
  allowedSuitability: string[];
  /** The suitability the copies get (chosen, else the default). */
  suitabilityCode: string | null;
  files: {
    versionId: string;
    fromState: CdeState | null;
    /** Mode of the transition (from → to) in the table; null: no row. */
    mode: CdeTransitionMode | null;
    currentRevision: string | null;
    proposedRevision: string | null;
  }[];
}

/**
 * The ISO 19650 transition table of D-7 without named workflows: direct upload only into WIP,
 * WIP → Shared and Shared → Published by an approved review, Shared → WIP and Published → Archived
 * by the system. A project that enforces the rules with an empty table uses it (ISO-1).
 */
export const DEFAULT_CDE_TRANSITIONS: readonly CdeTransitionDto[] = [
  { fromState: null, toState: "wip", mode: "direct", workflowTemplateId: null, requireReason: false },
  { fromState: "wip", toState: "shared", mode: "review", workflowTemplateId: null, requireReason: false },
  { fromState: "shared", toState: "wip", mode: "auto", workflowTemplateId: null, requireReason: false },
  { fromState: "shared", toState: "published", mode: "review", workflowTemplateId: null, requireReason: false },
  { fromState: "published", toState: "archived", mode: "auto", workflowTemplateId: null, requireReason: false },
];
