/**
 * Viewer registry: which in-browser viewer opens a file, and which server-side preview
 * derivatives it needs. One place for the web app ("Aç"), the upload hook and the API.
 */
import { splitExtension } from "../kernel/naming.js";
import { projectPath } from "../core/paths.js";
import { SHARED_DEFAULT_LANGUAGE, sharedText } from "../platform/i18n.js";

/** In-browser viewers. */
export type ViewerKind =
  | "pdf"
  | "ifc"
  | "document"
  | "slides"
  | "sheet"
  | "cad"
  | "image"
  | "text"
  | "markdown"
  | "video"
  | "audio"
  | "email"
  | "none";

/**
 * Server-side preview derivatives of a version:
 * - pdf: page-layout PDF of an office file, made by an optional converter plug-in. Office files
 *   are viewed in the browser without it (docx, odt, pptx, xlsx…); the PDF adds the exact layout.
 * - sheet: spreadsheet as compact JSON (SheetJS)
 * - dxf: DXF of a DWG (LibreDWG dwg2dxf); for a DXF only its text and encoding are read. Both are
 *   checked (Civil 3D objects, failed conversions) and repaired (values broken over lines)
 * - scene: the drawing's prebuilt 2D scene ("2B sahne"): dxf-viewer's scene built once on the
 *   server, so the browser shows large drawings without parsing the DXF (docs/features/VIEWERS.md)
 * - text: plain text only (search and the "Sor" assistant); office text and speaker notes are
 *   read from the XML parts, no converter needed
 */
export type PreviewKind = "pdf" | "sheet" | "dxf" | "scene" | "text";
export const PREVIEW_KINDS: readonly PreviewKind[] = ["pdf", "sheet", "dxf", "scene", "text"];

export type PreviewStatus = "pending" | "processing" | "ready" | "failed" | "unavailable";

export interface ViewerSpec {
  kind: ViewerKind;
  /** Short label in the caller's language ("Sunum", "Tablo"). */
  label: string;
  /** Derivatives built after upload. */
  previews: PreviewKind[];
  /** Derivatives a viewer may request later (e.g. a PDF of a spreadsheet). */
  onDemand: PreviewKind[];
}

/** Short label of a viewer kind ("Presentation", "Spreadsheet"). */
export function viewerLabel(kind: ViewerKind, lang: string = SHARED_DEFAULT_LANGUAGE): string {
  return sharedText(lang, `viewers.kinds.${kind}`);
}

/** Extensions per viewer (lower case, without the dot). */
export const VIEWER_EXTENSIONS: Record<Exclude<ViewerKind, "none">, readonly string[]> = {
  pdf: ["pdf"],
  ifc: ["ifc"],
  document: ["docx", "docm", "doc", "dotx", "odt", "ott", "rtf"],
  slides: ["pptx", "pptm", "ppt", "ppsx", "pps", "odp"],
  sheet: ["xlsx", "xlsm", "xlsb", "xls", "ods", "csv", "tsv"],
  cad: ["dwg", "dxf"],
  image: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif"],
  text: ["txt", "log", "json", "xml", "ini", "cfg", "conf", "yaml", "yml", "ifcxml", "bcf", "sql"],
  markdown: ["md", "markdown"],
  video: ["mp4", "webm", "ogv", "m4v", "mov"],
  audio: ["mp3", "wav", "ogg", "oga", "m4a", "aac", "flac"],
  email: ["eml"],
};

const BY_EXT = new Map<string, Exclude<ViewerKind, "none">>();
for (const [kind, exts] of Object.entries(VIEWER_EXTENSIONS) as [Exclude<ViewerKind, "none">, readonly string[]][]) {
  for (const e of exts) BY_EXT.set(e, kind);
}

/** Derivatives built on upload, per viewer. */
function previewsOf(kind: ViewerKind, ext: string): { previews: PreviewKind[]; onDemand: PreviewKind[] } {
  switch (kind) {
    case "pdf":
      return { previews: ["text"], onDemand: [] };
    case "document":
    case "slides":
      // Text (and notes) always; the PDF follows automatically when a converter is configured.
      return { previews: ["text"], onDemand: ["pdf"] };
    case "sheet":
      // Delimited text has no layout worth printing.
      return { previews: ["sheet"], onDemand: ext === "csv" || ext === "tsv" ? [] : ["pdf"] };
    case "cad":
      // The scene follows the DXF automatically (it is built from it).
      return { previews: ["dxf"], onDemand: ["scene"] };
    case "text":
    case "markdown":
    case "email":
      return { previews: ["text"], onDemand: [] };
    default:
      return { previews: [], onDemand: [] };
  }
}

/** Viewer of an extension ("DOCX", ".docx" and "docx" are the same). */
export function viewerForExtension(extension: string, lang: string = SHARED_DEFAULT_LANGUAGE): ViewerSpec {
  const ext = extension.trim().replace(/^\.+/, "").toLowerCase();
  const kind: ViewerKind = BY_EXT.get(ext) ?? "none";
  return { kind, label: viewerLabel(kind, lang), ...previewsOf(kind, ext) };
}

/** Viewer of a file name; `label` in `lang`. */
export function viewerFor(fileName: string, lang: string = SHARED_DEFAULT_LANGUAGE): ViewerSpec {
  return viewerForExtension(splitExtension(fileName).extension, lang);
}

/** Office formats the browser renders itself (no server software). */
export type BrowserOffice = "docx" | "odt" | "pptx";

const BROWSER_OFFICE: Record<string, BrowserOffice> = {
  docx: "docx",
  docm: "docx",
  dotx: "docx",
  odt: "odt",
  ott: "odt",
  pptx: "pptx",
  pptm: "pptx",
  ppsx: "pptx",
};

/** In-browser renderer of an office extension; null for legacy binary formats (.doc, .ppt, .rtf, .odp). */
export function browserOffice(extension: string): BrowserOffice | null {
  return BROWSER_OFFICE[extension.trim().replace(/^\.+/, "").toLowerCase()] ?? null;
}

/**
 * How the "Aç" page shows a document or presentation:
 * - pdf: the converter's PDF (documents open in the PDF viewer; presentations use its pages)
 * - browser: rendered in the browser (docx-preview, ODF, pptx)
 * - wait: only a PDF can show it and the converter is making it
 * - convert: only a PDF can show it and there is none ("dönüştürücü gerekli")
 * Documents prefer the browser view (the PDF is one click away); presentations prefer the PDF
 * when it exists, for fidelity.
 */
export type OfficeShow = { show: "pdf" } | { show: "browser"; renderer: BrowserOffice } | { show: "wait" } | { show: "convert" };

export function officeShow(info: Pick<VersionPreviewDto, "viewer" | "extension" | "previews" | "pdfConverter">): OfficeShow {
  const renderer = browserOffice(info.extension);
  const pdf = info.previews.find((p) => p.kind === "pdf");
  const ready = pdf?.status === "ready";
  const busy = pdf?.status === "pending" || pdf?.status === "processing";
  if (info.viewer === "slides" && ready) return { show: "pdf" };
  if (renderer) return { show: "browser", renderer };
  if (ready) return { show: "pdf" };
  if (busy || (info.pdfConverter && (!pdf || pdf.status === "unavailable"))) return { show: "wait" };
  return { show: "convert" };
}

/** Page-layout PDF action for office views: open it, wait for it, make it, or nothing (no converter). */
export function officePdfAction(info: Pick<VersionPreviewDto, "previews" | "pdfConverter" | "canRequest">): "open" | "busy" | "request" | null {
  const pdf = info.previews.find((p) => p.kind === "pdf");
  if (pdf?.status === "ready") return "open";
  if (pdf?.status === "pending" || pdf?.status === "processing") return "busy";
  if (info.pdfConverter && info.canRequest.includes("pdf")) return "request";
  return null;
}

/**
 * Web route that opens a version: the PDF viewer (with markups) for PDFs, the model viewer
 * for IFC, the universal viewer page for everything else (it also shows the "no preview" card).
 */
export function viewerPath(projectId: string, fileName: string, versionId: string): string {
  const { kind } = viewerFor(fileName);
  if (kind === "pdf") return projectPath(projectId, `view/${versionId}`);
  if (kind === "ifc") return projectPath(projectId, `viewer?v=${versionId}`);
  return projectPath(projectId, `open/${versionId}`);
}

/** One preview derivative of a version. */
export interface PreviewDto {
  kind: PreviewKind;
  status: PreviewStatus;
  error: string | null;
  /** Admin hint when a converter is missing ("unavailable"). */
  hint: string | null;
  meta: PreviewMeta;
  updatedAt: string;
}

export interface PreviewMeta {
  /** PDF previews: page (slide) count. */
  pageCount?: number;
  /** Presentations: speaker notes per slide (index = slide - 1), when they could be read. */
  notes?: string[];
  /** Spreadsheets: sheet names. */
  sheets?: string[];
  /** Data was cut at the size limits. */
  truncated?: boolean;
  /** DXF: TextDecoder label of the drawing ("utf-8", "windows-1254"). */
  encoding?: string;
  /** DXF: the drawing is the original file (no conversion). */
  original?: boolean;
  /** Characters of text extracted for search. */
  textChars?: number;
  /** DXF: values broken over several lines that were joined (LibreDWG 0.13 output). */
  repairs?: number;
  /** DXF: size of the DXF the browser would parse. */
  dxfBytes?: number;
  /** DXF: what the drawing holds and how it can be shown. */
  cad?: CadCheck;
  /** Scene: the prebuilt 2D scene. */
  scene?: CadSceneMeta;
  /** Scene: build phase while processing. */
  phase?: "parse" | "build" | "compress";
  /** Scene: storage key of the model-space-only scene (server side; not sent to the browser). */
  sceneModelKey?: string;
}

/**
 * Result of the drawing check after conversion:
 * - ok: shown as is
 * - partial: shown, with a small warning (the converter reported many errors, or Civil 3D objects
 *   were skipped while plain AutoCAD objects remain)
 * - civil3d: only Civil 3D objects (alignments, corridors, surfaces): nothing to show
 * - empty: no entities at all (the conversion failed)
 */
export interface CadCheck {
  status: "ok" | "partial" | "civil3d" | "empty";
  /** Error lines dwg2dxf wrote (0 for a DXF upload). */
  converterErrors: number;
  /** Civil 3D object classes (AECC_*) in the CLASSES section. */
  aeccClasses: number;
  /** Entities in the ENTITIES section (model and paper space), in paper space, in block definitions. */
  entities: number;
  paperEntities: number;
  blockEntities: number;
  /** $INSUNITS of the drawing (0 unitless, 1 in, 4 mm, 5 cm, 6 m …), null when missing. */
  insunits: number | null;
  /** $MEASUREMENT (0 imperial, 1 metric), null when missing. */
  measurement: number | null;
  /** $EXTMIN / $EXTMAX (x, y) when the drawing has valid extents. */
  extMin: [number, number] | null;
  extMax: [number, number] | null;
}

/** The prebuilt 2D scene of a drawing (preview kind "scene"). */
export interface CadSceneMeta {
  /** Container size before and after gzip (the download). */
  bytes: number;
  gzBytes: number;
  /** Model-space-only variant ("Yalnız Model Alanı"); null when the drawing has no paper-space entities (the full scene is the same). */
  model: { bytes: number; gzBytes: number } | null;
  batches: number;
  layers: number;
  /** Server build time per phase, milliseconds. */
  timings: { parse: number; build: number; encode: number };
  /** Container format version. */
  format: number;
}

export interface VersionPreviewDto {
  versionId: string;
  fileId: string;
  folderId: string;
  fileName: string;
  extension: string;
  version: number;
  currentVersion: number;
  size: number;
  uploadedAt: string;
  viewer: ViewerKind;
  viewerLabel: string;
  previews: PreviewDto[];
  /** Kinds that can be requested now (on demand or retried). */
  canRequest: PreviewKind[];
  canDownload: boolean;
  /**
   * The server can make page-layout PDFs of office files (a converter plug-in is configured).
   * Without it office files are still viewed in the browser.
   */
  pdfConverter: boolean;
}

/** Spreadsheet preview (JSON derivative). */
export interface SheetPreviewDto {
  sheets: SheetDataDto[];
  truncated: boolean;
}

/**
 * A cell as displayed: plain text, or a one-element array for numbers and dates
 * (right-aligned), or null when empty.
 */
export type SheetCell = string | [string] | null;

export interface SheetDataDto {
  name: string;
  hidden: boolean;
  /** Rows and columns in the data (after trimming empty edges). */
  rowCount: number;
  colCount: number;
  /** Column widths in CSS pixels. */
  colWidths: number[];
  rows: SheetCell[][];
  merges: { r0: number; c0: number; r1: number; c1: number }[];
  truncated: boolean;
}

export interface ConverterStatusDto {
  available: boolean;
  path: string | null;
  /** How it was found: env variable, known install path or PATH. */
  source: "env" | "auto" | "path" | null;
  hint: string;
}

export interface ConvertersDto {
  soffice: ConverterStatusDto;
  dwg2dxf: ConverterStatusDto;
}
