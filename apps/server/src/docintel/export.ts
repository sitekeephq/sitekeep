/**
 * Register export: CSV (UTF-8 with BOM, ";" separated, opens directly in Turkish Excel) and a
 * minimal XLSX (one sheet, inline strings) written with yazl, so no spreadsheet library is needed.
 */
import { Readable } from "node:stream";
import { ZipFile } from "yazl";
import { submittalDisciplineLabel, submittalTypeLabel, type SubmittalRegisterItem } from "@sitekeep/shared";
import type { tFor } from "../i18n/index.js";

type T = ReturnType<typeof tFor>;

/** Column headers of the register export, in the reader's language. */
export function registerColumns(t: T): string[] {
  return [
    t("docintel:columns.no"),
    t("docintel:columns.sectionCode"),
    t("docintel:columns.sectionTitle"),
    t("docintel:columns.page"),
    t("docintel:columns.type"),
    t("docintel:columns.typeName"),
    t("docintel:columns.discipline"),
    t("docintel:columns.description"),
    t("docintel:columns.excerpt"),
    t("docintel:columns.confidence"),
    t("docintel:columns.keywords"),
  ];
}

export function registerRows(items: SubmittalRegisterItem[], t: T, lang: string): (string | number)[][] {
  // The label helpers return the code itself for an unknown code.
  const known = (code: string, label: string) => (label === code ? null : label);
  return items
    .filter((i) => !i.excluded)
    .map((i) => [
      i.id,
      i.sectionCode ?? "",
      i.sectionTitle ?? "",
      i.page ?? "",
      i.type ?? "",
      i.type ? (known(i.type, submittalTypeLabel(i.type, lang)) ?? "") : t("docintel:columns.untyped"),
      i.discipline ? `${i.discipline} ${known(i.discipline, submittalDisciplineLabel(i.discipline, lang)) ?? ""}`.trim() : "",
      i.description,
      i.excerpt,
      Math.round(i.typeConfidence * 100) / 100,
      i.keywords.join(", "),
    ]);
}

export function toCsv(header: string[], rows: (string | number)[][]): string {
  const cell = (v: string | number) => {
    const s = String(v);
    // Leading = + - @ would be read as a formula by spreadsheet programs.
    const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
    return /[";\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return "﻿" + [header, ...rows].map((r) => r.map(cell).join(";")).join("\r\n") + "\r\n";
}

function xml(s: string): string {
  return s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function colName(i: number): string {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** Single-sheet XLSX workbook. */
export async function toXlsx(sheetName: string, header: string[], rows: (string | number)[][]): Promise<Buffer> {
  const all = [header, ...rows];
  const sheetRows = all
    .map((r, ri) => {
      const cells = r
        .map((v, ci) => {
          const ref = `${colName(ci)}${ri + 1}`;
          const style = ri === 0 ? ' s="1"' : "";
          if (typeof v === "number") return `<c r="${ref}"${style}><v>${v}</v></c>`;
          return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${xml(v)}</t></is></c>`;
        })
        .join("");
      return `<row r="${ri + 1}">${cells}</row>`;
    })
    .join("");
  const widths = [8, 14, 30, 7, 7, 24, 18, 40, 80, 7, 30];
  const cols = header.map((_, i) => `<col min="${i + 1}" max="${i + 1}" width="${widths[i] ?? 15}" customWidth="1"/>`).join("");
  const files: Record<string, string> = {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xml(sheetName.slice(0, 31))}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    "xl/styles.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf/><xf fontId="1" applyFont="1"/></cellXfs></styleSheet>`,
    "xl/worksheets/sheet1.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${cols}</cols><sheetData>${sheetRows}</sheetData><autoFilter ref="A1:${colName(header.length - 1)}${all.length}"/></worksheet>`,
  };
  const zip = new ZipFile();
  for (const [name, content] of Object.entries(files)) zip.addBuffer(Buffer.from(content, "utf8"), name);
  zip.end();
  const chunks: Buffer[] = [];
  for await (const c of zip.outputStream as unknown as Readable) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}
