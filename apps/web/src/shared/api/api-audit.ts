/** API client of the audit log (docs/features/AUDIT_LOG.md): project log, file history, chain check. */
import type { AuditPageDto, AuditVerifyDto } from "@sitekeep/shared";
import { currentLanguage } from "../../i18n";
import { request } from "./client";

export interface AuditFilter {
  from?: string;
  to?: string;
  /** Exact action or a prefix such as "file.*". */
  action?: string;
  userId?: string;
  targetType?: string;
  targetId?: string;
}

export function auditQuery(f: AuditFilter, page: { cursor?: number | null; limit?: number } = {}): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v) q.set(k, v);
  if (page.cursor) q.set("cursor", String(page.cursor));
  if (page.limit) q.set("limit", String(page.limit));
  return q.toString();
}

export const auditApi = {
  project: (pid: string, f: AuditFilter, cursor?: number | null, limit = 50) =>
    request<AuditPageDto>("GET", `/projects/${pid}/audit?${auditQuery(f, { cursor, limit })}`),
  /** Column names in the interface language. */
  projectCsvUrl: (pid: string, f: AuditFilter) => `/api/v1/projects/${pid}/audit.csv?${auditQuery(f)}&lang=${currentLanguage()}`,
  fileHistory: (pid: string, fileId: string, cursor?: number | null, limit = 20) =>
    request<AuditPageDto>("GET", `/projects/${pid}/files/${fileId}/history?${auditQuery({}, { cursor, limit })}`),
  /** System administrators only. */
  verify: () => request<AuditVerifyDto>("GET", "/admin/audit/verify"),
};
