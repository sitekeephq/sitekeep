/** Work links, delivery, detail, timeline, and today contracts. */
import type { MyTaskDto } from "../workflow/workflow.js";
import type { WorkBuildDto } from "./build-works.js";
import type { LetterData } from "./letters.js";
import type { TransmittalPurpose } from "./work-catalog.js";
import type { WorkSummaryDto } from "./work-summary.js";
export type { WorkSummaryDto } from "./work-summary.js";
import type { WorkFieldValues } from "./work-fields.js";

// ---- Links, delivery, DTOs ------------------------------------------------------------------

export const WORK_LINK_KINDS = ["file_version", "review", "issue", "work"] as const;
export type WorkLinkKind = (typeof WORK_LINK_KINDS)[number];

/** ilgi = reference (a reply is an "ilgi" with meta.reply), ek = attachment, kaynak = origin (e.g. review), kapak = cover PDF. */
export const WORK_LINK_ROLES = ["ilgi", "ek", "kaynak", "kapak"] as const;
export type WorkLinkRole = (typeof WORK_LINK_ROLES)[number];
export const WORK_LINK_ROLE_LABELS_TR: Record<WorkLinkRole, string> = {
  ilgi: "İlgi",
  ek: "Ek",
  kaynak: "Kaynak",
  kapak: "Kapak",
};

export interface WorkLinkMeta {
  /** Attachment is an e-signed (PAdES) PDF. Only recorded; no signature check yet. */
  signed?: boolean;
  /** "ilgi" link created by "Cevap yaz": sending this work answers the target. */
  reply?: boolean;
}

export interface WorkLinkTargetDto {
  /** Display text, e.g. "A-101.pdf" or "PKF-GLN-2026-0004 Konu". */
  label: string;
  /** Web app path to open the target. */
  link: string | null;
  /** file_version: version number, file id, revision attribute. */
  version?: number;
  fileId?: string;
  revision?: string | null;
  status?: string;
  /** Target is gone or not visible to the caller. */
  missing?: boolean;
}

export interface WorkLinkDto {
  id: string;
  kind: WorkLinkKind;
  targetId: string;
  role: WorkLinkRole;
  meta: WorkLinkMeta;
  createdAt: string;
  /** Link points at this work (only in incoming lists). */
  incoming?: boolean;
  /** For incoming links: the work that holds the link. */
  sourceWorkId?: string;
  target: WorkLinkTargetDto;
}

export const DELIVERY_STATUSES = ["pending", "sent", "delivered", "failed"] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];
export const DELIVERY_STATUS_LABELS_TR: Record<DeliveryStatus, string> = {
  pending: "Hazırlanıyor",
  sent: "Gönderildi",
  delivered: "Teslim Edildi",
  failed: "Teslim Edilemedi",
};

export interface DeliveryChannelDto {
  id: string;
  label: string;
  /** The channel needs a user-entered reference (e.g. KEP gönderim no). */
  manual: boolean;
  /** Sending requires at least one attachment marked as e-signed PDF. */
  requiresSignedPdf: boolean;
  description: string;
}

export interface WorkDeliveryDto {
  channel: string;
  channelLabel?: string;
  status: DeliveryStatus;
  /** KEP gönderim no / e-posta message id / elden teslim tutanak no. */
  reference: string | null;
  note: string | null;
  sentAt: string | null;
  sentBy: string | null;
  updatedAt: string | null;
}

export interface WorkReceiptDto {
  companyId: string;
  companyName?: string;
  receivedAt: string;
  receivedBy: string;
  receivedByName?: string;
}

export type WorkEventKind =
  | "created"
  | "updated"
  | "status"
  | "linked"
  | "unlinked"
  | "sent"
  | "delivery"
  | "received"
  | "replied"
  | "answered"
  | "comment"
  | "cover_pdf"
  | "submitted"
  | "responded"
  | "decided"
  | "revised"
  | "cancelled"
  | "minutes"
  | "archived"
  | "reopened"
  | "letter"
  | "letter_pdf"
  | "mail";

export interface WorkEventDto {
  id: string;
  kind: WorkEventKind;
  userId: string | null;
  userName?: string;
  message: string | null;
  details: Record<string, unknown> | null;
  at: string;
}

export interface WorkDetailDto extends WorkSummaryDto {
  fields: WorkFieldValues;
  ownerCompanyId: string | null;
  delivery: WorkDeliveryDto | null;
  receipts: WorkReceiptDto[];
  links: WorkLinkDto[];
  /** Links in other visible works that point at this one (replies, references). */
  backlinks: WorkLinkDto[];
  events: WorkEventDto[];
  workflowInstanceId: string | null;
  canEdit: boolean;
  canSend: boolean;
  /** The caller's company is a recipient and has not confirmed receipt yet. */
  canReceive: boolean;
  canReply: boolean;
  /** Display names of companies and users referenced by the work. */
  names: Record<string, string>;
  /** Type-specific structured data (meeting agenda and minutes, submittal revision…). */
  data?: Record<string, unknown>;
  /** RFI / submittal / meeting extras: revisions, workflow chain, minutes (build-works.ts). */
  build?: WorkBuildDto | null;
  /** Correspondence: official letter data (works.data.letter with defaults) and actions. */
  letter?: WorkLetterInfoDto | null;
}

/** Letter part of a correspondence work's detail. */
export interface WorkLetterInfoDto {
  data: LetterData;
  /** Works reachable through "ilgi" links in both directions, without this one. */
  threadCount: number;
  /** Outgoing letter: the official PDF can be previewed / is stored on sending. */
  pdf: boolean;
  canArchive: boolean;
  canCancel: boolean;
  canReopen: boolean;
  canDelete: boolean;
  /** Letter texts may be edited (draft, or an incoming registration that is not archived/cancelled). */
  canEditLetter: boolean;
  /** SMTP is configured: "E-posta gönder" sends from the server. */
  smtp: boolean;
}

export interface WorkThreadItemDto extends WorkSummaryDto {
  /** Works this one references with "ilgi" (inside the thread). */
  refs: string[];
}

// ---- "Bugün" --------------------------------------------------------------------------------

export interface TodayWorkDto extends WorkSummaryDto {
  projectCode: string;
  projectName: string;
  link: string;
}

export interface TodayDto {
  /** Open works assigned to me. */
  assigned: TodayWorkDto[];
  /** Letters addressed to my company ("gereği") that ask for a reply. */
  awaitingReply: TodayWorkDto[];
  /** Transmittals / letters sent to my company that I have not confirmed yet. */
  toReceive: TodayWorkDto[];
  /** My open works due in the next 2 days. */
  dueSoon: TodayWorkDto[];
  overdue: TodayWorkDto[];
  /** Review steps waiting for me (same data as /my-tasks). */
  tasks: MyTaskDto[];
  /** New versions in followed folders; null until folder following exists. */
  newVersions: null;
  counts: {
    assigned: number;
    awaitingReply: number;
    toReceive: number;
    dueSoon: number;
    overdue: number;
    tasks: number;
    total: number;
  };
}

/** Days before the due date when a work counts as "due soon". */
export const WORK_DUE_SOON_DAYS = 2;

/** Workflow template options for works (stored next to, not inside, workflow templates). */
export interface WorkAutomationDto {
  templateId: string;
  templateName: string;
  /** Create a transmittal when a review that used this template completes. */
  autoTransmittal: boolean;
  /** Recipient companies; empty = the company of the person who started the review. */
  recipientCompanyIds: string[];
  purpose: TransmittalPurpose;
  /** Send right away (cover PDF + notification) or leave as draft. */
  send: boolean;
  /** Only approved files (default) or every file of the review. */
  include: "approved" | "all";
}
