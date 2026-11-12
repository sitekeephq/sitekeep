import { chainText } from "@sitekeep/shared";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { DEFAULT_LANGUAGE } from "../i18n/index.js";
import { reviewFiles, reviews, workflowInstances } from "../db/schema.js";
import { fileChain, hasStages } from "./chain.js";
import {
  SUBJECT_REVIEW,
  type ApprovalRow,
  type InstanceRow,
  type ReviewRow,
} from "./review-types.js";

type ReviewFileRow = typeof reviewFiles.$inferSelect;

function chainOf(instance: InstanceRow, rf: ReviewFileRow, lang: string): { chain: string | null; chainFull: string | null } {
  if (!hasStages(instance.template)) return { chain: null, chainFull: null };
  const cells = fileChain(instance.template, instance, rf, new Date(), lang);
  return { chain: chainText(cells, true), chainFull: chainText(cells) };
}

/** Every non-cancelled review decision touching the given versions (as source or as approved copy). */
export async function approvalHistory(db: Db, projectId: string, versionIds: string[], lang: string = DEFAULT_LANGUAGE): Promise<ApprovalRow[]> {
  if (!versionIds.length) return [];
  const ids = new Set(versionIds);
  const instanceJoin = and(eq(workflowInstances.subjectType, SUBJECT_REVIEW), eq(workflowInstances.subjectId, reviews.id));
  const rows = await db
    .select({ rf: reviewFiles, r: reviews, i: workflowInstances })
    .from(reviewFiles)
    .innerJoin(reviews, eq(reviews.id, reviewFiles.reviewId))
    .innerJoin(workflowInstances, instanceJoin)
    .where(and(eq(reviews.projectId, projectId), inArray(reviewFiles.fileVersionId, versionIds)))
    .orderBy(desc(reviews.createdAt));
  const copies = await db
    .select({ rf: reviewFiles, r: reviews, i: workflowInstances })
    .from(reviewFiles)
    .innerJoin(reviews, eq(reviews.id, reviewFiles.reviewId))
    .innerJoin(workflowInstances, instanceJoin)
    .where(and(eq(reviews.projectId, projectId), inArray(reviewFiles.copiedVersionId, versionIds)));
  const out: ApprovalRow[] = [];
  const reviewName = (review: ReviewRow) =>
    review.code && review.code !== review.name ? `${review.code} ${review.name}` : review.name;
  for (const { rf, r, i } of rows) {
    if (i.status === "cancelled") continue;
    const returned = rf.stoppedAtStep !== null && rf.stoppedAtStep !== undefined;
    const status = i.status === "running" && !returned ? "in_review" : rf.finalStatus;
    if (!status || !ids.has(rf.fileVersionId)) continue;
    out.push({
      versionId: rf.fileVersionId,
      status,
      reviewId: r.id,
      reviewNumber: r.number,
      reviewName: reviewName(r),
      decidedAt: rf.decidedAt?.toISOString() ?? null,
      isCopy: false,
      at: (rf.decidedAt ?? r.createdAt).getTime(),
      label: status === "in_review" ? null : rf.finalLabel,
      ...chainOf(i, rf, lang),
    });
  }
  for (const { rf, r, i } of copies) {
    if (!rf.copiedVersionId || !rf.finalStatus) continue;
    out.push({
      versionId: rf.copiedVersionId,
      status: rf.finalStatus,
      reviewId: r.id,
      reviewNumber: r.number,
      reviewName: reviewName(r),
      decidedAt: rf.decidedAt?.toISOString() ?? null,
      isCopy: true,
      at: (rf.decidedAt ?? r.createdAt).getTime(),
      label: rf.finalLabel,
      ...chainOf(i, rf, lang),
    });
  }
  return out.sort((x, y) => y.at - x.at);
}

/** Latest approval status per version (running reviews show as "in_review"). */
export async function latestApprovals(db: Db, projectId: string, versionIds: string[], lang: string = DEFAULT_LANGUAGE) {
  const latest = new Map<string, ApprovalRow>();
  for (const row of await approvalHistory(db, projectId, versionIds, lang)) {
    const current = latest.get(row.versionId);
    if (
      !current ||
      (row.status === "in_review" && current.status !== "in_review") ||
      (current.status !== "in_review" && row.at > current.at)
    )
      latest.set(row.versionId, row);
  }
  return latest;
}
