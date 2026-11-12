import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  WORKFLOW_KINDS,
  type FolderSettingsDto,
  type WorkflowTemplateDto,
} from "@sitekeep/shared";
import type { AppDeps } from "../../app/deps.js";
import { FolderTree, isUuid, projectAccess, requireAction, requireProjectAdmin } from "../../core/security/access.js";
import { audit } from "../../core/platform/audit.js";
import type { Db } from "../../db/index.js";
import { folderSettings, workflowTemplates } from "../../db/schema.js";
import { badRequest, notFound } from "../../core/platform/http.js";
import { folderGate } from "../../workflow/service.js";
import { msg, requestLanguage } from "../../i18n/index.js";

import { parseTemplateBody } from "../template-schemas.js";

export async function workflowRoutes(api: FastifyInstance, { db }: AppDeps) {
  // ---- Templates -------------------------------------------------------------------------

  api.get<{ Params: { pid: string }; Querystring: { kind?: string } }>(
    "/projects/:pid/workflow-templates",
    async (req) => {
      const a = await projectAccess(db, req.params.pid, req.user!);
      const kind = req.query.kind ? z.enum(WORKFLOW_KINDS).parse(req.query.kind) : undefined;
      const rows = await db
        .select()
        .from(workflowTemplates)
        .where(
          and(
            eq(workflowTemplates.projectId, a.project.id),
            isNull(workflowTemplates.archivedAt),
            kind ? eq(workflowTemplates.kind, kind) : undefined,
          ),
        )
        .orderBy(asc(workflowTemplates.name));
      return rows.map(toTemplateDto);
    },
  );

  api.post<{ Params: { pid: string } }>("/projects/:pid/workflow-templates", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    requireProjectAdmin(a);
    const body = await parseTemplateBody(db, a.project.id, req.body, [], requestLanguage(req));
    const [row] = await db
      .insert(workflowTemplates)
      .values({ projectId: a.project.id, ...body, createdBy: a.user.id })
      .returning();
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "workflow_template.created",
      targetType: "workflow_template",
      targetId: row!.id,
      details: { name: body.name, kind: body.kind, steps: body.steps.length },
    });
    return toTemplateDto(row!);
  });

  api.put<{ Params: { pid: string; tid: string } }>("/projects/:pid/workflow-templates/:tid", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    requireProjectAdmin(a);
    const existing = await loadTemplate(db, a.project.id, req.params.tid);
    const body = await parseTemplateBody(db, a.project.id, req.body, [], requestLanguage(req));
    // Running instances keep their own snapshot; only new ones see the change.
    const [row] = await db
      .update(workflowTemplates)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(workflowTemplates.id, existing.id))
      .returning();
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "workflow_template.updated",
      targetType: "workflow_template",
      targetId: existing.id,
      details: { name: body.name, steps: body.steps.length },
    });
    return toTemplateDto(row!);
  });

  api.delete<{ Params: { pid: string; tid: string } }>("/projects/:pid/workflow-templates/:tid", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    requireProjectAdmin(a);
    const existing = await loadTemplate(db, a.project.id, req.params.tid);
    await db.update(workflowTemplates).set({ archivedAt: new Date() }).where(eq(workflowTemplates.id, existing.id));
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "workflow_template.deleted",
      targetType: "workflow_template",
      targetId: existing.id,
      details: { name: existing.name },
    });
    return { ok: true };
  });

  // ---- Folder settings (review gate) -------------------------------------------------------

  api.get<{ Params: { pid: string; fid: string } }>("/projects/:pid/folders/:fid/settings", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const tree = await FolderTree.load(db, a.project.id);
    if (!tree.visible(a.principal, req.params.fid)) throw notFound(msg("workflow:entities.folder"));
    return folderSettingsDto(db, tree, req.params.fid);
  });

  api.put<{ Params: { pid: string; fid: string } }>("/projects/:pid/folders/:fid/settings", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const body = z.object({ requireApprovedReview: z.boolean() }).parse(req.body);
    const tree = await FolderTree.load(db, a.project.id);
    requireAction(tree, a, req.params.fid, "manage");
    const now = new Date();
    await db
      .insert(folderSettings)
      .values({ folderId: req.params.fid, requireApprovedReview: body.requireApprovedReview, updatedAt: now })
      .onConflictDoUpdate({
        target: folderSettings.folderId,
        set: { requireApprovedReview: body.requireApprovedReview, updatedAt: now },
      });
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "folder.settings_updated",
      targetType: "folder",
      targetId: req.params.fid,
      details: { name: tree.get(req.params.fid).name, ...body },
    });
    return folderSettingsDto(db, tree, req.params.fid);
  });
}

async function folderSettingsDto(db: Db, tree: FolderTree, folderId: string): Promise<FolderSettingsDto> {
  const [own] = await db.select().from(folderSettings).where(eq(folderSettings.folderId, folderId));
  const gate = await folderGate(db, tree, folderId);
  return {
    folderId,
    requireApprovedReview: !!own?.requireApprovedReview,
    gated: gate.gated,
    gatedBy: gate.byFolderId ? tree.get(gate.byFolderId).name : null,
  };
}

async function loadTemplate(db: Db, projectId: string, tid: string) {
  if (!isUuid(tid)) throw notFound(msg("workflow:entities.template"));
  const [row] = await db
    .select()
    .from(workflowTemplates)
    .where(
      and(eq(workflowTemplates.id, tid), eq(workflowTemplates.projectId, projectId), isNull(workflowTemplates.archivedAt)),
    );
  if (!row) throw notFound(msg("workflow:entities.template"));
  return row;
}

export function toTemplateDto(r: typeof workflowTemplates.$inferSelect): WorkflowTemplateDto {
  return {
    id: r.id,
    projectId: r.projectId,
    kind: r.kind,
    name: r.name,
    steps: r.steps,
    finalOutcomes: r.finalOutcomes,
    chain: r.chainConfig ?? {},
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

