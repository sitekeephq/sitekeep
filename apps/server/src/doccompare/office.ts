/**
 * Readers for the non-PDF comparisons, without new dependencies (the zip reader of core/formats/xlsx.ts):
 *   XLSX  every worksheet as rows of strings (shared / inline strings, cached formula values)
 *   CSV   delimiter detected (; , tab), quoted fields
 *   DOCX  paragraphs of word/document.xml (tables give one paragraph per cell)
 *   text  lines
 */
import { DEFAULT_LANGUAGE, msg, render } from "../i18n/index.js";
import { unzipEntries } from "../core/formats/xlsx.js";
import type { TextUnit } from "./text-diff.js";

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

const MAX_ROWS = 50_000;

/** Every worksheet in workbook order. */
export function readWorkbook(buf: Buffer): { name: string; rows: string[][] }[] {
  const files = unzipEntries(buf, 200 * 1024 * 1024);
  const shared = files.get("xl/sharedStrings.xml")?.toString("utf8") ?? "";
  const strings = [...shared.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]!));
  const workbook = files.get("xl/workbook.xml")?.toString("utf8") ?? "";
  const rels = files.get("xl/_rels/workbook.xml.rels")?.toString("utf8") ?? "";
  const target = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = /\bId="([^"]+)"/.exec(m[1]!)?.[1];
    const t = /\bTarget="([^"]+)"/.exec(m[1]!)?.[1];
    if (id && t) target.set(id, t.replace(/^\/?xl\//, "").replace(/^\//, ""));
  }
  const sheets: { name: string; path: string }[] = [];
  for (const m of workbook.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const name = unesc(/\bname="([^"]*)"/.exec(m[1]!)?.[1] ?? `Sayfa${sheets.length + 1}`); // i18n-ok: fallback sheet name, matched between versions
    const rid = /\br:id="([^"]+)"/.exec(m[1]!)?.[1];
    const t = rid ? target.get(rid) : undefined;
    if (t) sheets.push({ name, path: `xl/${t}` });
  }
  if (!sheets.length) {
    // No workbook part: take the worksheet files in number order.
    const paths = [...files.keys()].filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k));
    paths.sort((x, y) => Number(/\d+/.exec(x)![0]) - Number(/\d+/.exec(y)![0]));
    paths.forEach((p, i) => sheets.push({ name: `Sayfa${i + 1}`, path: p })); // i18n-ok: fallback sheet name, matched between versions
  }
  if (!sheets.length) throw new Error(render(DEFAULT_LANGUAGE, msg("doccompare:errors.xlsxNoSheets")));
  return sheets.map((s) => ({ name: s.name, rows: sheetRows(files.get(s.path)?.toString("utf8") ?? "", strings) }));
}

function sheetRows(xml: string, strings: string[]): string[][] {
  const rows: string[][] = [];
  for (const rm of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const rAttr = /\br="(\d+)"/.exec(rm[1]!)?.[1];
    const rowIndex = rAttr ? Number(rAttr) - 1 : rows.length;
    if (rowIndex >= MAX_ROWS) break;
    while (rows.length < rowIndex) rows.push([]);
    const row: string[] = [];
    for (const cm of rm[2]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
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
    rows[rowIndex] = row;
  }
  return rows;
}

/** CSV / TSV rows; the delimiter is the most frequent of ; , tab on the first line. */
export function readCsv(text: string): string[][] {
  const body = text.replace(/^﻿/, "");
  const first = body.split(/\r?\n/, 1)[0] ?? "";
  const counts: [string, number][] = [";", ",", "\t"].map((d) => [d, first.split(d).length - 1]);
  counts.sort((x, y) => y[1] - x[1]);
  const delim = counts[0]![1] > 0 ? counts[0]![0] : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (quoted) {
      if (ch === '"') {
        if (body[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && !cell) quoted = true;
    else if (ch === delim) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && body[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      if (rows.length >= MAX_ROWS) break;
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** Paragraphs of a DOCX (body text, tables cell by cell), empty paragraphs dropped. */
export function docxUnits(buf: Buffer): TextUnit[] {
  const files = unzipEntries(buf, 200 * 1024 * 1024);
  const xml = files.get("word/document.xml")?.toString("utf8");
  if (xml === undefined) throw new Error(render(DEFAULT_LANGUAGE, msg("doccompare:errors.docxInvalid")));
  const out: TextUnit[] = [];
  for (const m of xml.matchAll(/<w:p\b[^>]*?(?:\/>|>([\s\S]*?)<\/w:p>)/g)) {
    const inner = (m[1] ?? "").replace(/<w:tab\/>/g, "<w:t>\t</w:t>").replace(/<w:br\/>/g, "<w:t> </w:t>");
    const text = [...inner.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)]
      .map((x) => unesc(x[1]!))
      .join("")
      .replace(/\s+/g, " ")
      .trim();
    if (text) out.push({ text, page: 1 });
  }
  return out;
}

/** Non-empty lines of a text file. */
export function textUnits(text: string): TextUnit[] {
  return text
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l.trim())
    .map((l) => ({ text: l.trim(), page: 1 }));
}
