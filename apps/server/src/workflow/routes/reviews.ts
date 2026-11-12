import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  can,
  outcomeLabel,
  type OnBehalfOfDto,
  type ReviewDetailDto,
  type ReviewSummaryDto,
  type VersionApprovalDto,
  type WorkflowAssignee,
} from "@sitekeep/shared";
import type { AppDeps } from "../../app/deps.js";
import { FolderTree, isUuid, projectAccess, userNames, type ProjectAccess } from "../../core/security/access.js";
import { audit } from "../../core/platform/audit.js";
import type { Db } from "../../db/index.js";
import {
  attributeDefinitions,
  companies,
  fileVersions,
  files,
  projectRoles,
  reviewFiles,
  reviewMarks,
  reviews,
  workflowActions,
  workflowInstances,
} from "../../db/schema.js";
import { notFound } from "../../core/platform/http.js";
import { msg, requestLanguage } from "../../i18n/index.js";
import { requireModule } from "../../projects/modules.js";
import type { ActorContext } from "../../workflow/engine.js";
import { isAssignee, onBehalfOf } from "../../workflow/engine.js";
import {
  SUBJECT_REVIEW,
  approvalHistory,
  cancelReview,
  latestApprovals,
  loadInstance,
  previewReview,
  reassignStep,
  startReview,
  submitStep,
  type InstanceRow,
  type ReviewRow,
} from "../../workflow/reviews.js";
import { fileChain } from "../../workflow/chain.js";
import { folderPath } from "../../workflow/chain-service.js";
import { toDefinitionDto } from "../../modules/documents/public.js";
import { actorFor, memberWithRoles } from "../../workflow/service.js";
import { canSee, loadVisibleReview, submittedNow } from "../review-access.js";
import { checkSteps } from "../template-schemas.js";

const assigneeSchema = z.object({ type: z.enum(["user", "company", "role"]), id: z.string().min(1).max(64) });
const startSchema = z.object({
  // Optional when the template numbers reviews ({Proje}-{Tip}-{0000}); the number becomes the name.
  name: z.string().trim().max(300).nullable().optional(),
  note: z.string().trim().max(5000).nullable().optional(),
  templateId: z.string().uuid(),
  versionIds: z.array(z.string().uuid()).min(1).max(500),
  targetFolderId: z.string().uuid().nullable().optional(),
  targetPattern: z.string().trim().max(300).nullable().optional(),
  targetFallback: z.boolean().optional(),
});

export async function reviewRoutes(api: FastifyInstance, deps: AppDeps) {
  const { db, storage } = deps;
  const base = { db, jobs: deps.jobs };
  const ctxFor = (req: Parameters<typeof requestLanguage>[0]) => ({ ...base, lang: requestLanguage(req) });

  api.get<{ Params: { pid: string }; Querystring: { status?: string; mine?: string } }>(
    "/projects/:pid/reviews",
    async (req) => {
      const a = await projectAccess(db, req.params.pid, req.user!);
      const status = req.query.status ? z.enum(["running", "completed", "cancelled"]).parse(req.query.status) : undefined;
      const rows = await db
        .select({ r: reviews, i: workflowInstances })
        .from(reviews)
        .innerJoin(
          workflowInstances,
          and(eq(workflowInstances.subjectType, SUBJECT_REVIEW), eq(workflowInstances.subjectId, reviews.id)),
        )
        .where(and(eq(reviews.projectId, a.project.id), status ? eq(workflowInstances.status, status) : undefined))
        .orderBy(desc(reviews.number));
      const member = await memberRow(db, a);
      const visible = rows.filter(({ r, i }) => canSee(a, actorFor(a.user, member, i.startedBy), r, i));
      const counts = await fileCounts(
        db,
        visible.map((v) => v.r.id),
      );
      const submitted = await submittedNow(db, visible.map((v) => v.i), a.user.id);
      const names = await userNames(db, visible.map((v) => v.r.createdBy));
      return visible
        .map(({ r, i }) => {
          const actor = actorFor(a.user, member, i.startedBy);
          return toSummary(r, i, counts.get(r.id) ?? 0, names, myTurn(i, actor, submitted.has(i.id)));
        })
        .filter((s) => req.query.mine !== "1" || s.myTurn);
    },
  );

  api.post<{ Params: { pid: string } }>("/projects/:pid/reviews", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    requireModule(a, "reviews");
    const body = startSchema.parse(req.body);
    const { review } = await startReview(ctxFor(req), a, body);
    return detail(db, a, review, requestLanguage(req));
  });

  /** What a start would do (assignees resolved by attribute, review number, copy path per file). */
  api.post<{ Params: { pid: string } }>("/projects/:pid/reviews/preview", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    return previewReview(ctxFor(req), a, startSchema.parse(req.body));
  });

  api.get<{ Params: { pid: string; rid: string } }>("/projects/:pid/reviews/:rid", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const review = await loadVisibleReview(db, a, req.params.rid);
    return detail(db, a, review, requestLanguage(req));
  });

  api.post<{ Params: { pid: string; rid: string } }>("/projects/:pid/reviews/:rid/submit", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const review = await loadVisibleReview(db, a, req.params.rid);
    const body = z
      .object({
        comment: z.string().trim().max(5000).nullable().optional(),
        files: z
          .array(
            z.object({
              reviewFileId: z.string().uuid(),
              // A base outcome code or a custom outcome code of the step.
              outcome: z.string().trim().min(1).max(40),
              comment: z.string().trim().max(5000).nullable().optional(),
            }),
          )
          .min(1)
          .max(500),
        attributes: z
          .record(z.string().uuid(), z.record(z.string().trim().min(1).max(100), z.string().max(1000)))
          .optional(),
      })
      .parse(req.body);
    const step = (await loadInstance(db, review.id)).stepIndex;
    await submitStep(ctxFor(req), a, review, body);
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "review.submitted",
      targetType: "review",
      targetId: review.id,
      details: { number: review.number, name: review.name, stepIndex: step },
    });
    return detail(db, a, review, requestLanguage(req));
  });

  api.post<{ Params: { pid: string; rid: string } }>("/projects/:pid/reviews/:rid/cancel", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const review = await loadVisibleReview(db, a, req.params.rid);
    const body = z.object({ comment: z.string().trim().max(5000).nullable().optional() }).parse(req.body ?? {});
    await cancelReview(ctxFor(req), a, review, body.comment ?? null);
    return detail(db, a, review, requestLanguage(req));
  });

  api.post<{ Params: { pid: string; rid: string } }>("/projects/:pid/reviews/:rid/reassign", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const review = await loadVisibleReview(db, a, req.params.rid);
    const body = z.object({ assignees: z.array(assigneeSchema).min(1).max(50) }).parse(req.body);
    await reassignStep(ctxFor(req), a, review, body.assignees, (steps) => checkSteps(db, a.project.id, steps, [], [], requestLanguage(req)));
    return detail(db, a, review, requestLanguage(req));
  });

  /** Reviewers download the pinned version even without folder rights. */
  api.get<{ Params: { pid: string; rid: string; rfid: string } }>(
    "/projects/:pid/reviews/:rid/files/:rfid/download",
    async (req, reply) => {
      const a = await projectAccess(db, req.params.pid, req.user!);
      const review = await loadVisibleReview(db, a, req.params.rid);
      if (!isUuid(req.params.rfid)) throw notFound(msg("workflow:entities.file"));
      const [row] = await db
        .select()
        .from(reviewFiles)
        .innerJoin(fileVersions, eq(fileVersions.id, reviewFiles.fileVersionId))
        .innerJoin(files, eq(files.id, reviewFiles.fileId))
        .where(and(eq(reviewFiles.id, req.params.rfid), eq(reviewFiles.reviewId, review.id)));
      if (!row) throw notFound(msg("workflow:entities.file"));
      await audit(db, {
        projectId: a.project.id,
        userId: a.user.id,
        action: "file.downloaded",
        targetType: "file",
        targetId: row.files.id,
        details: { version: row.file_versions.version, reviewId: review.id },
      });
      const name = row.files.name;
      const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
      reply.header("Content-Disposition", `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`);
      reply.header("Content-Length", String(row.file_versions.size));
      reply.header("Content-Type", "application/octet-stream");
      return reply.send(storage.get(row.file_versions.storageKey));
    },
  );

  // ---- Approval status -------------------------------------------------------------------

  /** Latest approval status of the current version of each file in a folder. */
  api.get<{ Params: { pid: string; fid: string } }>("/projects/:pid/folders/:fid/approvals", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const tree = await FolderTree.load(db, a.project.id);
    if (!tree.visible(a.principal, req.params.fid)) throw notFound(msg("workflow:entities.folder"));
    const level = tree.permission(a.principal, req.params.fid).level;
    if (level === "none") return [];
    const rows = await db
      .select({ versionId: fileVersions.id, createdBy: files.createdBy })
      .from(files)
      .innerJoin(fileVersions, and(eq(fileVersions.fileId, files.id), eq(fileVersions.version, files.currentVersion)))
      .where(and(eq(files.folderId, req.params.fid), isNull(files.deletedAt)));
    const ids = (can(level, "view") ? rows : rows.filter((r) => r.createdBy === a.user.id)).map((r) => r.versionId);
    const latest = await latestApprovals(db, a.project.id, ids, requestLanguage(req));
    return [...latest.values()].map(toApprovalDto);
  });

  /** Approval history of every version of a file. */
  api.get<{ Params: { pid: string; id: string } }>("/projects/:pid/files/:id/approvals", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    if (!isUuid(req.params.id)) throw notFound(msg("workflow:entities.file"));
    const [file] = await db
      .select()
      .from(files)
      .where(and(eq(files.id, req.params.id), eq(files.projectId, a.project.id), isNull(files.deletedAt)));
    if (!file) throw notFound(msg("workflow:entities.file"));
    const tree = await FolderTree.load(db, a.project.id);
    if (!tree.byId.has(file.folderId)) throw notFound(msg("workflow:entities.file"));
    const perm = tree.permission(a.principal, file.folderId);
    if (!can(perm.level, "view") && !(perm.canUpload && file.createdBy === a.user.id)) throw notFound(msg("workflow:entities.file"));
    const versions = await db
      .select({ id: fileVersions.id })
      .from(fileVersions)
      .where(eq(fileVersions.fileId, file.id));
    return (
      await approvalHistory(
        db,
        a.project.id,
        versions.map((v) => v.id),
        requestLanguage(req),
      )
    ).map(toApprovalDto);
  });
}

// ---- Helpers ------------------------------------------------------------------------------

function toApprovalDto(r: Awaited<ReturnType<typeof approvalHistory>>[number]): VersionApprovalDto {
  return {
    versionId: r.versionId,
    status: r.status,
    reviewId: r.reviewId,
    reviewNumber: r.reviewNumber,
    reviewName: r.reviewName,
    decidedAt: r.decidedAt,
    isCopy: r.isCopy,
    label: r.label,
    chain: r.chain,
    chainFull: r.chainFull,
  };
}

async function memberRow(db: Db, a: ProjectAccess) {
  return memberWithRoles(db, a.project.id, a.user.id);
}

function myTurn(i: InstanceRow, actor: ActorContext, alreadySubmitted: boolean): boolean {
  if (i.status !== "running" || alreadySubmitted) return false;
  return isAssignee(i.template.steps[i.stepIndex]!, actor);
}

async function fileCounts(db: Db, reviewIds: string[]) {
  const out = new Map<string, number>();
  if (!reviewIds.length) return out;
  const rows = await db
    .select({ reviewId: reviewFiles.reviewId })
    .from(reviewFiles)
    .where(inArray(reviewFiles.reviewId, reviewIds));
  for (const r of rows) out.set(r.reviewId, (out.get(r.reviewId) ?? 0) + 1);
  return out;
}

function toSummary(
  r: ReviewRow,
  i: InstanceRow,
  fileCount: number,
  names: Map<string, string>,
  turn: boolean,
): ReviewSummaryDto {
  const step = i.template.steps[i.stepIndex];
  return {
    id: r.id,
    projectId: r.projectId,
    number: r.number,
    name: r.name,
    status: i.status,
    templateName: i.template.name,
    stepIndex: i.stepIndex,
    stepCount: i.template.steps.length,
    stepName: i.status === "running" ? (step?.name ?? null) : null,
    stepDueAt: i.stepDueAt?.toISOString() ?? null,
    fileCount,
    startedBy: r.createdBy,
    startedByName: names.get(r.createdBy),
    createdAt: r.createdAt.toISOString(),
    completedAt: i.completedAt?.toISOString() ?? null,
    myTurn: turn,
    code: r.code,
    overdue: i.status === "running" && !!i.stepDueAt && i.stepDueAt.getTime() < Date.now(),
  };
}

async function detail(db: Db, a: ProjectAccess, reviewRow: ReviewRow, lang?: string): Promise<ReviewDetailDto> {
  const [review] = await db.select().from(reviews).where(eq(reviews.id, reviewRow.id));
  const r = review!;
  const i = await loadInstance(db, r.id);
  const rfRows = await db
    .select()
    .from(reviewFiles)
    .innerJoin(fileVersions, eq(fileVersions.id, reviewFiles.fileVersionId))
    .innerJoin(files, eq(files.id, reviewFiles.fileId))
    .where(eq(reviewFiles.reviewId, r.id))
    .orderBy(asc(files.name));
  const marks = rfRows.length
    ? await db
        .select()
        .from(reviewMarks)
        .where(
          inArray(
            reviewMarks.reviewFileId,
            rfRows.map((x) => x.review_files.id),
          ),
        )
        .orderBy(asc(reviewMarks.at))
    : [];
  const actions = await db
    .select()
    .from(workflowActions)
    .where(eq(workflowActions.instanceId, i.id))
    .orderBy(asc(workflowActions.at));

  const userIds = [
    r.createdBy,
    ...marks.map((m) => m.userId),
    ...actions.map((x) => x.userId),
    ...i.template.steps.flatMap((s) => s.assignees.filter((x) => x.type === "user").map((x) => x.id)),
  ];
  const names = await userNames(db, userIds);
  const submitted = actions.filter((x) => x.kind === "submit");
  const behalfOf = (x: (typeof actions)[number]) => (x.details?.onBehalfOf as WorkflowAssignee[] | undefined) ?? [];
  const behalfFor = (userId: string, stepIndex: number) => {
    const x = submitted.find((y) => y.userId === userId && y.stepIndex === stepIndex);
    return x ? behalfOf(x) : [];
  };
  // Companies / teams from the steps and from "on behalf of" records (assignees may have changed since).
  const groupRefs = [...i.template.steps.flatMap((s) => s.assignees), ...submitted.flatMap(behalfOf)];
  const companyIds = [...new Set(groupRefs.filter((x) => x.type === "company").map((x) => x.id))];
  const companyRows = companyIds.length
    ? await db.select().from(companies).where(inArray(companies.id, companyIds))
    : [];
  const roleIds = [...new Set(groupRefs.filter((x) => x.type === "role" && isUuid(x.id)).map((x) => x.id))];
  const roleRows = roleIds.length
    ? await db
        .select({ id: projectRoles.id, name: projectRoles.name })
        .from(projectRoles)
        .where(and(inArray(projectRoles.id, roleIds), eq(projectRoles.projectId, r.projectId)))
    : [];
  const groupNames = new Map<string, string>([
    ...companyRows.map((c) => [c.id, c.name] as [string, string]),
    ...roleRows.map((x) => [x.id, x.name] as [string, string]),
  ]);
  const behalfDto = (list: WorkflowAssignee[]): OnBehalfOfDto[] =>
    list.map((b) => ({ type: b.type, id: b.id, name: groupNames.get(b.id) }));

  const member = await memberRow(db, a);
  const actor = actorFor(a.user, member, i.startedBy);
  const submittedBy = [
    ...new Set(marks.filter((m) => m.stepIndex === i.stepIndex).map((m) => m.userId)),
  ];
  const turn = myTurn(i, actor, submittedBy.includes(a.user.id));

  let targetFolderPath: string | null = null;
  const tree = r.targetFolderId ? await FolderTree.load(db, r.projectId) : null;
  if (tree && r.targetFolderId) targetFolderPath = folderPath(tree, r.targetFolderId, lang);
  const fileTargetPath = (rf: (typeof rfRows)[number]["review_files"]) =>
    tree && rf.copyFolderId ? folderPath(tree, rf.copyFolderId, lang) : null;

  // Required attributes of any step: their definitions (by name) for typed inputs.
  const requiredNames = [...new Set(i.template.steps.flatMap((s) => s.requiredAttributes ?? []))];
  const defs = requiredNames.length
    ? await db
        .select()
        .from(attributeDefinitions)
        .where(and(eq(attributeDefinitions.projectId, r.projectId), inArray(attributeDefinitions.name, requiredNames)))
    : [];
  const stepLabels = (rf: (typeof rfRows)[number]["review_files"]) =>
    Object.fromEntries(
      Object.entries(rf.stepResults).map(([k, base]) => [k, outcomeLabel(i.template.steps[Number(k)], rf.stepCodes?.[k] ?? base, lang)!]),
    );

  return {
    ...toSummary(r, i, rfRows.length, names, turn),
    note: r.note,
    targetFolderId: r.targetFolderId,
    targetFolderPath,
    steps: i.template.steps,
    finalOutcomes: i.template.finalOutcomes,
    files: rfRows.map(({ review_files: rf, file_versions: v, files: f }) => ({
      id: rf.id,
      fileId: f.id,
      fileVersionId: v.id,
      fileName: f.name,
      version: v.version,
      sourceFolderId: rf.sourceFolderId,
      stepResults: rf.stepResults,
      finalStatus: rf.finalStatus,
      copiedFileId: rf.copiedFileId,
      copiedVersionId: rf.copiedVersionId,
      copyError: rf.copyError,
      stepCodes: rf.stepCodes ?? {},
      stepLabels: stepLabels(rf),
      finalLabel: rf.finalLabel,
      stoppedAtStep: rf.stoppedAtStep,
      chain: fileChain(i.template, i, rf, new Date(), lang),
      targetPath: fileTargetPath(rf),
      copyUnresolved: rf.copyUnresolved ?? [],
      attributes: f.attributes,
    })),
    marks: marks.map((m) => ({
      reviewFileId: m.reviewFileId,
      stepIndex: m.stepIndex,
      userId: m.userId,
      userName: names.get(m.userId),
      outcome: m.outcome,
      code: m.optionCode ?? m.outcome,
      label: outcomeLabel(i.template.steps[m.stepIndex], m.optionCode ?? m.outcome, lang) ?? undefined,
      comment: m.comment,
      at: m.at.toISOString(),
      onBehalfOf: behalfDto(behalfFor(m.userId, m.stepIndex)),
    })),
    actions: actions.map((x) => ({
      id: x.id,
      kind: x.kind,
      stepIndex: x.stepIndex,
      userId: x.userId,
      userName: x.userId ? names.get(x.userId) : undefined,
      outcome: x.outcome,
      comment: x.comment,
      details: x.details,
      at: x.at.toISOString(),
      ...(x.kind === "submit" ? { onBehalfOf: behalfDto(behalfOf(x)) } : {}),
    })),
    submittedBy,
    canAct: turn,
    canCancel: i.status === "running" && (a.isProjectAdmin || r.createdBy === a.user.id),
    canReassign: i.status === "running" && a.isProjectAdmin,
    names: {
      ...Object.fromEntries(names),
      ...Object.fromEntries(groupNames),
    },
    chain: i.template.chain ?? {},
    targetPattern: r.targetPattern,
    attributeDefinitions: defs.map(toDefinitionDto),
    actingFor: turn ? behalfDto(onBehalfOf(i.template.steps[i.stepIndex]!, actor)) : [],
  };
}

