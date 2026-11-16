/** API client for Yönetim → Gizlilik Merkezi (docs/features/PRIVACY.md). */
import type {
  AnonymiseResultDto,
  OutboundLogPageDto,
  PersonalDataExportDto,
  PrivacyConnectionDto,
  PrivacyNoticeAdminDto,
  PrivacyNoticePublicDto,
  PrivacyNoticeSettings,
  PrivacySettingsDto,
  PrivacySummaryDto,
  UserDto,
} from "@sitekeep/shared";
import { request } from "./client";

export interface OutboundFilter {
  purpose?: string;
  host?: string;
  from?: string;
  to?: string;
  blocked?: boolean;
}

export function outboundQuery(f: OutboundFilter, extra: Record<string, string | number> = {}): string {
  const q = new URLSearchParams();
  if (f.purpose) q.set("purpose", f.purpose);
  if (f.host) q.set("host", f.host);
  if (f.from) q.set("from", f.from);
  if (f.to) q.set("to", f.to);
  if (f.blocked) q.set("blocked", "true");
  for (const [k, v] of Object.entries(extra)) q.set(k, String(v));
  return q.toString();
}

/** Fired after the kill switch changed, so the admin banner refreshes. */
export const PRIVACY_CHANGED_EVENT = "cde:privacy-changed";

export const privacyApi = {
  summary: () => request<PrivacySummaryDto>("GET", "/admin/privacy"),
  status: () => request<{ killSwitch: boolean }>("GET", "/admin/privacy/status"),
  saveSettings: (s: Partial<PrivacySettingsDto>) => request<PrivacySummaryDto>("PUT", "/admin/privacy/settings", s),
  setKillSwitch: (on: boolean) => request<PrivacySummaryDto>("PUT", "/admin/privacy/kill-switch", { on }),
  connections: () => request<PrivacyConnectionDto[]>("GET", "/admin/privacy/connections"),
  setConnection: (id: string, enabled: boolean) =>
    request<PrivacyConnectionDto[]>("PUT", `/admin/privacy/connections/${encodeURIComponent(id)}`, { enabled }),
  outbound: (f: OutboundFilter, limit: number, offset: number) =>
    request<OutboundLogPageDto>("GET", `/admin/privacy/outbound?${outboundQuery(f, { limit, offset })}`),
  csvUrl: (f: OutboundFilter) => `/api/v1/admin/privacy/outbound.csv?${outboundQuery(f)}`,
  notice: () => request<PrivacyNoticeAdminDto>("GET", "/admin/privacy/notice"),
  saveNotice: (s: Partial<PrivacyNoticeSettings>) => request<PrivacyNoticeAdminDto>("PUT", "/admin/privacy/notice", s),
  /** Signed out: the notice of the sign-in and invitation pages (docs/features/PRIVACY_NOTICE.md). */
  publicNotice: () => request<PrivacyNoticePublicDto>("GET", "/auth/privacy-notice"),
};

/** Data subject rights (docs/features/DATA_SUBJECT_RIGHTS.md): export, anonymise, e-mail correction. */
export const subjectApi = {
  exports: (userId: string) => request<PersonalDataExportDto[]>("GET", `/admin/users/${userId}/data-exports`),
  requestExport: (userId: string, includeFiles: boolean) =>
    request<PersonalDataExportDto>("POST", `/admin/users/${userId}/data-exports`, { includeFiles }),
  downloadUrl: (exportId: string) => `/api/v1/admin/data-exports/${exportId}/download`,
  anonymise: (userId: string, confirmEmail: string) => request<AnonymiseResultDto>("POST", `/admin/users/${userId}/anonymise`, { confirmEmail }),
  changeEmail: (userId: string, email: string) => request<UserDto>("PUT", `/admin/users/${userId}/email`, { email }),
  myExports: () => request<PersonalDataExportDto[]>("GET", "/me/data-exports"),
  requestMyExport: (includeFiles: boolean) => request<PersonalDataExportDto>("POST", "/me/data-exports", { includeFiles }),
  myDownloadUrl: (exportId: string) => `/api/v1/me/data-exports/${exportId}/download`,
  disposalsCsvUrl: (lang: string) => `/api/v1/admin/privacy/disposals.csv?lang=${encodeURIComponent(lang)}`,
};
