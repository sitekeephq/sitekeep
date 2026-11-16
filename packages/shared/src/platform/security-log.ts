/**
 * Administration → Security Log and security alerts (docs/features/SECURITY_LOG.md): the
 * installation's security events from the audit log, alert rules with their thresholds, and the
 * read-only auditor role.
 */

/** Groups of the security log's "type" filter (the actions of each: apps/server/src/audit/security-log.ts). */
export type SecurityLogCategory = "sign_in" | "two_factor" | "users" | "permissions" | "settings" | "connections" | "api_access" | "audit" | "alerts";

export const SECURITY_LOG_CATEGORIES: readonly SecurityLogCategory[] = [
  "sign_in",
  "two_factor",
  "users",
  "permissions",
  "settings",
  "connections",
  "api_access",
  "audit",
  "alerts",
];

/** Rules that raise a security alert. */
export type SecurityAlertRule =
  | "failed_sign_ins_account"
  | "failed_sign_ins_global"
  | "bulk_download"
  | "new_admin"
  | "kill_switch_off"
  | "two_factor_off"
  | "audit_chain_broken";

export const SECURITY_ALERT_RULES: readonly SecurityAlertRule[] = [
  "failed_sign_ins_account",
  "failed_sign_ins_global",
  "bulk_download",
  "new_admin",
  "kill_switch_off",
  "two_factor_off",
  "audit_chain_broken",
];

export type SecurityAlertStatus = "open" | "acknowledged" | "dismissed";

export interface SecurityAlertSettings {
  /** Failed sign-ins for one account (user or e-mail address) within the window. */
  failedSignInsAccount: number;
  /** Failed sign-ins installation-wide within the window. */
  failedSignInsGlobal: number;
  /** Window of both failed sign-in rules, minutes. */
  failedSignInsWindowMinutes: number;
  /** Files one person downloads (single files and the files of ZIPs) within the window. */
  bulkDownloadFiles: number;
  /** Window of the bulk download rule, minutes. */
  bulkDownloadWindowMinutes: number;
  /** Rules switched off (every rule is on by default). */
  disabledRules: SecurityAlertRule[];
  /** Addresses that get an e-mail for each new alert (only when SMTP is configured and allowed). */
  emailTo: string[];
}

export const SECURITY_ALERT_DEFAULTS: SecurityAlertSettings = {
  failedSignInsAccount: 10,
  failedSignInsGlobal: 50,
  failedSignInsWindowMinutes: 15,
  bulkDownloadFiles: 200,
  bulkDownloadWindowMinutes: 60,
  disabledRules: [],
  emailTo: [],
};

/** Allowed range of each number (inclusive). */
export const SECURITY_ALERT_LIMITS = {
  failedSignInsAccount: [3, 1000],
  failedSignInsGlobal: [5, 100_000],
  failedSignInsWindowMinutes: [1, 1440],
  bulkDownloadFiles: [10, 1_000_000],
  bulkDownloadWindowMinutes: [5, 1440],
} as const satisfies Record<Exclude<keyof SecurityAlertSettings, "disabledRules" | "emailTo">, readonly [number, number]>;

/** At most this many alert e-mail recipients. */
export const SECURITY_ALERT_MAX_RECIPIENTS = 10;

/** Stored (possibly partial or out-of-range) settings → complete settings within the limits. */
export function normalizeSecurityAlertSettings(stored: Partial<SecurityAlertSettings> | null | undefined): SecurityAlertSettings {
  const out: SecurityAlertSettings = { ...SECURITY_ALERT_DEFAULTS, disabledRules: [], emailTo: [] };
  for (const [key, [min, max]] of Object.entries(SECURITY_ALERT_LIMITS) as [keyof typeof SECURITY_ALERT_LIMITS, readonly [number, number]][]) {
    const v = stored?.[key];
    if (typeof v === "number" && Number.isFinite(v)) out[key] = Math.min(max, Math.max(min, Math.round(v)));
  }
  if (Array.isArray(stored?.disabledRules)) out.disabledRules = [...new Set(stored.disabledRules.filter((r) => SECURITY_ALERT_RULES.includes(r)))];
  if (Array.isArray(stored?.emailTo))
    out.emailTo = [...new Set(stored.emailTo.map((e) => String(e).trim().toLowerCase()).filter(Boolean))].slice(0, SECURITY_ALERT_MAX_RECIPIENTS);
  return out;
}

/** GET /admin/security-alerts */
export interface SecurityAlertDto {
  id: string;
  rule: SecurityAlertRule;
  status: SecurityAlertStatus;
  createdAt: string;
  /** The latest event that matched the rule again while the alert was open. */
  lastSeenAt: string;
  /** Events that matched while the alert was open (1 = the one that raised it). */
  occurrences: number;
  /** The person concerned (failed sign-ins of an account, downloads, a new administrator). */
  userId: string | null;
  userName?: string;
  /** Counts, thresholds, windows, the audit row; never an IP address or an e-mail address. */
  details: Record<string, unknown>;
  /** Audit row that raised it (the security log can be filtered to it). */
  auditId: number | null;
  handledAt: string | null;
  handledByName?: string;
  /** E-mail sent to the configured addresses. */
  mailedAt: string | null;
}

/** GET /admin/security-alerts/settings: the settings and whether e-mail can be sent now. */
export interface SecurityAlertSettingsDto extends SecurityAlertSettings {
  /** null = e-mail can be sent; otherwise why not. */
  mail: null | "smtp_not_configured" | "smtp_disabled";
}
