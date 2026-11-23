/**
 * Project set-up wizard (docs/features/PROJECT_SETUP_WIZARD.md): the explicit choices a wizard
 * makes on top of a project template. The choices are applied to the template itself
 * (`applySetupOverrides`) and the result goes through the same checks as any template
 * (`checkProjectTemplate`), so a wizard project equals a template project plus these choices.
 *
 * Pure functions: the server (preview, create) and the web wizard (step validation) share them.
 */
import type { ProjectModule } from "../core/module-state.js";
import type { CdeCodeScheme, CdeState, CdeWipPolicy, TemplateTaskTeam } from "../documents/cde.js";
import { cdeTransitionKey } from "../documents/cde.js";
import type { StepRule } from "../workflow/workflow.js";
import { CSB_PROJECT_CODE_PATTERN } from "../kernel/naming-csb2026.js";
import { SHARED_DEFAULT_LANGUAGE, sharedText } from "./i18n.js";
import type { InvitationDeliveryDto, InvitationLanguage } from "./invitations.js";
import {
  FOLDER_NAME_FORBIDDEN,
  checkProjectTemplate,
  folderNode,
  type CreateFromTemplateRequest,
  type ProjectTemplate,
  type TemplateAssignee,
  type TemplatePreviewDto,
  type TemplateFolder,
  type TemplateSlot,
} from "./template.js";

/** Code profiles the wizard offers (custom suitability lists are edited in Project Settings → CDE). */
export const PROJECT_SETUP_CODE_SCHEMES = ["iso_uk_na", "legacy_r"] as const satisfies readonly CdeCodeScheme[];

/** At most this many folder additions and removals per project. */
export const PROJECT_SETUP_MAX_FOLDER_EDITS = 50;
/** At most this many parties added to the template's slots. */
export const PROJECT_SETUP_MAX_EXTRA_PARTIES = 10;
/** At most this many people added while the project is created. */
export const PROJECT_SETUP_MAX_PEOPLE = 200;

export interface ProjectSetupDetails {
  /** YYYY-MM-DD. */
  startDate?: string;
  /** YYYY-MM-DD, not before the start. */
  endDate?: string;
  location?: string;
  /** The client (appointing party) as written on title blocks. */
  client?: string;
  /**
   * ÇŞB EK-1 project code (six characters, e.g. "270001"), given by the authority. Fills the
   * "{EK1}" token of naming standards (ÇŞB 2026 EK-2 profile: docs/features/NAMING_CSB_2026.md).
   */
  csbProjectCode?: string;
}

/**
 * A person added to the project by e-mail, in a party (slot) and project roles: an existing user, or
 * (with `invite` on the request) someone without an account, who is invited.
 */
export interface ProjectSetupPerson {
  email: string;
  /** Name of an invited person until they set their own (default: the part before @). */
  name?: string;
  /** Slot key: the member's company in the project is the company mapped to it. */
  slot?: string | null;
  /** Project role keys of the template (`roles[].key`). */
  roles?: string[];
  projectAdmin?: boolean;
}

/** New assignees, duration or rule of one workflow step (`step`: 0-based). */
export interface ProjectSetupStepOverride {
  workflow: string;
  step: number;
  assignees?: TemplateAssignee[];
  days?: number;
  rule?: StepRule;
}

/** The workflow a review transition of the template's table asks for (null: any approved review). */
export interface ProjectSetupTransitionOverride {
  from: CdeState | null;
  to: CdeState;
  workflow: string | null;
}

/** New codes of a list field of a naming standard (e.g. the Volume or Level codes of the project). */
export interface ProjectSetupNamingValues {
  standard: string;
  field: string;
  values: { code: string; description?: string }[];
}

export interface ProjectSetupFolderAdd {
  /** Path of an existing template folder ("00-GENERAL" or "00-GENERAL/06-Meeting Minutes"). */
  parent: string;
  name: string;
}

export interface ProjectSetupOverrides {
  /** Parties added to the template's slots (e.g. the client's technical unit). */
  parties?: TemplateSlot[];
  /** Slots that get a task team, and the lead appointed party (replaces `cde.taskTeams`). */
  taskTeams?: TemplateTaskTeam[];
  /** Folders added below template folders and template folders left out (no state, not referenced). */
  folders?: { add?: ProjectSetupFolderAdd[]; remove?: string[] };
  /**
   * Name of the naming standard that gives document codes (`cde.containerStandard`). When it differs
   * from the template's, folders named by the template's document code standard switch to it (e.g.
   * the ÇŞB 2026 profile instead of the ISO 19650 naming of the Turkish construction template).
   */
  containerStandard?: string;
  naming?: ProjectSetupNamingValues[];
  workflows?: ProjectSetupStepOverride[];
  transitions?: ProjectSetupTransitionOverride[];
  cde?: { codeScheme?: (typeof PROJECT_SETUP_CODE_SCHEMES)[number]; enforceTransitions?: boolean; wipPolicy?: CdeWipPolicy; adminSeesWip?: boolean };
  /** Project module switches (an off switch skips the template parts of that module). */
  modules?: Partial<Record<ProjectModule, boolean>>;
}

/** What happened to a person of the wizard when the project was created (or would be, in the dry run). */
export interface ProjectSetupPersonReportDto {
  email: string;
  /**
   * added: member with the chosen party and roles; invite (dry run) / invited: no account, invited
   * (a pending member until the invitation is accepted); no_account: no account and no invitation;
   * group_address: info@, noreply@ … are not added.
   */
  status: "added" | "invite" | "invited" | "no_account" | "group_address";
  userId?: string;
  name?: string;
  /** invited: the invitation (the link when no e-mail was sent). */
  invitation?: InvitationDeliveryDto;
}

/** Invitations of the wizard: people without an account are invited instead of only reported. */
export interface ProjectSetupInvite {
  /** Language of the e-mails; default the installation's language. */
  language?: InvitationLanguage;
}

/** `POST /projects/from-template` and `POST /projects/setup/preview` with the wizard's choices. */
export interface ProjectSetupRequest extends CreateFromTemplateRequest {
  setup?: ProjectSetupOverrides;
  details?: ProjectSetupDetails;
  people?: ProjectSetupPerson[];
  invite?: ProjectSetupInvite;
}

/** The dry run of the wizard (`POST /projects/setup/preview`): the template preview plus the people. */
export interface ProjectSetupPreviewDto extends TemplatePreviewDto {
  people: ProjectSetupPersonReportDto[];
}

const SLOT_KEY = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const GROUP_LOCAL_PARTS = new Set([
  "admin", "all", "bilgi", "contact", "hello", "hr", "ik", "info", "iletisim", "mail", "muhasebe", "no-reply",
  "noreply", "office", "sales", "satis", "support", "destek", "team", "ekip", "proje", "project", "projects",
]);

/** "proje2" → "proje", "info_01" → "info" (linear: a regex ending in \d+$ backtracks quadratically). */
function withoutTrailingNumber(local: string): string {
  let end = local.length;
  while (end > 0 && local.charCodeAt(end - 1) >= 48 && local.charCodeAt(end - 1) <= 57) end--;
  if (end === local.length) return local;
  if (end > 0 && "._-".includes(local[end - 1]!)) end--;
  return local.slice(0, end);
}

/** A shared mailbox (info@, noreply@, proje@ …): group addresses are not added as people (design §3). */
export function isGroupAddress(email: string): boolean {
  const local = email.trim().toLowerCase().split("@")[0] ?? "";
  return GROUP_LOCAL_PARTS.has(local) || GROUP_LOCAL_PARTS.has(withoutTrailingNumber(local));
}

/** Folder path → the declared folder and its parent list (before skeleton expansion). */
function findDeclared(
  list: (string | TemplateFolder)[],
  path: string,
): { parent: (string | TemplateFolder)[]; index: number; folder: TemplateFolder } | null {
  const names = path.split("/").map((n) => n.trim()).filter(Boolean);
  if (!names.length) return null;
  let level = list;
  for (let i = 0; i < names.length; i++) {
    const index = level.findIndex((node) => folderNode(node).name === names[i]);
    if (index < 0) return null;
    const node = level[index]!;
    if (typeof node === "string") {
      // A string folder becomes an object so children can be added to it.
      level[index] = { name: node };
    }
    const folder = level[index] as TemplateFolder;
    if (i === names.length - 1) return { parent: level, index, folder };
    level = folder.children ??= [];
  }
  return null;
}

function hasState(folder: TemplateFolder): boolean {
  if (folder.state || folder.skeleton) return true;
  return (folder.children ?? []).some((child) => typeof child !== "string" && hasState(child));
}

/** Folder paths the template refers to (archive, review copy targets, meeting minutes). */
function referencedPaths(template: ProjectTemplate): string[] {
  const out: string[] = [];
  if (template.cde?.archiveFolder) out.push(template.cde.archiveFolder);
  for (const w of template.workflows ?? []) if (w.chain?.copyTarget?.folder) out.push(w.chain.copyTarget.folder);
  for (const m of template.meetings ?? []) if (m.minutesFolder) out.push(m.minutesFolder);
  return out.map((p) => p.split("/").map((n) => n.trim()).filter(Boolean).join("/"));
}

/**
 * The template with the wizard's choices applied, and the problems of the choices themselves (unknown
 * folders, steps, fields …). References the choices create (a task team of an unknown slot, an unknown
 * workflow) are left to `checkProjectTemplate`, which runs on the result.
 */
export function applySetupOverrides(
  source: ProjectTemplate,
  setup: ProjectSetupOverrides | undefined,
  lang: string = SHARED_DEFAULT_LANGUAGE,
): { template: ProjectTemplate; errors: string[] } {
  const template = structuredClone(source) as ProjectTemplate;
  const errors: string[] = [];
  if (!setup) return { template, errors };
  const text = (key: string, params?: Record<string, string | number>) => sharedText(lang, `setup.${key}`, params);

  // Parties: new slots, after the template's own.
  const parties = setup.parties ?? [];
  if (parties.length > PROJECT_SETUP_MAX_EXTRA_PARTIES) errors.push(text("tooManyParties", { max: PROJECT_SETUP_MAX_EXTRA_PARTIES }));
  for (const party of parties.slice(0, PROJECT_SETUP_MAX_EXTRA_PARTIES)) {
    if (!SLOT_KEY.test(party.key)) errors.push(text("partyKeyInvalid", { key: party.key }));
    else if (template.slots.some((s) => s.key === party.key)) errors.push(text("partyKeyTaken", { key: party.key }));
    else if (!party.label?.trim()) errors.push(text("partyLabelEmpty", { key: party.key }));
    else template.slots.push({ ...party, label: party.label.trim() });
  }

  const cde = (template.cde ??= {});
  if (setup.taskTeams) {
    if (setup.taskTeams.filter((t) => t.lead).length > 1) errors.push(text("oneLead"));
    cde.taskTeams = setup.taskTeams.map((t) => ({ slot: t.slot, ...(t.lead ? { lead: true } : {}) }));
  }

  // Folders: within limits. Template folders with a state (or generated from dimensions) and
  // folders the template refers to stay; new folders go below existing template folders.
  const removes = setup.folders?.remove ?? [];
  const adds = setup.folders?.add ?? [];
  if (removes.length + adds.length > PROJECT_SETUP_MAX_FOLDER_EDITS) errors.push(text("tooManyFolderEdits", { max: PROJECT_SETUP_MAX_FOLDER_EDITS }));
  const referenced = referencedPaths(template);
  for (const raw of removes) {
    const path = raw.split("/").map((n) => n.trim()).filter(Boolean).join("/");
    const found = findDeclared(template.folders, path);
    if (!found) errors.push(text("folderNotFound", { path: raw }));
    else if (hasState(found.folder)) errors.push(text("folderHasState", { path }));
    else if (referenced.some((r) => r === path || r.startsWith(`${path}/`))) errors.push(text("folderReferenced", { path }));
    else found.parent.splice(found.index, 1);
  }
  for (const add of adds) {
    const name = add.name ?? "";
    const found = findDeclared(template.folders, add.parent);
    if (!found) {
      errors.push(text("folderNotFound", { path: add.parent }));
      continue;
    }
    if (!name.trim() || name !== name.trim() || name.length > 200 || FOLDER_NAME_FORBIDDEN.test(name)) {
      errors.push(text("folderNameInvalid", { name }));
      continue;
    }
    const children = (found.folder.children ??= []);
    if (children.some((child) => folderNode(child).name === name)) errors.push(text("folderExists", { path: `${add.parent}/${name}` }));
    else children.push({ name });
  }

  if (setup.containerStandard !== undefined) {
    const previous = cde.containerStandard;
    if (previous && previous !== setup.containerStandard && template.namingStandards?.some((s) => s.name === setup.containerStandard))
      replaceFolderNaming(template, previous, setup.containerStandard);
    cde.containerStandard = setup.containerStandard;
  }

  for (const change of setup.naming ?? []) {
    const standard = template.namingStandards?.find((s) => s.name === change.standard);
    const field = standard?.fields.find((f) => f.name === change.field);
    if (!standard || !field) {
      errors.push(text("namingFieldNotFound", { standard: change.standard, field: change.field }));
      continue;
    }
    if (field.type !== "list") {
      errors.push(text("namingFieldNotList", { field: change.field }));
      continue;
    }
    // Codes the template already has keep their `parents` (dependent lists, e.g. Alt Disiplin / Öge).
    const parentsOf = new Map(field.values.filter((v) => v.parents).map((v) => [v.code, v.parents!]));
    const values = change.values.map((v) => {
      const code = v.code.trim();
      const parents = parentsOf.get(code);
      return { code, ...(v.description?.trim() ? { description: v.description.trim() } : {}), ...(parents ? { parents: [...parents] } : {}) };
    });
    if (!values.length || values.some((v) => !v.code)) {
      errors.push(text("namingValuesEmpty", { field: change.field }));
      continue;
    }
    const codes = values.map((v) => v.code.toUpperCase());
    const duplicate = codes.find((c, i) => codes.indexOf(c) !== i);
    if (duplicate) {
      errors.push(text("namingValueDuplicate", { field: change.field, code: duplicate }));
      continue;
    }
    field.values = values;
  }

  for (const change of setup.workflows ?? []) {
    const workflow = template.workflows?.find((w) => w.name === change.workflow);
    const step = workflow?.steps[change.step];
    if (!workflow || !step) {
      errors.push(text("stepNotFound", { workflow: change.workflow, step: change.step + 1 }));
      continue;
    }
    if (change.assignees) {
      if (!change.assignees.length && !step.assigneeRule) errors.push(text("stepNoAssignee", { workflow: workflow.name, step: step.name }));
      else step.assignees = change.assignees;
    }
    if (change.days !== undefined) {
      if (!Number.isInteger(change.days) || change.days < 0 || change.days > 365) errors.push(text("stepDays", { workflow: workflow.name, step: step.name }));
      else step.days = change.days;
    }
    if (change.rule) step.rule = change.rule;
  }

  for (const change of setup.transitions ?? []) {
    const row = cde.transitions?.find((t) => t.from === change.from && t.to === change.to);
    const key = cdeTransitionKey(change.from, change.to);
    if (!row) errors.push(text("transitionNotFound", { transition: key }));
    else if (row.mode !== "review") errors.push(text("transitionNotReview", { transition: key }));
    else if (change.workflow) row.workflow = change.workflow;
    else delete row.workflow;
  }

  if (setup.cde) {
    for (const key of ["codeScheme", "enforceTransitions", "wipPolicy", "adminSeesWip"] as const) {
      if (setup.cde[key] !== undefined) (cde as Record<string, unknown>)[key] = setup.cde[key];
    }
  }
  if (!Object.keys(cde).length) delete template.cde;
  if (setup.modules) template.modules = { ...template.modules, ...setup.modules };
  return { template, errors: [...new Set(errors)] };
}

/** Points the folders (and the root) named by `from` at the naming standard `to`. */
function replaceFolderNaming(template: ProjectTemplate, from: string, to: string): void {
  if (template.root?.naming === from) template.root.naming = to;
  const walk = (list: (string | TemplateFolder)[]) => {
    for (const node of list) {
      if (typeof node === "string") continue;
      if (node.naming === from) node.naming = to;
      if (node.children) walk(node.children);
    }
  };
  walk(template.folders);
}

/** Problems of the project details (dates, lengths). */
export function checkSetupDetails(details: ProjectSetupDetails | undefined, lang: string = SHARED_DEFAULT_LANGUAGE): string[] {
  if (!details) return [];
  const errors: string[] = [];
  const valid = (d: string) => DATE.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`));
  if (details.startDate && !valid(details.startDate)) errors.push(sharedText(lang, "setup.dateInvalid", { value: details.startDate }));
  if (details.endDate && !valid(details.endDate)) errors.push(sharedText(lang, "setup.dateInvalid", { value: details.endDate }));
  if (details.startDate && details.endDate && valid(details.startDate) && valid(details.endDate) && details.endDate < details.startDate)
    errors.push(sharedText(lang, "setup.endBeforeStart"));
  if ((details.location ?? "").length > 200) errors.push(sharedText(lang, "setup.tooLong", { field: "location", max: 200 }));
  if ((details.client ?? "").length > 200) errors.push(sharedText(lang, "setup.tooLong", { field: "client", max: 200 }));
  if (details.csbProjectCode && !CSB_PROJECT_CODE_PATTERN.test(details.csbProjectCode))
    errors.push(sharedText(lang, "setup.csbProjectCodeInvalid", { value: details.csbProjectCode }));
  return errors;
}

/** Problems of the people list against the template (after the overrides): e-mails, parties, roles. */
export function checkSetupPeople(
  people: readonly ProjectSetupPerson[] | undefined,
  template: ProjectTemplate,
  lang: string = SHARED_DEFAULT_LANGUAGE,
): string[] {
  if (!people?.length) return [];
  const errors: string[] = [];
  if (people.length > PROJECT_SETUP_MAX_PEOPLE) errors.push(sharedText(lang, "setup.tooManyPeople", { max: PROJECT_SETUP_MAX_PEOPLE }));
  const seen = new Set<string>();
  const slots = new Set(template.slots.map((s) => s.key));
  const roles = new Set((template.roles ?? []).map((r) => r.key));
  for (const person of people) {
    const email = person.email.trim().toLowerCase();
    if (email.length > 254 || !EMAIL.test(email)) errors.push(sharedText(lang, "setup.emailInvalid", { email: person.email }));
    else if (seen.has(email)) errors.push(sharedText(lang, "setup.emailDuplicate", { email }));
    seen.add(email);
    if ((person.name ?? "").length > 200) errors.push(sharedText(lang, "setup.tooLong", { field: email, max: 200 }));
    if (person.slot && !slots.has(person.slot)) errors.push(sharedText(lang, "setup.personSlotUnknown", { email, slot: person.slot }));
    for (const role of person.roles ?? []) if (!roles.has(role)) errors.push(sharedText(lang, "setup.personRoleUnknown", { email, role }));
  }
  return errors;
}

/**
 * Everything the wizard can check without the server: the choices, the resulting template
 * (`checkProjectTemplate`), the details and the people. Companies, the project code and accounts are
 * checked by the server's dry run (`POST /projects/setup/preview`).
 */
export function checkProjectSetup(
  template: ProjectTemplate,
  input: { setup?: ProjectSetupOverrides; details?: ProjectSetupDetails; people?: ProjectSetupPerson[]; dimensions?: Record<string, string[]> },
  lang: string = SHARED_DEFAULT_LANGUAGE,
): { template: ProjectTemplate; errors: string[] } {
  const applied = applySetupOverrides(template, input.setup, lang);
  const errors = [
    ...applied.errors,
    ...checkProjectTemplate(applied.template, input.dimensions ?? {}, lang),
    ...checkSetupDetails(input.details, lang),
    ...checkSetupPeople(input.people, applied.template, lang),
  ];
  return { template: applied.template, errors: [...new Set(errors)] };
}

/**
 * Folder paths of the template the wizard offers: `parents` (where a folder may be added: every
 * declared folder) and `removable` (declared folders without a state, skeleton or reference).
 */
export function setupFolderOptions(template: ProjectTemplate): { parents: string[]; removable: string[] } {
  const parents: string[] = [];
  const removable: string[] = [];
  const referenced = referencedPaths(template);
  const walk = (list: readonly (string | TemplateFolder)[], base: string) => {
    for (const node of list) {
      const folder = folderNode(node);
      const path = base ? `${base}/${folder.name}` : folder.name;
      parents.push(path);
      if (!hasState(folder) && !referenced.some((r) => r === path || r.startsWith(`${path}/`))) removable.push(path);
      walk(folder.children ?? [], path);
    }
  };
  walk(template.folders, "");
  return { parents, removable };
}
