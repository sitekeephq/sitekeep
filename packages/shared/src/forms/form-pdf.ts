/**
 * PDF form templates ("PDF'ten Şablon"): the client's own paper form becomes a form template.
 * Every item keeps where it sits on the source PDF, so a filled form prints in the original layout.
 *
 * Also the vocabulary of form flows: an approval chain written in plain Turkish ("Formu şantiye
 * şefi doldurur, kalite kontrol mühendisi kontrol eder …") becomes an ordinary workflow template
 * (kind "form"); steps may own form items (only that step fills / signs them).
 */
import type { FormItem, FormItemType, FormTemplateSchema, FormValue, TableColumnType } from "./form-types.js";
import type { PdfBox, PdfMark, FormItemPdf } from "./form-types.js";
import { SHARED_DEFAULT_LANGUAGE, labelText, sharedIntlLocale, sharedText } from "../platform/i18n.js";
import { type FormPdfSourceDto, type PdfDetectionLevel } from "./form-pdf-source.js";
import { formatChainage } from "../platform/locations.js";
import { type ReviewChainConfig } from "../workflow/review-chains.js";
import { type FinalOutcomeMap, type WorkflowAssignee, type WorkflowStep } from "../workflow/workflow.js";

export type { PdfBox, PdfMark, FormItemPdf } from "./form-types.js";

export * from "./form-pdf-source.js";

// ---- Geometry --------------------------------------------------------------------------------

/** A box on a PDF page in points: origin top-left, y down; page is 1-based. */
// ---- Source PDF and analysis -------------------------------------------------------------------

/** A field found on the PDF, before naming. */
export interface PdfFieldCandidate {
  /** Stable key within one analysis: "c1", "c2" … */
  key: string;
  label: string;
  type: FormItemType;
  pdf: FormItemPdf;
  section: string;
  options?: string[];
  columns?: { label: string; type: TableColumnType }[];
  multiline?: boolean;
  unit?: string;
  allowNa?: boolean;
  /** How it was found ("AcroForm", "noktalı boşluk", "alt çizgi", "kutu", "onay kutusu", "tablo" …). */
  hint: string;
}

export interface PdfAnalysisDto {
  source: FormPdfSourceDto;
  level: PdfDetectionLevel;
  /** Plain Turkish notes for the user (e.g. "taranmış PDF: alanları elle yerleştirin"). */
  messages: string[];
  candidates: PdfFieldCandidate[];
  /** Suggested template: name / code from the title, items carrying their PDF placement. */
  draft: { code: string; name: string; category: string | null; schema: FormTemplateSchema };
  /** Vision models (scanned PDFs) can be plugged in later; none is installed now. */
  vision: { available: boolean; note: string };
}

/** Result of naming candidates with the local model. */
export interface PdfNamingDto {
  schema: FormTemplateSchema;
  name: string | null;
  model: string;
  provider: string;
  repaired: boolean;
  ms: number;
  /** Candidates the model left out or got wrong; they keep the heuristic name. */
  kept: number;
}

// ---- Values as printed text -----------------------------------------------------------------------

/** "2026-10-12" → "12.10.2026". */
export function formatDateDots(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : iso;
}

/** Number as printed in the reader's language ("12,5" in Turkish, "12.5" in English). */
function printNum(n: number, lang: string): string {
  return n.toLocaleString(sharedIntlLocale(lang), { maximumFractionDigits: 6 });
}

/** A value as printed on the form ("Evet", "12,5 mm", "12.10.2026"); null when empty or drawn otherwise. */
export function formValueText(
  item: FormItem,
  v: FormValue | undefined,
  lookup: { location?(id: string): string | undefined; file?(id: string): string | undefined } = {},
  lang: string = SHARED_DEFAULT_LANGUAGE,
): string | null {
  if (v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length)) return null;
  switch (item.type) {
    case "yes_no":
      return labelText(lang, "yesNo", String(v));
    case "number":
      return typeof v === "number" ? `${printNum(v, lang)}${item.unit ? ` ${item.unit}` : ""}` : String(v);
    case "km":
      return typeof v === "number" ? sharedText(lang, "forms.print.km", { value: formatChainage(v) }) : String(v);
    case "date":
      return formatDateDots(String(v));
    case "multi_choice":
      return (v as string[]).join(", ");
    case "location":
      return lookup.location?.(String(v)) ?? null;
    case "file":
      return lookup.file?.(String(v)) ?? null;
    case "score":
      return typeof v === "number" ? sharedText(lang, "forms.print.score", { value: printNum(v, lang) }) : null;
    case "signature":
    case "photo":
    case "table":
      return null;
    default:
      return String(v);
  }
}

/** The body of a form flow: an ordinary workflow template of kind "form". */
export interface FormFlowBody {
  name: string;
  steps: WorkflowStep[];
  finalOutcomes: FinalOutcomeMap;
  chain: ReviewChainConfig;
}

export interface FlowActorSuggestionDto {
  assignee: WorkflowAssignee;
  name: string;
  /** 0–1, higher is closer. */
  score: number;
}

/** A role named in the description that the project does not have ("rol oluştur / eşleştir"). */
export interface FlowUnresolvedActorDto {
  /** The placeholder assignee id used in the draft until it is matched or created. */
  placeholder: string;
  name: string;
  suggestions: FlowActorSuggestionDto[];
}

/** "Akışı anlatın" result: a flow draft to confirm and edit before it is saved. */
export interface FormFlowDraftDto {
  flow: FormFlowBody;
  lines: string[];
  unresolved: FlowUnresolvedActorDto[];
  /** Display names of the assignees the draft uses. */
  names: Record<string, string>;
  warnings: string[];
  model: string | null;
  provider: string | null;
  repaired: boolean;
  ms: number;
}

/** A form template's saved flow. */
export interface FormFlowDto {
  workflowTemplateId: string | null;
  flow: FormFlowBody | null;
  lines: string[];
  names: Record<string, string>;
}
