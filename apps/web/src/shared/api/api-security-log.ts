/**
 * Security log, security alerts and the audit log of every project (docs/features/SECURITY_LOG.md).
 * System administrators and auditors read; only administrators change alert settings and handle alerts.
 */
import type { AuditPageDto, SecurityAlertDto, SecurityAlertSettings, SecurityAlertSettingsDto, SecurityAlertStatus, SecurityLogCategory } from "@sitekeep/shared";
import { currentLanguage } from "../../i18n";
import { get, post, put } from "./client";

export interface SecurityLogFilter {
  type?: SecurityLogCategory;
  userId?: string;
  from?: string;
  to?: string;
  /** Exact, or the beginning of an address ("10.0.4."). */
  ip?: string;
  /** One audit row (an alert's). */
  id?: number;
}

/** Filters of the audit log of every project (GET /admin/audit). */
export interface AllEventsFilter {
  projectId?: string;
  userId?: string;
  from?: string;
  to?: string;
  /** Exact action or a prefix such as "file.*". */
  action?: string;
}

function query(f: object, page: { cursor?: number | null; limit?: number } = {}): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  if (page.cursor) q.set("cursor", String(page.cursor));
  if (page.limit) q.set("limit", String(page.limit));
  return q.toString();
}

export const securityLogApi = {
  page: (f: SecurityLogFilter, cursor?: number | null, limit = 50) => get<AuditPageDto>(`/admin/security-log?${query(f, { cursor, limit })}`),
  /** Column names in the interface language. */
  csvUrl: (f: SecurityLogFilter) => `/api/v1/admin/security-log.csv?${query({ ...f, lang: currentLanguage() })}`,
  allEvents: (f: AllEventsFilter, cursor?: number | null, limit = 50) => get<AuditPageDto>(`/admin/audit?${query(f, { cursor, limit })}`),
  allEventsCsvUrl: (f: AllEventsFilter) => `/api/v1/admin/audit.csv?${query({ ...f, lang: currentLanguage() })}`,
  projects: () => get<{ id: string; code: string; name: string }[]>("/admin/audit/projects"),

  alerts: (status: SecurityAlertStatus | "all" = "open", limit = 100) => get<SecurityAlertDto[]>(`/admin/security-alerts?status=${status}&limit=${limit}`),
  acknowledge: (id: string) => post<{ ok: true }>(`/admin/security-alerts/${id}/acknowledge`),
  dismiss: (id: string) => post<{ ok: true }>(`/admin/security-alerts/${id}/dismiss`),
  alertSettings: () => get<SecurityAlertSettingsDto>("/admin/security-alerts/settings"),
  saveAlertSettings: (s: Partial<SecurityAlertSettings>) => put<SecurityAlertSettingsDto>("/admin/security-alerts/settings", s),
};
