/**
 * Minimal XLSX writer and reader for registers (submittal register, RFI log, spec register
 * import). Why not exceljs: it adds ~20 MB of dependencies for what is a single sheet of strings
 * and numbers here; yazl (already a dependency) writes the zip and node:zlib reads it.
 *
 * Writer: one or more sheets, inline strings, numbers, a bold header row, frozen header,
 * column widths and an auto filter. Reader: the first worksheet as a string table (shared and
 * inline strings, numbers; formulas give their cached value).
 */
import { inflateRawSync } from "node:zlib";
import { ZipFile } from "yazl";
import { DEFAULT_LANGUAGE, tFor } from "../../i18n/index.js";

export type Cell = string | number | null | undefined;

export interface Sheet {
  name: string;
  columns: { title: string; width?: number }[];
  rows: Cell[][];
}

const esc = (s: string) =>
  s
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

function colName(i: number): string {
  let s = "";
  let n = i + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function cellXml(ref: string, v: Cell, style: number): string {
  if (v === null || v === undefined || v === "") return "";
  if (typeof v === "number" && Number.isFinite(v)) return `<c r="${ref}" s="${style}"><v>${v}</v></c>`;
  return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${esc(String(v))}</t></is></c>`;
}

function sheetXml(s: Sheet): string {
  const cols = s.columns.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width ?? 18}" customWidth="1"/>`).join("");
  const header = `<row r="1">${s.columns.map((c, i) => cellXml(`${colName(i)}1`, c.title, 1)).join("")}</row>`;
  const body = s.rows
    .map((r, ri) => `<row r="${ri + 2}">${r.map((v, ci) => cellXml(`${colName(ci)}${ri + 2}`, v, 2)).join("")}</row>`)
    .join("");
  const last = `${colName(Math.max(s.columns.length - 1, 0))}${s.rows.length + 1}`;
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` +
    `<cols>${cols}</cols><sheetData>${header}${body}</sheetData>` +
    `<autoFilter ref="A1:${last}"/></worksheet>`
  );
}

/** Builds an .xlsx file. */
export async function writeXlsx(sheets: Sheet[]): Promise<Buffer> {
  const zip = new ZipFile();
  const add = (name: string, xml: string) => zip.addBuffer(Buffer.from(xml, "utf8"), name);
  const names = sheets.map((s, i) => esc((s.name || `Sayfa${i + 1}`).replace(/[\\/?*[\]:]/g, " ").slice(0, 31)));
  add(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
      `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
      sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("") +
      `</Types>`,
  );
  add(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  );
  add(
    "xl/workbook.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>` +
      names.map((n, i) => `<sheet name="${n}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") +
      `</sheets>` +
      `</workbook>`,
  );
  add(
    "xl/_rels/workbook.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("") +
      `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
  );
  add(
    "xl/styles.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
      `<fonts count="2"><font><sz val="10"/><name val="Arial"/></font><font><b/><sz val="10"/><name val="Arial"/></font></fonts>` +
      `<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE8EEF4"/><bgColor indexed="64"/></patternFill></fill></fills>` +
      `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
      `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
      `<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
      `<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>` +
      `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf></cellXfs>` +
      `</styleSheet>`,
  );
  sheets.forEach((s, i) => add(`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s)));
  zip.end();
  const chunks: Buffer[] = [];
  for await (const c of zip.outputStream) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

// ---- Reader -------------------------------------------------------------------------------------

/** Entries of a zip file (stored or deflated), read through the central directory. */
export function unzipEntries(buf: Buffer, limit = 50 * 1024 * 1024, lang: string = DEFAULT_LANGUAGE): Map<string, Buffer> {
  const t = tFor(lang);
  const out = new Map<string, Buffer>();
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--)
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) throw new Error(t("works:errors.xlsxNotZip"));
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(t("works:errors.zipCorrupt"));
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString("utf8");
    p += 46 + nlen + elen + clen;
    total += usize;
    if (total > limit) throw new Error(t("works:errors.xlsxTooLarge"));
    const lnlen = buf.readUInt16LE(local + 26);
    const lelen = buf.readUInt16LE(local + 28);
    const start = local + 30 + lnlen + lelen;
    const data = buf.subarray(start, start + csize);
    if (method === 0) out.set(name, Buffer.from(data));
    else if (method === 8) out.set(name, inflateRawSync(data));
  }
  return out;
}

const unesc = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&");

function textOf(xml: string): string {
  return [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => unesc(m[1]!)).join("");
}

function colIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? "A";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** First worksheet as rows of strings. */
export function readXlsx(buf: Buffer, lang: string = DEFAULT_LANGUAGE): string[][] {
  const files = unzipEntries(buf, undefined, lang);
  const shared = files.get("xl/sharedStrings.xml")?.toString("utf8") ?? "";
  const strings = [...shared.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]!));
  const sheetName =
    [...files.keys()].filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort((a, b) => Number(/\d+/.exec(a)![0]) - Number(/\d+/.exec(b)![0]))[0];
  if (!sheetName) throw new Error(tFor(lang)("works:errors.xlsxNoSheet"));
  const xml = files.get(sheetName)!.toString("utf8");
  const rows: string[][] = [];
  for (const rm of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row: string[] = [];
    for (const cm of rm[1]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1]!;
      const inner = cm[2] ?? "";
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
      const t = /\bt="([^"]+)"/.exec(attrs)?.[1];
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      let value = "";
      if (t === "s") value = strings[Number(v)] ?? "";
      else if (t === "inlineStr") value = textOf(inner);
      else if (v !== undefined) value = unesc(v);
      const idx = ref ? colIndex(ref) : row.length;
      while (row.length < idx) row.push("");
      row[idx] = value;
    }
    rows.push(row);
  }
  return rows;
}
