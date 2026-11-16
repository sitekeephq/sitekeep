/**
 * ISO-7 delivery plan API (ISO 19650-2 §5.4.3–§5.4.5, docs/features/DELIVERY_PLAN.md):
 *   GET    /projects/:pid/delivery-plan                    the MIDP (administrators) or the caller's TIDPs; ?teamId= one TIDP
 *   POST   /projects/:pid/delivery-plan/milestones         project administrators; audit "delivery_plan.milestone_created"
 *   PATCH  /projects/:pid/delivery-plan/milestones/:mid    project administrators; audit "delivery_plan.milestone_updated"
 *   DELETE /projects/:pid/delivery-plan/milestones/:mid    project administrators; its targets go too; "delivery_plan.milestone_deleted"
 *   PUT    /projects/:pid/delivery-plan/teams/:tid/lead    project administrators: { userId | null }; "delivery_plan.lead_set"
 *   POST   /projects/:pid/delivery-plan/deliverables       administrators, the team's lead; "delivery_plan.deliverable_created"
 *   PATCH  /projects/:pid/delivery-plan/deliverables/:id   administrators, the team's lead; "delivery_plan.deliverable_updated"
 *   DELETE /projects/:pid/delivery-plan/deliverables/:id   administrators, the team's lead; "delivery_plan.deliverable_deleted"
 *   GET    /projects/:pid/delivery-plan/export?format=xlsx|csv&teamId=   what the caller sees; "delivery_plan.exported"
 *   POST   /projects/:pid/delivery-plan/import             { fileName, content (base64), teamId?, dryRun? }; "delivery_plan.imported"
 */
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  DELIVERY_PLAN_COLUMNS,
  DELIVERY_PLAN_HEADER_ALIASES,
  DELIVERY_PLAN_IMPORT_COLUMNS,
  formatPlanTarget,
  isPlanDate,
  milestoneHeader,
  milestoneOfHeader,
  parseCsvTable,
  parsePlanDate,
  parsePlanTarget,
  planHeaderKey,
  type DeliverableTargetDto,
  type DeliveryPlanDto,
  type DeliveryPlanImportColumn,
  type DeliveryPlanImportReportDto,
} from "@sitekeep/shared";
import type { AppDeps } from "../app/deps.js";
import { isUuid, projectAccess, requireProjectAdmin, type ProjectAccess } from "../core/security/access.js";
import { audit } from "../core/platform/audit.js";
import { badRequest, conflict, forbidden, notFound } from "../core/platform/http.js";
import { decodeText } from "../core/formats/text.js";
import { readXlsx, writeXlsx } from "../core/formats/xlsx.js";
import { toCsv } from "../docintel/export.js";
import { deliveryDeliverables, deliveryMilestones, deliveryTeamLeads } from "../db/schema.js";
import type { Db } from "../db/index.js";
import { msg, requestLanguage, tFor } from "../i18n/index.js";
import {
  canEditTeam,
  codeChecker,
  isTeamMember,
  loadDeliveryPlan,
  loadMilestones,
  loadPlanScope,
  milestoneDto,
  nextPosition,
  normaliseTargets,
  projectCodeProfile,
  type DeliverableRow,
  type PlanScope,
} from "./delivery-plan.js";

const day = z
  .string()
  .trim()
  .refine((s) => isPlanDate(s), { message: "YYYY-MM-DD" });
const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((s) => (s === undefined ? undefined : s || null));
const targetSchema = z.object({
  milestoneId: z.string().uuid(),
  suitabilityCode: z.string().trim().max(20).nullable().default(null),
  revisionCode: z.string().trim().max(20).nullable().default(null),
});
const deliverableBody = z
  .object({
    teamId: z.string().uuid(),
    code: z.string().trim().min(1).max(200),
    title: z.string().trim().min(1).max(500),
    discipline: optText(100),
    docType: optText(100),
    targets: z.array(targetSchema).max(100).optional(),
    dueShared: day.nullable().optional(),
    duePublished: day.nullable().optional(),
    notes: optText(2000),
  })
  .strict();
const milestoneBody = z
  .object({
    code: optText(20),
    name: z.string().trim().min(1).max(200),
    dueDate: day.nullable().optional(),
    position: z.number().int().min(0).max(100_000).optional(),
  })
  .strict();

const MAX_IMPORT_ROWS = 5000;

type T = ReturnType<typeof tFor>;

async function requireRow(db: Db, projectId: string, id: string): Promise<DeliverableRow> {
  if (!isUuid(id)) throw notFound(msg("cde:deliveryPlan.entities.deliverable"));
  const [row] = await db
    .select()
    .from(deliveryDeliverables)
    .where(and(eq(deliveryDeliverables.id, id), eq(deliveryDeliverables.projectId, projectId)));
  if (!row) throw notFound(msg("cde:deliveryPlan.entities.deliverable"));
  return row;
}

function requireTeamEdit(scope: PlanScope, teamId: string | null) {
  if (canEditTeam(scope, teamId)) return;
  const team = scope.teams.find((t) => t.id === teamId)?.name ?? "—";
  throw forbidden(msg("cde:deliveryPlan.errors.notAllowed", { team }));
}

function checkDueOrder(t: T, shared: string | null | undefined, published: string | null | undefined): string | null {
  return shared && published && published < shared ? t("cde:deliveryPlan.errors.dueOrder", { shared, published }) : null;
}

/** Fields an audit row names: the code, the title and the team. */
const auditOf = (r: Pick<DeliverableRow, "code" | "title" | "teamId">) => ({ code: r.code, title: r.title, teamId: r.teamId });

const PLAN_FIELDS = ["teamId", "code", "title", "discipline", "docType", "targets", "dueShared", "duePublished", "notes"] as const;
type PlanFields = Pick<DeliverableRow, (typeof PLAN_FIELDS)[number]>;

/** Field names whose values differ. */
function changedFields(before: PlanFields, after: Partial<PlanFields>): string[] {
  return PLAN_FIELDS.filter((k) => after[k] !== undefined && JSON.stringify(after[k]) !== JSON.stringify(before[k]));
}

export async function deliveryPlanRoutes(api: FastifyInstance, deps: AppDeps) {
  const { db } = deps;

  api.get<{ Params: { pid: string }; Querystring: { teamId?: string } }>("/projects/:pid/delivery-plan", async (req): Promise<DeliveryPlanDto> => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    return loadDeliveryPlan(db, a, { teamId: req.query.teamId || null });
  });

  // ---- Milestones (MIDP) ----------------------------------------------------------------------

  async function milestoneNameFree(projectId: string, name: string, exceptId?: string) {
    const all = await loadMilestones(db, projectId);
    const key = name.trim().toLocaleLowerCase("tr");
    if (all.some((m) => m.id !== exceptId && m.name.trim().toLocaleLowerCase("tr") === key))
      throw conflict(msg("cde:deliveryPlan.errors.milestoneTaken", { name }));
  }

  api.post<{ Params: { pid: string } }>("/projects/:pid/delivery-plan/milestones", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    requireProjectAdmin(a);
    const body = milestoneBody.parse(req.body);
    await milestoneNameFree(a.project.id, body.name);
    const [row] = await db
      .insert(deliveryMilestones)
      .values({
        projectId: a.project.id,
        code: body.code ?? null,
        name: body.name,
        dueDate: body.dueDate ?? null,
        position: body.position ?? (await nextPosition(db, a.project.id, "milestones")),
      })
      .returning();
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "delivery_plan.milestone_created",
      targetType: "delivery_milestone",
      targetId: row!.id,
      details: { name: row!.name, code: row!.code, dueDate: row!.dueDate },
    });
    return milestoneDto(row!);
  });

  api.patch<{ Params: { pid: string; mid: string } }>("/projects/:pid/delivery-plan/milestones/:mid", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    requireProjectAdmin(a);
    const body = milestoneBody.partial().strict().parse(req.body);
    const before = (await loadMilestones(db, a.project.id)).find((m) => m.id === req.params.mid);
    if (!before) throw notFound(msg("cde:deliveryPlan.entities.milestone"));
    if (body.name) await milestoneNameFree(a.project.id, body.name, before.id);
    const [row] = await db
      .update(deliveryMilestones)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(deliveryMilestones.id, before.id))
      .returning();
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "delivery_plan.milestone_updated",
      targetType: "delivery_milestone",
      targetId: before.id,
      details: { name: row!.name, before: { name: before.name, code: before.code, dueDate: before.dueDate }, after: { name: row!.name, code: row!.code, dueDate: row!.dueDate } },
    });
    return milestoneDto(row!);
  });

  api.delete<{ Params: { pid: string; mid: string } }>("/projects/:pid/delivery-plan/milestones/:mid", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    requireProjectAdmin(a);
    const before = (await loadMilestones(db, a.project.id)).find((m) => m.id === req.params.mid);
    if (!before) throw notFound(msg("cde:deliveryPlan.entities.milestone"));
    let targets = 0;
    await db.transaction(async (tx) => {
      const rows = await tx.select().from(deliveryDeliverables).where(eq(deliveryDeliverables.projectId, a.project.id));
      for (const r of rows) {
        const kept = (r.targets ?? []).filter((t) => t.milestoneId !== before.id);
        if (kept.length === (r.targets ?? []).length) continue;
        targets++;
        await tx.update(deliveryDeliverables).set({ targets: kept }).where(eq(deliveryDeliverables.id, r.id));
      }
      await tx.delete(deliveryMilestones).where(eq(deliveryMilestones.id, before.id));
    });
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "delivery_plan.milestone_deleted",
      targetType: "delivery_milestone",
      targetId: before.id,
      details: { name: before.name, code: before.code, dueDate: before.dueDate, targets },
    });
    return { ok: true };
  });

  // ---- Team leads -------------------------------------------------------------------------------

  api.put<{ Params: { pid: string; tid: string } }>("/projects/:pid/delivery-plan/teams/:tid/lead", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    requireProjectAdmin(a);
    const body = z.object({ userId: z.string().uuid().nullable() }).strict().parse(req.body);
    const scope = await loadPlanScope(db, a);
    const team = scope.teams.find((t) => t.id === req.params.tid);
    if (!team) throw notFound(msg("cde:deliveryPlan.entities.team"));
    if (body.userId && !(await isTeamMember(db, a.project.id, team.id, body.userId))) throw badRequest(msg("cde:deliveryPlan.errors.leadNotMember"));
    const previous = scope.leads.get(team.id) ?? null;
    if (body.userId)
      await db
        .insert(deliveryTeamLeads)
        .values({ teamId: team.id, projectId: a.project.id, userId: body.userId })
        .onConflictDoUpdate({ target: deliveryTeamLeads.teamId, set: { userId: body.userId } });
    else await db.delete(deliveryTeamLeads).where(eq(deliveryTeamLeads.teamId, team.id));
    if (previous !== body.userId)
      await audit(db, {
        projectId: a.project.id,
        userId: a.user.id,
        action: "delivery_plan.lead_set",
        targetType: "role",
        targetId: team.id,
        details: { name: team.name, userId: body.userId, previousUserId: previous },
      });
    return { teamId: team.id, userId: body.userId };
  });

  // ---- Deliverables (TIDP rows) ---------------------------------------------------------------

  /** Checks a create / update: the team, the code, the targets and the dates. Throws on the first problem. */
  async function prepare(a: ProjectAccess, scope: PlanScope, input: Partial<z.infer<typeof deliverableBody>>, exceptId: string | null, lang: string) {
    const t = tFor(lang);
    const out: Partial<PlanFields> & { codeNorm?: string } = {};
    if (input.teamId !== undefined) {
      if (!scope.teams.some((x) => x.id === input.teamId)) throw badRequest(msg("cde:deliveryPlan.errors.noTeam"));
      requireTeamEdit(scope, input.teamId);
      out.teamId = input.teamId;
    }
    if (input.code !== undefined) {
      const check = (await codeChecker(db, a.project.id, lang))(input.code);
      if (!check.ok) throw badRequest(check.message);
      const [taken] = await db
        .select({ id: deliveryDeliverables.id })
        .from(deliveryDeliverables)
        .where(and(eq(deliveryDeliverables.projectId, a.project.id), eq(deliveryDeliverables.codeNorm, check.norm)));
      if (taken && taken.id !== exceptId) throw conflict(msg("cde:deliveryPlan.errors.codeTaken", { code: check.code }));
      out.code = check.code;
      out.codeNorm = check.norm;
    }
    if (input.title !== undefined) out.title = input.title;
    if (input.discipline !== undefined) out.discipline = input.discipline;
    if (input.docType !== undefined) out.docType = input.docType;
    if (input.notes !== undefined) out.notes = input.notes;
    if (input.dueShared !== undefined) out.dueShared = input.dueShared;
    if (input.duePublished !== undefined) out.duePublished = input.duePublished;
    if (input.targets !== undefined) {
      const milestones = new Set((await loadMilestones(db, a.project.id)).map((m) => m.id));
      const r = normaliseTargets(input.targets, milestones, await projectCodeProfile(db, a.project.id), lang);
      if ("error" in r) throw badRequest(r.error);
      out.targets = r.targets;
    }
    return { fields: out, t };
  }

  api.post<{ Params: { pid: string } }>("/projects/:pid/delivery-plan/deliverables", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const body = deliverableBody.parse(req.body);
    const scope = await loadPlanScope(db, a);
    const { fields, t } = await prepare(a, scope, body, null, requestLanguage(req));
    const order = checkDueOrder(t, fields.dueShared, fields.duePublished);
    if (order) throw badRequest(order);
    const [row] = await db
      .insert(deliveryDeliverables)
      .values({
        projectId: a.project.id,
        teamId: fields.teamId!,
        code: fields.code!,
        codeNorm: fields.codeNorm!,
        title: fields.title!,
        discipline: fields.discipline ?? null,
        docType: fields.docType ?? null,
        targets: fields.targets ?? [],
        dueShared: fields.dueShared ?? null,
        duePublished: fields.duePublished ?? null,
        notes: fields.notes ?? null,
        position: await nextPosition(db, a.project.id, "deliverables"),
        createdBy: a.user.id,
      })
      .returning();
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "delivery_plan.deliverable_created",
      targetType: "delivery_deliverable",
      targetId: row!.id,
      details: { ...auditOf(row!), dueShared: row!.dueShared, duePublished: row!.duePublished },
    });
    const plan = await loadDeliveryPlan(db, a);
    return plan.deliverables.find((d) => d.id === row!.id)!;
  });

  api.patch<{ Params: { pid: string; id: string } }>("/projects/:pid/delivery-plan/deliverables/:id", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const before = await requireRow(db, a.project.id, req.params.id);
    const scope = await loadPlanScope(db, a);
    requireTeamEdit(scope, before.teamId);
    const body = deliverableBody.partial().strict().parse(req.body);
    const { fields, t } = await prepare(a, scope, body, before.id, requestLanguage(req));
    const order = checkDueOrder(t, fields.dueShared !== undefined ? fields.dueShared : before.dueShared, fields.duePublished !== undefined ? fields.duePublished : before.duePublished);
    if (order) throw badRequest(order);
    const changed = changedFields(before, fields);
    if (changed.length) {
      await db
        .update(deliveryDeliverables)
        .set({ ...fields, updatedAt: new Date() })
        .where(eq(deliveryDeliverables.id, before.id));
      const after = { ...before, ...fields };
      await audit(db, {
        projectId: a.project.id,
        userId: a.user.id,
        action: "delivery_plan.deliverable_updated",
        targetType: "delivery_deliverable",
        targetId: before.id,
        details: {
          ...auditOf(after),
          changed,
          before: Object.fromEntries(changed.map((k) => [k, before[k as keyof PlanFields]])),
          after: Object.fromEntries(changed.map((k) => [k, after[k as keyof PlanFields]])),
        },
      });
    }
    const plan = await loadDeliveryPlan(db, a);
    const dto = plan.deliverables.find((d) => d.id === before.id);
    // A lead who moved the row to a team they do not see gets the row without status.
    if (!dto) return { id: before.id };
    return dto;
  });

  api.delete<{ Params: { pid: string; id: string } }>("/projects/:pid/delivery-plan/deliverables/:id", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const before = await requireRow(db, a.project.id, req.params.id);
    requireTeamEdit(await loadPlanScope(db, a), before.teamId);
    await db.delete(deliveryDeliverables).where(eq(deliveryDeliverables.id, before.id));
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "delivery_plan.deliverable_deleted",
      targetType: "delivery_deliverable",
      targetId: before.id,
      details: auditOf(before),
    });
    return { ok: true };
  });

  // ---- Export -----------------------------------------------------------------------------------

  api.get<{ Params: { pid: string }; Querystring: { format?: string; teamId?: string } }>("/projects/:pid/delivery-plan/export", async (req, reply) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const format = req.query.format ?? "xlsx";
    if (format !== "xlsx" && format !== "csv") throw badRequest(msg("cde:deliveryPlan.errors.fileType"));
    const lang = requestLanguage(req);
    const t = tFor(lang);
    const plan = await loadDeliveryPlan(db, a, { teamId: req.query.teamId || null });
    const fixed = (k: (typeof DELIVERY_PLAN_COLUMNS)[number]) => t(`cde:deliveryPlan.columns.${k}`);
    const header = [
      ...(["code", "title", "team", "discipline", "docType"] as const).map(fixed),
      ...plan.milestones.map(milestoneHeader),
      ...(["dueShared", "duePublished", "notes", "status", "late", "document"] as const).map(fixed),
    ];
    const rows = plan.deliverables.map((d) => [
      d.code,
      d.title,
      d.teamName ?? "",
      d.discipline ?? "",
      d.docType ?? "",
      ...plan.milestones.map((m) => formatPlanTarget(d.targets.find((x) => x.milestoneId === m.id))),
      d.dueShared ?? "",
      d.duePublished ?? "",
      d.notes ?? "",
      t(`cde:deliveryPlan.statuses.${d.status}`),
      d.late ? t(`cde:deliveryPlan.late.${d.late}`) : "",
      d.document ? [d.document.name, d.document.revisionCode, d.document.suitabilityCode].filter(Boolean).join(" · ") : "",
    ]);
    const team = req.query.teamId ? plan.teams.find((x) => x.id === req.query.teamId) : null;
    const base = [a.project.code, t("cde:deliveryPlan.fileName"), team?.code ?? team?.name].filter(Boolean).join("-").replace(/[\\/:*?"<>|\s]+/g, "_");
    const disposition = (name: string) => `attachment; filename="${name.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`;
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "delivery_plan.exported",
      targetType: "project",
      targetId: a.project.id,
      details: { format, count: rows.length, teamId: req.query.teamId ?? null },
    });
    if (format === "csv") {
      reply.header("Content-Type", "text/csv; charset=utf-8");
      reply.header("Content-Disposition", disposition(`${base}.csv`));
      return reply.send(toCsv(header, rows));
    }
    const widths = [28, 40, 20, 14, 12, ...plan.milestones.map(() => 16), 14, 14, 30, 16, 26, 40];
    const buf = await writeXlsx([
      { name: t("cde:deliveryPlan.sheetName"), columns: header.map((title, i) => ({ title, width: widths[i] })), rows },
      {
        name: t("cde:deliveryPlan.milestonesSheet"),
        columns: [{ title: "#", width: 6 }, { title: t("cde:deliveryPlan.entities.milestone"), width: 40 }, { title: "", width: 14 }],
        rows: plan.milestones.map((m, i) => [i + 1, milestoneHeader(m), m.dueDate ?? ""]),
      },
    ]);
    reply.header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    reply.header("Content-Disposition", disposition(`${base}.xlsx`));
    return reply.send(buf);
  });

  // ---- Import -----------------------------------------------------------------------------------

  api.post<{ Params: { pid: string } }>("/projects/:pid/delivery-plan/import", async (req): Promise<DeliveryPlanImportReportDto> => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const body = z
      .object({
        fileName: z.string().trim().min(1).max(255),
        content: z.string().min(1).max(8_000_000),
        teamId: z.string().uuid().nullable().optional(),
        dryRun: z.boolean().optional(),
      })
      .parse(req.body);
    const lang = requestLanguage(req);
    const t = tFor(lang);
    const data = Buffer.from(body.content, "base64");
    let table: string[][];
    if (/\.xlsx$/i.test(body.fileName)) {
      try {
        table = readXlsx(data, lang);
      } catch {
        throw badRequest(msg("cde:deliveryPlan.errors.fileUnreadable"));
      }
    } else if (/\.(csv|txt|tsv)$/i.test(body.fileName)) table = parseCsvTable(decodeText(data));
    else throw badRequest(msg("cde:deliveryPlan.errors.fileType"));
    table = table.filter((r) => r.some((c) => String(c ?? "").trim()));
    if (table.length < 2) throw badRequest(msg("cde:deliveryPlan.errors.empty"));
    if (table.length - 1 > MAX_IMPORT_ROWS) throw badRequest(msg("cde:deliveryPlan.errors.tooManyRows", { max: MAX_IMPORT_ROWS }));

    const scope = await loadPlanScope(db, a);
    const milestones = await loadMilestones(db, a.project.id);
    // Column of each header: the exported names (English and Turkish), the aliases, the milestones.
    const names = new Map<string, DeliveryPlanImportColumn>();
    for (const col of DELIVERY_PLAN_IMPORT_COLUMNS) {
      for (const l of ["en", "tr", lang]) names.set(planHeaderKey(tFor(l)(`cde:deliveryPlan.columns.${col}`)), col);
      for (const alias of DELIVERY_PLAN_HEADER_ALIASES[col]) names.set(planHeaderKey(alias), col);
    }
    const columns = new Map<DeliveryPlanImportColumn, number>();
    const milestoneColumns = new Map<number, (typeof milestones)[number]>();
    table[0]!.forEach((h, i) => {
      const col = names.get(planHeaderKey(String(h ?? "")));
      if (col && !columns.has(col)) columns.set(col, i);
      else if (!col) {
        const m = milestoneOfHeader(String(h ?? ""), milestones);
        if (m) milestoneColumns.set(i, m);
      }
    });
    if (!columns.has("code")) throw badRequest(msg("cde:deliveryPlan.errors.noCodeColumn"));

    const check = await codeChecker(db, a.project.id, lang);
    const profile = await projectCodeProfile(db, a.project.id);
    const milestoneIds = new Set(milestones.map((m) => m.id));
    const existing = new Map((await db.select().from(deliveryDeliverables).where(eq(deliveryDeliverables.projectId, a.project.id))).map((r) => [r.codeNorm, r]));
    const teamKey = (s: string) => planHeaderKey(s);
    const errors: DeliveryPlanImportReportDto["errors"] = [];
    const creates: (typeof deliveryDeliverables.$inferInsert)[] = [];
    const updates: { before: DeliverableRow; fields: Partial<PlanFields> & { codeNorm: string }; changed: string[] }[] = [];
    const seen = new Set<string>();
    let unchanged = 0;

    for (let i = 1; i < table.length; i++) {
      const rowNo = i + 1;
      const cells = table[i]!;
      const cell = (col: DeliveryPlanImportColumn): string | undefined => {
        const idx = columns.get(col);
        return idx === undefined ? undefined : String(cells[idx] ?? "").trim();
      };
      const fail = (message: string) => errors.push({ row: rowNo, message });
      const code = check(cell("code") ?? "");
      if (!code.ok) {
        fail(code.message);
        continue;
      }
      if (seen.has(code.norm)) {
        fail(t("cde:deliveryPlan.errors.rowDuplicate", { code: code.code }));
        continue;
      }
      seen.add(code.norm);
      const before = existing.get(code.norm);
      // Team: the column (name or code), else the TIDP being imported into, else the row's own.
      const teamText = cell("team");
      let teamId: string | null = before?.teamId ?? body.teamId ?? null;
      if (teamText) {
        const team = scope.teams.find((x) => teamKey(x.name) === teamKey(teamText) || (x.code && teamKey(x.code) === teamKey(teamText)));
        if (!team) {
          fail(t("cde:deliveryPlan.errors.rowTeamUnknown", { team: teamText }));
          continue;
        }
        teamId = team.id;
      } else if (body.teamId) teamId = body.teamId;
      if (!teamId || !scope.teams.some((x) => x.id === teamId)) {
        fail(t("cde:deliveryPlan.errors.noTeam"));
        continue;
      }
      const forbiddenTeam = [teamId, before?.teamId ?? teamId].find((id) => !canEditTeam(scope, id));
      if (forbiddenTeam !== undefined) {
        fail(t("cde:deliveryPlan.errors.notAllowed", { team: scope.teams.find((x) => x.id === forbiddenTeam)?.name ?? "—" }));
        continue;
      }
      const title = cell("title");
      if (!title && !before) {
        fail(t("cde:deliveryPlan.errors.titleRequired"));
        continue;
      }
      const dates: Partial<Record<"dueShared" | "duePublished", string | null>> = {};
      let bad = false;
      for (const col of ["dueShared", "duePublished"] as const) {
        const raw = cell(col);
        if (raw === undefined) continue;
        const parsed = parsePlanDate(raw);
        if (parsed === undefined) {
          fail(t("cde:deliveryPlan.errors.rowDate", { column: String(table[0]![columns.get(col)!] ?? col), value: raw }));
          bad = true;
        } else dates[col] = parsed;
      }
      if (bad) continue;
      const shared = dates.dueShared !== undefined ? dates.dueShared : (before?.dueShared ?? null);
      const published = dates.duePublished !== undefined ? dates.duePublished : (before?.duePublished ?? null);
      const order = checkDueOrder(t, shared, published);
      if (order) {
        fail(order);
        continue;
      }
      // Targets: only the milestone columns of the file change; an empty cell clears that target.
      let targets: DeliverableTargetDto[] | undefined;
      if (milestoneColumns.size) {
        const map = new Map((before?.targets ?? []).map((x) => [x.milestoneId, x]));
        let targetError: string | null = null;
        for (const [idx, m] of milestoneColumns) {
          const parsed = parsePlanTarget(String(cells[idx] ?? ""));
          if (!parsed) {
            map.delete(m.id);
            continue;
          }
          const r = normaliseTargets([{ milestoneId: m.id, ...parsed }], milestoneIds, profile, lang);
          if ("error" in r) {
            targetError = t("cde:deliveryPlan.errors.rowTarget", { milestone: milestoneHeader(m), error: r.error });
            break;
          }
          if (r.targets[0]) map.set(m.id, r.targets[0]);
        }
        if (targetError) {
          fail(targetError);
          continue;
        }
        targets = milestones.filter((m) => map.has(m.id)).map((m) => map.get(m.id)!);
      }
      const text = (col: "discipline" | "docType" | "notes", max: number) => {
        const v = cell(col);
        return v === undefined ? undefined : v.slice(0, max) || null;
      };
      const fields: Partial<PlanFields> & { codeNorm: string } = {
        teamId,
        code: code.code,
        codeNorm: code.norm,
        ...(title ? { title: title.slice(0, 500) } : {}),
        ...(text("discipline", 100) !== undefined ? { discipline: text("discipline", 100) } : {}),
        ...(text("docType", 100) !== undefined ? { docType: text("docType", 100) } : {}),
        ...(text("notes", 2000) !== undefined ? { notes: text("notes", 2000) } : {}),
        ...dates,
        ...(targets ? { targets } : {}),
      };
      if (before) {
        const changed = changedFields(before, fields);
        if (changed.length) updates.push({ before, fields, changed });
        else unchanged++;
      } else
        creates.push({
          projectId: a.project.id,
          teamId,
          code: code.code,
          codeNorm: code.norm,
          title: fields.title!,
          discipline: fields.discipline ?? null,
          docType: fields.docType ?? null,
          targets: fields.targets ?? [],
          dueShared: fields.dueShared ?? null,
          duePublished: fields.duePublished ?? null,
          notes: fields.notes ?? null,
          createdBy: a.user.id,
        });
    }

    const report: DeliveryPlanImportReportDto = { applied: false, created: creates.length, updated: updates.length, unchanged, errors };
    // All or nothing: a file with errors, or a dry run, writes nothing.
    if (errors.length || body.dryRun || (!creates.length && !updates.length)) return report;
    let position = await nextPosition(db, a.project.id, "deliverables");
    await db.transaction(async (tx) => {
      if (creates.length) await tx.insert(deliveryDeliverables).values(creates.map((c) => ({ ...c, position: position++ })));
      for (const u of updates)
        await tx
          .update(deliveryDeliverables)
          .set({ ...u.fields, updatedAt: new Date() })
          .where(eq(deliveryDeliverables.id, u.before.id));
    });
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "delivery_plan.imported",
      targetType: "project",
      targetId: a.project.id,
      details: {
        fileName: body.fileName,
        teamId: body.teamId ?? null,
        count: creates.length + updates.length,
        created: creates.map((c) => c.code),
        updated: updates.map((u) => ({ code: u.before.code, changed: u.changed })),
      },
    });
    return { ...report, applied: true };
  });
}
