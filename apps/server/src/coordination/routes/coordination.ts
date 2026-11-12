/**
 * Model coordination API: model sets (federations + saved views), clash tests, clash results
 * with stable ids, group assignment, issues from clash groups and the statistics summary.
 */
import { capability } from "../../sdk/capabilities.js";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  type ModelSetDto,
  type ModelSetItem,
} from "@sitekeep/shared";
import type { AppDeps } from "../../app/deps.js";
import { FolderTree, isUuid, projectAccess, userNames, type AuthUser, type ProjectAccess } from "../../core/security/access.js";
import { audit } from "../../core/platform/audit.js";
import type { Db } from "../../db/index.js";
import {
  files,
  modelSetViews,
  modelSets,
} from "../../db/schema.js";
import { badRequest, conflict, forbidden, notFound } from "../../core/platform/http.js";
import { requireModule } from "../../projects/modules.js";
import {
  isIfc,
  registerIdsJob,
  resolveItems,
} from "../../coordination/service.js";
import { requireView } from "../../modules/documents/public.js";
import { viewerStateFields } from "../../bcf/viewpoint-schema.js";
import { msg, type Msg } from "../../i18n/index.js";

type SetRow = typeof modelSets.$inferSelect;

const itemSchema = z.object({ fileId: z.string().uuid(), versionId: z.string().uuid().nullable().default(null) });
const vec3 = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
const ruleSchema = z.object({
  classes: z.array(z.string().trim().min(1).max(100)).max(100),
  fileIds: z.array(z.string().uuid()).max(200).optional(),
  action: z.enum(["hide", "color", "isolate"]),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  opacity: z.number().min(0).max(1).optional(),
});
const viewStateSchema = z.object({
  camera: z.object({ position: vec3, target: vec3, projection: z.enum(["perspective", "orthographic"]) }),
  hiddenFileIds: z.array(z.string().uuid()).max(200).default([]),
  rules: z.array(ruleSchema).max(50).default([]),
  ...viewerStateFields,
});

/** Model sets (federated models and saved views). Clash tests are the Coordinate module's. */
export async function coordinationRoutes(api: FastifyInstance, deps: AppDeps) {
  const { db, storage, jobs } = deps;
  registerIdsJob(db, storage, jobs);

  // ---------------------------------------------------------------- model sets

  api.get<{ Params: { pid: string } }>("/projects/:pid/model-sets", async (req) => {
    const ctx = await context(db, req.params.pid, req.user!);
    const rows = await db.select().from(modelSets).where(eq(modelSets.projectId, ctx.a.project.id)).orderBy(asc(modelSets.name));
    return Promise.all(rows.map((r) => toSetDto(db, ctx, r)));
  });

  api.post<{ Params: { pid: string } }>("/projects/:pid/model-sets", async (req) => {
    const ctx = await context(db, req.params.pid, req.user!);
    requireModule(ctx.a, "coordination");
    const body = z
      .object({ name: z.string().trim().min(1).max(200), description: z.string().trim().max(2000).nullable().optional(), items: z.array(itemSchema).max(200) })
      .parse(req.body);
    const items = await checkItems(db, ctx, body.items);
    const [row] = await db
      .insert(modelSets)
      .values({ projectId: ctx.a.project.id, name: body.name, description: body.description ?? null, items, createdBy: ctx.a.user.id })
      .returning();
    await audit(db, { projectId: ctx.a.project.id, userId: ctx.a.user.id, action: "model_set.created", targetType: "model_set", targetId: row!.id, details: { name: body.name, files: items.length } });
    return toSetDto(db, ctx, row!);
  });

  api.get<{ Params: { pid: string; sid: string } }>("/projects/:pid/model-sets/:sid", async (req) => {
    const ctx = await context(db, req.params.pid, req.user!);
    return toSetDto(db, ctx, await loadSet(db, ctx, req.params.sid));
  });

  api.patch<{ Params: { pid: string; sid: string } }>("/projects/:pid/model-sets/:sid", async (req) => {
    const ctx = await context(db, req.params.pid, req.user!);
    const set = await loadSet(db, ctx, req.params.sid);
    requireOwner(ctx, set.createdBy, msg("coordination:errors.setEditOwner"));
    const body = z
      .object({
        name: z.string().trim().min(1).max(200).optional(),
        description: z.string().trim().max(2000).nullable().optional(),
        items: z.array(itemSchema).max(200).optional(),
      })
      .parse(req.body);
    const items = body.items ? await checkItems(db, ctx, body.items) : set.items;
    if (body.items) {
      // Tests must keep pointing at files of the set.
      const ids = new Set(items.map((i) => i.fileId));
      const user = await capability("coordinate.modelSets")?.testUsingRemovedFile(db, set.id, ids);
      if (user) throw conflict(msg("coordination:errors.testUsesRemovedFile", { name: user }));
    }
    const [row] = await db
      .update(modelSets)
      .set({ name: body.name ?? set.name, description: body.description === undefined ? set.description : body.description, items, updatedAt: new Date() })
      .where(eq(modelSets.id, set.id))
      .returning();
    await audit(db, { projectId: ctx.a.project.id, userId: ctx.a.user.id, action: "model_set.updated", targetType: "model_set", targetId: set.id, details: { name: row!.name } });
    return toSetDto(db, ctx, row!);
  });

  api.delete<{ Params: { pid: string; sid: string } }>("/projects/:pid/model-sets/:sid", async (req) => {
    const ctx = await context(db, req.params.pid, req.user!);
    const set = await loadSet(db, ctx, req.params.sid);
    requireOwner(ctx, set.createdBy, msg("coordination:errors.setDeleteOwner"));
    if (await capability("coordinate.modelSets")?.hasTests(db, set.id)) throw conflict(msg("coordination:errors.setHasTests"));
    await db.delete(modelSets).where(eq(modelSets.id, set.id));
    await audit(db, { projectId: ctx.a.project.id, userId: ctx.a.user.id, action: "model_set.deleted", targetType: "model_set", targetId: set.id, details: { name: set.name } });
    return { ok: true };
  });

  /** Saves a view (camera, hidden files, class rules) to a set; every member who sees the set may. */
  api.post<{ Params: { pid: string; sid: string } }>("/projects/:pid/model-sets/:sid/views", async (req) => {
    const ctx = await context(db, req.params.pid, req.user!);
    const set = await loadSet(db, ctx, req.params.sid);
    const body = z.object({ name: z.string().trim().min(1).max(200), state: viewStateSchema }).parse(req.body);
    const ids = new Set(set.items.map((i) => i.fileId));
    if (body.state.hiddenFileIds.some((f) => !ids.has(f))) throw badRequest(msg("coordination:errors.hiddenFilesNotInSet"));
    const [row] = await db
      .insert(modelSetViews)
      .values({ modelSetId: set.id, name: body.name, state: body.state, createdBy: ctx.a.user.id })
      .returning();
    return { ...row!, createdAt: row!.createdAt.toISOString(), createdByName: ctx.a.user.name };
  });

  api.delete<{ Params: { pid: string; sid: string; vid: string } }>("/projects/:pid/model-sets/:sid/views/:vid", async (req) => {
    const ctx = await context(db, req.params.pid, req.user!);
    const set = await loadSet(db, ctx, req.params.sid);
    if (!isUuid(req.params.vid)) throw notFound(msg("coordination:entities.view"));
    const [view] = await db
      .select()
      .from(modelSetViews)
      .where(and(eq(modelSetViews.id, req.params.vid), eq(modelSetViews.modelSetId, set.id)));
    if (!view) throw notFound(msg("coordination:entities.view"));
    requireOwner(ctx, view.createdBy, msg("coordination:errors.viewDeleteOwner"));
    await db.delete(modelSetViews).where(eq(modelSetViews.id, view.id));
    return { ok: true };
  });
}

// ------------------------------------------------------------------------------------ helpers

export interface Ctx {
  a: ProjectAccess;
  tree: FolderTree;
}

export async function context(db: Db, pid: string, user: AuthUser): Promise<Ctx> {
  const a = await projectAccess(db, pid, user);
  return { a, tree: await FolderTree.load(db, a.project.id) };
}

function requireOwner(ctx: Ctx, createdBy: string | null, message: Msg) {
  if (ctx.a.isProjectAdmin || createdBy === ctx.a.user.id) return;
  throw forbidden(message);
}

export async function loadSet(db: Db, ctx: Ctx, sid: string): Promise<SetRow> {
  if (!isUuid(sid)) throw notFound(msg("coordination:entities.modelSet"));
  const [row] = await db.select().from(modelSets).where(and(eq(modelSets.id, sid), eq(modelSets.projectId, ctx.a.project.id)));
  if (!row) throw notFound(msg("coordination:entities.modelSet"));
  return row;
}

export async function setsById(db: Db, ids: string[]) {
  const unique = [...new Set(ids)];
  const rows = unique.length ? await db.select().from(modelSets).where(inArray(modelSets.id, unique)) : [];
  return new Map(rows.map((r) => [r.id, r]));
}

export function fileVisible(ctx: Ctx, file: typeof files.$inferSelect): boolean {
  if (!ctx.tree.byId.has(file.folderId)) return false;
  try {
    requireView(ctx.tree, ctx.a, file);
    return true;
  } catch {
    return false;
  }
}

/** Items must be IFC files of the project the caller can see; pinned versions must belong to the file. */
async function checkItems(db: Db, ctx: Ctx, items: ModelSetItem[]): Promise<ModelSetItem[]> {
  const seen = new Set<string>();
  const out: ModelSetItem[] = [];
  for (const it of items) {
    if (seen.has(it.fileId)) continue;
    seen.add(it.fileId);
    out.push(it);
  }
  const resolved = await resolveItems(db, ctx.a.project.id, out);
  for (const r of resolved) {
    if (!r.file || !fileVisible(ctx, r.file)) throw notFound(msg("coordination:entities.file"));
    if (!isIfc(r.file.name)) throw badRequest(msg("coordination:errors.notIfcForSet", { name: r.file.name }));
    if (!r.version) throw badRequest(msg("coordination:errors.pinnedVersionMismatch", { name: r.file.name }));
  }
  return out;
}

async function toSetDto(db: Db, ctx: Ctx, set: SetRow): Promise<ModelSetDto> {
  const resolved = await resolveItems(db, ctx.a.project.id, set.items);
  const views = await db.select().from(modelSetViews).where(eq(modelSetViews.modelSetId, set.id)).orderBy(asc(modelSetViews.name));
  const names = await userNames(db, [set.createdBy, ...views.map((v) => v.createdBy)]);
  return {
    id: set.id,
    projectId: set.projectId,
    name: set.name,
    description: set.description,
    items: resolved.map((r) => {
      if (!r.file) return { ...r.item, fileName: null, folderPath: null, resolvedVersionId: null, resolvedVersion: null, derivativeStatus: null, missing: true };
      if (!fileVisible(ctx, r.file))
        return { fileId: r.item.fileId, versionId: null, fileName: null, folderPath: null, resolvedVersionId: null, resolvedVersion: null, derivativeStatus: null, hidden: true };
      return {
        ...r.item,
        fileName: r.file.name,
        folderPath: ctx.tree
          .ancestry(r.file.folderId)
          .map((id) => ctx.tree.get(id).name)
          .join(" / "),
        resolvedVersionId: r.version?.id ?? null,
        resolvedVersion: r.version?.version ?? null,
        derivativeStatus: r.version?.derivativeStatus ?? null,
        missing: !r.version || undefined,
      };
    }),
    views: views.map((v) => ({
      id: v.id,
      modelSetId: v.modelSetId,
      name: v.name,
      state: v.state,
      createdBy: v.createdBy,
      createdByName: v.createdBy ? names.get(v.createdBy) : undefined,
      createdAt: v.createdAt.toISOString(),
    })),
    createdBy: set.createdBy,
    createdByName: set.createdBy ? names.get(set.createdBy) : undefined,
    createdAt: set.createdAt.toISOString(),
    updatedAt: set.updatedAt.toISOString(),
    canEdit: ctx.a.isProjectAdmin || set.createdBy === ctx.a.user.id,
  };
}
