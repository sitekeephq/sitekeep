/**
 * Project template format v2 (docs/features/PROJECT_TEMPLATES.md): what a template carries beyond
 * folders, naming, attributes, workflows and the ISO 19650 "cde" block.
 *
 * - **Localized values.** Any value may be given per language, `{ "tr": "…", "en": "…" }`; the
 *   project's language picks one when the template is read (`localizeTemplate`).
 * - **Parts.** Project roles, issue types and transmittal settings are applied by the core; RFI,
 *   submittal, meeting and form settings belong to an Enterprise module (Manage, Field) and are
 *   handed to it when it is installed, else skipped and reported (`TEMPLATE_PARTS`).
 */
import type { ProjectModule } from "../core/modules.js";
import type { OutcomeCode } from "../workflow/workflow.js";

export const TEMPLATE_FORMAT_V2 = "7d-cde/project-template@2";

// ---- Localized values ----------------------------------------------------------------------

const LANGUAGE_KEY = /^[a-z]{2}$/;

/**
 * True for a per-language value: a non-empty object whose keys are all two-letter language codes,
 * one of them "en" or "tr" ({ "tr": "Yüklenici", "en": "Contractor" }).
 */
export function isLocalizedValue(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((k) => LANGUAGE_KEY.test(k)) && (keys.includes("en") || keys.includes("tr"));
}

/** The value of a per-language object in `lang`: `lang`, else English, else Turkish, else the first. */
export function pickLanguage(value: Record<string, unknown>, lang: string): unknown {
  const base = lang.toLowerCase().slice(0, 2);
  if (base in value) return value[base];
  if ("en" in value) return value.en;
  if ("tr" in value) return value.tr;
  return Object.values(value)[0];
}

/** A copy of a template (or any JSON) with every per-language value resolved for `lang`. */
export function localizeTemplate<T>(raw: T, lang: string): T {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object") return node;
    if (isLocalizedValue(node)) return walk(pickLanguage(node, lang));
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v)]));
  };
  return walk(raw) as T;
}

// ---- Parts ------------------------------------------------------------------------------------

/** A project role (kind "role") created with the project; workflow steps may name it (`{ projectRole: key }`). */
export interface TemplateRole {
  /** Reference inside the template ("yuklenici-kontrol"). */
  key: string;
  name: string;
  description?: string;
  /** Chip colour, #rrggbb. */
  color?: string;
  /** The party the role belongs to (documentation; people are added by the administrator). */
  slot?: string;
}

export interface TemplateIssueCategory {
  category: string;
  types: string[];
}

export const TEMPLATE_ISSUE_FIELD_TYPES = ["list", "text", "date", "number"] as const;

/** An issue field the template asks for (kept with the settings; issues have no custom fields yet). */
export interface TemplateIssueField {
  name: string;
  type: (typeof TEMPLATE_ISSUE_FIELD_TYPES)[number];
  options?: string[];
}

/** Issue types of new issues, grouped by category (core). */
export interface TemplateIssueSettings {
  categories: TemplateIssueCategory[];
  customFields?: TemplateIssueField[];
}

/** Transmittal settings (core works engine: the built-in "transmittal" work type). */
export interface TemplateTransmittalSettings {
  /** Name of the transmittal work type. */
  name?: string;
  /** Number pattern, work numbering tokens ({Proje}, {Gönderen}, {Alıcı}, {YYYY}, {0000} …). */
  numbering?: string;
  /** Document attributes listed for each file on the cover sheet (informative). */
  attributes?: string[];
}

export const TEMPLATE_RFI_PERMISSION_ROLES = ["creator", "coordinator", "reviewer", "manager", "watcher"] as const;
export type TemplateRfiPermissionRole = (typeof TEMPLATE_RFI_PERMISSION_ROLES)[number];

/** A code with a name ("M", "Mechanical engineer"). */
export interface TemplateCodeName {
  code: string;
  name: string;
}

/** RFI settings (Manage). */
export interface TemplateRfiSettings {
  /** RFI types (disciplines). */
  types?: TemplateCodeName[];
  defaultType?: string;
  categories?: string[];
  /** Days to answer. */
  responseDays?: number;
  /** Number pattern (work numbering tokens). */
  numbering?: string;
  /** Name of a workflow of the template (kind "rfi"): the default workflow of new RFIs. */
  workflow?: string;
  /** Who does what: slot keys or project role keys per RFI role. */
  permissions?: Partial<Record<TemplateRfiPermissionRole, string[]>>;
}

/** A response of a submittal review and the outcome it stands for. */
export interface TemplateSubmittalResponse {
  label: string;
  code: OutcomeCode;
}

/** Material / method approval (submittal) settings (Manage). */
export interface TemplateSubmittalSettings {
  itemTypes?: string[];
  responses?: TemplateSubmittalResponse[];
  /** Specification sections (disciplines). */
  specSections?: TemplateCodeName[];
  responseDays?: number;
  numbering?: string;
  /** Name of a workflow of the template (kind "submittal"): the default workflow of new items. */
  workflow?: string;
  /** Slot or project role keys kept informed. */
  watchers?: string[];
}

/** A meeting template (Manage): a meeting kind with its standard agenda. */
export interface TemplateMeeting {
  name: string;
  agenda: string[];
  /** Slot keys invited. */
  attendees?: string[];
  /** Folder path (from the project root) where the minutes are filed. */
  minutesFolder?: string;
}

/** A section of a form template; `editor` is the slot that fills it. */
export interface TemplateFormSection {
  name: string;
  editor?: string;
}

/** A form template (Field). */
export interface TemplateForm {
  /** Short code used in numbers ("DTF"). */
  key: string;
  name: string;
  category?: string;
  /** Name of a workflow of the template (kind "form"): the approval flow of the form. */
  workflow?: string;
  sections: TemplateFormSection[];
}

/** The v2 parts of a template and who applies them. */
export interface TemplateParts {
  roles?: TemplateRole[];
  issues?: TemplateIssueSettings;
  transmittal?: TemplateTransmittalSettings;
  rfi?: TemplateRfiSettings;
  submittals?: TemplateSubmittalSettings;
  meetings?: TemplateMeeting[];
  forms?: TemplateForm[];
}

export type TemplatePart = keyof TemplateParts;

/** Enterprise modules that apply template parts (docs/modules/README.md). */
export type TemplatePartModule = "manage" | "field";

/**
 * Every part, in the order it is applied: the module that applies it (null: the core) and the
 * project module switch it depends on (an off switch skips it).
 */
export const TEMPLATE_PARTS: readonly { part: TemplatePart; module: TemplatePartModule | null; projectModule: ProjectModule | null }[] = [
  { part: "roles", module: null, projectModule: null },
  { part: "issues", module: null, projectModule: "issues" },
  { part: "transmittal", module: null, projectModule: "transmittals" },
  { part: "rfi", module: "manage", projectModule: "rfi" },
  { part: "submittals", module: "manage", projectModule: "submittals" },
  { part: "meetings", module: "manage", projectModule: "meetings" },
  { part: "forms", module: "field", projectModule: "forms" },
];

/** The parts a template carries, in application order. */
export function templatePartsOf(template: TemplateParts): TemplatePart[] {
  return TEMPLATE_PARTS.filter(({ part }) => {
    const value = template[part];
    return Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null;
  }).map(({ part }) => part);
}

export const TEMPLATE_PART_STATUSES = ["applied", "partial", "skipped", "failed"] as const;
export type TemplatePartStatus = (typeof TEMPLATE_PART_STATUSES)[number];

/**
 * Why a part was skipped or failed: the module is not installed (or not licensed), the project's
 * module switch is off, the installed module version does not apply this part, or it failed.
 */
export type TemplatePartReason = "module_not_installed" | "module_off" | "unsupported" | "error";

/** What happened to one part when the project was created (`parts` of the create answer). */
export interface TemplatePartReportDto {
  part: TemplatePart;
  /** The module that applies it; null for the core. */
  module: TemplatePartModule | null;
  status: TemplatePartStatus;
  reason?: TemplatePartReason;
  /** Records created or changed. */
  count?: number;
  /** What was not applied, in the requester's language. */
  notes?: string[];
}

/** Whether a part can be applied on this server (preview, for the setup wizard). */
export interface TemplatePartAvailabilityDto {
  part: TemplatePart;
  module: TemplatePartModule | null;
  /** False when the module is not installed: the part will be skipped. */
  available: boolean;
}

/** Result of a module's template handler for one part. */
export interface TemplatePartResult {
  status: "applied" | "partial";
  count?: number;
  notes?: string[];
}
