/**
 * Model markups (FP-3, docs/features/MODEL_MARKUP.md): pins and drawings on an IFC model view with
 * their viewpoint, comments, carrying over to a newer version and turning a markup into an issue.
 *
 * Visibility: a private markup only reaches its author; a project markup everyone who can see
 * every model version of its view (FolderTree, so the task-team WIP rule applies). Creating,
 * commenting and carrying over need markup permission in the folder of the markup's model.
 */
import { randomUUID } from "node:crypto";
import { and, asc, count, eq, inArray, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  can,
  carryVersionIds,
  MODEL_MARKUP_VISIBILITIES,
  type ModelMarkupAnchor,
  type ModelMarkupCommentDto,
  type ModelMarkupDetailDto,
  type ModelMarkupDto,
  type ModelMarkupListDto,
} from "@sitekeep/shared";
import type { AppDeps } from "../../app/deps.js";
import { FolderTree, isUuid, projectAccess, userNames, type ProjectAccess } from "../../core/security/access.js";
import { audit } from "../../core/platform/audit.js";
import { badRequest, conflict, forbidden, notFound } from "../../core/platform/http.js";
import type { Db } from "../../db/index.js";
import { fileVersions, files, issues, modelMarkupComments, modelMarkups, versionIndexes } from "../../db/schema.js";
import { loadVersionIndex } from "../../jobs/version-index.js";
import { requireModule } from "../../projects/modules.js";
import { msg } from "../../i18n/index.js";
import { isModelFile } from "../../files/model-formats.js";
import { insertIssue, viewpointSchema } from "./issues.js";
import { shapesSchema } from "./markups.js";

type Row = typeof modelMarkups.$inferSelect;

interface VersionRef {
  versionId: string;
  fileId: string;
  fileName: string;
  version: number;
  folderId: string;
  createdBy: string | null;
}

const vec3 = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const anchorSchema = z.object({
  point: vec3,
  globalId: z.string().max(64).nullable().optional(),
  fileVersionId: z.string().uuid().optional(),
});
const visibilitySchema = z.enum(MODEL_MARKUP_VISIBILITIES as [string, ...string[]]) as z.ZodType<"private" | "project">;
const titleSchema = z.string().trim().max(300);

const createSchema = z.object({
  kind: z.enum(["pin", "drawing"]),
  versionId: z.string().uuid(),
  title: titleSchema.optional(),
  color: colorSchema,
  visibility: visibilitySchema.optional(),
  viewpoint: viewpointSchema,
  anchor: anchorSchema.nullable().optional(),
  shapes: shapesSchema.optional(),
});

const updateSchema = z.object({
  title: titleSchema.optional(),
  color: colorSchema.optional(),
  status: z.enum(["open", "closed"]).optional(),
  visibility: visibilitySchema.optional(),
  shapes: shapesSchema.optional(),
});

const issueSchema = z.object({
  title: z.string().trim().min(1).max(300),
  description: z.string().trim().max(10000).nullable().optional(),
  priority: z.enum(["low", "normal", "high", "critical"]).optional(),
  type: z.string().trim().max(100).nullable().optional(),
});

const entity = msg("coordination:entities.modelMarkup");

export async function modelMarkupRoutes(api: FastifyInstance, { db, storage }: AppDeps) {
  /** Markups of the given model versions, and those of older versions of the same files not carried over yet. */
  api.get<{ Params: { pid: string }; Querystring: { versions?: string } }>("/projects/:pid/model-markups", async (req): Promise<ModelMarkupListDto> => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const tree = await FolderTree.load(db, a.project.id);
    const requested = (req.query.versions ?? "").split(",").filter(isUuid).slice(0, 100);
    const refs = await versionRefs(db, a.project.id, requested);
    const visible = requested.filter((v) => refs.has(v) && canView(tree, a, refs.get(v)!));
    if (!visible.length) return { current: [], older: [] };
    const fileIds = [...new Set(visible.map((v) => refs.get(v)!.fileId))];
    const rows = await db
      .select()
      .from(modelMarkups)
      .where(and(eq(modelMarkups.projectId, a.project.id), inArray(modelMarkups.fileId, fileIds)))
      .orderBy(asc(modelMarkups.createdAt));
    const seen = await visibleRows(db, tree, a, rows);
    const versionOf = new Map(visible.map((v) => [refs.get(v)!.fileId, refs.get(v)!.version]));
    const current = seen.filter((r) => visible.includes(r.versionId));
    const carried = new Set(current.map((r) => r.carriedFromId).filter(Boolean));
    const allRefs = await versionRefs(db, a.project.id, seen.map((r) => r.versionId));
    const older = seen.filter((r) => {
      if (visible.includes(r.versionId) || carried.has(r.id)) return false;
      const v = allRefs.get(r.versionId)?.version;
      return v !== undefined && v < (versionOf.get(r.fileId) ?? 0);
    });
    const dtos = await toDtos(db, [...current, ...older], allRefs, { withSnapshot: false });
    return { current: dtos.slice(0, current.length), older: dtos.slice(current.length) };
  });

  api.get<{ Params: { pid: string; mid: string } }>("/projects/:pid/model-markups/:mid", async (req): Promise<ModelMarkupDetailDto> => {
    const m = await loadMarkup(db, req.params.pid, req.params.mid, req.user!);
    return detail(m);
  });

  api.post<{ Params: { pid: string } }>("/projects/:pid/model-markups", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const tree = await FolderTree.load(db, a.project.id);
    const body = createSchema.parse(req.body);
    const viewIds = [...new Set(body.viewpoint.fileVersionIds)];
    if (!viewIds.includes(body.versionId)) throw badRequest(msg("coordination:modelMarkup.versionNotInView"));
    const refs = await versionRefs(db, a.project.id, viewIds);
    for (const id of viewIds) if (!refs.has(id) || !canView(tree, a, refs.get(id)!)) throw notFound(msg("coordination:entities.file"));
    const ref = refs.get(body.versionId)!;
    if (!isModelFile(ref.fileName)) throw badRequest(msg("coordination:modelMarkup.notIfc", { name: ref.fileName }));
    if (!canMarkup(tree, a, ref)) throw forbidden(msg("coordination:modelMarkup.markupDenied"));
    if (body.kind === "pin" && !body.anchor) throw badRequest(msg("coordination:modelMarkup.pinNeedsAnchor"));
    if (body.kind === "drawing" && !body.shapes?.length) throw badRequest(msg("coordination:modelMarkup.drawingNeedsShapes"));
    const [row] = await db
      .insert(modelMarkups)
      .values({
        projectId: a.project.id,
        fileId: ref.fileId,
        versionId: ref.versionId,
        versionIds: viewIds,
        kind: body.kind,
        title: body.title ?? "",
        color: body.color,
        visibility: body.visibility ?? "private",
        viewpoint: { ...body.viewpoint, guid: body.viewpoint.guid ?? randomUUID() },
        anchor: body.kind === "pin" ? (body.anchor as ModelMarkupAnchor) : null,
        shapes: body.kind === "drawing" ? body.shapes! : [],
        authorId: a.user.id,
      })
      .returning();
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "model_markup.created",
      targetType: "file",
      targetId: ref.fileId,
      details: { markupId: row!.id, kind: row!.kind, version: ref.version, visibility: row!.visibility },
    });
    return (await toDtos(db, [row!], refs))[0]!;
  });

  api.patch<{ Params: { pid: string; mid: string } }>("/projects/:pid/model-markups/:mid", async (req) => {
    const m = await loadMarkup(db, req.params.pid, req.params.mid, req.user!);
    const body = updateSchema.parse(req.body);
    const own = m.row.authorId === m.a.user.id;
    const { status, ...rest } = body;
    if (Object.values(rest).some((v) => v !== undefined) && !own) throw forbidden(msg("coordination:modelMarkup.editOwnOnly"));
    if (status !== undefined && !own && !m.a.isProjectAdmin) throw forbidden(msg("coordination:modelMarkup.statusRole"));
    if (body.shapes && m.row.kind !== "drawing") throw badRequest(msg("coordination:modelMarkup.drawingNeedsShapes"));
    const [row] = await db
      .update(modelMarkups)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(modelMarkups.id, m.row.id))
      .returning();
    await audit(db, {
      projectId: m.a.project.id,
      userId: m.a.user.id,
      action: status && status !== m.row.status ? (status === "closed" ? "model_markup.closed" : "model_markup.reopened") : "model_markup.updated",
      targetType: "file",
      targetId: m.row.fileId,
      details: { markupId: m.row.id, ...withoutShapes(body) },
    });
    return (await toDtos(db, [row!], m.refs))[0]!;
  });

  api.delete<{ Params: { pid: string; mid: string } }>("/projects/:pid/model-markups/:mid", async (req) => {
    const m = await loadMarkup(db, req.params.pid, req.params.mid, req.user!);
    if (m.row.authorId !== m.a.user.id && !m.a.isProjectAdmin) throw forbidden(msg("coordination:modelMarkup.deleteRole"));
    await db.delete(modelMarkups).where(eq(modelMarkups.id, m.row.id));
    await audit(db, {
      projectId: m.a.project.id,
      userId: m.a.user.id,
      action: "model_markup.deleted",
      targetType: "file",
      targetId: m.row.fileId,
      details: { markupId: m.row.id, kind: m.row.kind, title: m.row.title },
    });
    return { ok: true };
  });

  api.post<{ Params: { pid: string; mid: string } }>("/projects/:pid/model-markups/:mid/comments", async (req): Promise<ModelMarkupCommentDto> => {
    const m = await loadMarkup(db, req.params.pid, req.params.mid, req.user!);
    if (!canMarkup(m.tree, m.a, m.refs.get(m.row.versionId)!)) throw forbidden(msg("coordination:modelMarkup.markupDenied"));
    const body = z.object({ body: z.string().trim().min(1).max(10000) }).parse(req.body);
    const [row] = await db.insert(modelMarkupComments).values({ markupId: m.row.id, authorId: m.a.user.id, body: body.body }).returning();
    await db.update(modelMarkups).set({ updatedAt: new Date() }).where(eq(modelMarkups.id, m.row.id));
    await audit(db, {
      projectId: m.a.project.id,
      userId: m.a.user.id,
      action: "model_markup.commented",
      targetType: "file",
      targetId: m.row.fileId,
      details: { markupId: m.row.id },
    });
    return toCommentDto(row!, m.a.user.name);
  });

  /**
   * Copies a markup to a newer version of its file. The pin keeps its point; its element is looked
   * up by GlobalId in the newer version's element index and marked missing when it is gone.
   */
  api.post<{ Params: { pid: string; mid: string } }>("/projects/:pid/model-markups/:mid/carry-over", async (req) => {
    const m = await loadMarkup(db, req.params.pid, req.params.mid, req.user!);
    const body = z.object({ versionId: z.string().uuid() }).parse(req.body);
    const refs = await versionRefs(db, m.a.project.id, [body.versionId]);
    const target = refs.get(body.versionId);
    if (!target || !canView(m.tree, m.a, target)) throw notFound(msg("coordination:entities.file"));
    const from = m.refs.get(m.row.versionId)!;
    if (target.fileId !== m.row.fileId || target.version <= from.version) throw badRequest(msg("coordination:modelMarkup.carryNotNewer"));
    if (!canMarkup(m.tree, m.a, target)) throw forbidden(msg("coordination:modelMarkup.markupDenied"));
    const [existing] = await db
      .select()
      .from(modelMarkups)
      .where(and(eq(modelMarkups.carriedFromId, m.row.id), eq(modelMarkups.versionId, target.versionId)));
    const allRefs = new Map([...m.refs, ...refs]);
    if (existing) return { markup: (await toDtos(db, [existing], allRefs))[0]!, existing: true };

    const versionIds = carryVersionIds(m.row.versionIds, m.row.versionId, target.versionId);
    let anchor = m.row.anchor;
    if (anchor) {
      const found = anchor.globalId ? await elementInVersion(db, storage, target.versionId, anchor.globalId) : null;
      anchor = {
        ...anchor,
        ...(anchor.fileVersionId === m.row.versionId && { fileVersionId: target.versionId }),
        missing: found === false ? true : undefined,
      };
      if (!anchor.missing) delete anchor.missing;
    }
    const [row] = await db
      .insert(modelMarkups)
      .values({
        projectId: m.a.project.id,
        fileId: m.row.fileId,
        versionId: target.versionId,
        versionIds,
        kind: m.row.kind,
        title: m.row.title,
        color: m.row.color,
        status: m.row.status,
        visibility: m.row.visibility,
        viewpoint: { ...m.row.viewpoint, guid: randomUUID(), fileVersionIds: versionIds },
        anchor,
        shapes: m.row.shapes,
        authorId: m.a.user.id,
        carriedFromId: m.row.id,
      })
      .returning();
    await audit(db, {
      projectId: m.a.project.id,
      userId: m.a.user.id,
      action: "model_markup.carried_over",
      targetType: "file",
      targetId: m.row.fileId,
      details: { markupId: row!.id, fromMarkupId: m.row.id, fromVersion: from.version, toVersion: target.version, anchorMissing: !!anchor?.missing },
    });
    return { markup: (await toDtos(db, [row!], allRefs))[0]!, existing: false };
  });

  /**
   * Creates an issue from the markup: its viewpoint (snapshot with the drawing) becomes the issue's
   * primary BCF viewpoint and a pin becomes the issue pin. A private markup becomes project-visible,
   * since the issue shows it to the project.
   */
  api.post<{ Params: { pid: string; mid: string } }>("/projects/:pid/model-markups/:mid/issue", async (req) => {
    const m = await loadMarkup(db, req.params.pid, req.params.mid, req.user!);
    requireModule(m.a, "issues");
    if (m.row.issueId) {
      const [prev] = await db.select({ number: issues.number }).from(issues).where(eq(issues.id, m.row.issueId));
      if (prev) throw conflict(msg("coordination:modelMarkup.issueExists", { number: prev.number }), { issueId: m.row.issueId });
    }
    const body = issueSchema.parse(req.body);
    const anchor = m.row.anchor;
    const issue = await insertIssue(db, m.a.project.id, m.a.user.id, {
      ...body,
      viewpoint: { ...m.row.viewpoint, guid: randomUUID() },
      pin: anchor
        ? { position: anchor.point, fileVersionId: anchor.fileVersionId ?? m.row.versionId, ...(anchor.globalId && { globalId: anchor.globalId }) }
        : null,
    });
    const publish = m.row.visibility === "private" && m.row.authorId === m.a.user.id;
    const [row] = await db
      .update(modelMarkups)
      .set({ issueId: issue.id, ...(publish && { visibility: "project" as const }), updatedAt: new Date() })
      .where(eq(modelMarkups.id, m.row.id))
      .returning();
    await audit(db, {
      projectId: m.a.project.id,
      userId: m.a.user.id,
      action: "issue.created",
      targetType: "issue",
      targetId: issue.id,
      details: { number: issue.number, title: issue.title, fromModelMarkup: m.row.id },
    });
    await audit(db, {
      projectId: m.a.project.id,
      userId: m.a.user.id,
      action: "model_markup.issue_created",
      targetType: "file",
      targetId: m.row.fileId,
      details: { markupId: m.row.id, issueNumber: issue.number, published: publish },
    });
    return { markup: (await toDtos(db, [row!], m.refs))[0]!, issue: { id: issue.id, number: issue.number } };
  });

  async function detail(m: Awaited<ReturnType<typeof loadMarkup>>): Promise<ModelMarkupDetailDto> {
    const comments = await db
      .select()
      .from(modelMarkupComments)
      .where(eq(modelMarkupComments.markupId, m.row.id))
      .orderBy(asc(modelMarkupComments.createdAt));
    const names = await userNames(db, comments.map((c) => c.authorId));
    const [dto] = await toDtos(db, [m.row], m.refs);
    return {
      ...dto!,
      comments: comments.map((c) => toCommentDto(c, names.get(c.authorId))),
      canEdit: m.row.authorId === m.a.user.id,
      canComment: canMarkup(m.tree, m.a, m.refs.get(m.row.versionId)!),
    };
  }
}

/** A markup the caller can see (404 otherwise, so hidden markups and models are not revealed). */
async function loadMarkup(db: Db, pid: string, mid: string, user: NonNullable<import("fastify").FastifyRequest["user"]>) {
  const a = await projectAccess(db, pid, user);
  if (!isUuid(mid)) throw notFound(entity);
  const [row] = await db.select().from(modelMarkups).where(and(eq(modelMarkups.id, mid), eq(modelMarkups.projectId, a.project.id)));
  if (!row) throw notFound(entity);
  const tree = await FolderTree.load(db, a.project.id);
  const refs = await versionRefs(db, a.project.id, [...new Set([row.versionId, ...row.versionIds])]);
  if (!rowVisible(tree, a, row, refs)) throw notFound(entity);
  return { a, tree, row, refs };
}

async function versionRefs(db: Db, projectId: string, ids: string[]): Promise<Map<string, VersionRef>> {
  const list = [...new Set(ids.filter(isUuid))];
  if (!list.length) return new Map();
  const rows = await db
    .select({
      versionId: fileVersions.id,
      fileId: files.id,
      fileName: files.name,
      version: fileVersions.version,
      folderId: files.folderId,
      createdBy: files.createdBy,
    })
    .from(fileVersions)
    .innerJoin(files, eq(files.id, fileVersions.fileId))
    .where(and(inArray(fileVersions.id, list), eq(files.projectId, projectId), isNull(files.deletedAt)));
  return new Map(rows.map((r) => [r.versionId, r]));
}

/** Same rule as requireView (documents/policy.ts), without throwing. */
function canView(tree: FolderTree, a: ProjectAccess, ref: VersionRef): boolean {
  if (!tree.byId.has(ref.folderId)) return false;
  const p = tree.permission(a.principal, ref.folderId);
  return can(p.level, "view") || (p.canUpload && ref.createdBy === a.user.id);
}

function canMarkup(tree: FolderTree, a: ProjectAccess, ref: VersionRef): boolean {
  return tree.byId.has(ref.folderId) && can(tree.permission(a.principal, ref.folderId).level, "markup");
}

function rowVisible(tree: FolderTree, a: ProjectAccess, row: Row, refs: Map<string, VersionRef>): boolean {
  if (row.visibility !== "project" && row.authorId !== a.user.id) return false;
  return [row.versionId, ...row.versionIds].every((id) => {
    const ref = refs.get(id);
    return !!ref && canView(tree, a, ref);
  });
}

async function visibleRows(db: Db, tree: FolderTree, a: ProjectAccess, rows: Row[]): Promise<Row[]> {
  const refs = await versionRefs(db, a.project.id, rows.flatMap((r) => [r.versionId, ...r.versionIds]));
  return rows.filter((r) => rowVisible(tree, a, r, refs));
}

/** true / false when the version's element index answers, null when there is no index yet. */
async function elementInVersion(db: Db, storage: AppDeps["storage"], versionId: string, globalId: string): Promise<boolean | null> {
  const [idx] = await db.select().from(versionIndexes).where(eq(versionIndexes.versionId, versionId));
  if (!idx) return null;
  try {
    const elements = await loadVersionIndex(storage, versionId, idx.storageKey);
    return Object.prototype.hasOwnProperty.call(elements, globalId);
  } catch {
    return null;
  }
}

async function toDtos(db: Db, rows: Row[], refs: Map<string, VersionRef>, opts: { withSnapshot?: boolean } = {}): Promise<ModelMarkupDto[]> {
  if (!rows.length) return [];
  const names = await userNames(db, rows.map((r) => r.authorId));
  const ids = rows.map((r) => r.id);
  const counts = await db
    .select({ id: modelMarkupComments.markupId, n: count() })
    .from(modelMarkupComments)
    .where(inArray(modelMarkupComments.markupId, ids))
    .groupBy(modelMarkupComments.markupId);
  const countOf = new Map(counts.map((c) => [c.id, Number(c.n)]));
  const issueIds = rows.map((r) => r.issueId).filter((x): x is string => !!x);
  const numbers = issueIds.length
    ? new Map((await db.select({ id: issues.id, number: issues.number }).from(issues).where(inArray(issues.id, issueIds))).map((i) => [i.id, i.number]))
    : new Map<string, number>();
  return rows.map((r) => {
    const ref = refs.get(r.versionId);
    return {
      id: r.id,
      projectId: r.projectId,
      fileId: r.fileId,
      fileName: ref?.fileName,
      versionId: r.versionId,
      version: ref?.version,
      versionIds: r.versionIds,
      kind: r.kind,
      title: r.title,
      color: r.color,
      status: r.status,
      visibility: r.visibility,
      viewpoint: opts.withSnapshot === false ? { ...r.viewpoint, snapshot: undefined } : r.viewpoint,
      anchor: r.anchor ?? null,
      shapes: r.shapes,
      authorId: r.authorId,
      authorName: names.get(r.authorId),
      issueId: r.issueId,
      issueNumber: r.issueId ? (numbers.get(r.issueId) ?? null) : null,
      carriedFromId: r.carriedFromId,
      commentCount: countOf.get(r.id) ?? 0,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  });
}

function toCommentDto(r: typeof modelMarkupComments.$inferSelect, authorName: string | undefined): ModelMarkupCommentDto {
  return { id: r.id, markupId: r.markupId, authorId: r.authorId, authorName, body: r.body, createdAt: r.createdAt.toISOString() };
}

function withoutShapes<T extends { shapes?: unknown }>(body: T) {
  const { shapes, ...rest } = body;
  return shapes === undefined ? rest : { ...rest, shapes: (shapes as unknown[]).length };
}
