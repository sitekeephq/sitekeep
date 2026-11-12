import { and, asc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { checkStandard, validateName, type NamingStandard } from "@sitekeep/shared";
import type { AppDeps } from "../../app/deps.js";
import { FolderTree, projectAccess, requireAction, requireProjectAdmin } from "../../core/security/access.js";
import { audit } from "../../core/platform/audit.js";
import type { Db } from "../../db/index.js";
import { namingStandards } from "../../db/schema.js";
import { badRequest, notFound } from "../../core/platform/http.js";
import { msg, requestLanguage } from "../../i18n/index.js";

const valueSchema = z.object({ code: z.string().trim().min(1), description: z.string().optional() });
/** false = metadata field (attribute only, not part of the name). */
const inName = z.boolean().optional();
const fieldSchema = z.discriminatedUnion("type", [
  z.object({ name: z.string().trim().min(1), type: z.literal("list"), values: z.array(valueSchema).min(1), inName }),
  z.object({
    name: z.string().trim().min(1),
    type: z.literal("text"),
    minLength: z.number().int().min(0).optional(),
    maxLength: z.number().int().min(1).optional(),
    inName,
  }),
  z.object({
    name: z.string().trim().min(1),
    type: z.literal("number"),
    digits: z.number().int().min(1).max(12),
    minDigits: z.number().int().min(1).max(12).optional(),
    maxDigits: z.number().int().min(1).max(12).optional(),
    inName,
  }),
]);
export const standardSchema = z.object({
  name: z.string().trim().min(1),
  delimiter: z.string().length(1),
  fields: z.array(fieldSchema).min(1).max(30),
  allowSuffix: z.boolean().optional(),
  allowDelimiterInCodes: z.boolean().optional(),
});

export async function namingRoutes(api: FastifyInstance, { db }: AppDeps) {
  api.get<{ Params: { pid: string } }>("/projects/:pid/naming-standards", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const rows = await db
      .select()
      .from(namingStandards)
      .where(eq(namingStandards.projectId, a.project.id))
      .orderBy(asc(namingStandards.createdAt));
    return rows.map(toDto);
  });

  api.post<{ Params: { pid: string } }>("/projects/:pid/naming-standards", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    requireProjectAdmin(a);
    const definition = parseStandard(req.body, requestLanguage(req));
    const [row] = await db.insert(namingStandards).values({ projectId: a.project.id, definition }).returning();
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "naming.created",
      targetType: "naming_standard",
      targetId: row!.id,
      details: { name: definition.name },
    });
    return toDto(row!);
  });

  api.put<{ Params: { pid: string; sid: string } }>("/projects/:pid/naming-standards/:sid", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    requireProjectAdmin(a);
    const definition = parseStandard(req.body, requestLanguage(req));
    const [row] = await db
      .update(namingStandards)
      .set({ definition })
      .where(and(eq(namingStandards.id, req.params.sid), eq(namingStandards.projectId, a.project.id)))
      .returning();
    if (!row) throw notFound(msg("documents:entities.namingStandard"));
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "naming.updated",
      targetType: "naming_standard",
      targetId: row.id,
    });
    return toDto(row);
  });

  /**
   * Checks names against the standard that applies to a folder, without uploading.
   * Used by the web uploader, the MCP server and AECPilot deliveries.
   */
  api.post<{ Params: { pid: string } }>("/projects/:pid/naming/validate", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const body = z
      .object({ folderId: z.string().uuid(), names: z.array(z.string().min(1)).min(1).max(1000) })
      .parse(req.body);
    const tree = await FolderTree.load(db, a.project.id);
    requireAction(tree, a, body.folderId, "upload");
    const standard = await standardForFolder(db, tree, body.folderId);
    return {
      standard: standard?.name ?? null,
      results: body.names.map((name) =>
        standard ? { name, ...validateName(standard, name, requestLanguage(req)) } : { name, ok: true, errors: [], fields: [] },
      ),
    };
  });
}

export async function standardForFolder(db: Db, tree: FolderTree, folderId: string): Promise<NamingStandard | null> {
  const sid = tree.namingStandardId(folderId);
  if (!sid) return null;
  const [row] = await db.select().from(namingStandards).where(eq(namingStandards.id, sid));
  return row?.definition ?? null;
}

function parseStandard(body: unknown, lang: string): NamingStandard {
  const definition = standardSchema.parse(body) as NamingStandard;
  const problems = checkStandard(definition, lang);
  if (problems.length) throw badRequest(problems.join(" "), problems);
  return definition;
}

function toDto(r: typeof namingStandards.$inferSelect) {
  return { id: r.id, projectId: r.projectId, definition: r.definition };
}
