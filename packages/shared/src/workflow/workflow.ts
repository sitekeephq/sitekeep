/**
 * Workflow engine vocabulary shared by the server, the web app and the MCP server.
 *
 * One engine drives reviews now and RFIs, submittals and transmittals later:
 * record → steps (person / company / role) → days → outcome code → state change → notification.
 */

import type { AttributeAssigneeRule, ChainCellDto, OutcomeOption, ReviewChainConfig } from "./review-chains.js";
import type { AttributeDefinitionDto } from "../kernel/attributes.js";
import type { OnBehalfOfDto } from "./roles.js";
import type { AssigneeType } from "./assignee-types.js";

export type { AssigneeType } from "./assignee-types.js";

export const WORKFLOW_KINDS = ["review", "rfi", "submittal", "transmittal", "form", "progress_payment"] as const;
export type WorkflowKind = (typeof WORKFLOW_KINDS)[number];

export const WORKFLOW_KIND_LABELS_TR: Record<WorkflowKind, string> = {
  review: "Doküman İncelemesi",
  rfi: "Bilgi Talebi",
  submittal: "Teknik Onay",
  transmittal: "Gönderim Formu",
  form: "Form Onayı",
  progress_payment: "Hakediş Onayı",
};

export * from "./workflow-primitives.js";
import {
  OUTCOME_LABELS_TR,
  type OutcomeCode,
  type StepRule,
  type WorkflowAssignee,
} from "./workflow-primitives.js";

export interface WorkflowStep {
  name: string;
  assignees: WorkflowAssignee[];
  rule: StepRule;
  /** Calendar days for this step; 0 = no due date. */
  days: number;
  /** Outcomes allowed in this step (base codes; derived from outcomeOptions when those are set). */
  outcomes: OutcomeCode[];
  // ---- Review chains (review-chains.ts); all optional ----
  /** Custom, e.g. party-labelled answers; the engine uses their kind. */
  outcomeOptions?: OutcomeOption[];
  /** Index into the template's chain stages. */
  stage?: number;
  /** Assignees picked by a file field when the review starts (added to `assignees`). */
  assigneeRule?: AttributeAssigneeRule;
  /** Set on the running snapshot: the field value(s) the rule resolved with. */
  resolvedBy?: { attribute: string; values: string[] };
  /** Attribute names the reviewer must fill before submitting; written to the file. */
  requiredAttributes?: string[];
  // ---- Form flows (form-pdf.ts); all optional ----
  /** Form item ids the step's assignees fill or sign: only they may change them, and only in this step. */
  formFields?: string[];
  /** Form flows: a revise / reject answer sends the form back to this step (index); absent = back to the filler as a draft. */
  returnTo?: number | null;
}

/** Maps the outcome of the last step to the final status (missing = same code). */
export type FinalOutcomeMap = Partial<Record<OutcomeCode, OutcomeCode>>;

export interface WorkflowTemplateDto {
  id: string;
  projectId: string;
  kind: WorkflowKind;
  name: string;
  steps: WorkflowStep[];
  finalOutcomes: FinalOutcomeMap;
  /** Stages, origin party, number pattern and copy rule (review chains). */
  chain: ReviewChainConfig;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export type WorkflowStatus = "running" | "completed" | "cancelled";

export const WORKFLOW_STATUS_LABELS_TR: Record<WorkflowStatus, string> = {
  running: "Devam Ediyor",
  completed: "Tamamlandı",
  cancelled: "İptal Edildi",
};

/** Approval status of a file version: a final outcome, or "in_review" while a review runs. */
export type ApprovalStatus = OutcomeCode | "in_review";

export const APPROVAL_STATUS_LABELS_TR: Record<ApprovalStatus, string> = {
  ...OUTCOME_LABELS_TR,
  in_review: "İncelemede",
};

export interface VersionApprovalDto {
  versionId: string;
  status: ApprovalStatus;
  reviewId: string;
  reviewNumber: number;
  reviewName: string;
  decidedAt: string | null;
  /** True when this version is the approved copy in the target folder. */
  isCopy?: boolean;
  /** Custom label of the status ("İDARE ŞARTLI ONAYLANDI"). */
  label?: string | null;
  /** Compact chain status ("T✓ Y✓ M⧗ İ·") and the full text. */
  chain?: string | null;
  chainFull?: string | null;
}

export interface ReviewSummaryDto {
  id: string;
  projectId: string;
  number: number;
  name: string;
  status: WorkflowStatus;
  templateName: string;
  stepIndex: number;
  stepCount: number;
  stepName: string | null;
  stepDueAt: string | null;
  fileCount: number;
  startedBy: string;
  startedByName?: string;
  createdAt: string;
  completedAt: string | null;
  /** The caller can act on the current step. */
  myTurn?: boolean;
  /** Generated review number from the template's pattern, e.g. "MBE-RP-0007". */
  code?: string | null;
  /** The current step is past its due date. */
  overdue?: boolean;
}

export interface ReviewFileDto {
  id: string;
  fileId: string;
  fileVersionId: string;
  fileName: string;
  version: number;
  sourceFolderId: string;
  /** Combined outcome of each finished step, by step index. */
  stepResults: Record<string, OutcomeCode>;
  finalStatus: OutcomeCode | null;
  copiedFileId: string | null;
  copiedVersionId: string | null;
  copyError: string | null;
  /** Code given per step (custom outcome code or the base code). */
  stepCodes?: Record<string, string>;
  /** Display label per step. */
  stepLabels?: Record<string, string>;
  /** Display label of the final status ("İDARE ŞARTLI ONAYLANDI"). */
  finalLabel?: string | null;
  /** Step where the chain stopped for this file (sent back to the originator). */
  stoppedAtStep?: number | null;
  /** Per-stage status: Tasarımcı ✓ → Yüklenici ✓ → Müşavir ⧗ → İdare ·. */
  chain?: ChainCellDto[];
  /** Folder the approved copy goes to / went to (smart copy target). */
  targetPath?: string | null;
  /** Pattern fields that could not be filled for this file. */
  copyUnresolved?: string[];
  /** Current attributes of the file (for required attributes during review). */
  attributes?: Record<string, string>;
}

export interface ReviewMarkDto {
  reviewFileId: string;
  stepIndex: number;
  userId: string;
  userName?: string;
  outcome: OutcomeCode;
  /** Custom outcome code and its label. */
  code?: string;
  label?: string;
  comment: string | null;
  at: string;
  /** Teams / companies the reviewer answered for ("ekip adına"). */
  onBehalfOf?: OnBehalfOfDto[];
}

export type WorkflowActionKind = "start" | "submit" | "step_completed" | "completed" | "cancel" | "reassign" | "note";

export interface WorkflowActionDto {
  id: string;
  kind: WorkflowActionKind;
  stepIndex: number;
  userId: string | null;
  userName?: string;
  outcome: OutcomeCode | null;
  comment: string | null;
  details: Record<string, unknown> | null;
  at: string;
  /** Submit actions: teams / companies the person answered for. */
  onBehalfOf?: OnBehalfOfDto[];
}

export interface ReviewDetailDto extends ReviewSummaryDto {
  note: string | null;
  targetFolderId: string | null;
  targetFolderPath: string | null;
  steps: WorkflowStep[];
  finalOutcomes: FinalOutcomeMap;
  files: ReviewFileDto[];
  marks: ReviewMarkDto[];
  actions: WorkflowActionDto[];
  /** Users who already answered the current step. */
  submittedBy: string[];
  canAct: boolean;
  canCancel: boolean;
  canReassign: boolean;
  /** Display names of users, companies and project roles referenced by the steps. */
  names: Record<string, string>;
  /** Chain options of the snapshot (stages, origin party, patterns). */
  chain?: ReviewChainConfig;
  /** Sub-folder pattern under the target folder. */
  targetPattern?: string | null;
  /** Definitions of the attributes the steps require (by name; missing = free text). */
  attributeDefinitions?: AttributeDefinitionDto[];
  /** When the caller can act: the teams / companies their answer will be recorded for. */
  actingFor?: OnBehalfOfDto[];
}

export interface NotificationDto {
  id: string;
  projectId: string | null;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface MyTaskDto {
  projectId: string;
  projectCode: string;
  projectName: string;
  kind: WorkflowKind;
  subjectId: string;
  number: number;
  name: string;
  stepIndex: number;
  stepName: string;
  stepDueAt: string | null;
  overdue: boolean;
  link: string;
  /** Work tasks (RFI, submittal): the work number, e.g. "CNS_HLL_M_RFI_001". */
  code?: string | null;
}

export interface FolderSettingsDto {
  folderId: string;
  /** Set on this folder. */
  requireApprovedReview: boolean;
  /** Effective: set here or on a parent folder. */
  gated: boolean;
  /** Name of the folder the gate comes from when inherited. */
  gatedBy: string | null;
}
