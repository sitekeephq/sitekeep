/**
 * Submittal register exchange format. The doc-intelligence branch extracts this from
 * specifications ("şartname → submittal register"); the import endpoint accepts the same rows
 * as JSON, CSV or XLSX and creates submittal items (preview first, then create).
 */
/**
 * One submittal requirement of a specification register: the doc-intelligence output
 * ("Şartname analizi", docintel.ts re-exports this type) and the input of the Submittal import.
 * Rows read from CSV / XLSX get defaults for the extraction-only fields (id, confidence, keywords).
 */
export interface SubmittalRegisterItem {
  /** Stable within its register ("S001"). */
  id: string;
  /** Specification section code, e.g. "05 12 00". */
  sectionCode: string | null;
  sectionTitle: string | null;
  /** 1-based page in the specification. */
  page: number | null;
  /** Short item description ("Teknik föy / katalog – Klima santrali"). */
  description: string;
  /** Quoted specification text (≤ 300 characters from extraction). */
  excerpt: string;
  /** Submittal kind: a code (MOS, UCZ…; see SUBMITTAL_TYPES) or its label; null when undecided. */
  type: string | null;
  typeConfidence: number;
  /** Discipline code or name ("MEK", "M", "Mekanik"); null when undecided. */
  discipline: string | null;
  /** Trigger phrases that matched ("teknik föy", "onaya sunulacaktır"). */
  keywords: string[];
  /** Left out by the user (not imported). */
  excluded?: boolean;
  /** Type or excerpt came from the language model. */
  aiAssisted?: boolean;
  /** Optional item title for the import (default: from the description). */
  title?: string | null;
  /** Specification file version the row was extracted from (linked to the created item). */
  sourceFileVersionId?: string | null;
}

export interface RegisterImportRowDto {
  row: number;
  item: SubmittalRegisterItem;
  title: string;
  /** Matched kind option ("MOS - Malzeme Onay"), null when not recognised. */
  kind: string | null;
  discipline: string | null;
  /** Package the row goes to (by section or kind), null without packages. */
  packageKey: string | null;
  problems: string[];
}

export interface RegisterImportResultDto {
  dryRun: boolean;
  rows: RegisterImportRowDto[];
  valid: number;
  invalid: number;
  packages: { key: string; bolum: string; discipline: string; count: number; existingId: string | null }[];
  created: { items: string[]; packages: string[] } | null;
}
