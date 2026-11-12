/**
 * Location tree (stations, zones, floors, rooms, tunnel sections with km chainage), CSV and IFC
 * import, and location links for issues, forms and files.
 */
import { and, asc, eq, inArray, max } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  LOCATION_LINK_KINDS,
  can,
  foldTr,
  parseChainage,
  splitExtension,
  type LocationLinkDto,
  type LocationLinkKind,
} from "@sitekeep/shared";
import type { AppDeps } from "../app/deps.js";
import { FolderTree, isUuid, projectAccess, requireProjectAdmin, type ProjectAccess } from "../core/security/access.js";
import { audit } from "../core/platform/audit.js";
import type { Db } from "../db/index.js";
import { files, issues, jobs, locationLinks, locations } from "../db/schema.js";
import { capability } from "../sdk/capabilities.js";
import { badRequest, conflict, forbidden, notFound } from "../core/platform/http.js";
import { DEFAULT_LANGUAGE, msg, requestLanguage, tFor } from "../i18n/index.js";
import { IFC_LOCATIONS_JOB, registerLocationJobs, type IfcLocationsPayload } from "../jobs/ifc-spatial.js";
import { loadVersion, requireView } from "../modules/documents/public.js";
import { loadLocations, requireLocation, setLocationLink, subtreeIds, toLocationDto } from "./location-links.js";

const chainage = z
  .union([z.number(), z.string()])
  .nullable()
  .optional()
  .transform((v, ctx) => {
    if (v === undefined) return undefined;
    try {
      return parseChainage(v, DEFAULT_LANGUAGE);
    } catch (e) {
      ctx.addIssue({ code: "custom", message: (e as Error).message });
      return z.NEVER;
    }
  });

const fields = {
  parentId: z.string().uuid().nullable().optional(),
  name: z.string().trim().min(1).max(200),
  code: z
    .string()
    .trim()
    .max(40)
    .nullable()
    .optional()
    .transform((v) => (v === undefined ? undefined : v || null)),
  type: z
    .string()
    .trim()
    .max(60)
    .nullable()
    .optional()
    .transform((v) => (v === undefined ? undefined : v || null)),
  kmStart: chainage,
  kmEnd: chainage,
  sortOrder: z.number().int().min(-1_000_000_000).max(1_000_000_000).optional(),
  ifcFileVersionId: z.string().uuid().nullable().optional(),
  ifcGlobalId: z.string().trim().max(64).nullable().optional(),
};

function checkKm(kmStart: number | null | undefined, kmEnd: number | null | undefined) {
  if (kmStart != null && kmEnd != null && kmStart > kmEnd) throw badRequest(msg("locations:errors.kmStartAfterEnd"));
}

export async function locationRoutes(api: FastifyInstance, { db, storage, jobs: queue }: AppDeps) {
  registerLocationJobs(db, storage, queue);
  api.get<{ Params: { pid: string } }>("/projects/:pid/locations", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    return (await loadLocations(db, a.project.id)).map(toLocationDto);
  });

  api.post<{ Params: { pid: string } }>("/projects/:pid/locations", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    requireProjectAdmin(a);
    const body = z.object(fields).parse(req.body);
    if (body.parentId) await requireLocation(db, a.project.id, body.parentId);
    checkKm(body.kmStart, body.kmEnd);
    if (body.ifcFileVersionId) await loadVersion(db, a.project.id, body.ifcFileVersionId, req.user!);
    const [m] = await db.select({ n: max(locations.sortOrder) }).from(locations).where(eq(locations.projectId, a.project.id));
    const [row] = await db
      .insert(locations)
      .values({
        projectId: a.project.id,
        parentId: body.parentId ?? null,
        name: body.name,
        code: body.code ?? null,
        type: body.type ?? null,
        kmStart: body.kmStart ?? null,
        kmEnd: body.kmEnd ?? null,
        sortOrder: body.sortOrder ?? (m?.n ?? 0) + 1,
        ifcFileVersionId: body.ifcFileVersionId ?? null,
        ifcGlobalId: body.ifcGlobalId ?? null,
        createdBy: a.user.id,
      })
      .returning();
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "location.created",
      targetType: "location",
      targetId: row!.id,
      details: { name: row!.name, code: row!.code },
    });
    return toLocationDto(row!);
  });

  api.patch<{ Params: { pid: string; lid: string } }>("/projects/:pid/locations/:lid", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    requireProjectAdmin(a);
    const row = await requireLocation(db, a.project.id, req.params.lid);
    const body = z.object({ ...fields, name: fields.name.optional() }).parse(req.body);
    if (body.parentId) {
      const all = await loadLocations(db, a.project.id);
      if (subtreeIds(all, row.id).includes(body.parentId)) throw badRequest(msg("locations:errors.moveUnderItself"));
      await requireLocation(db, a.project.id, body.parentId);
    }
    checkKm(body.kmStart === undefined ? row.kmStart : body.kmStart, body.kmEnd === undefined ? row.kmEnd : body.kmEnd);
    if (body.ifcFileVersionId) await loadVersion(db, a.project.id, body.ifcFileVersionId, req.user!);
    const patch = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
    const [updated] = await db
      .update(locations)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(locations.id, row.id))
      .returning();
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "location.updated",
      targetType: "location",
      targetId: row.id,
      details: { name: row.name, ...patch },
    });
    return toLocationDto(updated!);
  });

  /** Deletes the node and its subtree; linked nodes need ?force=1 (their links are removed). */
  api.delete<{ Params: { pid: string; lid: string }; Querystring: { force?: string } }>(
    "/projects/:pid/locations/:lid",
    async (req) => {
      const a = await projectAccess(db, req.params.pid, req.user!);
      requireProjectAdmin(a);
      const row = await requireLocation(db, a.project.id, req.params.lid);
      const ids = subtreeIds(await loadLocations(db, a.project.id), row.id);
      const links = await db.select().from(locationLinks).where(inArray(locationLinks.locationId, ids));
      if (links.length && req.query.force !== "1")
        throw conflict(msg("locations:errors.linkedRecords", { count: links.length }), {
          links: links.length,
          nodes: ids.length,
        });
      await db.delete(locations).where(inArray(locations.id, ids));
      await audit(db, {
        projectId: a.project.id,
        userId: a.user.id,
        action: "location.deleted",
        targetType: "location",
        targetId: row.id,
        details: { name: row.name, nodes: ids.length, links: links.length },
      });
      return { ok: true, nodes: ids.length, links: links.length };
    },
  );

  // ---- CSV import -----------------------------------------------------------------------------

  /**
   * CSV with a header row; columns (Turkish or English, any order): kod/code, ad/name,
   * tip/type, üst kod/parent, km başlangıç/km_start, km bitiş/km_end, sıra/order.
   * Rows are matched by code (update) or created. All-or-nothing: any error aborts the import.
   */
  api.post<{ Params: { pid: string } }>("/projects/:pid/locations/import-csv", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    requireProjectAdmin(a);
    const body = z.object({ csv: z.string().min(1).max(5_000_000), parentId: z.string().uuid().nullable().optional() }).parse(req.body);
    if (body.parentId) await requireLocation(db, a.project.id, body.parentId);
    const lang = requestLanguage(req);
    const t = tFor(lang);
    const parsed = parseLocationCsv(body.csv, lang);
    if (parsed.errors.length) throw badRequest(msg("locations:errors.csvErrors", { count: parsed.errors.length }), parsed.errors);

    const existing = await loadLocations(db, a.project.id);
    const byCode = new Map(existing.filter((l) => l.code).map((l) => [l.code!, l]));
    const csvCodes = new Set(parsed.rows.map((r) => r.code).filter(Boolean));
    const errors: { line: number; message: string }[] = [];
    for (const r of parsed.rows) {
      if (r.parentCode && !csvCodes.has(r.parentCode) && !byCode.has(r.parentCode))
        errors.push({ line: r.line, message: t("locations:csv.parentNotFound", { code: r.parentCode }) });
      if (r.parentCode && r.parentCode === r.code) errors.push({ line: r.line, message: t("locations:csv.ownParent") });
    }
    // Parent cycles inside the file.
    const parentOf = new Map(parsed.rows.filter((r) => r.code).map((r) => [r.code!, r.parentCode]));
    for (const r of parsed.rows) {
      if (!r.code) continue;
      const seen = new Set<string>([r.code]);
      let p = parentOf.get(r.code);
      while (p && parentOf.has(p)) {
        if (seen.has(p)) {
          errors.push({ line: r.line, message: t("locations:csv.parentCycle", { code: r.code }) });
          break;
        }
        seen.add(p);
        p = parentOf.get(p);
      }
    }
    if (errors.length) throw badRequest(msg("locations:errors.csvErrors", { count: errors.length }), errors);

    let created = 0;
    let updated = 0;
    await db.transaction(async (tx) => {
      const [m] = await tx.select({ n: max(locations.sortOrder) }).from(locations).where(eq(locations.projectId, a.project.id));
      let order = (m?.n ?? 0) + 1;
      const idByCode = new Map([...byCode.entries()].map(([c, l]) => [c, l.id]));
      // Parents first: repeat passes until every row is placed.
      const pending = [...parsed.rows];
      while (pending.length) {
        const before = pending.length;
        for (let i = 0; i < pending.length; i++) {
          const r = pending[i]!;
          const parentReady = !r.parentCode || idByCode.has(r.parentCode) && !pending.some((x) => x !== r && x.code === r.parentCode);
          if (!parentReady) continue;
          const parentId = r.parentCode ? idByCode.get(r.parentCode)! : (body.parentId ?? null);
          const values = {
            name: r.name,
            type: r.type,
            kmStart: r.kmStart,
            kmEnd: r.kmEnd,
            parentId,
            ...(r.sortOrder !== null ? { sortOrder: r.sortOrder } : {}),
          };
          const old = r.code ? byCode.get(r.code) : undefined;
          if (old) {
            await tx.update(locations).set({ ...values, updatedAt: new Date() }).where(eq(locations.id, old.id));
            updated++;
          } else {
            const [ins] = await tx
              .insert(locations)
              .values({ projectId: a.project.id, code: r.code, sortOrder: order++, ...values, createdBy: a.user.id })
              .returning({ id: locations.id });
            if (r.code) idByCode.set(r.code, ins!.id);
            created++;
          }
          pending.splice(i, 1);
          i--;
        }
        if (pending.length === before) throw badRequest(msg("locations:errors.parentCodesUnresolved"));
      }
    });
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "location.imported_csv",
      targetType: "project",
      targetId: a.project.id,
      details: { created, updated },
    });
    return { created, updated, total: parsed.rows.length };
  });

  // ---- IFC import -----------------------------------------------------------------------------

  api.post<{ Params: { pid: string } }>("/projects/:pid/locations/import-ifc", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    requireProjectAdmin(a);
    const body = z.object({ fileVersionId: z.string().uuid(), parentId: z.string().uuid().nullable().optional() }).parse(req.body);
    const { file, tree } = await loadVersion(db, a.project.id, body.fileVersionId, req.user!);
    requireView(tree, a, file);
    if (splitExtension(file.name).extension.toLowerCase() !== "ifc") throw badRequest(msg("locations:errors.ifcOnly"));
    if (body.parentId) await requireLocation(db, a.project.id, body.parentId);
    const payload: IfcLocationsPayload = {
      projectId: a.project.id,
      versionId: body.fileVersionId,
      parentId: body.parentId ?? null,
      userId: a.user.id,
    };
    const jobId = await queue.enqueue(IFC_LOCATIONS_JOB, payload as unknown as Record<string, unknown>);
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "location.import_ifc_queued",
      targetType: "file",
      targetId: file.id,
      details: { name: file.name, versionId: body.fileVersionId, jobId },
    });
    return { jobId, status: "queued" };
  });

  api.get<{ Params: { pid: string; jid: string } }>("/projects/:pid/locations/import-jobs/:jid", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    if (!isUuid(req.params.jid)) throw notFound(msg("locations:entities.job"));
    const [job] = await db.select().from(jobs).where(and(eq(jobs.id, req.params.jid), eq(jobs.kind, IFC_LOCATIONS_JOB)));
    const p = job?.payload as unknown as IfcLocationsPayload | undefined;
    if (!job || p?.projectId !== a.project.id) throw notFound(msg("locations:entities.job"));
    return { jobId: job.id, status: job.status, error: job.error, result: p.result ?? null };
  });

  // ---- Links ----------------------------------------------------------------------------------

  /** Links of one target (?kind=&targetId=), of many targets (?kind=&targetIds=a,b) or of a location (?locationId=&subtree=1). */
  api.get<{ Params: { pid: string }; Querystring: { kind?: string; targetId?: string; targetIds?: string; locationId?: string; subtree?: string } }>(
    "/projects/:pid/location-links",
    async (req) => {
      const a = await projectAccess(db, req.params.pid, req.user!);
      const kind = req.query.kind ? z.enum(LOCATION_LINK_KINDS).parse(req.query.kind) : undefined;
      const targetIds = (req.query.targetIds ?? req.query.targetId ?? "").split(",").filter(isUuid);
      let locIds: string[] | undefined;
      if (req.query.locationId) {
        const loc = await requireLocation(db, a.project.id, req.query.locationId);
        locIds = req.query.subtree === "1" ? subtreeIds(await loadLocations(db, a.project.id), loc.id) : [loc.id];
      }
      if (!locIds && !targetIds.length) throw badRequest(msg("locations:errors.locationOrTargetRequired"));
      const rows = await db
        .select()
        .from(locationLinks)
        .where(
          and(
            eq(locationLinks.projectId, a.project.id),
            kind ? eq(locationLinks.kind, kind) : undefined,
            targetIds.length ? inArray(locationLinks.targetId, targetIds) : undefined,
            locIds ? inArray(locationLinks.locationId, locIds) : undefined,
          ),
        );
      return labelLinks(db, a, rows);
    },
  );

  api.put<{ Params: { pid: string } }>("/projects/:pid/location-links", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const body = z
      .object({ kind: z.enum(LOCATION_LINK_KINDS), targetId: z.string().uuid(), locationId: z.string().uuid().nullable() })
      .parse(req.body);
    await requireLinkPermission(db, a, body.kind, body.targetId);
    await setLocationLink(db, a, body.kind, body.targetId, body.locationId);
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "location.linked",
      targetType: body.kind,
      targetId: body.targetId,
      details: { locationId: body.locationId },
    });
    return { kind: body.kind, targetId: body.targetId, locationId: body.locationId };
  });
}

/** Who may change the location of a target: issue editors, form editors, file editors. */
async function requireLinkPermission(db: Db, a: ProjectAccess, kind: LocationLinkKind, targetId: string) {
  if (kind === "issue") {
    const [i] = await db.select().from(issues).where(and(eq(issues.id, targetId), eq(issues.projectId, a.project.id)));
    if (!i) throw notFound(msg("locations:entities.issue"));
    if (!(a.isProjectAdmin || i.createdBy === a.user.id || i.assigneeUserId === a.user.id))
      throw forbidden(msg("locations:errors.issueLinkForbidden"));
  } else if (kind === "form") {
    const [f] = (await capability("field.forms")?.list(db, { projectId: a.project.id, ids: [targetId] })) ?? [];
    if (!f) throw notFound(msg("locations:entities.form"));
    if (!(a.isProjectAdmin || (f.status === "draft" && f.createdBy === a.user.id)))
      throw forbidden(msg("locations:errors.formLinkForbidden"));
  } else {
    const [f] = await db.select().from(files).where(and(eq(files.id, targetId), eq(files.projectId, a.project.id)));
    if (!f || f.deletedAt) throw notFound(msg("locations:entities.file"));
    const tree = await FolderTree.load(db, a.project.id);
    if (!tree.byId.has(f.folderId)) throw notFound(msg("locations:entities.file"));
    const perm = tree.permission(a.principal, f.folderId);
    if (!can(perm.level, "edit")) {
      if (!can(perm.level, "view")) throw notFound(msg("locations:entities.file"));
      throw forbidden();
    }
  }
}

async function labelLinks(db: Db, a: ProjectAccess, rows: (typeof locationLinks.$inferSelect)[]): Promise<LocationLinkDto[]> {
  const ids = (k: LocationLinkKind) => rows.filter((r) => r.kind === k).map((r) => r.targetId);
  const labels = new Map<string, string>();
  const issueIds = ids("issue");
  if (issueIds.length)
    for (const i of await db.select().from(issues).where(inArray(issues.id, issueIds))) labels.set(i.id, `#${i.number} ${i.title}`);
  const formIds = ids("form");
  if (formIds.length) for (const f of (await capability("field.forms")?.list(db, { ids: formIds })) ?? []) labels.set(f.id, `${f.number} ${f.name}`);
  const fileIds = ids("file");
  const hidden = new Set<string>();
  if (fileIds.length) {
    const tree = await FolderTree.load(db, a.project.id);
    for (const f of await db.select().from(files).where(inArray(files.id, fileIds))) {
      const visible = !f.deletedAt && tree.byId.has(f.folderId) && can(tree.permission(a.principal, f.folderId).level, "view");
      if (visible) labels.set(f.id, f.name);
      else hidden.add(f.id);
    }
  }
  return rows
    .filter((r) => !hidden.has(r.targetId))
    .map((r) => ({ kind: r.kind, targetId: r.targetId, locationId: r.locationId, label: labels.get(r.targetId) }));
}

// ---- CSV ----------------------------------------------------------------------------------------

export interface CsvLocationRow {
  line: number;
  code: string | null;
  name: string;
  type: string | null;
  parentCode: string | null;
  kmStart: number | null;
  kmEnd: number | null;
  sortOrder: number | null;
}

const HEADER_ALIASES: Record<string, keyof Omit<CsvLocationRow, "line">> = {
  kod: "code",
  code: "code",
  ad: "name",
  adi: "name",
  isim: "name",
  name: "name",
  tip: "type",
  tur: "type",
  type: "type",
  ust: "parentCode",
  ustkod: "parentCode",
  ustkodu: "parentCode",
  parent: "parentCode",
  parentcode: "parentCode",
  kmbaslangic: "kmStart",
  kmbas: "kmStart",
  kmstart: "kmStart",
  kmfrom: "kmStart",
  baslangickm: "kmStart",
  kmbitis: "kmEnd",
  kmend: "kmEnd",
  kmto: "kmEnd",
  bitiskm: "kmEnd",
  sira: "sortOrder",
  order: "sortOrder",
  sortorder: "sortOrder",
};

function headerKey(h: string): string {
  return foldTr(h)
    .replace(/[çğıöşü]/g, (c) => ({ ç: "c", ğ: "g", ı: "i", ö: "o", ş: "s", ü: "u" })[c] ?? c)
    .replace(/[^a-z0-9]/g, "");
}

/** Minimal RFC 4180 parser; the delimiter (; , or tab) is taken from the header line. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const firstLine = src.split(/\r?\n/, 1)[0] ?? "";
  const counts = [";", ",", "\t"].map((d) => [d, firstLine.split(d).length - 1] as const);
  const delim = counts.sort((x, y) => y[1] - x[1])[0]![1] > 0 ? counts[0]![0] : ";";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === delim) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim()));
}

export function parseLocationCsv(
  text: string,
  lang: string = DEFAULT_LANGUAGE,
): { rows: CsvLocationRow[]; errors: { line: number; message: string }[] } {
  const t = tFor(lang);
  const table = parseCsv(text);
  const errors: { line: number; message: string }[] = [];
  if (!table.length) return { rows: [], errors: [{ line: 1, message: t("locations:csv.empty") }] };
  const header = table[0]!.map((h) => HEADER_ALIASES[headerKey(h)]);
  if (!header.includes("name"))
    return { rows: [], errors: [{ line: 1, message: t("locations:csv.noNameColumn") }] };
  const rows: CsvLocationRow[] = [];
  const codes = new Set<string>();
  table.slice(1).forEach((cells, i) => {
    const line = i + 2;
    const get = (k: keyof Omit<CsvLocationRow, "line">) => {
      const idx = header.indexOf(k);
      return idx >= 0 ? (cells[idx] ?? "").trim() : "";
    };
    const name = get("name");
    const code = get("code") || null;
    if (!name) errors.push({ line, message: t("locations:csv.nameEmpty") });
    if (name.length > 200) errors.push({ line, message: t("locations:csv.nameTooLong") });
    if (code && code.length > 40) errors.push({ line, message: t("locations:csv.codeTooLong") });
    if (code && codes.has(code)) errors.push({ line, message: t("locations:csv.duplicateCode", { code }) });
    if (code) codes.add(code);
    let kmStart: number | null = null;
    let kmEnd: number | null = null;
    try {
      kmStart = parseChainage(get("kmStart"), lang);
      kmEnd = parseChainage(get("kmEnd"), lang);
      if (kmStart !== null && kmEnd !== null && kmStart > kmEnd) errors.push({ line, message: t("locations:csv.kmStartAfterEnd") });
    } catch (e) {
      errors.push({ line, message: (e as Error).message });
    }
    const so = get("sortOrder");
    if (so && !/^-?\d+$/.test(so)) errors.push({ line, message: t("locations:csv.orderNotInteger", { value: so }) });
    rows.push({
      line,
      code,
      name,
      type: get("type") || null,
      parentCode: get("parentCode") || null,
      kmStart,
      kmEnd,
      sortOrder: so && /^-?\d+$/.test(so) ? Number(so) : null,
    });
  });
  if (!rows.length && !errors.length) errors.push({ line: 2, message: t("locations:csv.noDataRows") });
  return { rows, errors };
}
