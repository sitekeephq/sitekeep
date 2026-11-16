/** Sheet list export ("pafta listesi"): CSV (Turkish Excel friendly) or XLSX. */
import type { FastifyReply } from "fastify";
import type { CdeState } from "@sitekeep/shared";
import { writeXlsx } from "../core/formats/xlsx.js";
import { badRequest } from "../core/platform/http.js";
import { toCsv } from "../docintel/export.js";
import { msg, type tFor } from "../i18n/index.js";

type T = ReturnType<typeof tFor>;

export interface SheetListRow {
  number: string;
  title: string | null;
  discipline: string | null;
  revision: string | null;
  suitability: string | null;
  date: string | null;
  state: CdeState | null;
  cdeStatus: string | null;
  fileName: string;
  page: number;
}

const WIDTHS = [6, 22, 44, 14, 10, 12, 12, 16, 40, 7];

export function sheetListColumns(t: T): string[] {
  return [
    t("sheets:columns.no"),
    t("sheets:columns.number"),
    t("sheets:columns.title"),
    t("sheets:columns.discipline"),
    t("sheets:columns.revision"),
    t("sheets:columns.suitability"),
    t("sheets:columns.date"),
    t("sheets:columns.status"),
    t("sheets:columns.file"),
    t("sheets:columns.page"),
  ];
}

/** Status column: the folder state, with the document's flag (superseded, withdrawn …) when it has one. */
function status(r: SheetListRow, t: T): string {
  const state = r.state ? t(`sheets:states.${r.state}`) : "";
  const flag = r.cdeStatus ? t(`sheets:flags.${r.cdeStatus as "returned" | "superseded" | "withdrawn"}`) : "";
  return [state, flag].filter(Boolean).join(" · ");
}

export function sheetListRows(list: SheetListRow[], t: T): (string | number)[][] {
  return list.map((r, i) => [
    i + 1,
    r.number,
    r.title ?? "",
    r.discipline ?? "",
    r.revision ?? "",
    r.suitability ?? "",
    r.date ?? "",
    status(r, t),
    r.fileName,
    r.page,
  ]);
}

export async function sendSheetList(
  reply: FastifyReply,
  format: string,
  baseName: string,
  sheetName: string,
  columns: string[],
  rows: (string | number)[][],
) {
  const safe = baseName.replace(/[\\/:*?"<>|]/g, "_");
  const disposition = (name: string) =>
    `attachment; filename="${name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "")}"; filename*=UTF-8''${encodeURIComponent(name)}`;
  if (format === "csv") {
    reply.header("Content-Type", "text/csv; charset=utf-8");
    reply.header("Content-Disposition", disposition(`${safe}.csv`));
    return reply.send(toCsv(columns, rows));
  }
  if (format === "xlsx") {
    const buf = await writeXlsx([{ name: sheetName, columns: columns.map((title, i) => ({ title, width: WIDTHS[i] })), rows }]);
    reply.header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    reply.header("Content-Disposition", disposition(`${safe}.xlsx`));
    return reply.send(buf);
  }
  throw badRequest(msg("sheets:errors.badFormat"));
}
