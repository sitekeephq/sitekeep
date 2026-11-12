/** Report dashboards: query spec types and DTOs shared by the server and the web app. */

export const REPORT_FILTER_OPS = [
  "eq",
  "neq",
  "in",
  "contains",
  "gt",
  "gte",
  "lt",
  "lte",
  "between",
  "isNull",
] as const;
export type ReportFilterOp = (typeof REPORT_FILTER_OPS)[number];

export const REPORT_METRIC_OPS = ["count", "sum", "avg", "min", "max"] as const;
export type ReportMetricOp = (typeof REPORT_METRIC_OPS)[number];

export const REPORT_BUCKETS = ["day", "week", "month"] as const;
export type ReportBucket = (typeof REPORT_BUCKETS)[number];

export type ReportScalar = string | number | boolean | null;
export type ReportValue = ReportScalar | ReportScalar[];

export interface ReportFilter {
  field: string;
  op: ReportFilterOp;
  value?: ReportValue;
}

export type ReportGroupBy = string | { field: string; bucket?: ReportBucket };

export interface ReportMetric {
  op: ReportMetricOp;
  field?: string;
  /** Output column name; defaults to `count` or `<op>_<field>`. */
  as?: string;
}

export interface ReportSort {
  field: string;
  dir?: "asc" | "desc";
}

export interface ReportQuerySpec {
  dataset: string;
  filters?: ReportFilter[];
  groupBy?: ReportGroupBy[];
  metrics?: ReportMetric[];
  /** Columns of raw (ungrouped) rows; all fields when omitted. */
  fields?: string[];
  sort?: ReportSort[];
  limit?: number;
}

export interface ReportQueryRef {
  id: string;
  spec: ReportQuerySpec;
}

export type ReportRow = Record<string, ReportScalar>;
export type ReportData = Record<string, ReportRow[]>;

export const REPORT_MAX_ROWS = 5000;
export const REPORT_HTML_MAX_BYTES = 500 * 1024;
export const REPORT_MAX_QUERIES = 20;

export type ReportSharing = "private" | "project" | "company" | "admins";
export const REPORT_SHARING = ["private", "project", "company", "admins"] as const;

export const REPORT_SHARING_LABELS_TR: Record<ReportSharing, string> = {
  private: "Yalnızca Ben",
  project: "Tüm Proje Üyeleri",
  company: "Firmam",
  admins: "Proje Yöneticileri",
};

/**
 * Module families of the report builder: every dataset and template belongs to one. A module page's
 * "Rapor" shortcut opens the builder scoped to its family (only those datasets go to the AI prompt).
 */
export const REPORT_MODULES = [
  "documents",
  "issues",
  "works",
  "correspondence",
  "rfi",
  "submittals",
  "meetings",
  "transmittals",
  "reviews",
  "forms",
  "locations",
  "schedule",
  "coordination",
  "doccompare",
  "spec",
  "models",
  "project",
] as const;
export type ReportModule = (typeof REPORT_MODULES)[number];

export const REPORT_MODULE_LABELS_TR: Record<ReportModule, string> = {
  documents: "Dokümanlar",
  issues: "Sorunlar",
  works: "Tüm İşler",
  correspondence: "Yazışmalar",
  rfi: "Bilgi Talepleri",
  submittals: "Teknik Onaylar",
  meetings: "Toplantılar ve Eylemler",
  transmittals: "Gönderim Formları",
  reviews: "İncelemeler",
  forms: "Formlar",
  locations: "Konumlar",
  schedule: "İş Programı",
  coordination: "Çakışmalar",
  doccompare: "Doküman Karşılaştırmaları",
  spec: "Şartname Analizi",
  models: "Modeller",
  project: "Proje ve Aktivite",
};

export function isReportModule(v: unknown): v is ReportModule {
  return typeof v === "string" && (REPORT_MODULES as readonly string[]).includes(v);
}

export type ReportFieldType = "string" | "number" | "date" | "boolean";

export interface ReportFieldDto {
  name: string;
  type: ReportFieldType;
  label: string;
  description?: string;
  /** Known values (code → Turkish label). */
  values?: Record<string, string>;
}

export interface ReportDatasetDto {
  name: string;
  label: string;
  description: string;
  fields: ReportFieldDto[];
  /** e.g. `attributes.` — any field with this prefix is allowed. */
  dynamicPrefix?: string;
  adminOnly?: boolean;
  /** Module family (templates, "Rapor" shortcuts, AI dataset routing). */
  module?: ReportModule;
}

export interface ReportTemplateDto {
  id: string;
  name: string;
  description: string;
  queries: ReportQueryRef[];
  html: string;
  module?: ReportModule;
}

export interface ReportModuleDto {
  key: ReportModule;
  label: string;
  /** Datasets of the family (AI scope of the module's "Rapor" shortcut). */
  datasets: string[];
  /** Example prompts for the builder opened from the module. */
  examples: string[];
}

export interface ReportCatalogDto {
  aiAvailable: boolean;
  datasets: ReportDatasetDto[];
  templates: ReportTemplateDto[];
  examplePrompts: string[];
  modules?: ReportModuleDto[];
  /** Datasets of modules that are off in the project: only for the labels of existing dashboards. */
  labelDatasets?: ReportDatasetDto[];
}

/** Code → Turkish label maps of the datasets a dashboard uses (merged per field name, for the frame). */
export function reportValueLabels(datasets: ReportDatasetDto[], names?: Iterable<string>): Record<string, Record<string, string>> {
  const want = names ? new Set(names) : null;
  const out: Record<string, Record<string, string>> = {};
  for (const d of datasets) {
    if (want && !want.has(d.name)) continue;
    for (const f of d.fields) if (f.values) out[f.name] = { ...(out[f.name] ?? {}), ...f.values };
  }
  return out;
}

/** Dataset names used by queries. */
export function reportQueryDatasets(queries: ReportQueryRef[]): string[] {
  return [...new Set(queries.map((q) => q.spec.dataset))];
}

export interface DashboardSummaryDto {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  ownerId: string;
  ownerName?: string;
  sharing: ReportSharing;
  version: number;
  createdAt: string;
  updatedAt: string;
  isMine: boolean;
  canEdit: boolean;
}

export interface DashboardDto extends DashboardSummaryDto {
  queries: ReportQueryRef[];
  html: string;
}

export interface DashboardVersionDto {
  version: number;
  name: string;
  description: string | null;
  sharing: ReportSharing;
  createdBy: string | null;
  createdByName?: string;
  createdAt: string;
  queries?: ReportQueryRef[];
  html?: string;
}

export interface ReportDraft {
  name: string;
  description?: string | null;
  queries: ReportQueryRef[];
  html: string;
}

/**
 * Why a query of a dashboard did not run:
 * - invalid: the saved query no longer fits the dataset (a field was renamed or removed) — repairable
 * - forbidden: the viewer may not use the dataset
 * - failed: the data could not be loaded (e.g. a model that is not indexed yet)
 */
export type ReportQueryErrorKind = "invalid" | "forbidden" | "failed";

export interface ReportDataResult {
  results: ReportData;
  /** Per-query problems (e.g. a dataset the viewer may not use). */
  errors: Record<string, string>;
  errorKinds?: Record<string, ReportQueryErrorKind>;
  generatedAt: string;
  /**
   * Change stamp of the data behind the result (see GET …/stamp). The client re-runs the queries
   * only when the stamp it polls differs from this one.
   */
  stamp?: string;
}

export interface ReportStampDto {
  stamp: string;
  /** When the newest change to the data behind the stamp was recorded (null: none yet). */
  changedAt: string | null;
}

/** Answer of "Yapay zekâ ile onar" for one broken query. */
export interface ReportRepairResult {
  queryId: string;
  spec: ReportQuerySpec;
  /** What changed, in Turkish (from the model, may be empty). */
  note: string;
}

export interface ReportGenerateResult extends ReportDataResult {
  draft: ReportDraft;
  attempts: number;
}

export function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}
