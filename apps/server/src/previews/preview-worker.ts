/**
 * Worker thread for preview parsing that can take seconds on large files:
 * - "sheet": spreadsheet → compact JSON (SheetJS CE, Apache-2.0) + plain text
 * - "dxf": DXF text entities and encoding
 * Kept free of relative imports so Node can run it directly (also as .ts in dev/tests);
 * the pure functions are exported for tests.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { parentPort, workerData } from "node:worker_threads";
import * as XLSX from "xlsx";
// Legacy code pages (BIFF5 .xls, DBF) need the full code page table in the ESM build.
import * as cptable from "xlsx/dist/cpexcel.full.mjs";
import type { SheetCell, SheetDataDto, SheetPreviewDto } from "@sitekeep/shared";

XLSX.set_cptable(cptable);

/** Limits: cells over all sheets, rows and columns per sheet, extracted text characters. */
export const SHEET_LIMITS = { cells: 2_000_000, rows: 200_000, cols: 1_000, text: 200_000 };

/** UTF-8 when valid, else Windows-1254 (Turkish Excel CSV exports). */
export function decodeText(buf: Buffer): string {
  const bom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder("utf-16le").decode(buf.subarray(2));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bom ? buf.subarray(3) : buf);
  } catch {
    return new TextDecoder("windows-1254").decode(buf);
  }
}

const trNumber = new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 10, useGrouping: false });
const pad = (n: number) => String(n).padStart(2, "0");

/** Excel's locale-dependent default date formats are shown the Turkish way. */
const DEFAULT_DATE = new Set(["m/d/yy", "m/d/yyyy", "mm-dd-yy", "d-mmm-yy", "d/m/yy", "m/d/yy;@"]);
const DEFAULT_DATETIME = new Set(["m/d/yy h:mm", "m/d/yyyy h:mm"]);

function formatNumberCell(cell: XLSX.CellObject, date1904: boolean): string {
  const v = cell.v as number;
  const z = typeof cell.z === "string" ? cell.z : "General";
  if (z === "General" || z === "@") return cell.w && z === "@" ? cell.w : trNumber.format(v);
  if (XLSX.SSF.is_date(z)) {
    // SheetJS cannot format some Turkish formats ("dd.mm.yyyy": the dot is read as a decimal
    // point) and leaves no text: those are shown the Turkish way too.
    if (DEFAULT_DATE.has(z) || DEFAULT_DATETIME.has(z) || !cell.w) {
      const d = XLSX.SSF.parse_date_code(v, { date1904 }) as { y: number; m: number; d: number; H: number; M: number } | undefined;
      if (!d) return cell.w ?? String(v);
      const day = `${pad(d.d)}.${pad(d.m)}.${d.y}`;
      const time = DEFAULT_DATETIME.has(z) || (!cell.w && /h/i.test(z));
      return time ? `${day} ${pad(d.H)}:${pad(d.M)}` : day;
    }
    return cell.w;
  }
  const w = cell.w ?? String(v);
  // Number formats ("#,##0.00", "0.0%"): Turkish separators.
  return /[#0]/.test(z) ? w.replace(/[.,]/g, (c) => (c === "." ? "," : ".")) : w;
}

function display(cell: XLSX.CellObject | undefined, date1904: boolean, csv: boolean): SheetCell {
  if (!cell) return null;
  switch (cell.t) {
    case "z":
      return null;
    case "e":
      return cell.w ?? "#HATA";
    case "b":
      return cell.v ? "DOĞRU" : "YANLIŞ"; // i18n-ok: stored sheet preview data, Turkish cell formatting like the separators above
    case "n":
      return [formatNumberCell(cell, date1904)];
    case "d": {
      const d = cell.v instanceof Date ? cell.v : new Date(String(cell.v));
      return [Number.isNaN(d.getTime()) ? String(cell.v) : `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`];
    }
    default: {
      const s = cell.v == null ? "" : String(cell.v);
      if (!s) return null;
      // Delimited text keeps its strings; numeric-looking ones are right-aligned.
      if (csv && /^[-+]?[\d.,]+%?$/.test(s.trim())) return [s];
      return s;
    }
  }
}

function colWidth(info: XLSX.ColInfo | undefined): number {
  if (!info) return 80;
  if (info.hidden) return 0;
  const px = info.wpx ?? (info.wch != null ? info.wch * 7 + 5 : info.width != null ? info.width * 7 + 5 : 80);
  return Math.max(24, Math.min(600, Math.round(px)));
}

export interface SheetParseResult {
  data: SheetPreviewDto;
  text: string;
  textTruncated: boolean;
}

/** Reads a spreadsheet (xlsx, xlsm, xlsb, xls, ods, csv, tsv) into the preview JSON and plain text. */
export function parseSheet(buf: Buffer, extension: string): SheetParseResult {
  const ext = extension.toLowerCase();
  const csv = ext === "csv" || ext === "tsv";
  const wb = csv
    ? XLSX.read(decodeText(buf), { type: "string", raw: true, dense: true, ...(ext === "tsv" && { FS: "\t" }) })
    : XLSX.read(buf, { type: "buffer", dense: true, cellNF: true, cellText: true, cellStyles: true, cellDates: false });
  const date1904 = !!wb.Workbook?.WBProps?.date1904;
  const sheets: SheetDataDto[] = [];
  let cellBudget = SHEET_LIMITS.cells;
  let text = "";
  let textTruncated = false;
  const addText = (s: string) => {
    if (textTruncated) return;
    if (text.length + s.length > SHEET_LIMITS.text) {
      text += s.slice(0, SHEET_LIMITS.text - text.length);
      textTruncated = true;
    } else text += s;
  };

  wb.SheetNames.forEach((name, i) => {
    const ws = wb.Sheets[name]!;
    const hidden = !!wb.Workbook?.Sheets?.[i]?.Hidden;
    const dense = (ws as unknown as { "!data"?: (XLSX.CellObject | undefined)[][] })["!data"] ?? [];
    const ref = ws["!ref"] ? XLSX.utils.decode_range(ws["!ref"]) : null;
    let rowCount = 0;
    let colCount = 0;
    const rows: SheetCell[][] = [];
    let truncated = false;
    if (ref) {
      const maxRow = Math.min(ref.e.r, SHEET_LIMITS.rows - 1);
      const maxCol = Math.min(ref.e.c, SHEET_LIMITS.cols - 1);
      if (ref.e.r > maxRow || ref.e.c > maxCol) truncated = true;
      for (let r = 0; r <= maxRow; r++) {
        const src = dense[r];
        const row: SheetCell[] = [];
        if (src) {
          for (let c = 0; c <= Math.min(maxCol, src.length - 1); c++) row[c] = display(src[c], date1904, csv);
        }
        let last = row.length - 1;
        while (last >= 0 && row[last] == null) last--;
        row.length = last + 1;
        for (let c = 0; c < row.length; c++) if (row[c] === undefined) row[c] = null;
        if (row.length) {
          rowCount = r + 1;
          colCount = Math.max(colCount, row.length);
        }
        if (cellBudget - row.length < 0) {
          truncated = true;
          break;
        }
        cellBudget -= Math.max(row.length, 1);
        rows.push(row);
      }
    }
    rows.length = Math.min(rows.length, rowCount);
    const merges = (ws["!merges"] ?? [])
      .filter((m) => m.s.r < rows.length && m.s.c < colCount)
      .map((m) => ({ r0: m.s.r, c0: m.s.c, r1: Math.min(m.e.r, rows.length - 1), c1: Math.min(m.e.c, colCount - 1) }));
    const cols = ws["!cols"] ?? [];
    const colWidths = Array.from({ length: colCount }, (_, c) => colWidth(cols[c]));
    sheets.push({ name, hidden, rowCount: rows.length, colCount, colWidths, rows, merges, truncated });

    if (!hidden) {
      if (wb.SheetNames.length > 1) addText(`## ${name}\n`);
      for (const row of rows) {
        if (textTruncated) break;
        const line = row
          .map((c) => (c == null ? "" : Array.isArray(c) ? c[0] : c))
          .filter(Boolean)
          .join(" | ");
        if (line) addText(`${line}\n`);
      }
    }
  });
  return { data: { sheets, truncated: sheets.some((s) => s.truncated) }, text: text.trim(), textTruncated };
}

// ---------------------------------------------------------------------------------------------
// DXF
// ---------------------------------------------------------------------------------------------

export interface DxfInfo {
  /** TextDecoder label to read the drawing with. */
  encoding: string;
  binary: boolean;
  text: string;
  truncated: boolean;
}

const MTEXT_SPECIAL: Record<string, string> = { c: "Ø", d: "°", p: "±" };

/** Plain text of an MTEXT/TEXT value: formatting codes removed, escapes decoded. */
export function cleanDxfText(s: string): string {
  return s
    .replace(/\\U\+([0-9a-fA-F]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/%%([cdp])/gi, (_, k: string) => MTEXT_SPECIAL[k.toLowerCase()]!)
    .replace(/%%u|%%o/gi, "")
    .replace(/\\[Pp]/g, "\n")
    .replace(/\\[Ss]([^;]*?)[#^/]([^;]*);/g, "$1/$2")
    .replace(/\\[ACcFfHhQqTtWwp][^;\\]*;/g, "")
    .replace(/\\[LlOoKkNn~]/g, (m) => (m === "\\~" ? " " : ""))
    .replace(/\\([\\{}])/g, "$1")
    .replace(/[{}]/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function detectDxfEncoding(buf: Buffer): string {
  const head = buf.subarray(0, 512 * 1024).toString("latin1");
  const ver = /\$ACADVER\s*\r?\n\s*1\s*\r?\n\s*(AC\d{4})/.exec(head)?.[1] ?? "";
  if (ver >= "AC1021") return "utf-8";
  // Some writers use UTF-8 regardless of the version: valid UTF-8 with non-ASCII bytes wins.
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf);
    if (buf.some((b) => b >= 0x80)) return "utf-8";
  } catch {
    /* not UTF-8 */
  }
  const cp = /\$DWGCODEPAGE\s*\r?\n\s*3\s*\r?\n\s*ANSI_(\d+)/i.exec(head)?.[1];
  const label = cp ? `windows-${cp}` : "windows-1252";
  try {
    new TextDecoder(label);
    return label;
  } catch {
    return "windows-1252";
  }
}

const TEXT_ENTITIES = new Set(["TEXT", "MTEXT", "ATTRIB", "ATTDEF", "MULTILEADER", "MLEADER", "DIMENSION"]);

/** What the drawing holds, for the viewer's cards (Civil 3D, empty drawing) and the scene build. */
export interface DxfStats {
  /** Entities in the ENTITIES section (model and paper space). */
  entities: number;
  /** Of those, in paper space (group 67 = 1). */
  paperEntities: number;
  /** Entities inside block definitions. */
  blockEntities: number;
  /** Civil 3D object classes (AECC_*) declared in the CLASSES section. */
  aeccClasses: number;
  /** $INSUNITS (0 unitless, 4 mm, 5 cm, 6 m …); null when the header has none. */
  insunits: number | null;
  /** $MEASUREMENT (0 imperial, 1 metric); null when missing. */
  measurement: number | null;
  /** $EXTMIN / $EXTMAX (x, y) when present. */
  extMin: [number, number] | null;
  extMax: [number, number] | null;
}

/** Encoding, text entities (TEXT, MTEXT, attributes, leaders, dimension overrides) and counts of an ASCII DXF. */
export function dxfInfo(buf: Buffer, maxText = SHEET_LIMITS.text): DxfInfo & { stats: DxfStats; brokenLines: number } {
  const stats: DxfStats = { entities: 0, paperEntities: 0, blockEntities: 0, aeccClasses: 0, insunits: null, measurement: null, extMin: null, extMax: null };
  if (buf.subarray(0, 22).toString("latin1").startsWith("AutoCAD Binary DXF")) {
    return { encoding: "utf-8", binary: true, text: "", truncated: false, stats, brokenLines: 0 };
  }
  // Group-code lines that are no integer: the drawing needs the repair pass (fast path when 0).
  let brokenLines = 0;
  const encoding = detectDxfEncoding(buf);
  const lines = new TextDecoder(encoding).decode(buf).split(/\r?\n/);
  const seen = new Set<string>();
  const out: string[] = [];
  let size = 0;
  let truncated = false;
  let entity = "";
  let parts: string[] = [];
  let section = "";
  let type = "";
  let headerVar = "";
  let sectionName = false;
  const point: Record<string, [number, number]> = {};
  const flush = () => {
    if (entity && parts.length && !truncated) {
      const t = cleanDxfText(parts.join(""));
      if (t && t !== "<>" && !seen.has(t)) {
        seen.add(t);
        if (size + t.length > maxText) truncated = true;
        else {
          out.push(t);
          size += t.length + 1;
        }
      }
    }
    parts = [];
  };
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = lines[i]!.trim();
    const value = lines[i + 1]!;
    if (!INT_LINE.test(code)) brokenLines++;
    const named = sectionName;
    sectionName = false;
    if (code === "0") {
      flush();
      type = value.trim();
      sectionName = type === "SECTION";
      entity = TEXT_ENTITIES.has(type) ? type : "";
      if (type === "SECTION" || type === "ENDSEC") section = type === "ENDSEC" ? "" : section;
      else if (section === "ENTITIES") stats.entities++;
      else if (section === "BLOCKS" && type !== "BLOCK" && type !== "ENDBLK") stats.blockEntities++;
      continue;
    }
    if (code === "2" && named) section = value.trim();
    else if (section === "HEADER") {
      if (code === "9") headerVar = value.trim();
      else if (headerVar === "$INSUNITS" && code === "70") stats.insunits = Number.parseInt(value.trim(), 10);
      else if (headerVar === "$MEASUREMENT" && code === "70") stats.measurement = Number.parseInt(value.trim(), 10);
      else if ((headerVar === "$EXTMIN" || headerVar === "$EXTMAX") && (code === "10" || code === "20")) {
        const p = (point[headerVar] ??= [0, 0]);
        p[code === "10" ? 0 : 1] = Number.parseFloat(value.trim());
      }
    } else if (section === "CLASSES" && type === "CLASS" && code === "1" && /^AECC_/i.test(value.trim())) stats.aeccClasses++;
    else if (section === "ENTITIES" && code === "67" && value.trim() === "1") stats.paperEntities++;
    if (!entity || truncated) continue;
    // MTEXT: chunks in 3, the last piece in 1; leaders: 304; others: 1.
    if (code === "3" && entity === "MTEXT") parts.push(value);
    else if (code === "1") parts.push(value);
    else if (code === "304" && (entity === "MULTILEADER" || entity === "MLEADER")) parts.push(value);
  }
  flush();
  const finite = (p?: [number, number]) => (p && p.every(Number.isFinite) && Math.abs(p[0]) < 1e19 ? p : null);
  stats.extMin = finite(point.$EXTMIN);
  stats.extMax = finite(point.$EXTMAX);
  return { encoding, binary: false, text: out.join("\n"), truncated, stats, brokenLines };
}

// ---------------------------------------------------------------------------------------------
// DXF repair: LibreDWG's dwg2dxf writes some string values (MTEXT/TEXT/attribute values with
// font codes) with raw line breaks inside, so the code/value line pairs get out of step and
// dxf-viewer's parser stops with "Cannot parse group code". The repair joins the broken pieces.
// ---------------------------------------------------------------------------------------------

const INT_LINE = /^\s*-?\d+\s*$/;
const FLOAT_VALUE = /^\s*[-+]?((\d+\.?\d*|\.\d+)([eE][-+]?\d+)?|nan|inf|infinity|-?nan\(ind\))\s*$/i;
const INT_VALUE = /^\s*[-+]?\d+\s*$/;
const TYPE_VALUE = /^\s*[A-Za-z0-9_]*[A-Za-z][A-Za-z0-9_]*\s*$/;

/** Whether `value` can follow group code `code` (the value types of dxf-parser's parseGroupValue). */
function valueFits(code: number, value: string): boolean {
  if (code === 0) return TYPE_VALUE.test(value);
  if ((code >= 10 && code <= 59) || (code >= 110 && code <= 149) || (code >= 210 && code <= 239) || (code >= 460 && code <= 469) || (code >= 1010 && code <= 1059)) {
    return FLOAT_VALUE.test(value);
  }
  if (
    (code >= 60 && code <= 99) ||
    (code >= 160 && code <= 179) ||
    (code >= 270 && code <= 299) ||
    (code >= 370 && code <= 389) ||
    (code >= 400 && code <= 409) ||
    (code >= 420 && code <= 429) ||
    (code >= 440 && code <= 459) ||
    (code >= 1060 && code <= 1071)
  ) {
    return INT_VALUE.test(value) || FLOAT_VALUE.test(value);
  }
  return true; // strings, handles
}

/**
 * Joins values broken over several lines. Lines are fed one at a time (without line ends); the
 * repaired lines go to `emit`. A line where a group code should be that is not an integer (or an
 * integer whose next line does not fit the code's value type) continues the previous value:
 * joined with "\P" (MTEXT paragraph break) for MTEXT text (codes 1 and 3), a space otherwise.
 */
export class DxfPairRepair {
  /** Lines joined onto a previous value. */
  repairs = 0;
  private entity = "";
  private code: string | null = null;
  private codeNum = 0;
  private value: string | null = null;
  private candidate: string | null = null;
  private readonly emit: (line: string) => void;

  constructor(emit: (line: string) => void) {
    this.emit = emit;
  }

  push(line: string): void {
    if (this.candidate !== null) {
      const cand = this.candidate;
      this.candidate = null;
      const n = Number.parseInt(cand, 10);
      if (valueFits(n, line)) {
        this.flushPair();
        this.code = cand;
        this.codeNum = n;
        this.value = line;
        if (n === 0) this.entity = line.trim();
        return;
      }
      this.join(cand);
      // `line` takes the code position again.
    }
    if (this.code === null || this.value !== null) {
      if (INT_LINE.test(line)) {
        const n = Number.parseInt(line, 10);
        if (n >= -5 && n <= 1071) {
          this.candidate = line;
          return;
        }
      }
      this.join(line);
      return;
    }
    this.value = line;
  }

  end(): void {
    if (this.candidate !== null) {
      this.join(this.candidate);
      this.candidate = null;
    }
    this.flushPair();
  }

  private join(piece: string): void {
    this.repairs++;
    if (this.code === null || this.value === null) return; // garbage before the first pair: dropped
    const sep = this.entity === "MTEXT" && (this.codeNum === 1 || this.codeNum === 3) ? "\\P" : " ";
    this.value += sep + piece;
  }

  private flushPair(): void {
    if (this.code !== null && this.value !== null) {
      this.emit(this.code);
      this.emit(this.value);
    }
    this.code = null;
    this.value = null;
  }
}

/** Repairs a DXF text in memory (tests and small files). */
export function repairDxfText(text: string): { text: string; repairs: number } {
  const out: string[] = [];
  const r = new DxfPairRepair((l) => out.push(l));
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  for (const l of lines) r.push(l);
  r.end();
  return { text: out.length ? `${out.join("\n")}\n` : "", repairs: r.repairs };
}

/**
 * Streams a DXF through the repair (latin1, so every byte is kept as is; 170 MB files take a few
 * seconds). Lines end with "\n" in the output. Binary DXF is copied unchanged.
 */
export async function repairDxfFile(inputPath: string, outputPath: string): Promise<{ repairs: number; bytes: number }> {
  const { createReadStream, createWriteStream } = await import("node:fs");
  const out = createWriteStream(outputPath, { encoding: "latin1" });
  let buffered: string[] = [];
  let bufferedLen = 0;
  let bytes = 0;
  const flushOut = async () => {
    if (!buffered.length) return;
    const s = buffered.join("");
    buffered = [];
    bufferedLen = 0;
    bytes += s.length;
    if (!out.write(s, "latin1")) await new Promise<void>((res) => out.once("drain", () => res()));
  };
  const repair = new DxfPairRepair((l) => {
    buffered.push(l, "\n");
    bufferedLen += l.length + 1;
  });
  let rest = "";
  let first = true;
  let binary = false;
  for await (const chunk of createReadStream(inputPath, { encoding: "latin1", highWaterMark: 1 << 20 }) as AsyncIterable<string>) {
    if (first) {
      first = false;
      binary = chunk.startsWith("AutoCAD Binary DXF");
    }
    if (binary) {
      buffered.push(chunk);
      bufferedLen += chunk.length;
    } else {
      let text = rest + chunk;
      // A "\r" at the end may be the first half of "\r\n": keep it for the next chunk.
      const cut = text.endsWith("\r") ? text.length - 1 : text.length;
      const lines = text.slice(0, cut).split(/\r\n|\r|\n/);
      rest = lines.pop()! + text.slice(cut);
      text = "";
      for (const l of lines) repair.push(l);
    }
    if (bufferedLen > 1 << 20) await flushOut();
  }
  if (!binary) {
    const tail = rest.replace(/\r$/, "");
    if (tail) repair.push(tail);
    repair.end();
  }
  await flushOut();
  await new Promise<void>((res, rej) => out.end((err?: Error | null) => (err ? rej(err) : res())));
  return { repairs: binary ? 0 : repair.repairs, bytes };
}

// ---------------------------------------------------------------------------------------------

interface Input {
  task: "sheet" | "dxf";
  inputPath: string;
  extension?: string;
  /** sheet: gzip JSON output; dxf: where the repaired DXF goes when the drawing needs repairs (see repairDxfFile). */
  outputPath?: string;
}

async function runTask(input: Input): Promise<unknown> {
  if (input.task === "sheet") {
    const r = parseSheet(readFileSync(input.inputPath), input.extension ?? "xlsx");
    writeFileSync(input.outputPath!, gzipSync(Buffer.from(JSON.stringify(r.data))));
    return { sheets: r.data.sheets.map((s) => s.name), truncated: r.data.truncated, text: r.text, textTruncated: r.textTruncated };
  }
  // Fast path: a drawing whose code lines are all integers is used as it is (no rewrite).
  const first = dxfInfo(readFileSync(input.inputPath));
  if (!input.outputPath || !first.brokenLines) return { ...first, repairs: 0, repaired: false };
  const { repairs } = await repairDxfFile(input.inputPath, input.outputPath);
  return { ...dxfInfo(readFileSync(input.outputPath)), repairs, repaired: true };
}

if (parentPort && workerData && (workerData as Input).task) {
  const port = parentPort;
  runTask(workerData as Input).then(
    (result) => port.postMessage({ type: "done", result }),
    (err: unknown) => port.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) }),
  );
}
