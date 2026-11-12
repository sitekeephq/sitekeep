import { randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, inArray, max } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { IssueCommentDto, IssueDto, IssuePin, IssuePriority, IssueViewpoint } from "@sitekeep/shared";
import type { AppDeps } from "../../app/deps.js";
import { isUuid, projectAccess, userNames } from "../../core/security/access.js";
import { audit } from "../../core/platform/audit.js";
import type { Db } from "../../db/index.js";
import { issueComments, issueViewpoints, issues, projectMembers } from "../../db/schema.js";
import { badRequest, forbidden, notFound } from "../../core/platform/http.js";
import { requireModule } from "../../projects/modules.js";
import { viewerStateFields, viewpointBcfFields, viewpointCameraSchema } from "../../bcf/viewpoint-schema.js";
import { issueViewpointList } from "../../bcf/topics.js";
import { DEFAULT_LANGUAGE, msg, render } from "../../i18n/index.js";

const vec3 = z.tuple([z.number(), z.number(), z.number()]);
const viewpointSchema = z.object({
  camera: viewpointCameraSchema,
  fileVersionIds: z.array(z.string().uuid()).max(100),
  selection: z.array(z.string().max(64)).max(5000).optional(),
  snapshot: z
    .string()
    .max(4_000_000)
    .refine((s) => /^data:image\/(png|jpeg);base64,/.test(s), render(DEFAULT_LANGUAGE, msg("coordination:errors.snapshotFormat")))
    .optional(),
  ...viewerStateFields,
  ...viewpointBcfFields,
});
const pinSchema = z.object({
  position: vec3,
  fileVersionId: z.string().uuid().optional(),
  globalId: z.string().max(64).optional(),
});
const statusSchema = z.enum(["open", "in_progress", "in_review", "closed"]);
const prioritySchema = z.enum(["low", "normal", "high", "critical"]);

const issueFields = {
  title: z.string().trim().min(1).max(300),
  description: z.string().trim().max(10000).nullable().optional(),
  priority: prioritySchema.optional(),
  type: z.string().trim().max(100).nullable().optional(),
  assigneeUserId: z.string().uuid().nullable().optional(),
  assigneeCompanyId: z.string().uuid().nullable().optional(),
  dueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  viewpoint: viewpointSchema.nullable().optional(),
  pin: pinSchema.nullable().optional(),
  // BCF topic fields.
  labels: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
  stage: z.string().trim().max(100).nullable().optional(),
  referenceLinks: z.array(z.string().trim().min(1).max(2000)).max(50).optional(),
};

/** A saved viewpoint always has a BCF GUID: a new one when the client sent none (viewpoints are immutable in BCF). */
function withGuid<T extends { viewpoint?: IssueViewpoint | null }>(body: T): T {
  if (body.viewpoint && !body.viewpoint.guid) return { ...body, viewpoint: { ...body.viewpoint, guid: randomUUID() } };
  return body;
}

export async function issueRoutes(api: FastifyInstance, { db }: AppDeps) {
  api.get<{ Params: { pid: string }; Querystring: { status?: string; assignedToMe?: string } }>(
    "/projects/:pid/issues",
    async (req) => {
      const a = await projectAccess(db, req.params.pid, req.user!);
      const status = req.query.status ? statusSchema.parse(req.query.status) : undefined;
      const rows = await db
        .select()
        .from(issues)
        .where(
          and(
            eq(issues.projectId, a.project.id),
            status ? eq(issues.status, status) : undefined,
            req.query.assignedToMe === "1" ? eq(issues.assigneeUserId, a.user.id) : undefined,
          ),
        )
        .orderBy(desc(issues.number));
      const names = await userNames(db, rows.flatMap((r) => [r.createdBy, r.assigneeUserId]));
      const extra = await extraViewpointCounts(db, rows.map((r) => r.id));
      // Snapshots are large; the list omits them.
      return rows.map((r) => toIssueDto(r, names, { withSnapshot: false, extraViewpoints: extra.get(r.id) ?? 0 }));
    },
  );

  api.post<{ Params: { pid: string } }>("/projects/:pid/issues", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    requireModule(a, "issues");
    const body = withGuid(z.object(issueFields).parse(req.body));
    await checkAssignee(a.project.id, body.assigneeUserId);
    const row = await insertIssue(db, a.project.id, a.user.id, body);
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "issue.created",
      targetType: "issue",
      targetId: row.id,
      details: { number: row.number, title: row.title },
    });
    return toIssueDto(row, await userNames(db, [row.createdBy, row.assigneeUserId]));
  });

  api.get<{ Params: { pid: string; iid: string } }>("/projects/:pid/issues/:iid", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const row = await loadIssue(a.project.id, req.params.iid);
    const extra = await extraViewpointCounts(db, [row.id]);
    return toIssueDto(row, await userNames(db, [row.createdBy, row.assigneeUserId]), { extraViewpoints: extra.get(row.id) ?? 0 });
  });

  /** Every viewpoint of an issue, primary first, with snapshots (issue detail, viewer ?issue=…&vp=…). */
  api.get<{ Params: { pid: string; iid: string } }>("/projects/:pid/issues/:iid/viewpoints", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const row = await loadIssue(a.project.id, req.params.iid);
    return issueViewpointList(db, row);
  });

  api.patch<{ Params: { pid: string; iid: string } }>("/projects/:pid/issues/:iid", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const row = await loadIssue(a.project.id, req.params.iid);
    const allowed = a.isProjectAdmin || row.createdBy === a.user.id || row.assigneeUserId === a.user.id;
    if (!allowed) throw forbidden(msg("coordination:errors.issueEditRole"));
    const body = withGuid(
      z.object({ ...issueFields, title: issueFields.title.optional(), status: statusSchema.optional() }).parse(req.body),
    );
    await checkAssignee(a.project.id, body.assigneeUserId);
    // An imported assignee without a member match is dropped once someone sets the assignee here.
    const importedFrom =
      body.assigneeUserId !== undefined && row.importedFrom?.assignedTo ? { ...row.importedFrom, assignedTo: undefined } : undefined;
    const [updated] = await db
      .update(issues)
      .set({ ...body, ...(importedFrom && { importedFrom }), modifiedBy: a.user.id, updatedAt: new Date() })
      .where(eq(issues.id, row.id))
      .returning();
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "issue.updated",
      targetType: "issue",
      targetId: row.id,
      details: { number: row.number, ...withoutBlobs(body) },
    });
    return toIssueDto(updated!, await userNames(db, [updated!.createdBy, updated!.assigneeUserId]));
  });

  api.get<{ Params: { pid: string; iid: string } }>("/projects/:pid/issues/:iid/comments", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const issue = await loadIssue(a.project.id, req.params.iid);
    const rows = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, issue.id))
      .orderBy(asc(issueComments.createdAt));
    const names = await userNames(db, rows.map((r) => r.authorId));
    return rows.map((r) => toCommentDto(r, names.get(r.authorId)));
  });

  api.post<{ Params: { pid: string; iid: string } }>("/projects/:pid/issues/:iid/comments", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const issue = await loadIssue(a.project.id, req.params.iid);
    const body = z.object({ body: z.string().trim().min(1).max(10000), viewpointGuid: z.string().uuid().nullable().optional() }).parse(req.body);
    const id = randomUUID();
    const [row] = await db
      .insert(issueComments)
      .values({ id, guid: id, issueId: issue.id, authorId: a.user.id, body: body.body, viewpointGuid: body.viewpointGuid ?? null })
      .returning();
    await db.update(issues).set({ updatedAt: new Date() }).where(eq(issues.id, issue.id));
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "issue.commented",
      targetType: "issue",
      targetId: issue.id,
      details: { number: issue.number },
    });
    return toCommentDto(row!, a.user.name);
  });

  async function loadIssue(projectId: string, iid: string) {
    if (!isUuid(iid)) throw notFound(msg("coordination:entities.issue"));
    const [row] = await db.select().from(issues).where(and(eq(issues.id, iid), eq(issues.projectId, projectId)));
    if (!row) throw notFound(msg("coordination:entities.issue"));
    return row;
  }

  async function checkAssignee(projectId: string, userId: string | null | undefined) {
    if (!userId) return;
    const [m] = await db
      .select()
      .from(projectMembers)
      .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)));
    if (!m) throw badRequest(msg("coordination:errors.assigneeNotMember"));
  }
}

/** Inserts an issue with the next project number (also used by clash groups → issue). */
export async function insertIssue(
  db: Db,
  projectId: string,
  userId: string,
  body: {
    title: string;
    description?: string | null;
    priority?: IssuePriority;
    type?: string | null;
    assigneeUserId?: string | null;
    assigneeCompanyId?: string | null;
    dueDate?: string | null;
    viewpoint?: IssueViewpoint | null;
    pin?: IssuePin | null;
    labels?: string[];
    stage?: string | null;
    referenceLinks?: string[];
  },
) {
  // The BCF topic GUID of an issue created here is its id; its viewpoint gets a GUID too.
  const id = randomUUID();
  const viewpoint = body.viewpoint ? { ...body.viewpoint, guid: body.viewpoint.guid ?? randomUUID() } : null;
  return db.transaction(async (tx) => {
    const [m] = await tx.select({ n: max(issues.number) }).from(issues).where(eq(issues.projectId, projectId));
    const [inserted] = await tx
      .insert(issues)
      .values({
        id,
        guid: id,
        projectId,
        number: (m?.n ?? 0) + 1,
        title: body.title,
        description: body.description ?? null,
        priority: body.priority ?? "normal",
        type: body.type ?? null,
        assigneeUserId: body.assigneeUserId ?? null,
        assigneeCompanyId: body.assigneeCompanyId ?? null,
        dueDate: body.dueDate ?? null,
        viewpoint,
        pin: body.pin ?? null,
        labels: body.labels ?? [],
        stage: body.stage ?? null,
        referenceLinks: body.referenceLinks ?? [],
        createdBy: userId,
      })
      .returning();
    return inserted!;
  });
}

function withoutBlobs<T extends { viewpoint?: unknown }>(body: T) {
  const { viewpoint, ...rest } = body;
  return { ...rest, viewpoint: viewpoint === undefined ? undefined : viewpoint ? "(güncellendi)" : null }; // i18n-ok: audit detail (data)
}

export function toIssueDto(
  r: typeof issues.$inferSelect,
  names: Map<string, string>,
  opts: { withSnapshot?: boolean; extraViewpoints?: number } = {},
): IssueDto {
  const viewpoint =
    r.viewpoint && opts.withSnapshot === false ? { ...r.viewpoint, snapshot: undefined } : r.viewpoint;
  return {
    id: r.id,
    projectId: r.projectId,
    number: r.number,
    title: r.title,
    description: r.description,
    status: r.status,
    priority: r.priority,
    type: r.type,
    assigneeUserId: r.assigneeUserId,
    assigneeCompanyId: r.assigneeCompanyId,
    dueDate: r.dueDate,
    createdBy: r.createdBy,
    createdByName: names.get(r.createdBy),
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    viewpoint,
    pin: r.pin,
    guid: r.guid,
    labels: r.labels,
    stage: r.stage,
    referenceLinks: r.referenceLinks,
    ...(opts.extraViewpoints !== undefined && { extraViewpointCount: opts.extraViewpoints }),
    importedFrom: r.importedFrom ?? null,
  };
}

export function toCommentDto(r: typeof issueComments.$inferSelect, authorName: string | undefined): IssueCommentDto {
  return {
    id: r.id,
    issueId: r.issueId,
    authorId: r.authorId,
    authorName,
    body: r.body,
    createdAt: r.createdAt.toISOString(),
    guid: r.guid,
    viewpointGuid: r.viewpointGuid,
    importedAuthor: r.importedAuthor,
  };
}

/** Number of viewpoints after the primary one, per issue. */
async function extraViewpointCounts(db: Db, ids: string[]): Promise<Map<string, number>> {
  if (!ids.length) return new Map();
  const rows = await db
    .select({ issueId: issueViewpoints.issueId, n: count() })
    .from(issueViewpoints)
    .where(inArray(issueViewpoints.issueId, ids))
    .groupBy(issueViewpoints.issueId);
  return new Map(rows.map((r) => [r.issueId, Number(r.n)]));
}
