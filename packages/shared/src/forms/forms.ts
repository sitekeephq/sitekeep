/**
 * Forms and checklists: versioned JSON templates (sections → items) and filled form instances.
 *
 * A template keeps every version; a version becomes immutable once a form uses it, so editing a
 * used template creates the next version (PKF copied templates as "GÜNCEL" / "ESKİ" instead).
 * Pure helpers here (validation, score, failed items, numbering, similarity) run on the server
 * and in the browser (offline checks).
 */
import { SHARED_DEFAULT_LANGUAGE, sharedText } from "../platform/i18n.js";
import type { FormPdfSourceDto } from "./form-pdf-source.js";
import type { OutcomeOption } from "../workflow/review-chains.js";
import type { WorkflowActionDto, OutcomeCode } from "../workflow/workflow.js";
import { FORM_ITEM_TYPES, FORM_ITEM_TYPE_LABELS_TR, TABLE_COLUMN_TYPES, type FormItemType, type TableColumnType, type FormTableColumn, type FormItem, type FormSection, type FormTemplateSchema, type TableRow, type FormValue, type FormValues } from "./form-types.js";

export * from "./form-constants.js";

export { FORM_ITEM_TYPES, FORM_ITEM_TYPE_LABELS_TR, TABLE_COLUMN_TYPES };

export type { FormItemType, TableColumnType, FormTableColumn, FormItem, FormSection, FormTemplateSchema, TableRow, FormValue, FormValues };

export const FORM_STATUSES = ["draft", "submitted", "in_review", "closed"] as const;

/** List filter: every status except closed ("açık kalan formlar"). */
export const FORM_OPEN_FILTER = "open";

export type FormStatus = (typeof FORM_STATUSES)[number];

export const FORM_STATUS_LABELS_TR: Record<FormStatus, string> = {
  draft: "Taslak",
  submitted: "Gönderildi",
  in_review: "İncelemede",
  closed: "Kapalı",
};

// ---- DTOs ------------------------------------------------------------------------------------

export interface FormTemplateVersionDto {
  id: string;
  version: number;
  createdAt: string;
  /** At least one form uses this version (it can no longer change). */
  used: boolean;
  /** Source PDF of the version (PDF templates); every version keeps its own. */
  sourceId?: string | null;
}

/** Where a template came from: the client's PDF form, the built-in library or the editor. */
export const FORM_TEMPLATE_ORIGINS = ["pdf", "library", "manual"] as const;

export type FormTemplateOrigin = (typeof FORM_TEMPLATE_ORIGINS)[number];

export const FORM_TEMPLATE_ORIGIN_LABELS_TR: Record<FormTemplateOrigin, string> = {
  pdf: "PDF Formu",
  library: "Hazır Şablon",
  manual: "Elle Hazırlanan",
};

export interface FormTemplateDto {
  id: string;
  projectId: string;
  code: string;
  name: string;
  category: string | null;
  description: string | null;
  numberPattern: string;
  workflowTemplateId: string | null;
  currentVersion: number;
  currentVersionId: string;
  schema: FormTemplateSchema;
  archived: boolean;
  mergedIntoId: string | null;
  builtinKey: string | null;
  formCount: number;
  createdAt: string;
  updatedAt: string;
  versions?: FormTemplateVersionDto[];
  origin: FormTemplateOrigin;
  /** Source PDF of the current version (PDF templates). */
  source: FormPdfSourceDto | null;
  /** The approval flow as readable steps ("2. Kalite Kontrol kontrol eder (Onay → 3. adım / Ret → 1. adıma döner)"). */
  flowLines?: string[];
}

export interface FormTemplateInput {
  code: string;
  name: string;
  category?: string | null;
  description?: string | null;
  numberPattern?: string;
  workflowTemplateId?: string | null;
  schema: FormTemplateSchema;
  /** Source PDF (from "PDF'ten şablon"); kept by every later version unless replaced. */
  sourceId?: string | null;
}

/** Built-in template offered in the library ("Hazır şablonlar"). */
export interface FormLibraryItemDto {
  key: string;
  code: string;
  name: string;
  category: string;
  description: string;
  itemCount: number;
  schema: FormTemplateSchema;
}

export interface FormAttachmentDto {
  id: string;
  itemId: string;
  kind: "photo" | "signature";
  fileName: string;
  contentType: string;
  size: number;
  createdBy: string;
  createdByName?: string;
  createdAt: string;
}

export interface FormIssueLinkDto {
  id: string;
  itemId: string;
  row: number | null;
  issueId: string;
  issueNumber: number;
  issueTitle: string;
  issueStatus: string;
}

export interface FormSummaryDto {
  id: string;
  projectId: string;
  number: string;
  templateId: string;
  templateCode: string;
  templateName: string;
  templateVersion: number;
  templateVersionId: string;
  status: FormStatus;
  formDate: string;
  locationId: string | null;
  locationPath: string | null;
  score: number | null;
  failedCount: number;
  /** Outcome of the last finished review round, if any. */
  lastOutcome: OutcomeCode | null;
  createdBy: string;
  createdByName?: string;
  createdAt: string;
  updatedAt: string;
  submittedBy: string | null;
  submittedByName?: string;
  submittedAt: string | null;
  closedAt: string | null;
}

export interface FormWorkflowDto {
  status: "running" | "completed" | "cancelled";
  templateName: string;
  stepIndex: number;
  stepCount: number;
  stepName: string | null;
  stepDueAt: string | null;
  /** Outcomes allowed on the current step. */
  outcomes: OutcomeCode[];
  /** The step's answers with their labels (custom, e.g. "KALİTE KONTROL ONAYLADI", or the base codes). */
  options?: OutcomeOption[];
  canAct: boolean;
  actions: WorkflowActionDto[];
}

export interface FormDetailDto extends FormSummaryDto {
  schema: FormTemplateSchema;
  values: FormValues;
  attachments: FormAttachmentDto[];
  issueLinks: FormIssueLinkDto[];
  failedItems: FailedItem[];
  workflow: FormWorkflowDto | null;
  canEdit: boolean;
  canSubmit: boolean;
  canClose: boolean;
  canReturn: boolean;
  /** Source PDF of the form's template version (PDF templates). */
  source?: FormPdfSourceDto | null;
  /** Items filled by a later flow step, not by the filler: item id → "2. adım: Kalite Kontrol". */
  reservedFields?: Record<string, string>;
  /** Items the caller may fill now as the assignee of the current flow step. */
  stepFields?: string[];
}

export interface FailedItem {
  itemId: string;
  label: string;
  row?: number;
}

export interface TemplateSimilarityDto {
  a: { id: string; code: string; name: string };
  b: { id: string; code: string; name: string };
  score: number;
  nameScore: number;
  itemScore: number;
  shared: number;
  onlyA: string[];
  onlyB: string[];
  suggestion: string;
}

// ---- Template checks -------------------------------------------------------------------------

export function allItems(schema: FormTemplateSchema): FormItem[] {
  return schema.sections.flatMap((s) => s.items);
}

/** Structural problems of a template (empty when valid). */
export function checkTemplateSchema(schema: FormTemplateSchema, lang: string = SHARED_DEFAULT_LANGUAGE): string[] {
  const problems: string[] = [];
  const say = (key: string, params?: Record<string, string>) => problems.push(sharedText(lang, `forms.template.${key}`, params));
  if (!schema.sections.length) say("noSections");
  const ids = new Set<string>();
  const sectionIds = new Set<string>();
  for (const s of schema.sections) {
    if (sectionIds.has(s.id)) say("duplicateSectionId", { id: s.id });
    sectionIds.add(s.id);
    if (!s.title.trim()) say("emptySectionTitle");
    for (const it of s.items) {
      const n = it.label || it.id;
      if (ids.has(it.id)) say("duplicateItemId", { id: it.id });
      ids.add(it.id);
      if (!it.label.trim()) say("emptyItemLabel", { id: it.id });
      if ((it.type === "choice" || it.type === "multi_choice") && !(it.options ?? []).filter((o) => o.trim()).length)
        say("emptyOptions", { item: n });
      if (it.options && new Set(it.options).size !== it.options.length) say("duplicateOption", { item: n });
      if (it.failOptions?.some((f) => !(it.options ?? []).includes(f))) say("failOptionMissing", { item: n });
      if (it.type === "number" && it.min !== undefined && it.max !== undefined && it.min > it.max)
        say("minAboveMax", { item: n });
      if (it.type === "table") {
        const cols = it.columns ?? [];
        if (!cols.length) say("noColumns", { item: n });
        const cids = cols.map((c) => c.id);
        if (new Set(cids).size !== cids.length) say("duplicateColumnId", { item: n });
        for (const c of cols) {
          if (!c.label.trim()) say("emptyColumnLabel", { item: n });
          if (c.type === "choice" && !(c.options ?? []).length) say("columnNoOptions", { item: n, column: c.label });
        }
      }
    }
  }
  for (const it of allItems(schema)) {
    if (it.type !== "score") continue;
    for (const ref of it.scoreOf ?? []) {
      const target = allItems(schema).find((x) => x.id === ref);
      if (!target || target.type !== "yes_no") say("scoreSource", { item: it.label, ref });
    }
  }
  return problems;
}

/** "Item / 2. satır / Column": a table cell named in problems and failed items. */
function cellLabel(lang: string, item: string, row: number, column: string): string {
  return sharedText(lang, "forms.values.cell", { item, row, column });
}

/** Items answered "no", choices among failOptions, and "no" cells in yes/no table columns. */
export function failedItems(schema: FormTemplateSchema, values: Readonly<FormValues>, lang: string = SHARED_DEFAULT_LANGUAGE): FailedItem[] {
  const out: FailedItem[] = [];
  for (const it of allItems(schema)) {
    const v = values[it.id];
    if (it.type === "yes_no" && v === "no") out.push({ itemId: it.id, label: it.label });
    if (it.type === "choice" && typeof v === "string" && it.failOptions?.includes(v)) out.push({ itemId: it.id, label: it.label });
    if (it.type === "table" && Array.isArray(v)) {
      (v as TableRow[]).forEach((row, ri) => {
        for (const c of it.columns ?? []) {
          if (c.type === "yes_no" && row?.[c.id] === "no") out.push({ itemId: it.id, row: ri, label: cellLabel(lang, it.label, ri + 1, c.label) });
        }
      });
    }
  }
  return out;
}

const TOKEN_RE = /\{([^{}]+)\}/g;

const KNOWN_TOKENS = new Set(["PROJE", "KOD", "YYYY", "YY", "MM", "KONUM"]);

/** Problems of a numbering pattern, e.g. "{PROJE}-{KOD}-{YYYY}-{0000}". */
export function checkNumberPattern(pattern: string, lang: string = SHARED_DEFAULT_LANGUAGE): string[] {
  const problems: string[] = [];
  let seq = 0;
  for (const m of pattern.matchAll(TOKEN_RE)) {
    const t = m[1]!;
    if (/^0+$/.test(t)) seq++;
    else if (!KNOWN_TOKENS.has(t)) problems.push(sharedText(lang, "forms.numberPattern.unknownToken", { token: `{${t}}` }));
  }
  if (seq !== 1) problems.push(sharedText(lang, "forms.numberPattern.noSequence"));
  if (pattern.length > 100) problems.push(sharedText(lang, "forms.numberPattern.tooLong", { count: 100 }));
  return problems;
}
