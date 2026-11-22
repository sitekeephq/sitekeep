/**
 * Gizlilik Merkezi (Yönetim): what leaves the server, which connections exist, the outbound log
 * and the "Tüm Dış Bağlantıları Kapat" switch. docs/features/PRIVACY.md.
 */
import { SHARED_DEFAULT_LANGUAGE, sharedText } from "./i18n.js";

export type PrivacyAiMode = "off" | "local_only" | "allow_external";

/** Months the personal part of the audit log (IP, user agent, e-mail) is kept (Privacy Centre). */
export const AUDIT_PERSONAL_RETENTION = { default: 12, min: 1, max: 120 } as const;

/** Recycle bin auto-purge choices in days (null = off, the default). */
export const TRASH_PURGE_DAYS = [30, 90, 180, 365] as const;

/** Audit log retention in years (null = unlimited, the default; at least 1 year: ISO 19650, contracts). */
export const AUDIT_LOG_RETENTION = { min: 1, max: 50 } as const;

/** Finished personal data exports (ZIP) are deleted this many days after they were built. */
export const PERSONAL_EXPORT_KEEP_DAYS = 7;

/** What the daily retention job can delete (disposal record, docs/features/DATA_SUBJECT_RIGHTS.md). */
export type DisposalCategory =
  | "trash_files"
  | "trash_folders"
  | "audit_log"
  | "audit_personal"
  | "outbound_log"
  | "sessions"
  | "api_tokens"
  | "oauth_tokens"
  | "oauth_codes"
  | "oauth_refresh_tokens"
  | "invitations"
  | "personal_exports";

export interface PrivacySettingsDto {
  logRetentionDays: number;
  /** Personal part of the audit log (IP address, user agent, e-mail) is deleted after this many months. */
  auditPersonalRetentionMonths: number;
  /** Recycle bin items deleted for good this many days after they were deleted (null = never). */
  trashPurgeDays: number | null;
  /** Audit log rows deleted after this many years (null = kept for the life of the installation). */
  auditLogRetentionYears: number | null;
  /** "İç ağ" list: exact host, "*.firma.com.tr" or an IPv4 range "10.20.0.0/16". */
  lanHosts: string[];
  /** "Yerel Modelde de Maskele". */
  redactLocal: boolean;
  /** Replace project members' names with role and company. */
  redactNames: boolean;
}

export interface PrivacySummaryDto {
  /** Fixed statement shown first. */
  statement: string;
  killSwitch: { on: boolean; at: string | null; byName: string | null };
  ai: {
    /** Mode in force (the kill switch turns allow_external into local_only). */
    mode: PrivacyAiMode;
    /** Mode the administrator chose. */
    storedMode: PrivacyAiMode;
    /** Projects that consented to external AI (effective only in allow_external). */
    externalProjects: { id: string; code: string | null; name: string }[];
  };
  data: {
    database: string;
    storage: string;
  };
  settings: PrivacySettingsDto;
}

/** "auth": sign-in with Google; "module": a connection a module declared (registerPrivacyConnection). */
export type PrivacyConnectionKind = "ai" | "smtp" | "office" | "auth" | "module" | "mcp" | "ai_queue" | "oauth" | "license";

export interface PrivacyConnectionDto {
  /** "ai:<providerId>", "ai:env", "smtp", "office:editor", "office:converter", "google", a module's ("autodesk"), "mcp", "ai_queue", "oauth". */
  id: string;
  kind: PrivacyConnectionKind;
  name: string;
  /** host[:port] (several comma-separated); null when not configured or inbound only. */
  host: string | null;
  /** "local" = inside the network (private range or "iç ağ" list), "external" = outside, "inbound" = clients connect to the CDE. */
  location: "local" | "external" | "inbound";
  enabled: boolean;
  /** Toggle allowed here (OAuth apps are managed on their own page). */
  toggleable: boolean;
  /** ISO time of the last logged call (outbound connections). */
  lastUsedAt: string | null;
  /** Short facts ("Varsayılan", "3 erişim anahtarı", "Yazma anahtarları açık"…). */
  notes: string[];
}

export interface OutboundLogRowDto {
  id: string;
  at: string;
  purpose: string;
  connection: string | null;
  host: string;
  method: string;
  local: boolean;
  blocked: boolean;
  bytesOut: number | null;
  bytesIn: number | null;
  status: number | null;
  error: string | null;
  durationMs: number | null;
  userName: string | null;
  projectCode: string | null;
  details: Record<string, unknown> | null;
}

export interface OutboundLogPageDto {
  rows: OutboundLogRowDto[];
  total: number;
  /** Distinct purposes and hosts of the kept log (filter lists). */
  purposes: string[];
  hosts: string[];
}

/** The promise at the top of Gizlilik Merkezi. */
export function privacyStatement(lang: string = SHARED_DEFAULT_LANGUAGE): string {
  return sharedText(lang, "privacy.statement");
}

/** A personal data export of one user (P1-1, docs/features/DATA_SUBJECT_RIGHTS.md). */
export interface PersonalDataExportDto {
  id: string;
  userId: string;
  status: "queued" | "running" | "done" | "failed";
  requestedAt: string;
  finishedAt: string | null;
  /** ZIP size in bytes when done. */
  size: number | null;
  includeFiles: boolean;
  /** Deleted (with its ZIP) after this time. */
  expiresAt: string | null;
  error: string | null;
}

/** Result of "anonymise user" (P1-2). */
export interface AnonymiseResultDto {
  id: string;
  name: string;
  removed: { tokens: number; invitations: number; auditPersonal: number; outboundRows: number; importedAuthor: number };
}
