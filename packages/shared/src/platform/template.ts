/**
 * Project templates: a project's structure as one JSON document, without files or records.
 *
 *   { name, description, slots, dimensions, root, folders, namingStandards, attributes, workflows }
 *
 * - **Slots** are company roles ("İdare", "Müşavir", "Tasarımcı", "Yüklenici"). Folder grants and
 *   workflow steps refer to slots; when a project is created each slot is mapped to a company.
 * - **Folders** form a tree. A folder can carry an ISO 19650 state plus a free sub-status label
 *   ("Onay için", "İş sonu"), a naming standard and attribute bindings (by name), grants per slot
 *   and the "approved review only" gate.
 * - **Skeletons** generate subtrees from dimensions (zone × discipline × document type, …):
 *   `skeleton: { order: ["Bölge", "Disiplin", "Tip"] }` with `dimensions.Bölge = [...]` etc.
 *   A dimension value may `insert` further dimensions below itself or `stop` the expansion.
 * - **On-demand (lazy) folders**: the analysis of PKF showed 73% of leaf folders stay empty, so by
 *   default the leaves a skeleton generates are *virtual*: they are listed under their parent but
 *   created only when the first file arrives (see `POST …/folders/:fid/materialize`). A folder can
 *   also be marked `lazy: true` explicitly; everything below a virtual folder is virtual too.
 *
 * Expansion and checks are pure functions here so the server, the web wizard and tests share them.
 * Structural validation (types, lengths) is done with zod on the server.
 */
import { SHARED_DEFAULT_LANGUAGE, sharedIntlLocale, sharedText } from "./i18n.js";
import type { AttributeDefinition } from "../kernel/attributes.js";
import type { NamingStandard } from "../kernel/naming.js";
import type { PermissionLevel } from "../kernel/permissions.js";
import type { FolderState } from "../core/types.js";
import type { ProjectModule } from "../core/modules.js";
import type { OutcomeOption, ReviewParty, ReviewStage } from "../workflow/review-chains.js";
import type { FinalOutcomeMap, OutcomeCode, StepRule, WorkflowKind, WorkflowRole } from "../workflow/workflow.js";

// Kept from the product's former name: exported template files carry it, renaming would reject them.
export const TEMPLATE_FORMAT = "7d-cde/project-template@1";

export const PARTIES = ["client", "consultant", "contractor", "designer", "subcontractor", "other"] as const;
export type Party = (typeof PARTIES)[number];

export const PARTY_LABELS_TR: Record<Party, string> = {
  client: "İdare / İşveren",
  consultant: "Müşavir / Danışman",
  contractor: "Yüklenici",
  designer: "Tasarımcı",
  subcontractor: "Alt Yüklenici / Tedarikçi",
  other: "Diğer",
};

/** Sub-status labels seen in PKF / MBE (ISO 19650 Shared split in two, As-Built as its own stage). */
export const STATE_LABEL_SUGGESTIONS_TR: { state: FolderState; label: string }[] = [
  { state: "shared", label: "İnceleme için" }, // i18n-ok: suggestion written into the folder as data
  { state: "shared", label: "Onay için" }, // i18n-ok: suggestion written into the folder as data
  { state: "published", label: "İş Sonu" }, // i18n-ok: suggestion written into the folder as data
];

/** A company role in the template; mapped to a real company when a project is created. */
export interface TemplateSlot {
  /** Stable reference used by grants and workflow steps, e.g. "yuklenici". */
  key: string;
  /** Display name, e.g. "Yüklenici". */
  label: string;
  party?: Party;
  /** Default company code used by naming standards through the `{slot:key}` token, e.g. "PAS". */
  code?: string;
  description?: string;
}

/** `slot: "*"` grants the level to every mapped slot. */
export interface TemplateGrant {
  slot: string;
  level: PermissionLevel;
}

export type DimensionValue =
  | string
  | {
      name: string;
      /** Dimensions inserted below this value, before the rest of the skeleton order. */
      insert?: string[];
      /** Don't apply the rest of the order below this value (inserted dimensions still apply). */
      stop?: boolean;
    };

export interface TemplateSkeleton {
  /** Dimension names, outermost first. */
  order: string[];
  /**
   * Which generated folders are created only when the first file arrives:
   * "leaves" (default) = the generated folders without children; "none" = create everything;
   * a dimension name = that dimension's folders and everything below them.
   */
  onDemand?: string;
}

export interface TemplateFolder {
  name: string;
  state?: FolderState;
  /** Sub-status shown next to the state, e.g. "Onay için", "İş sonu". */
  stateLabel?: string;
  /** Name of a naming standard in `namingStandards`; applies to the folder and its subfolders. */
  naming?: string;
  /** Names of attribute definitions bound to the folder (inherited by subfolders). */
  attributes?: string[];
  grants?: TemplateGrant[];
  /** Files enter only as approved review copies (folder gate). */
  gate?: boolean;
  /** Create this folder (and its subtree) only when the first file arrives. */
  lazy?: boolean;
  children?: (string | TemplateFolder)[];
  /** Subfolders generated from dimensions; added after `children`. */
  skeleton?: TemplateSkeleton;
}

export type TemplateRootSettings = Pick<TemplateFolder, "naming" | "attributes" | "grants" | "gate">;

export type TemplateAssignee = { slot: string } | { role: WorkflowRole };

/** Attribute-resolved assignees (review chains) with slots instead of companies. */
export interface TemplateAssigneeRule {
  type: "by_attribute";
  attribute: string;
  map: Record<string, TemplateAssignee[]>;
  fallback?: TemplateAssignee[];
}

export interface TemplateWorkflowStep {
  name: string;
  /** May be empty when the step has an `assigneeRule`. */
  assignees: TemplateAssignee[];
  rule: StepRule;
  days: number;
  outcomes: OutcomeCode[];
  // ---- Review chains (see review-chains.ts); all optional ----
  outcomeOptions?: OutcomeOption[];
  stage?: number;
  assigneeRule?: TemplateAssigneeRule;
  requiredAttributes?: string[];
}

/** Review-chain options of a workflow; the copy target's base folder is a path of folder names. */
export interface TemplateChainConfig {
  stages?: ReviewStage[];
  originParty?: ReviewParty | null;
  namePattern?: string | null;
  copyTarget?: {
    /** Base folder below the project root, e.g. "03-PUBLISHED (Yayınlanan)/Onaylı"; null = none. */
    folder: string | null;
    pattern: string;
    onUnresolved?: "fail" | "base";
  } | null;
}

export interface TemplateWorkflow {
  name: string;
  kind?: WorkflowKind;
  steps: TemplateWorkflowStep[];
  finalOutcomes?: FinalOutcomeMap;
  chain?: TemplateChainConfig;
}

export interface ProjectTemplate {
  format?: string;
  name: string;
  description?: string;
  slots: TemplateSlot[];
  dimensions?: Record<string, DimensionValue[]>;
  /** Settings of the project root folder ("Proje Dosyaları"). */
  root?: TemplateRootSettings;
  /** Top-level folders (children of the project root). */
  folders: (string | TemplateFolder)[];
  /**
   * Naming standards. List values and descriptions may use tokens: `{PROJE}` (project code),
   * `{slot:key}` (the slot's company code) and `{firma:key}` (the mapped company's name).
   * Values whose tokens cannot be resolved are dropped.
   */
  namingStandards?: NamingStandard[];
  attributes?: AttributeDefinition[];
  workflows?: TemplateWorkflow[];
  /** Issue / work types (kept for later; not applied yet). */
  issueTypes?: unknown[];
  /** Module switches of new projects; missing modules are on. */
  modules?: Partial<Record<ProjectModule, boolean>>;
  notes?: string[];
}

/** A folder after skeleton expansion. */
export interface ExpandedFolder {
  name: string;
  state?: FolderState;
  stateLabel?: string;
  naming?: string;
  attributes?: string[];
  grants?: TemplateGrant[];
  gate?: boolean;
  /** Created when the first file arrives. */
  virtual: boolean;
  children: ExpandedFolder[];
}

/** Stored on a real folder for each of its not-yet-created children; ids are resolved. */
export interface VirtualFolderSpec {
  name: string;
  state?: FolderState;
  stateLabel?: string;
  namingStandardId?: string;
  attributeDefinitionIds?: string[];
  grants?: { subjectType: "company"; subjectId: string; level: PermissionLevel }[];
  gate?: boolean;
  children?: VirtualFolderSpec[];
}

/** A not-yet-created child folder as listed in folder contents. */
export interface VirtualFolderDto {
  name: string;
  state: FolderState | null;
  stateLabel: string | null;
  /** Folders below it that will also be created on demand. */
  descendantCount: number;
}

export interface TemplateCounts {
  /** Folders created with the project (root included). */
  folders: number;
  /** Folders created when their first file arrives. */
  virtualFolders: number;
  grants: number;
  workflows: number;
  attributes: number;
  namingStandards: number;
}

export interface TemplateDimensionDto {
  name: string;
  /** Plain values; false when some values insert/stop (then the list can't be edited as text). */
  editable: boolean;
  values: string[];
}

export interface TemplateSummaryDto {
  id: string;
  name: string;
  description: string;
  builtIn: boolean;
  slots: TemplateSlot[];
  dimensions: TemplateDimensionDto[];
  counts: TemplateCounts;
}

export interface PreviewFolderDto {
  name: string;
  state?: FolderState;
  stateLabel?: string;
  naming?: string;
  gate?: boolean;
  grants?: TemplateGrant[];
  children?: PreviewFolderDto[];
  /** Direct children created on demand (names, at most 30). */
  onDemand?: string[];
  /** All folders below this one created on demand. */
  onDemandTotal?: number;
}

export interface TemplatePreviewDto {
  ok: boolean;
  errors: string[];
  warnings: string[];
  name: string;
  description: string;
  slots: TemplateSlot[];
  dimensions: TemplateDimensionDto[];
  counts: TemplateCounts;
  tree: PreviewFolderDto[];
}

export interface CreateFromTemplateRequest {
  code: string;
  name: string;
  description?: string;
  templateId?: string;
  template?: ProjectTemplate;
  /** slot key → company id (null or missing = leave the slot empty). */
  slotCompanies?: Record<string, string | null>;
  /** slot key → company code for naming tokens (overrides the slot's default code). */
  slotCodes?: Record<string, string>;
  /** dimension name → values (replaces the template's values). */
  dimensions?: Record<string, string[]>;
}

// ---------------------------------------------------------------------------------------------

/** Characters not allowed in folder names (same rule as the folder API). */
export const FOLDER_NAME_FORBIDDEN = /[\\/:*?"<>|]/;

/** Upper bound on generated folders (real + virtual) per template. */
export const TEMPLATE_MAX_FOLDERS = 50_000;

const MAX_SKELETON_DEPTH = 12;

export function folderNode(node: string | TemplateFolder): TemplateFolder {
  return typeof node === "string" ? { name: node } : node;
}

function dimensionValue(v: DimensionValue): { name: string; insert?: string[]; stop?: boolean } {
  return typeof v === "string" ? { name: v } : v;
}

/** Template dimensions with overrides applied (unknown override names are reported). */
export function templateDimensions(
  template: ProjectTemplate,
  overrides: Record<string, string[]> = {},
  lang: string = SHARED_DEFAULT_LANGUAGE,
): { dimensions: Record<string, DimensionValue[]>; errors: string[] } {
  const dimensions: Record<string, DimensionValue[]> = { ...(template.dimensions ?? {}) };
  const errors: string[] = [];
  for (const [name, values] of Object.entries(overrides)) {
    if (!(name in dimensions)) {
      errors.push(sharedText(lang, "template.unknownDimension", { name }));
      continue;
    }
    const clean = values.map((v) => v.trim()).filter(Boolean);
    // Keep insert/stop of values that are still present.
    const byName = new Map(dimensions[name]!.map((v) => [dimensionValue(v).name, v]));
    dimensions[name] = clean.map((v) => byName.get(v) ?? v);
  }
  return { dimensions, errors };
}

export function dimensionDtos(dimensions: Record<string, DimensionValue[]>): TemplateDimensionDto[] {
  return Object.entries(dimensions).map(([name, values]) => ({
    name,
    editable: values.every((v) => typeof v === "string" || (!v.insert?.length && !v.stop)),
    values: values.map((v) => dimensionValue(v).name),
  }));
}

/** Expands skeletons into a plain folder tree and marks on-demand folders. */
export function expandProjectTemplate(
  template: ProjectTemplate,
  overrides: Record<string, string[]> = {},
  lang: string = SHARED_DEFAULT_LANGUAGE,
): { folders: ExpandedFolder[]; errors: string[] } {
  const { dimensions, errors } = templateDimensions(template, overrides, lang);
  let total = 0;
  let tooBig = false;

  const count = () => {
    total++;
    if (total > TEMPLATE_MAX_FOLDERS && !tooBig) {
      tooBig = true;
      errors.push(sharedText(lang, "template.tooManyFolders", { max: TEMPLATE_MAX_FOLDERS.toLocaleString(sharedIntlLocale(lang)) }));
    }
    return !tooBig;
  };

  const generate = (
    order: readonly string[],
    onDemand: string,
    parentVirtual: boolean,
    depth: number,
    where: string,
  ): ExpandedFolder[] => {
    if (!order.length || tooBig) return [];
    if (depth > MAX_SKELETON_DEPTH) {
      errors.push(sharedText(lang, "template.skeletonTooDeep", { where, max: MAX_SKELETON_DEPTH }));
      return [];
    }
    const [dim, ...rest] = order;
    const values = dimensions[dim!];
    if (!values) {
      errors.push(sharedText(lang, "template.dimensionNotDefined", { where, name: dim }));
      return [];
    }
    const out: ExpandedFolder[] = [];
    for (const raw of values) {
      if (!count()) break;
      const v = dimensionValue(raw);
      const next = v.stop ? (v.insert ?? []) : [...(v.insert ?? []), ...rest];
      const virtualHere = parentVirtual || onDemand === dim;
      const children = generate(next, onDemand, virtualHere, depth + 1, `${where}/${v.name}`);
      out.push({
        name: v.name,
        virtual: virtualHere || (onDemand === "leaves" && children.length === 0),
        children,
      });
    }
    return out;
  };

  const expand = (node: string | TemplateFolder, parentVirtual: boolean, where: string): ExpandedFolder => {
    count();
    const f = folderNode(node);
    const virtual = parentVirtual || !!f.lazy;
    const path = where ? `${where}/${f.name}` : f.name;
    const children = (f.children ?? []).map((c) => expand(c, virtual, path));
    if (f.skeleton) {
      const onDemand = f.skeleton.onDemand ?? "leaves";
      if (onDemand !== "leaves" && onDemand !== "none" && !f.skeleton.order.includes(onDemand) && !(onDemand in dimensions))
        errors.push(sharedText(lang, "template.badOnDemand", { path, onDemand }));
      children.push(...generate(f.skeleton.order, onDemand, virtual, 1, path));
    }
    const names = new Set<string>();
    for (const c of children) {
      if (names.has(c.name)) errors.push(sharedText(lang, "template.duplicateSubfolder", { path, name: c.name }));
      names.add(c.name);
    }
    const out: ExpandedFolder = { name: f.name, virtual, children };
    if (f.state) out.state = f.state;
    if (f.stateLabel) out.stateLabel = f.stateLabel;
    if (f.naming) out.naming = f.naming;
    if (f.attributes?.length) out.attributes = f.attributes;
    if (f.grants?.length) out.grants = f.grants;
    if (f.gate) out.gate = true;
    return out;
  };

  const folders = template.folders.map((n) => expand(n, false, ""));
  const top = new Set<string>();
  for (const f of folders) {
    if (top.has(f.name)) errors.push(sharedText(lang, "template.duplicateTopFolder", { name: f.name }));
    top.add(f.name);
  }
  return { folders, errors };
}

export function walkExpanded(folders: readonly ExpandedFolder[], fn: (f: ExpandedFolder, path: string) => void, base = "") {
  for (const f of folders) {
    const path = base ? `${base}/${f.name}` : f.name;
    fn(f, path);
    walkExpanded(f.children, fn, path);
  }
}

/**
 * Semantic checks: references between slots, folders, naming standards, attributes and workflows,
 * folder names and skeleton dimensions. Returns messages in `lang` (empty = valid).
 */
export function checkProjectTemplate(
  template: ProjectTemplate,
  overrides: Record<string, string[]> = {},
  lang: string = SHARED_DEFAULT_LANGUAGE,
): string[] {
  const errors: string[] = [];
  if (!template.name?.trim()) errors.push(sharedText(lang, "template.nameEmpty"));

  const slotKeys = new Set<string>();
  for (const s of template.slots) {
    if (!s.key.trim()) errors.push(sharedText(lang, "template.slotKeyEmpty"));
    if (s.key === "*") errors.push(sharedText(lang, "template.slotKeyStar"));
    if (slotKeys.has(s.key)) errors.push(sharedText(lang, "template.duplicateSlot", { key: s.key }));
    slotKeys.add(s.key);
  }
  const standards = new Set<string>();
  for (const n of template.namingStandards ?? []) {
    if (standards.has(n.name)) errors.push(sharedText(lang, "template.duplicateStandard", { name: n.name }));
    standards.add(n.name);
  }
  const attributes = new Set<string>();
  for (const a of template.attributes ?? []) {
    if (attributes.has(a.name)) errors.push(sharedText(lang, "template.duplicateAttribute", { name: a.name }));
    attributes.add(a.name);
  }

  const checkSettings = (s: TemplateRootSettings, where: string) => {
    for (const g of s.grants ?? [])
      if (g.slot !== "*" && !slotKeys.has(g.slot)) errors.push(sharedText(lang, "template.grantSlotUnknown", { where, slot: g.slot }));
    if (s.naming && !standards.has(s.naming)) errors.push(sharedText(lang, "template.standardUnknown", { where, name: s.naming }));
    for (const a of s.attributes ?? [])
      if (!attributes.has(a)) errors.push(sharedText(lang, "template.attributeUnknown", { where, name: a }));
  };
  if (template.root) checkSettings(template.root, sharedText(lang, "template.projectRoot"));

  const expanded = expandProjectTemplate(template, overrides, lang);
  errors.push(...expanded.errors);
  walkExpanded(expanded.folders, (f, path) => {
    const name = f.name.trim();
    if (!name) errors.push(sharedText(lang, "template.folderNameEmpty", { path }));
    else if (name !== f.name) errors.push(sharedText(lang, "template.folderNameSpaces", { path }));
    if (name.length > 200) errors.push(sharedText(lang, "template.folderNameTooLong", { path, max: 200 }));
    if (FOLDER_NAME_FORBIDDEN.test(f.name)) errors.push(sharedText(lang, "template.folderNameForbidden", { path }));
    checkSettings(f, path);
  });

  const workflowNames = new Set<string>();
  for (const w of template.workflows ?? []) {
    if (workflowNames.has(w.name)) errors.push(sharedText(lang, "template.duplicateWorkflow", { name: w.name }));
    workflowNames.add(w.name);
    if (!w.steps.length) errors.push(sharedText(lang, "template.workflowNoSteps", { name: w.name }));
    w.steps.forEach((s, i) => {
      const rule = s.assigneeRule;
      if (!s.assignees.length && !rule) errors.push(sharedText(lang, "template.stepNoAssignee", { name: w.name, step: i + 1 }));
      const all = [...s.assignees, ...(rule ? [...Object.values(rule.map).flat(), ...(rule.fallback ?? [])] : [])];
      for (const a of all)
        if ("slot" in a && !slotKeys.has(a.slot))
          errors.push(sharedText(lang, "template.stepSlotUnknown", { name: w.name, step: i + 1, slot: a.slot }));
    });
    const copyFolder = w.chain?.copyTarget?.folder;
    if (copyFolder && copyFolder.split("/").some((n) => !n.trim()))
      errors.push(sharedText(lang, "template.copyTargetInvalid", { name: w.name, folder: copyFolder }));
  }
  return [...new Set(errors)];
}

/** Grants on a folder with "*" expanded to the given slots. */
export function expandGrants(grants: readonly TemplateGrant[] | undefined, slotKeys: readonly string[]): TemplateGrant[] {
  const out = new Map<string, TemplateGrant>();
  for (const g of grants ?? []) {
    for (const slot of g.slot === "*" ? slotKeys : [g.slot]) out.set(slot, { slot, level: g.level });
  }
  return [...out.values()];
}

/**
 * Counts what a template creates. `mappedSlots`: slots that have a company (grants to empty slots
 * are not created); defaults to every slot.
 */
export function countTemplate(
  template: ProjectTemplate,
  folders: readonly ExpandedFolder[],
  mappedSlots: readonly string[] = template.slots.map((s) => s.key),
): TemplateCounts {
  const mapped = new Set(mappedSlots);
  const counts: TemplateCounts = {
    folders: 1,
    virtualFolders: 0,
    grants: expandGrants(template.root?.grants, mappedSlots).filter((g) => mapped.has(g.slot)).length,
    workflows: template.workflows?.length ?? 0,
    attributes: template.attributes?.length ?? 0,
    namingStandards: template.namingStandards?.length ?? 0,
  };
  walkExpanded(folders, (f) => {
    if (f.virtual) counts.virtualFolders++;
    else {
      counts.folders++;
      counts.grants += expandGrants(f.grants, mappedSlots).filter((g) => mapped.has(g.slot)).length;
    }
  });
  return counts;
}

/** Preview tree: real folders in full, on-demand folders summarised on their real parent. */
export function previewTree(folders: readonly ExpandedFolder[]): PreviewFolderDto[] {
  const countAll = (f: ExpandedFolder): number => 1 + f.children.reduce((n, c) => n + countAll(c), 0);
  return folders
    .filter((f) => !f.virtual)
    .map((f) => {
      const out: PreviewFolderDto = { name: f.name };
      if (f.state) out.state = f.state;
      if (f.stateLabel) out.stateLabel = f.stateLabel;
      if (f.naming) out.naming = f.naming;
      if (f.gate) out.gate = true;
      if (f.grants?.length) out.grants = f.grants;
      const real = previewTree(f.children);
      if (real.length) out.children = real;
      const virtual = f.children.filter((c) => c.virtual);
      if (virtual.length) out.onDemand = virtual.slice(0, 30).map((c) => c.name);
      let total = virtual.reduce((n, c) => n + countAll(c), 0);
      for (const c of real) total += c.onDemandTotal ?? 0;
      if (total) out.onDemandTotal = total;
      return out;
    });
}

export interface TokenContext {
  projectCode: string;
  /** slot key → company code */
  slotCodes: Record<string, string | undefined>;
  /** slot key → company name */
  slotNames: Record<string, string | undefined>;
}

/** Replaces {PROJE}, {slot:key} and {firma:key}; null when a token has no value. */
export function resolveTemplateTokens(text: string, ctx: TokenContext): string | null {
  let missing = false;
  const out = text.replace(/\{(PROJE|slot:([^}]+)|firma:([^}]+))\}/g, (_m, all: string, slot?: string, firma?: string) => {
    let v: string | undefined;
    if (all === "PROJE") v = ctx.projectCode;
    else if (slot !== undefined) v = ctx.slotCodes[slot];
    else if (firma !== undefined) v = ctx.slotNames[firma];
    if (!v) {
      missing = true;
      return "";
    }
    return v;
  });
  return missing ? null : out;
}

/** Applies tokens to list values of a naming standard; unresolved values are dropped. */
export function resolveNamingTokens(standard: NamingStandard, ctx: TokenContext): NamingStandard {
  return {
    ...standard,
    fields: standard.fields.map((f) => {
      if (f.type !== "list") return f;
      const values = f.values.flatMap((v) => {
        const code = resolveTemplateTokens(v.code, ctx);
        if (code === null) return [];
        const description = v.description === undefined ? undefined : resolveTemplateTokens(v.description, ctx);
        const out = { ...v, code };
        if (description === null || description === undefined) delete out.description;
        else out.description = description;
        return [out];
      });
      const seen = new Set<string>();
      return { ...f, values: values.filter((v) => !seen.has(v.code) && !!seen.add(v.code)) };
    }),
  };
}
