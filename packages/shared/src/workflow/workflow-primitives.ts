import type { AssigneeType } from "./assignee-types.js";

/** Leaf outcome and assignee vocabulary shared by workflow catalogs. */
export const OUTCOME_CODES = ["approved", "approved_with_comments", "reviewed", "revise_resubmit", "rejected"] as const;
export type OutcomeCode = (typeof OUTCOME_CODES)[number];

export const OUTCOME_LABELS_TR: Record<OutcomeCode, string> = {
  approved: "Onaylandı",
  approved_with_comments: "Notlu Onaylandı",
  reviewed: "Görüldü",
  revise_resubmit: "Revize Et, Tekrar Gönder",
  rejected: "Reddedildi",
};

export const OUTCOME_TONE: Record<OutcomeCode, "ok" | "info" | "warn" | "danger"> = {
  approved: "ok",
  approved_with_comments: "ok",
  reviewed: "info",
  revise_resubmit: "warn",
  rejected: "danger",
};

export const OUTCOME_SEVERITY: Record<OutcomeCode, number> = {
  approved: 0,
  approved_with_comments: 1,
  reviewed: 2,
  revise_resubmit: 3,
  rejected: 4,
};

export const APPROVED_OUTCOMES: readonly OutcomeCode[] = ["approved", "approved_with_comments"];

export function isOutcomeCode(v: unknown): v is OutcomeCode {
  return typeof v === "string" && (OUTCOME_CODES as readonly string[]).includes(v);
}

export function isApprovedOutcome(code: OutcomeCode | null | undefined): boolean {
  return !!code && APPROVED_OUTCOMES.includes(code);
}

export const WORKFLOW_ROLES = ["project_admin", "starter"] as const;
export type WorkflowRole = (typeof WORKFLOW_ROLES)[number];
export const WORKFLOW_ROLE_LABELS_TR: Record<WorkflowRole, string> = {
  project_admin: "Proje Yöneticileri",
  starter: "Akışı Başlatan",
};

export interface WorkflowAssignee {
  type: AssigneeType;
  id: string;
}

export type StepRule = "any" | "all";
export const STEP_RULE_LABELS_TR: Record<StepRule, string> = {
  any: "Biri Yeterli",
  all: "Herkes Yanıtlamalı",
};
