import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  ATTRIBUTE_TYPES,
  checkAttributeDefinition,
  type AttributeDefinitionDto,
  type EffectiveAttributeDto,
} from "@sitekeep/shared";
import type { AppDeps } from "../../app/deps.js";
import { FolderTree, isUuid, projectAccess, requireAction, requireProjectAdmin } from "../../core/security/access.js";
import { audit } from "../../core/platform/audit.js";
import type { Db } from "../../db/index.js";
import { attributeDefinitions, files, folderAttributeBindings } from "../../db/schema.js";
import { badRequest, notFound } from "../../core/platform/http.js";
import { msg, requestLanguage } from "../../i18n/index.js";

type DefinitionRow = typeof attributeDefinitions.$inferSelect;

const definitionSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .refine((n) => !/[\x00-\x1f]/.test(n), "Öznitelik adında kontrol karakteri olamaz."), // i18n-ok: zod issue detail (validation details stay untranslated),
  type: z.enum(ATTRIBUTE_TYPES),
  options: z.array(z.string().trim().min(1).max(200)).max(500).optional(),
  required: z.boolean().optional(),
});

export async function attributeRoutes(api: FastifyInstance, { db }: AppDeps) {
  api.get<{ Params: { pid: string } }>("/projects/:pid/attribute-definitions", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const rows = await db
      .select()
      .from(attributeDefinitions)
      .where(eq(attributeDefinitions.projectId, a.project.id))
      .orderBy(asc(attributeDefinitions.createdAt), asc(attributeDefinitions.name));
    return rows.map(toDefinitionDto);
  });

  api.post<{ Params: { pid: string } }>("/projects/:pid/attribute-definitions", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    requireProjectAdmin(a);
    const body = parseDefinition(req.body, requestLanguage(req));
    const [row] = await db
      .insert(attributeDefinitions)
      .values({ projectId: a.project.id, ...body })
      .returning();
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "attribute.created",
      targetType: "attribute_definition",
      targetId: row!.id,
      details: { name: row!.name, type: row!.type, required: row!.required },
    });
    return toDefinitionDto(row!);
  });

  /** Renaming a definition also renames the key on every file of the project. */
  api.patch<{ Params: { pid: string; did: string } }>("/projects/:pid/attribute-definitions/:did", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    requireProjectAdmin(a);
    const current = await loadDefinition(db, a.project.id, req.params.did);
    const patch = definitionSchema.partial().parse(req.body);
    const merged = parseDefinition({
      name: patch.name ?? current.name,
      type: patch.type ?? current.type,
      options: patch.options ?? current.options,
      required: patch.required ?? current.required,
    }, requestLanguage(req));
    const row = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(attributeDefinitions)
        .set(merged)
        .where(eq(attributeDefinitions.id, current.id))
        .returning();
      if (merged.name !== current.name) {
        await tx
          .update(files)
          .set({
            attributes: sql`(${files.attributes} - ${current.name}::text) || jsonb_build_object(${merged.name}::text, ${files.attributes} -> ${current.name}::text)`,
          })
          .where(and(eq(files.projectId, a.project.id), sql`${files.attributes} ? ${current.name}::text`));
      }
      return updated!;
    });
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "attribute.updated",
      targetType: "attribute_definition",
      targetId: row.id,
      details: { name: row.name, from: { name: current.name, type: current.type }, ...patch },
    });
    return toDefinitionDto(row);
  });

  /** Removes the definition and its bindings; values already on files stay as free-form attributes. */
  api.delete<{ Params: { pid: string; did: string } }>("/projects/:pid/attribute-definitions/:did", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    requireProjectAdmin(a);
    const current = await loadDefinition(db, a.project.id, req.params.did);
    await db.delete(attributeDefinitions).where(eq(attributeDefinitions.id, current.id));
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "attribute.deleted",
      targetType: "attribute_definition",
      targetId: current.id,
      details: { name: current.name },
    });
    return { ok: true };
  });

  /** Definitions that apply to a folder: its own bindings plus those of every ancestor. */
  api.get<{ Params: { pid: string; fid: string } }>("/projects/:pid/folders/:fid/attribute-definitions", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const tree = await FolderTree.load(db, a.project.id);
    if (!isUuid(req.params.fid) || !tree.byId.has(req.params.fid) || !tree.visible(a.principal, req.params.fid))
      throw notFound(msg("documents:entities.folder"));
    return effectiveDefinitions(db, tree, req.params.fid);
  });

  /** Replaces the folder's direct bindings (inherited ones are not affected). */
  api.put<{ Params: { pid: string; fid: string } }>("/projects/:pid/folders/:fid/attribute-bindings", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const body = z.object({ definitionIds: z.array(z.string().uuid()).max(200) }).parse(req.body);
    const tree = await FolderTree.load(db, a.project.id);
    const folder = tree.get(req.params.fid);
    requireAction(tree, a, folder.id, "manage");
    const ids = [...new Set(body.definitionIds)];
    if (ids.length) {
      const found = await db
        .select({ id: attributeDefinitions.id })
        .from(attributeDefinitions)
        .where(and(eq(attributeDefinitions.projectId, a.project.id), inArray(attributeDefinitions.id, ids)));
      if (found.length !== ids.length) throw notFound(msg("documents:entities.attributeDefinition"));
    }
    await db.transaction(async (tx) => {
      await tx.delete(folderAttributeBindings).where(eq(folderAttributeBindings.folderId, folder.id));
      if (ids.length)
        await tx.insert(folderAttributeBindings).values(ids.map((definitionId) => ({ folderId: folder.id, definitionId })));
    });
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "folder.attributes_bound",
      targetType: "folder",
      targetId: folder.id,
      details: { name: folder.name, definitionIds: ids },
    });
    return effectiveDefinitions(db, tree, folder.id);
  });

  api.post<{ Params: { pid: string; fid: string; did: string } }>(
    "/projects/:pid/folders/:fid/attribute-bindings/:did",
    async (req) => {
      const a = await projectAccess(db, req.params.pid, req.user!);
      const tree = await FolderTree.load(db, a.project.id);
      const folder = tree.get(req.params.fid);
      requireAction(tree, a, folder.id, "manage");
      const def = await loadDefinition(db, a.project.id, req.params.did);
      await db.insert(folderAttributeBindings).values({ folderId: folder.id, definitionId: def.id }).onConflictDoNothing();
      await audit(db, {
        projectId: a.project.id,
        userId: a.user.id,
        action: "folder.attribute_bound",
        targetType: "folder",
        targetId: folder.id,
        details: { name: folder.name, attribute: def.name },
      });
      return effectiveDefinitions(db, tree, folder.id);
    },
  );

  api.delete<{ Params: { pid: string; fid: string; did: string } }>(
    "/projects/:pid/folders/:fid/attribute-bindings/:did",
    async (req) => {
      const a = await projectAccess(db, req.params.pid, req.user!);
      const tree = await FolderTree.load(db, a.project.id);
      const folder = tree.get(req.params.fid);
      requireAction(tree, a, folder.id, "manage");
      const def = await loadDefinition(db, a.project.id, req.params.did);
      await db
        .delete(folderAttributeBindings)
        .where(and(eq(folderAttributeBindings.folderId, folder.id), eq(folderAttributeBindings.definitionId, def.id)));
      await audit(db, {
        projectId: a.project.id,
        userId: a.user.id,
        action: "folder.attribute_unbound",
        targetType: "folder",
        targetId: folder.id,
        details: { name: folder.name, attribute: def.name },
      });
      return effectiveDefinitions(db, tree, folder.id);
    },
  );
}

/**
 * Definitions bound to the folder or any ancestor (union), each with the nearest folder
 * it is bound to. Ordered by creation, like the settings list.
 */
export async function effectiveDefinitions(db: Db, tree: FolderTree, folderId: string): Promise<EffectiveAttributeDto[]> {
  const chain = tree.ancestry(folderId);
  const rows = await db
    .select({ def: attributeDefinitions, folderId: folderAttributeBindings.folderId })
    .from(folderAttributeBindings)
    .innerJoin(attributeDefinitions, eq(attributeDefinitions.id, folderAttributeBindings.definitionId))
    .where(inArray(folderAttributeBindings.folderId, chain));
  const depth = new Map(chain.map((id, i) => [id, i]));
  const nearest = new Map<string, { def: DefinitionRow; folderId: string }>();
  for (const r of rows) {
    const cur = nearest.get(r.def.id);
    if (!cur || depth.get(r.folderId)! > depth.get(cur.folderId)!) nearest.set(r.def.id, r);
  }
  return [...nearest.values()]
    .sort((x, y) => x.def.createdAt.getTime() - y.def.createdAt.getTime() || x.def.name.localeCompare(y.def.name, "tr"))
    .map((r) => ({ ...toDefinitionDto(r.def), boundFolderId: r.folderId, inherited: r.folderId !== folderId }));
}

async function loadDefinition(db: Db, projectId: string, id: string): Promise<DefinitionRow> {
  if (!isUuid(id)) throw notFound(msg("documents:entities.attributeDefinition"));
  const [row] = await db
    .select()
    .from(attributeDefinitions)
    .where(and(eq(attributeDefinitions.id, id), eq(attributeDefinitions.projectId, projectId)));
  if (!row) throw notFound(msg("documents:entities.attributeDefinition"));
  return row;
}

function parseDefinition(body: unknown, lang: string) {
  const d = definitionSchema.parse(body);
  const options = d.type === "list" ? (d.options ?? []).map((o) => o.trim()) : [];
  const def = { name: d.name, type: d.type, options, required: d.required ?? false };
  const problems = checkAttributeDefinition(def, lang);
  if (problems.length) throw badRequest(problems.join(" "), problems);
  return def;
}

export function toDefinitionDto(r: DefinitionRow): AttributeDefinitionDto {
  return {
    id: r.id,
    projectId: r.projectId,
    name: r.name,
    type: r.type,
    options: r.options,
    required: r.required,
    createdAt: r.createdAt.toISOString(),
  };
}
