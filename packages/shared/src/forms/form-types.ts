/** Leaf form schema and value contracts shared by forms and PDF rendering. */
export const FORM_ITEM_TYPES = [
  "yes_no",
  "text",
  "number",
  "km",
  "date",
  "choice",
  "multi_choice",
  "signature",
  "photo",
  "location",
  "file",
  "table",
  "score",
] as const;
export type FormItemType = (typeof FORM_ITEM_TYPES)[number];

export const FORM_ITEM_TYPE_LABELS_TR: Record<FormItemType, string> = {
  yes_no: "Evet / Hayır / U.D.",
  text: "Metin",
  number: "Sayı (birimli)",
  km: "Km (kilometre)",
  date: "Tarih",
  choice: "Tek Seçim",
  multi_choice: "Çoklu Seçim",
  signature: "İmza",
  photo: "Fotoğraf",
  location: "Konum",
  file: "Dosya Referansı",
  table: "Tablo (tekrarlı satır)",
  score: "Puan (hesaplanan)",
};

export const TABLE_COLUMN_TYPES = ["text", "number", "km", "date", "yes_no", "choice"] as const;
export type TableColumnType = (typeof TABLE_COLUMN_TYPES)[number];

export interface FormTableColumn {
  id: string;
  label: string;
  type: TableColumnType;
  unit?: string;
  options?: string[];
  required?: boolean;
  min?: number;
  max?: number;
}



export interface PdfBox {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One tick box of an answer ("yes", "no", "na" or an option text). */
export interface PdfMark {
  value: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Fillable PDFs: the check box / radio group that carries this answer. */
  acroField?: string;
  /** Radio groups: the export value of this button. */
  acroValue?: string;
}

/** Where a form item sits on its source PDF. */
export interface FormItemPdf extends PdfBox {
  /** Fillable PDFs: the AcroForm field the value is written into. */
  acroField?: string;
  /** yes_no / choice / multi_choice: a tick box per answer. */
  marks?: PdfMark[];
  /** table: printed rows on the page; more rows go to an extra page. */
  rows?: number;
  /** table: column boundaries (absolute x, columns + 1 values). */
  colX?: number[];
  /** table: height of the printed header row inside the box. */
  headerH?: number;
}

/** One item of a template. Type-specific fields are optional and ignored by other types. */
export interface FormItem {
  id: string;
  type: FormItemType;
  label: string;
  help?: string;
  required?: boolean;
  /** yes_no: offer "Uygulanmaz" (default true). */
  allowNa?: boolean;
  /** text: multi-line input. */
  multiline?: boolean;
  /** number */
  unit?: string;
  min?: number;
  max?: number;
  /** choice / multi_choice */
  options?: string[];
  /** choice: answers that count as a failed item (e.g. "Uygun değil"). */
  failOptions?: string[];
  /** photo: most photos per item (default 10). */
  maxPhotos?: number;
  /** table */
  columns?: FormTableColumn[];
  maxRows?: number;
  /** score: yes/no items counted (empty = every yes/no item of the template). */
  scoreOf?: string[];
  /** PDF templates: where the item sits on the source PDF (page, box, AcroForm field, tick boxes, table grid). */
  pdf?: FormItemPdf;
}

export interface FormSection {
  id: string;
  title: string;
  items: FormItem[];
}

export interface FormTemplateSchema {
  sections: FormSection[];
}

export type TableRow = Record<string, string | number | null>;
/**
 * Stored values by item id:
 * yes_no "yes"|"no"|"na" · text/date/choice string · number number · km number (kilometres) · multi_choice string[] ·
 * signature attachment id · photo attachment ids · location location id · file file-version id ·
 * table rows · score number (computed by the server).
 */
export type FormValue = string | number | string[] | TableRow[] | null;
export type FormValues = Record<string, FormValue>;
