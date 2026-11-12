import type { OutcomeCode } from "@sitekeep/shared";
import { reviews, workflowInstances } from "../db/schema.js";
import type { Db } from "../db/index.js";
import type { JobQueue } from "../jobs/queue.js";
import { msg, type Msg } from "../i18n/index.js";

export type ReviewRow = typeof reviews.$inferSelect;
export type InstanceRow = typeof workflowInstances.$inferSelect;

export const SUBJECT_REVIEW = "review";

export interface ReviewCtx {
  db: Db;
  jobs: JobQueue;
  /** Language of the requester (problem lists, preview texts); the installation default otherwise. */
  lang?: string;
}

export function reviewLink(projectId: string, reviewId: string) {
  return `/projects/${projectId}/reviews/${reviewId}`;
}

export function reviewLabel(r: Pick<ReviewRow, "number" | "name" | "code">): Msg {
  return r.code
    ? msg("workflow:messages.reviewLabelCode", { code: r.code, name: r.name })
    : msg("workflow:messages.reviewLabelNumber", { number: r.number, name: r.name });
}

export interface SubmitInput {
  comment?: string | null;
  /** outcome: a base code, or a custom outcome code of the step. */
  files: { reviewFileId: string; outcome: string; comment?: string | null }[];
  /** Values for the step's required attributes, per review file id. */
  attributes?: Record<string, Record<string, string>>;
}

export interface CopyReport {
  approved: number;
  copied: number;
  failed: number;
  results: {
    name: string;
    ok: boolean;
    error?: string;
    fileId?: string;
    version?: number;
    /** Folder the copy landed in. */
    path?: string;
    /** Target pattern fields missing for this file. */
    unresolved?: string[];
  }[];
  /** Folders created for the smart copy target. */
  createdFolders?: string[];
}

export interface ApprovalRow {
  versionId: string;
  status: OutcomeCode | "in_review";
  reviewId: string;
  reviewNumber: number;
  reviewName: string;
  decidedAt: string | null;
  isCopy: boolean;
  at: number;
  label: string | null;
  chain: string | null;
  chainFull: string | null;
}
