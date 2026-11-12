import { applyCounter, can, checkPattern, pathSegments, renderPattern } from "@sitekeep/shared";
import { and, eq, inArray, isNull, max } from "drizzle-orm";
import { audit } from "../core/platform/audit.js";
import { badRequest, forbidden, notFound } from "../core/platform/http.js";
import { FolderTree, type ProjectAccess } from "../core/security/access.js";
import { DEFAULT_LANGUAGE, msg, tFor } from "../i18n/index.js";
import {
  fileVersions,
  files,
  reviewFiles,
  reviews,
  workflowActions,
  workflowInstances,
  workflowTemplates,
  type TemplateSnapshot,
} from "../db/schema.js";
import {
  builtinFields,
  enterStep,
  fileFieldValues,
  resolveAssigneeRules,
  resolveNamePrefix,
  type FileFields,
} from "./chain.js";
import { StandardCache, folderPath, nextReviewCounter, peekReviewCounter } from "./chain-service.js";
import { notifyStepAssignees } from "./review-engine.js";
import { SUBJECT_REVIEW, type ReviewCtx } from "./review-types.js";

export interface StartReviewInput {
  /** Optional when the template has a number pattern (the number becomes the name). */
  name?: string | null;
  note?: string | null;
  templateId: string;
  versionIds: string[];
  /** undefined = the template's copy target folder; null = no copy. */
  targetFolderId?: string | null;
  /** Sub-folder pattern under the target ("{Bölge}/{Disiplin}"); undefined = the template's. */
  targetPattern?: string | null;
  /** Copy files with missing pattern fields to the target folder itself instead of skipping them. */
  targetFallback?: boolean;
}

/** Everything a start resolves before writing (shared with the preview endpoint). */
export interface PreparedReview {
  template: typeof workflowTemplates.$inferSelect;
  rows: { files: typeof files.$inferSelect; file_versions: typeof fileVersions.$inferSelect }[];
  snapshot: TemplateSnapshot;
  targetFolderId: string | null;
  targetPattern: string | null;
  targetFallback: boolean;
  /** Review number prefix with the counter token, when the template numbers reviews. */
  codePrefix: string | null;
  fields: (FileFields & { versionId: string })[];
  problems: string[];
  tree: FolderTree;
}

export async function prepareReview(ctx: ReviewCtx, a: ProjectAccess, input: StartReviewInput): Promise<PreparedReview> {
  const { db } = ctx;
  const lang = ctx.lang ?? DEFAULT_LANGUAGE;
  const [template] = await db
    .select()
    .from(workflowTemplates)
    .where(
      and(
        eq(workflowTemplates.id, input.templateId),
        eq(workflowTemplates.projectId, a.project.id),
        eq(workflowTemplates.kind, "review"),
        isNull(workflowTemplates.archivedAt),
      ),
    );
  if (!template) throw notFound(msg("workflow:entities.reviewTemplate"));

  const versionIds = [...new Set(input.versionIds)];
  const rows = await db
    .select()
    .from(fileVersions)
    .innerJoin(files, eq(files.id, fileVersions.fileId))
    .where(and(inArray(fileVersions.id, versionIds), eq(files.projectId, a.project.id), isNull(files.deletedAt)));
  if (rows.length !== versionIds.length) throw notFound(msg("workflow:entities.version"));
  if (new Set(rows.map((r) => r.files.id)).size !== rows.length)
    throw badRequest(msg("workflow:errors.twoVersionsSameFile"));

  const tree = await FolderTree.load(db, a.project.id);
  for (const r of rows) {
    if (!tree.byId.has(r.files.folderId)) throw notFound(msg("workflow:entities.version"));
    const perm = tree.permission(a.principal, r.files.folderId);
    if (!can(perm.level, "view")) {
      if (!tree.visible(a.principal, r.files.folderId)) throw notFound(msg("workflow:entities.version"));
      throw forbidden(msg("workflow:errors.noViewPermission", { name: r.files.name }));
    }
  }
  const chain = template.chainConfig ?? {};
  const copyRule = chain.copyTarget ?? null;
  const targetFolderId = input.targetFolderId === undefined ? (copyRule?.folderId ?? null) : input.targetFolderId;
  if (targetFolderId) {
    if (!tree.byId.has(targetFolderId)) throw notFound(msg("workflow:entities.targetFolder"));
    if (!tree.permission(a.principal, targetFolderId).canUpload)
      throw forbidden(msg("workflow:errors.noTargetUploadPermission"));
  }
  const rawPattern = input.targetPattern === undefined ? (copyRule?.pattern ?? null) : input.targetPattern;
  const targetPattern = targetFolderId && rawPattern?.trim() ? rawPattern.trim() : null;
  const targetFallback = input.targetFallback ?? copyRule?.onUnresolved === "base";
  const problems: string[] = [];
  if (targetPattern) problems.push(...checkPattern(targetPattern, "path", lang));

  const standards = new StandardCache(db, tree);
  const fields: PreparedReview["fields"] = [];
  for (const r of rows) {
    const standard = await standards.forFile(r.files.folderId, targetFolderId);
    fields.push({
      versionId: r.file_versions.id,
      name: r.files.name,
      values: fileFieldValues(r.files.name, r.files.attributes, standard),
    });
  }

  const resolved = resolveAssigneeRules(template.steps, fields, lang);
  problems.push(...resolved.problems);
  let codePrefix: string | null = null;
  if (chain.namePattern) {
    const p = resolveNamePrefix(chain.namePattern, fields, builtinFields(a.project.code, new Date()), lang);
    problems.push(...p.problems);
    codePrefix = p.prefix;
  }
  if (!input.name?.trim() && !chain.namePattern) problems.push(tFor(lang)("workflow:errors.reviewNameRequired"));

  const snapshot: TemplateSnapshot = {
    templateId: template.id,
    name: template.name,
    steps: resolved.steps,
    finalOutcomes: template.finalOutcomes,
    chain,
  };
  return { template, rows, snapshot, targetFolderId, targetPattern, targetFallback, codePrefix, fields, problems, tree };
}

/** What a start would do: resolved assignees, review number and copy path per file. Writes nothing. */
export async function previewReview(ctx: ReviewCtx, a: ProjectAccess, input: StartReviewInput) {
  const p = await prepareReview(ctx, a, input);
  const code = p.codePrefix ? applyCounter(p.codePrefix, await peekReviewCounter(ctx.db, a.project.id, p.codePrefix)) : null;
  const base = p.targetFolderId ? folderPath(p.tree, p.targetFolderId, ctx.lang) : null;
  return {
    ok: p.problems.length === 0,
    problems: p.problems,
    code,
    steps: p.snapshot.steps,
    targetFolderPath: base,
    targetPattern: p.targetPattern,
    files: p.fields.map((f) => {
      if (!p.targetPattern || !base)
        return { versionId: f.versionId, name: f.name, values: f.values, targetPath: base, unresolved: [] as string[] };
      const r = renderPattern(p.targetPattern, f.values);
      const path = r.unresolved.length ? (p.targetFallback ? base : null) : [base, ...pathSegments(r.text)].join(" / ");
      return { versionId: f.versionId, name: f.name, values: f.values, targetPath: path, unresolved: r.unresolved };
    }),
  };
}

export async function startReview(ctx: ReviewCtx, a: ProjectAccess, input: StartReviewInput) {
  const { db } = ctx;
  const p = await prepareReview(ctx, a, input);
  if (p.problems.length) throw badRequest(p.problems.join(" "), p.problems);
  const { template, rows, snapshot, targetFolderId } = p;
  const now = new Date();
  const due = enterStep(snapshot, null, 0, now, null);
  const { review, instance } = await db.transaction(async (tx) => {
    const [m] = await tx.select({ n: max(reviews.number) }).from(reviews).where(eq(reviews.projectId, a.project.id));
    const code = p.codePrefix ? applyCounter(p.codePrefix, await nextReviewCounter(tx, a.project.id, p.codePrefix)) : null;
    const [review] = await tx
      .insert(reviews)
      .values({
        projectId: a.project.id,
        number: (m?.n ?? 0) + 1,
        name: input.name?.trim() || code!,
        note: input.note ?? null,
        targetFolderId,
        targetPattern: p.targetPattern,
        targetFallback: p.targetFallback,
        code,
        createdBy: a.user.id,
      })
      .returning();
    await tx.insert(reviewFiles).values(
      rows.map((r) => ({
        reviewId: review!.id,
        fileId: r.files.id,
        fileVersionId: r.file_versions.id,
        sourceFolderId: r.files.folderId,
      })),
    );
    const [instance] = await tx
      .insert(workflowInstances)
      .values({
        projectId: a.project.id,
        kind: "review",
        templateId: template.id,
        template: snapshot,
        subjectType: SUBJECT_REVIEW,
        subjectId: review!.id,
        stepIndex: 0,
        status: "running",
        stepStartedAt: now,
        stepDueAt: due.stepDueAt,
        stageDueAt: due.stageDueAt,
        startedBy: a.user.id,
      })
      .returning();
    await tx.insert(workflowActions).values({
      instanceId: instance!.id,
      stepIndex: 0,
      kind: "start",
      userId: a.user.id,
      comment: input.note ?? null,
      details: { files: rows.length, template: template.name, targetFolderId, targetPattern: p.targetPattern, code },
    });
    return { review: review!, instance: instance! };
  });

  await audit(db, {
    projectId: a.project.id,
    userId: a.user.id,
    action: "review.started",
    targetType: "review",
    targetId: review.id,
    details: {
      number: review.number,
      code: review.code,
      name: review.name,
      files: rows.length,
      template: template.name,
      targetFolderId,
      targetPattern: p.targetPattern,
    },
  });
  await notifyStepAssignees(db, review, instance);
  return { review, instance };
}
