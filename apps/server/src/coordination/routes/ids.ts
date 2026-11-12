/**
 * IDS checks: an .ids file uploaded into the project (a normal file) is run against an IFC
 * version (job kind "ids_check"); the report is stored, listed and exported as CSV.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { splitExtension, type IdsReportDto } from "@sitekeep/shared";
import type { AppDeps } from "../../app/deps.js";
import { FolderTree, isUuid, projectAccess, userNames, type AuthUser } from "../../core/security/access.js";
import { audit } from "../../core/platform/audit.js";
import type { Db } from "../../db/index.js";
import { fileVersions, files, idsReports } from "../../db/schema.js";
import { badRequest, notFound } from "../../core/platform/http.js";
import { requireModule } from "../../projects/modules.js";
import { loadVersion, requireView } from "../../modules/documents/files.js";
import { msg, tReq } from "../../i18n/index.js";

type ReportRow = typeof idsReports.$inferSelect;

export async function idsRoutes(api: FastifyInstance, { db, jobs }: AppDeps) {
  api.get<{ Params: { pid: string } }>("/projects/:pid/ids-reports", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const tree = await FolderTree.load(db, a.project.id);
    const rows = await db.select().from(idsReports).where(eq(idsReports.projectId, a.project.id)).orderBy(desc(idsReports.createdAt)).limit(200);
    const info = await versionInfo(db, rows.flatMap((r) => [r.idsVersionId, r.ifcVersionId]));
    const names = await userNames(db, rows.map((r) => r.createdBy));
    return rows
      .filter((r) => [r.idsVersionId, r.ifcVersionId].every((v) => visible(tree, a, info.get(v)?.file)))
      .map((r) => ({ ...toDto(r, info, names), specs: [] }));
  });

  api.post<{ Params: { pid: string } }>("/projects/:pid/ids-reports", async (req) => {
    const body = z.object({ idsVersionId: z.string().uuid(), ifcVersionId: z.string().uuid() }).parse(req.body);
    const ids = await loadVersion(db, req.params.pid, body.idsVersionId, req.user!);
    requireModule(ids.a, "coordination");
    requireView(ids.tree, ids.a, ids.file);
    const ifc = await loadVersion(db, req.params.pid, body.ifcVersionId, req.user!);
    requireView(ifc.tree, ifc.a, ifc.file);
    const ext = (n: string) => splitExtension(n).extension.toLowerCase();
    if (!["ids", "xml"].includes(ext(ids.file.name))) throw badRequest(msg("coordination:errors.notIdsFile", { name: ids.file.name }));
    if (ext(ifc.file.name) !== "ifc") throw badRequest(msg("coordination:errors.notIfcFile", { name: ifc.file.name }));
    const [row] = await db
      .insert(idsReports)
      .values({ projectId: ids.a.project.id, idsVersionId: body.idsVersionId, ifcVersionId: body.ifcVersionId, createdBy: ids.a.user.id })
      .returning();
    await jobs.enqueue("ids_check", { reportId: row!.id });
    await audit(db, {
      projectId: ids.a.project.id,
      userId: ids.a.user.id,
      action: "ids.check",
      targetType: "file",
      targetId: ifc.file.id,
      details: { reportId: row!.id, ids: ids.file.name, ifc: ifc.file.name, version: ifc.version.version },
    });
    const info = await versionInfo(db, [row!.idsVersionId, row!.ifcVersionId]);
    return toDto(row!, info, new Map([[ids.a.user.id, ids.a.user.name]]));
  });

  api.get<{ Params: { pid: string; rid: string } }>("/projects/:pid/ids-reports/:rid", async (req) => {
    const { row, info, names } = await loadReport(db, req.params.pid, req.params.rid, req.user!);
    return toDto(row, info, names);
  });

  api.get<{ Params: { pid: string; rid: string } }>("/projects/:pid/ids-reports/:rid/csv", async (req, reply) => {
    const { row, info } = await loadReport(db, req.params.pid, req.params.rid, req.user!);
    const t = tReq(req);
    const lines = [
      [
        t("coordination:csv.specification"),
        t("coordination:csv.status"),
        t("coordination:csv.applicable"),
        t("coordination:csv.passed"),
        t("coordination:csv.failed"),
        t("coordination:csv.globalId"),
        t("coordination:csv.class"),
        t("coordination:csv.name"),
        t("coordination:csv.reason"),
      ],
    ];
    const statusTr = { pass: t("coordination:csv.statusPass"), fail: t("coordination:csv.statusFail"), skipped: t("coordination:csv.statusSkipped") } as const;
    for (const s of row.specs) {
      const base = [s.name, statusTr[s.status], String(s.applicable), String(s.passed), String(s.failed)];
      if (!s.failures.length) lines.push([...base, "", "", "", s.note ?? ""]);
      for (const f of s.failures) lines.push([...base, f.globalId, f.ifcClass, f.name ?? "", f.reasons.join("; ")]);
    }
    const csv = "﻿" + lines.map((l) => l.map(csvCell).join(";")).join("\r\n") + "\r\n";
    const ifcName = info.get(row.ifcVersionId)?.file.name ?? "model";
    const name = `IDS-${splitExtension(ifcName).base}.csv`;
    reply.header("Content-Type", "text/csv; charset=utf-8");
    reply.header("Content-Disposition", `attachment; filename="${name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "")}"; filename*=UTF-8''${encodeURIComponent(name)}`);
    return reply.send(csv);
  });

  api.delete<{ Params: { pid: string; rid: string } }>("/projects/:pid/ids-reports/:rid", async (req) => {
    const { row, a } = await loadReport(db, req.params.pid, req.params.rid, req.user!);
    if (!a.isProjectAdmin && row.createdBy !== a.user.id) throw notFound(msg("coordination:entities.idsReport"));
    await db.delete(idsReports).where(eq(idsReports.id, row.id));
    return { ok: true };
  });
}

function csvCell(v: string): string {
  return /[";\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

type FileRow = typeof files.$inferSelect;

function visible(tree: FolderTree, a: Awaited<ReturnType<typeof projectAccess>>, file: FileRow | undefined): boolean {
  if (!file || file.deletedAt || !tree.byId.has(file.folderId)) return false;
  try {
    requireView(tree, a, file);
    return true;
  } catch {
    return false;
  }
}

async function versionInfo(db: Db, ids: string[]) {
  const unique = [...new Set(ids)];
  const rows = unique.length
    ? await db.select().from(fileVersions).innerJoin(files, eq(files.id, fileVersions.fileId)).where(inArray(fileVersions.id, unique))
    : [];
  return new Map(rows.map((r) => [r.file_versions.id, { version: r.file_versions, file: r.files }]));
}

async function loadReport(db: Db, pid: string, rid: string, user: AuthUser) {
  const a = await projectAccess(db, pid, user);
  if (!isUuid(rid)) throw notFound(msg("coordination:entities.idsReport"));
  const [row] = await db.select().from(idsReports).where(and(eq(idsReports.id, rid), eq(idsReports.projectId, a.project.id)));
  if (!row) throw notFound(msg("coordination:entities.idsReport"));
  const tree = await FolderTree.load(db, a.project.id);
  const info = await versionInfo(db, [row.idsVersionId, row.ifcVersionId]);
  if (![row.idsVersionId, row.ifcVersionId].every((v) => visible(tree, a, info.get(v)?.file))) throw notFound(msg("coordination:entities.idsReport"));
  return { row, info, a, names: await userNames(db, [row.createdBy]) };
}

function toDto(r: ReportRow, info: Awaited<ReturnType<typeof versionInfo>>, names: Map<string, string>): IdsReportDto {
  const ifc = info.get(r.ifcVersionId);
  return {
    id: r.id,
    projectId: r.projectId,
    idsVersionId: r.idsVersionId,
    ifcVersionId: r.ifcVersionId,
    idsFileName: info.get(r.idsVersionId)?.file.name ?? null,
    ifcFileName: ifc?.file.name ?? null,
    ifcVersion: ifc?.version.version ?? null,
    status: r.status,
    error: r.error,
    title: r.title,
    specs: r.specs,
    totals: r.totals ?? null,
    createdBy: r.createdBy,
    createdByName: r.createdBy ? names.get(r.createdBy) : undefined,
    createdAt: r.createdAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null,
  };
}
