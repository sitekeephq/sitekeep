/**
 * Document intelligence ("Doküman zekâsı"): title-block (antet) extraction, naming suggestions,
 * revision checks and the specification → submittal register. Shared DTOs plus the pure
 * revision helpers that the server and the web app both use.
 */
import { SHARED_DEFAULT_LANGUAGE, sharedText } from "../platform/i18n.js";

/** Title-block fields SiteKeep understands. Unknown label/value pairs are kept in `pairs`. */
export const ANTET_FIELD_KEYS = [
  "projectNo",
  "projectName",
  "drawingNo",
  "docNo",
  "sheetNo",
  "title",
  "revision",
  "date",
  "scale",
  "drawnBy",
  "checkedBy",
  "approvedBy",
  "discipline",
  "status",
  "company",
] as const;
export type AntetFieldKey = (typeof ANTET_FIELD_KEYS)[number];

export const ANTET_FIELD_LABELS_TR: Record<AntetFieldKey, string> = {
  projectNo: "Proje No",
  projectName: "Proje Adı",
  drawingNo: "Çizim No",
  docNo: "Doküman No",
  sheetNo: "Pafta No",
  title: "Pafta Adı",
  revision: "Revizyon",
  date: "Tarih",
  scale: "Ölçek",
  drawnBy: "Çizen",
  checkedBy: "Kontrol",
  approvedBy: "Onay",
  discipline: "Disiplin",
  status: "Durum",
  company: "Firma",
};

/** Rectangle in page display coordinates (points, origin top-left, y down). */
export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface AntetField {
  key: AntetFieldKey;
  /** The label as printed ("Çizim No", "DRAWING NO."). */
  label: string;
  value: string;
  /** 0–1. */
  confidence: number;
  /** How the value was found next to its label. */
  source: "inline" | "right" | "below" | "pattern" | "table";
  page: number;
  box?: Box;
}

/** Any label/value pair found in the title block, including labels without a known key. */
export interface AntetPair {
  label: string;
  value: string;
  key: AntetFieldKey | null;
}

export interface RevisionRow {
  rev: string;
  date: string | null;
  description: string | null;
}

export interface AntetResult {
  page: number;
  pageCount: number;
  pageSize: { width: number; height: number };
  /** Detected title-block area (null when no label cluster was found). */
  region: Box | null;
  /** Best value per key (highest confidence). */
  fields: AntetField[];
  pairs: AntetPair[];
  revisionTable: RevisionRow[];
  /** Strings on the page that look like document codes (several delimited parts). */
  codes: string[];
  /** False for scanned PDFs without a text layer (OCR is not done yet). */
  hasText: boolean;
  /** "drawing" when a title block was found, "text" for running text (reports, specifications). */
  kind: "drawing" | "text" | "empty";
  /** Short note for the user (e.g. "Metin katmanı yok; taranmış PDF olabilir."). */
  note?: string;
}

export type RevisionSource = "antet" | "table" | "filename" | "attribute";

export interface RevisionInfo {
  /** Normalised revision ("P02", "C01", "B", "3"); null when none was found. */
  value: string | null;
  source: RevisionSource | null;
  confidence: number;
  /** Every revision seen, by source (for the explanation). */
  candidates: { value: string; source: RevisionSource; raw: string }[];
}

export type RevisionWarningCode =
  | "same_content"
  | "same_revision_changed"
  | "revision_backwards"
  | "attribute_mismatch"
  | "name_mismatch"
  | "table_mismatch";

export interface RevisionWarning {
  code: RevisionWarningCode;
  severity: "info" | "warn";
  message: string;
}

/** One naming field of a suggestion. */
export interface SuggestedField {
  field: string;
  value: string | null;
  confidence: number;
  /** "Antetteki 'Pafta No: S-204' → Alt Disiplin 0204". */
  explanation: string;
  /** Other plausible values (codes) when the mapping is ambiguous. */
  alternatives: string[];
  ambiguous: boolean;
  source: "code" | "antet" | "filename" | "folder" | "single" | "ai" | "language" | null;
}

export interface SuggestedAttribute {
  name: string;
  value: string;
  confidence: number;
  explanation: string;
  /** No attribute definition with this name applies to the folder (stored as a free-form value). */
  freeForm: boolean;
}

export interface NamingSuggestionDto {
  /** Name of the folder's naming standard, null when the folder has none. */
  standard: string | null;
  /** Suggested file name (with the original extension). Only set when it validates. */
  name: string | null;
  /** True when the suggestion validates against the standard (or there is no standard). */
  ok: boolean;
  /** Errors of the best partial name (when `name` is null). */
  errors: string[];
  fields: SuggestedField[];
  attributes: SuggestedAttribute[];
  /** The current name already equals the suggestion. */
  unchanged: boolean;
  ai: { used: boolean; accepted: boolean; note?: string } | null;
}

export type ExtractionStatus = "pending" | "processing" | "done" | "failed" | "unsupported";

export interface VersionDocIntelDto {
  versionId: string;
  fileId: string;
  version: number;
  status: ExtractionStatus;
  error: string | null;
  antet: AntetResult | null;
  revision: RevisionInfo | null;
  warnings: RevisionWarning[];
  suggestion: NamingSuggestionDto | null;
  /** The file looks like a specification (name, folder or running text): offer "Şartname analizi". */
  specLike: boolean;
  /** Register already built from this version. */
  registerId: string | null;
  aiAvailable: boolean;
  updatedAt: string | null;
}

export interface SuggestFileResultDto {
  name: string;
  size: number;
  ok: boolean;
  error?: string;
  antet: AntetResult | null;
  revision: RevisionInfo | null;
  suggestion: NamingSuggestionDto | null;
}

// ---------------------------------------------------------------------------
// Submittal register (Şartnameden submittal)
// ---------------------------------------------------------------------------

/**
 * Submittal item types (ZAVM submittal sections). The labels are the Turkish source (matched
 * against typed input); screens and exports show submittalTypeLabel(code, lang).
 */
export const SUBMITTAL_TYPES = [
  { code: "MOS", label: "Malzeme Onay Sunumu" },
  { code: "NUM", label: "Numune" },
  { code: "UCZ", label: "Uygulama / Atölye Çizimi" }, // i18n-ok: Turkish source label
  { code: "YB", label: "Yöntem Beyanı" }, // i18n-ok: Turkish source label
  { code: "IP", label: "İş Programı" }, // i18n-ok: Turkish source label
  { code: "ISG", label: "İSG" }, // i18n-ok: Turkish source label
  { code: "TR", label: "Teknik Rapor / Hesap" },
  { code: "PMR", label: "Periyodik Muayene" },
  { code: "KS", label: "Kalite / Test" },
  { code: "IKOF", label: "İmalat Kontrol Onay Formu" }, // i18n-ok: Turkish source label
  { code: "BAS", label: "Bilgi Amaçlı Sunum" }, // i18n-ok: Turkish source label
  { code: "MKF", label: "Saha Malzeme Kabul" },
] as const;
export type SubmittalTypeCode = (typeof SUBMITTAL_TYPES)[number]["code"];
export const SUBMITTAL_TYPE_CODES = SUBMITTAL_TYPES.map((t) => t.code) as readonly SubmittalTypeCode[];

/** Disciplines suggested for register items (3-letter codes, as in the PKF/MBE and ZAVM projects). */
export const SUBMITTAL_DISCIPLINES = [
  { code: "MIM", label: "Mimari" },
  { code: "INS", label: "İnşaat / Yapısal" }, // i18n-ok: Turkish source label
  { code: "GEO", label: "Geoteknik" },
  { code: "MEK", label: "Mekanik" },
  { code: "ELK", label: "Elektrik" },
  { code: "ALT", label: "Altyapı" }, // i18n-ok: Turkish source label
  { code: "PEY", label: "Peyzaj" },
  { code: "GNL", label: "Genel" },
] as const;
export type SubmittalDisciplineCode = (typeof SUBMITTAL_DISCIPLINES)[number]["code"];

/** Label of a submittal type code in the reader's language ("UCZ" → "Uygulama / Atölye Çizimi"). */
export function submittalTypeLabel(code: string, lang: string = SHARED_DEFAULT_LANGUAGE): string {
  return SUBMITTAL_TYPES.some((t) => t.code === code) ? sharedText(lang, `documents.submittalTypes.${code}`) : code;
}

/** Label of a submittal discipline code in the reader's language ("MIM" → "Mimari"). */
export function submittalDisciplineLabel(code: string, lang: string = SHARED_DEFAULT_LANGUAGE): string {
  return SUBMITTAL_DISCIPLINES.some((d) => d.code === code) ? sharedText(lang, `documents.submittalDisciplines.${code}`) : code;
}

/**
 * One draft submittal requirement found in a specification. The single register row type lives
 * in submittal-register.ts (also the input of the Submittal import, POST …/submittals/import).
 */
import type { SubmittalRegisterItem } from "../works/submittal-register.js";
export type { SubmittalRegisterItem };

export interface SubmittalRegisterDto {
  id: string;
  projectId: string;
  versionId: string;
  fileId: string;
  fileName: string;
  version: number;
  items: SubmittalRegisterItem[];
  sectionCount: number;
  pageCount: number;
  usedAi: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SubmittalRegisterSummaryDto {
  id: string;
  versionId: string;
  fileId: string;
  fileName: string;
  version: number;
  itemCount: number;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Revisions
// ---------------------------------------------------------------------------

export interface ParsedRevision {
  /** Letter prefix ("P", "C", "R", "" for plain numbers). */
  prefix: string;
  /** Numeric part, null for pure letter revisions ("B"). */
  number: number | null;
  /** Letter revision ("B"), null for numbered ones. */
  letter: string | null;
  /** Normalised text ("P02", "B", "3"). */
  text: string;
}

const REV_RE = /^(?:REV(?:[İI]ZYON|ISION)?\.?\s*)?([A-Z]{1,2})?\s*[-.]?\s*(\d{1,3})(?:\.\d+)?$|^(?:REV(?:[İI]ZYON|ISION)?\.?\s*)?([A-Z])$/;

/**
 * Parses a revision code: "P02", "C1", "Rev.B", "R03", "Revizyon 2", "3", "B", "REV-A".
 * Returns null for anything else.
 */
export function parseRevision(raw: string | null | undefined): ParsedRevision | null {
  if (!raw) return null;
  const t = raw
    .normalize("NFC")
    .trim()
    .toLocaleUpperCase("tr-TR")
    .replace(/^R(?:EV)?\.?\s*NO\.?\s*:?\s*/, "")
    .replace(/[:]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!t || t.length > 16) return null;
  const m = REV_RE.exec(t);
  if (!m) return null;
  if (m[3]) return { prefix: "", number: null, letter: m[3], text: m[3] };
  let prefix = m[1] ?? "";
  const n = Number(m[2]);
  // "R03", "REV 3" and "3" are the same plain revision number.
  if (prefix === "R") prefix = "R";
  const width = Math.max(2, m[2]!.length);
  const text = prefix ? `${prefix}${String(n).padStart(width, "0")}` : String(n);
  return { prefix, number: n, letter: null, text };
}

/** Normalised revision text, or null. */
export function normalizeRevision(raw: string | null | undefined): string | null {
  return parseRevision(raw)?.text ?? null;
}

/** ISO 19650 suitability families: preliminary (P) comes before contractual (C). */
const FAMILY_ORDER: Record<string, number> = { P: 1, C: 2 };

/**
 * Compares two revisions: negative when a < b, 0 when equal, positive when a > b, null when
 * they cannot be compared (different numbering schemes).
 */
export function compareRevisions(a: string | null | undefined, b: string | null | undefined): number | null {
  const x = parseRevision(a);
  const y = parseRevision(b);
  if (!x || !y) return null;
  if (x.letter !== null && y.letter !== null) return x.letter.localeCompare(y.letter);
  if (x.number === null || y.number === null) return null;
  if (x.prefix === y.prefix || (["", "R"].includes(x.prefix) && ["", "R"].includes(y.prefix))) return x.number - y.number;
  const fx = FAMILY_ORDER[x.prefix];
  const fy = FAMILY_ORDER[y.prefix];
  if (fx && fy) return fx - fy;
  return null;
}

/**
 * Revision written in a file name: "…_P02.pdf", "… Rev.B.pdf", "…-R03.pdf", "… Revizyon 2.pdf",
 * "…_rev3.pdf". Only explicit forms are recognised; a bare "02" is not a revision.
 */
export function revisionFromFileName(fileName: string): { value: string; raw: string } | null {
  const base = fileName.replace(/\.[^.]+$/, "");
  const explicit = /(?:^|[\s_\-.(\[])(rev(?:izyon|ision)?\.?\s*[-_]?\s*([a-z]?\d{1,3}|[a-z]))(?=$|[\s_\-.)\]])/i.exec(base);
  if (explicit) {
    const v = normalizeRevision(explicit[2]!);
    if (v) return { value: v, raw: explicit[1]! };
  }
  const iso = /(?:^|[\s_\-.(\[])([PC]\d{2}(?:\.\d+)?|R\d{2})(?=$|[\s_\-.)\]])/.exec(base);
  if (iso) {
    const v = normalizeRevision(iso[1]!.replace(/\.\d+$/, ""));
    if (v) return { value: v, raw: iso[1]! };
  }
  return null;
}
