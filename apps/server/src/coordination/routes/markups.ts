/**
 * PDF viewing and markups (Sprint B): inline content for viewers, markups per file version
 * (drafts private to their author until published, like Forma) and issue links.
 */
import { and, asc, eq, inArray, or } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { can, splitExtension, type IssueLinkDto, type IssueLinkKind, type MarkupDto, type VersionInfoDto } from "@sitekeep/shared";
import type { AppDeps } from "../../app/deps.js";
import { isUuid, projectAccess, userNames, type AuthUser } from "../../core/security/access.js";
import { audit } from "../../core/platform/audit.js";
import type { Db } from "../../db/index.js";
import { fileMarkups, issueLinks, issues } from "../../db/schema.js";
import { forbidden, notFound } from "../../core/platform/http.js";
import { loadVersion, requireView } from "../../modules/documents/public.js";
import { capability } from "../../sdk/capabilities.js";
import { DEFAULT_LANGUAGE, msg, render } from "../../i18n/index.js";

type MarkupRow = typeof fileMarkups.$inferSelect;

/** Inline types; anything else is served as a download-only octet stream. */
const INLINE_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  txt: "text/plain; charset=utf-8",
  csv: "text/plain; charset=utf-8",
  ifc: "text/plain; charset=utf-8",
};

const point = z.tuple([z.number().finite(), z.number().finite()]);
const base = {
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, render(DEFAULT_LANGUAGE, msg("coordination:errors.colourFormat"))),
  width: z.number().positive().max(100),
};
const shapeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("pen"), ...base, points: z.array(point).min(2).max(5000) }),
  z.object({ type: z.literal("rect"), ...base, from: point, to: point }),
  z.object({ type: z.literal("cloud"), ...base, from: point, to: point }),
  z.object({ type: z.literal("arrow"), ...base, from: point, to: point }),
  z.object({
    type: z.literal("text"),
    ...base,
    at: point,
    text: z.string().trim().min(1).max(2000),
    size: z.number().min(2).max(500),
  }),
]);
const shapesSchema = z.array(shapeSchema).min(1).max(200);
const pageSchema = z.number().int().min(1).max(100_000);

export async function markupRoutes(api: FastifyInstance, deps: AppDeps) {
  const { db, storage } = deps;

  /** File content for in-browser viewers (PDF, images). Needs only view permission. */
  api.get<{ Params: { pid: string; vid: string } }>("/projects/:pid/versions/:vid/content", async (req, reply) => {
    const { a, file, version, tree } = await loadVersion(db, req.params.pid, req.params.vid, req.user!);
    requireView(tree, a, file);
    const ext = splitExtension(file.name).extension.toLowerCase();
    const type = INLINE_TYPES[ext];
    const ascii = file.name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
    reply.header(
      "Content-Disposition",
      `${type ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    );
    reply.header("Content-Type", type ?? "application/octet-stream");
    reply.header("Content-Length", String(version.size));
    reply.header("X-Content-Type-Options", "nosniff");
    // Opened directly in a tab, the content may not run scripts with the app's origin.
    reply.header("Content-Security-Policy", "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'");
    reply.header("Cache-Control", "private, max-age=3600");
    return reply.send(storage.get(version.storageKey));
  });

  /** A version with its file and the caller's rights (pages that start from a version id). */
  api.get<{ Params: { pid: string; vid: string } }>("/projects/:pid/versions/:vid/info", async (req): Promise<VersionInfoDto> => {
    const { a, file, version, tree } = await loadVersion(db, req.params.pid, req.params.vid, req.user!);
    requireView(tree, a, file);
    const perm = tree.permission(a.principal, file.folderId);
    return {
      id: version.id,
      fileId: file.id,
      fileName: file.name,
      folderId: file.folderId,
      version: version.version,
      currentVersion: file.currentVersion,
      extension: splitExtension(file.name).extension.toLowerCase(),
      size: version.size,
      uploadedAt: version.uploadedAt.toISOString(),
      canDownload: can(perm.level, "download") || (perm.canUpload && file.createdBy === a.user.id),
      canMarkup: can(perm.level, "markup"),
    };
  });

  /** Published markups of a version plus the caller's drafts. */
  api.get<{ Params: { pid: string; vid: string } }>("/projects/:pid/versions/:vid/markups", async (req) => {
    const { a, file, version, tree } = await loadVersion(db, req.params.pid, req.params.vid, req.user!);
    requireView(tree, a, file);
    const rows = await db
      .select()
      .from(fileMarkups)
      .where(
        and(
          eq(fileMarkups.versionId, version.id),
          or(eq(fileMarkups.published, true), eq(fileMarkups.authorId, a.user.id)),
        ),
      )
      .orderBy(asc(fileMarkups.createdAt));
    const names = await userNames(db, rows.map((r) => r.authorId));
    return rows.map((r) => toMarkupDto(r, names));
  });

  api.post<{ Params: { pid: string; vid: string } }>("/projects/:pid/versions/:vid/markups", async (req) => {
    const { a, file, version, tree } = await loadVersion(db, req.params.pid, req.params.vid, req.user!);
    requireMarkup(tree, a, file);
    const body = z
      .object({ page: pageSchema, shapes: shapesSchema, published: z.boolean().optional() })
      .parse(req.body);
    const [row] = await db
      .insert(fileMarkups)
      .values({
        versionId: version.id,
        page: body.page,
        shapes: body.shapes,
        authorId: a.user.id,
        published: body.published ?? false,
      })
      .returning();
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "markup.created",
      targetType: "file",
      targetId: file.id,
      details: { markupId: row!.id, version: version.version, page: body.page, published: row!.published },
    });
    return toMarkupDto(row!, new Map([[a.user.id, a.user.name]]));
  });

  api.patch<{ Params: { pid: string; mid: string } }>("/projects/:pid/markups/:mid", async (req) => {
    const m = await loadOwnMarkup(db, req.params.pid, req.params.mid, req.user!);
    const body = z.object({ page: pageSchema.optional(), shapes: shapesSchema.optional() }).parse(req.body);
    const [row] = await db
      .update(fileMarkups)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(fileMarkups.id, m.markup.id))
      .returning();
    await audit(db, {
      projectId: m.a.project.id,
      userId: m.a.user.id,
      action: "markup.updated",
      targetType: "file",
      targetId: m.file.id,
      details: { markupId: m.markup.id },
    });
    return toMarkupDto(row!, new Map([[m.a.user.id, m.a.user.name]]));
  });

  api.delete<{ Params: { pid: string; mid: string } }>("/projects/:pid/markups/:mid", async (req) => {
    const m = await loadOwnMarkup(db, req.params.pid, req.params.mid, req.user!);
    await db.transaction(async (tx) => {
      await tx.delete(issueLinks).where(and(eq(issueLinks.kind, "markup"), eq(issueLinks.targetId, m.markup.id)));
      await tx.delete(fileMarkups).where(eq(fileMarkups.id, m.markup.id));
    });
    await audit(db, {
      projectId: m.a.project.id,
      userId: m.a.user.id,
      action: "markup.deleted",
      targetType: "file",
      targetId: m.file.id,
      details: { markupId: m.markup.id, published: m.markup.published },
    });
    return { ok: true };
  });

  api.post<{ Params: { pid: string; mid: string } }>("/projects/:pid/markups/:mid/publish", async (req) => {
    const m = await loadOwnMarkup(db, req.params.pid, req.params.mid, req.user!);
    const [row] = await db
      .update(fileMarkups)
      .set({ published: true, updatedAt: new Date() })
      .where(eq(fileMarkups.id, m.markup.id))
      .returning();
    if (!m.markup.published) {
      await audit(db, {
        projectId: m.a.project.id,
        userId: m.a.user.id,
        action: "markup.published",
        targetType: "file",
        targetId: m.file.id,
        details: { markupId: m.markup.id },
      });
    }
    return toMarkupDto(row!, new Map([[m.a.user.id, m.a.user.name]]));
  });

  /** Issues linked to a version or to its markups the caller can see. */
  api.get<{ Params: { pid: string; vid: string } }>("/projects/:pid/versions/:vid/issue-links", async (req) => {
    const { a, file, version, tree } = await loadVersion(db, req.params.pid, req.params.vid, req.user!);
    requireView(tree, a, file);
    const visible = await db
      .select({ id: fileMarkups.id })
      .from(fileMarkups)
      .where(
        and(
          eq(fileMarkups.versionId, version.id),
          or(eq(fileMarkups.published, true), eq(fileMarkups.authorId, a.user.id)),
        ),
      );
    const markupIds = visible.map((r) => r.id);
    const rows = await db
      .select({ link: issueLinks, issue: issues })
      .from(issueLinks)
      .innerJoin(issues, eq(issues.id, issueLinks.issueId))
      .where(
        and(
          eq(issues.projectId, a.project.id),
          or(
            and(eq(issueLinks.kind, "version"), eq(issueLinks.targetId, version.id)),
            markupIds.length ? and(eq(issueLinks.kind, "markup"), inArray(issueLinks.targetId, markupIds)) : undefined,
          ),
        ),
      )
      .orderBy(asc(issues.number));
    return rows.map((r) => toLinkDto(r.link, r.issue));
  });

  /** Links of an issue, with where each target lives; targets the caller cannot see are left out. */
  api.get<{ Params: { pid: string; iid: string } }>("/projects/:pid/issues/:iid/links", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const issue = await loadIssue(db, a.project.id, req.params.iid);
    const links = await db.select().from(issueLinks).where(eq(issueLinks.issueId, issue.id)).orderBy(asc(issueLinks.createdAt));
    const out: IssueLinkDto[] = [];
    for (const link of links) {
      try {
        const target = await resolveTarget(db, a.project.id, req.user!, link.kind, link.targetId);
        out.push({ ...toLinkDto(link, issue), target: target.info });
      } catch {
        /* not visible to the caller */
      }
    }
    return out;
  });

  api.post<{ Params: { pid: string; iid: string } }>("/projects/:pid/issues/:iid/links", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const issue = await loadIssue(db, a.project.id, req.params.iid);
    requireIssueEdit(a, issue);
    const body = z.object({ kind: z.enum(["markup", "version"]), targetId: z.string().uuid() }).parse(req.body);
    const target = await resolveTarget(db, a.project.id, req.user!, body.kind, body.targetId);
    const [existing] = await db
      .select()
      .from(issueLinks)
      .where(and(eq(issueLinks.issueId, issue.id), eq(issueLinks.kind, body.kind), eq(issueLinks.targetId, body.targetId)));
    if (existing) return { ...toLinkDto(existing, issue), target: target.info };
    const [row] = await db
      .insert(issueLinks)
      .values({ issueId: issue.id, kind: body.kind, targetId: body.targetId, createdBy: a.user.id })
      .returning();
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "issue.linked",
      targetType: "issue",
      targetId: issue.id,
      details: { number: issue.number, kind: body.kind, targetId: body.targetId, fileId: target.info.fileId },
    });
    return { ...toLinkDto(row!, issue), target: target.info };
  });

  api.delete<{ Params: { pid: string; iid: string; lid: string } }>("/projects/:pid/issues/:iid/links/:lid", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const issue = await loadIssue(db, a.project.id, req.params.iid);
    requireIssueEdit(a, issue);
    if (!isUuid(req.params.lid)) throw notFound(msg("coordination:entities.link"));
    const [row] = await db
      .delete(issueLinks)
      .where(and(eq(issueLinks.id, req.params.lid), eq(issueLinks.issueId, issue.id)))
      .returning();
    if (!row) throw notFound(msg("coordination:entities.link"));
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "issue.unlinked",
      targetType: "issue",
      targetId: issue.id,
      details: { number: issue.number, kind: row.kind, targetId: row.targetId },
    });
    return { ok: true };
  });
}

function requireMarkup(
  tree: Awaited<ReturnType<typeof loadVersion>>["tree"],
  a: Awaited<ReturnType<typeof loadVersion>>["a"],
  file: Awaited<ReturnType<typeof loadVersion>>["file"],
) {
  requireView(tree, a, file);
  if (!can(tree.permission(a.principal, file.folderId).level, "markup"))
    throw forbidden(msg("coordination:errors.markupFolderDenied"));
}

/** A markup the caller wrote, on a file they may still mark up. */
async function loadOwnMarkup(db: Db, pid: string, mid: string, user: AuthUser) {
  if (!isUuid(mid)) throw notFound(msg("coordination:entities.markup"));
  const [markup] = await db.select().from(fileMarkups).where(eq(fileMarkups.id, mid));
  if (!markup) throw notFound(msg("coordination:entities.markup"));
  const v = await loadVersion(db, pid, markup.versionId, user);
  requireView(v.tree, v.a, v.file);
  if (!markup.published && markup.authorId !== user.id) throw notFound(msg("coordination:entities.markup"));
  if (markup.authorId !== user.id) throw forbidden(msg("coordination:errors.markupOwnOnly"));
  requireMarkup(v.tree, v.a, v.file);
  return { ...v, markup };
}

/** Checks that the caller can see a link target and describes where it lives. */
async function resolveTarget(db: Db, projectId: string, user: AuthUser, kind: IssueLinkKind, targetId: string) {
  if (kind === "clash_group") {
    // Clash groups are the Coordinate module's; without it there is nothing to link.
    const target = capability("coordinate.linkTargets");
    if (!target) throw notFound();
    return target.clashGroup(db, projectId, user, targetId);
  }
  let versionId = targetId;
  let page: number | undefined;
  if (kind === "markup") {
    const [markup] = await db.select().from(fileMarkups).where(eq(fileMarkups.id, targetId));
    if (!markup || (!markup.published && markup.authorId !== user.id)) throw notFound(msg("coordination:entities.markup"));
    versionId = markup.versionId;
    page = markup.page;
  }
  const v = await loadVersion(db, projectId, versionId, user);
  requireView(v.tree, v.a, v.file);
  return {
    info: { fileId: v.file.id, fileName: v.file.name, versionId: v.version.id, version: v.version.version, page },
  };
}

async function loadIssue(db: Db, projectId: string, iid: string) {
  if (!isUuid(iid)) throw notFound(msg("coordination:entities.issue"));
  const [row] = await db.select().from(issues).where(and(eq(issues.id, iid), eq(issues.projectId, projectId)));
  if (!row) throw notFound(msg("coordination:entities.issue"));
  return row;
}

/** Same rule as editing the issue itself. */
function requireIssueEdit(a: { isProjectAdmin: boolean; user: AuthUser }, issue: typeof issues.$inferSelect) {
  if (a.isProjectAdmin || issue.createdBy === a.user.id || issue.assigneeUserId === a.user.id) return;
  throw forbidden(msg("coordination:errors.issueLinksRole"));
}

function toMarkupDto(r: MarkupRow, names: Map<string, string>): MarkupDto {
  return {
    id: r.id,
    versionId: r.versionId,
    page: r.page,
    shapes: r.shapes,
    authorId: r.authorId,
    authorName: names.get(r.authorId),
    published: r.published,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

function toLinkDto(l: typeof issueLinks.$inferSelect, i: typeof issues.$inferSelect): IssueLinkDto {
  return {
    id: l.id,
    issueId: l.issueId,
    kind: l.kind,
    targetId: l.targetId,
    createdAt: l.createdAt.toISOString(),
    issue: { number: i.number, title: i.title, status: i.status, priority: i.priority },
  };
}
