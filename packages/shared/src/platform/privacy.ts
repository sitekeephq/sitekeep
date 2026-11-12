/**
 * Gizlilik Merkezi (Yönetim): what leaves the server, which connections exist, the outbound log
 * and the "Tüm Dış Bağlantıları Kapat" switch. docs/features/GIZLILIK.md.
 */
import { SHARED_DEFAULT_LANGUAGE, sharedText } from "./i18n.js";

export type PrivacyAiMode = "off" | "local_only" | "allow_external";

export interface PrivacySettingsDto {
  logRetentionDays: number;
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

export type PrivacyConnectionKind = "ai" | "smtp" | "office" | "mcp" | "ai_queue" | "oauth";

export interface PrivacyConnectionDto {
  /** "ai:<providerId>", "ai:env", "smtp", "office:editor", "office:converter", "mcp", "ai_queue", "oauth". */
  id: string;
  kind: PrivacyConnectionKind;
  name: string;
  /** host[:port]; null when not configured or inbound only. */
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
