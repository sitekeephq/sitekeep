import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import {
  TRANSMITTAL_PURPOSES,
  WORK_CATEGORIES,
  defaultStatuses,
  type WorkAutomationDto,
} from "@sitekeep/shared";
import { projectAccess, requireProjectAdmin } from "../../core/security/access.js";
import { audit } from "../../core/platform/audit.js";
import { badRequest, notFound } from "../../core/platform/http.js";
import { DEFAULT_LANGUAGE, msg, render, requestLanguage } from "../../i18n/index.js";
import {
  workTypes,
  workflowTemplateWorkOptions,
  workflowTemplates,
} from "../../db/schema.js";
import { projectModules, workModuleOn as moduleOn } from "../../projects/modules.js";
import { DELIVERY_CHANNELS, toChannelDto } from "../delivery.js";
import { companyNames, projectTypes, toTypeDto } from "../service.js";
import { defined, fieldDefSchema, uuid, type WorksRouteContext } from "./route-helpers.js";

const typeSchema = z.object({
  key: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, render(DEFAULT_LANGUAGE, msg("works:errors.typeKeyFormat"))),
  name: z.string().trim().min(1).max(120),
  category: z.enum(WORK_CATEGORIES).optional(),
  numberingPattern: z.string().trim().min(1).max(200),
  counterGroup: z.string().trim().max(40).nullable().optional(),
  fields: z.array(fieldDefSchema).max(60).optional(),
  settings: z
    .object({
      coverFolderId: uuid.nullable().optional(),
      replyTypeKey: z.string().trim().max(40).nullable().optional(),
      incoming: z.boolean().optional(),
      dueDays: z.number().int().min(0).max(365).nullable().optional(),
      submittedStatus: z.string().trim().max(40).nullable().optional(),
      outcomeStatus: z
        .partialRecord(z.enum(["approved", "approved_with_comments", "info", "revise", "rejected"]), z.string().trim().max(40))
        .nullable()
        .optional(),
    })
    .optional(),
  defaultWorkflowTemplateId: uuid.nullable().optional(),
  icon: z.string().trim().max(8).nullable().optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
});

export function registerWorkTypeRoutes(r: WorksRouteContext) {
  const { api, db } = r;

  api.get<{ Params: { pid: string }; Querystring: { all?: string; creatable?: string } }>("/projects/:pid/work-types", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const rows = await projectTypes(db, a.project.id);
    const modules = projectModules(a.project);
    return rows
      .filter((t) => req.query.all === "1" || !t.archivedAt)
      .filter((t) => req.query.creatable !== "1" || (!t.archivedAt && moduleOn(modules, t.category)))
      .map(toTypeDto);
  });

  api.post<{ Params: { pid: string } }>("/projects/:pid/work-types", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    requireProjectAdmin(a);
    await projectTypes(db, a.project.id);
    const parsed = typeSchema.parse(req.body);
    const body = { ...parsed, category: parsed.category ?? "generic", fields: parsed.fields ?? [], settings: parsed.settings ?? {} };
    await r.checkType(a.project.id, body, requestLanguage(req));
    const [row] = await db
      .insert(workTypes)
      .values({
        projectId: a.project.id,
        key: body.key,
        name: body.name,
        category: body.category,
        numberingPattern: body.numberingPattern,
        counterGroup: body.counterGroup || null,
        fields: body.fields,
        statuses: defaultStatuses(body.category),
        settings: body.settings,
        defaultWorkflowTemplateId: body.defaultWorkflowTemplateId ?? null,
        icon: body.icon ?? null,
        color: body.color ?? null,
      })
      .returning();
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "work_type.created",
      targetType: "work_type",
      targetId: row!.id,
      details: { key: body.key, name: body.name },
    });
    return toTypeDto(row!);
  });

  api.put<{ Params: { pid: string; tid: string } }>("/projects/:pid/work-types/:tid", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    requireProjectAdmin(a);
    const type = await r.loadType(a.project.id, req.params.tid);
    const body = typeSchema.omit({ key: true, category: true }).partial().parse(req.body);
    await r.checkType(a.project.id, { ...body, numberingPattern: body.numberingPattern ?? type.numberingPattern, fields: body.fields ?? type.fields }, requestLanguage(req));
    const [row] = await db
      .update(workTypes)
      .set({
        ...defined({
          name: body.name,
          numberingPattern: body.numberingPattern,
          counterGroup: body.counterGroup === undefined ? undefined : body.counterGroup || null,
          fields: body.fields,
          defaultWorkflowTemplateId: body.defaultWorkflowTemplateId,
          icon: body.icon,
          color: body.color,
        }),
        ...(body.settings ? { settings: { ...type.settings, ...body.settings } } : {}),
        updatedAt: new Date(),
      })
      .where(eq(workTypes.id, type.id))
      .returning();
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "work_type.updated",
      targetType: "work_type",
      targetId: type.id,
      details: { key: type.key, changed: Object.keys(body) },
    });
    return toTypeDto(row!);
  });

  api.delete<{ Params: { pid: string; tid: string } }>("/projects/:pid/work-types/:tid", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    requireProjectAdmin(a);
    const type = await r.loadType(a.project.id, req.params.tid);
    await db.update(workTypes).set({ archivedAt: new Date(), updatedAt: new Date() }).where(eq(workTypes.id, type.id));
    await audit(db, { projectId: a.project.id, userId: a.user.id, action: "work_type.archived", targetType: "work_type", targetId: type.id, details: { key: type.key } });
    return { ok: true };
  });

  api.post<{ Params: { pid: string; tid: string } }>("/projects/:pid/work-types/:tid/restore", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    requireProjectAdmin(a);
    const type = await r.loadType(a.project.id, req.params.tid);
    const [row] = await db.update(workTypes).set({ archivedAt: null, updatedAt: new Date() }).where(eq(workTypes.id, type.id)).returning();
    return toTypeDto(row!);
  });

  api.get<{ Params: { pid: string } }>("/projects/:pid/work-automation", async (req): Promise<WorkAutomationDto[]> => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const templates = await db
      .select()
      .from(workflowTemplates)
      .where(and(eq(workflowTemplates.projectId, a.project.id), inArray(workflowTemplates.kind, ["review", "rfi", "submittal"]), isNull(workflowTemplates.archivedAt)))
      .orderBy(asc(workflowTemplates.name));
    const opts = templates.length
      ? await db.select().from(workflowTemplateWorkOptions).where(inArray(workflowTemplateWorkOptions.templateId, templates.map((t) => t.id)))
      : [];
    return templates.map((t) => {
      const o = opts.find((x) => x.templateId === t.id);
      return {
        templateId: t.id,
        templateName: t.name,
        autoTransmittal: o?.autoTransmittal ?? false,
        recipientCompanyIds: o?.recipientCompanyIds ?? [],
        purpose: o?.purpose ?? "bilgi",
        send: o?.send ?? true,
        include: o?.include ?? "approved",
      };
    });
  });

  api.put<{ Params: { pid: string; tid: string } }>("/projects/:pid/work-automation/:tid", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    requireProjectAdmin(a);
    const [t] = await db.select().from(workflowTemplates).where(and(eq(workflowTemplates.id, req.params.tid), eq(workflowTemplates.projectId, a.project.id)));
    if (!t) throw notFound(msg("works:entities.template"));
    const body = z.object({
      autoTransmittal: z.boolean(),
      recipientCompanyIds: z.array(uuid).max(50).default([]),
      purpose: z.enum(TRANSMITTAL_PURPOSES).default("bilgi"),
      send: z.boolean().default(true),
      include: z.enum(["approved", "all"]).default("approved"),
    }).parse(req.body);
    const known = await companyNames(db, body.recipientCompanyIds);
    if (known.size !== new Set(body.recipientCompanyIds).size) throw badRequest(msg("works:errors.companyNotFound"));
    const values = { ...body, recipientCompanyIds: [...new Set(body.recipientCompanyIds)], updatedAt: new Date() };
    await db.insert(workflowTemplateWorkOptions).values({ templateId: t.id, projectId: a.project.id, ...values })
      .onConflictDoUpdate({ target: workflowTemplateWorkOptions.templateId, set: values });
    await audit(db, { projectId: a.project.id, userId: a.user.id, action: "work_automation.updated", targetType: "workflow_template", targetId: t.id, details: body });
    return { ok: true };
  });

  api.get("/delivery-channels", async (req) => DELIVERY_CHANNELS.map((c) => toChannelDto(c, requestLanguage(req))));
}
