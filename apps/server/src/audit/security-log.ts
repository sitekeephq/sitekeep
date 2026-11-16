/**
 * Security log (G-7, docs/features/SECURITY_LOG.md): the installation's security events, read from
 * the one audit log across every project and the rows written outside a project (sign-ins, users,
 * settings, connections). Each type of the filter is a list of actions (exact or "prefix.*") and,
 * for some, a condition on the details.
 */
import { and, eq, gte, inArray, like, lt, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { SECURITY_LOG_CATEGORIES, type SecurityLogCategory } from "@sitekeep/shared";
import { auditLog, auditPersonal } from "../db/schema.js";
import { badRequest } from "../core/platform/http.js";
import { msg } from "../i18n/index.js";

interface CategoryRule {
  /** Exact actions, or prefixes ending in ".*". */
  actions: string[];
  /** Only rows of these actions that also match (on top of `actions`). */
  where?: { actions: string[]; when: SQL }[];
}

/** `details` has this key (a changed flag in user.updated). */
const detailsHas = (key: string) => sql`(${auditLog.details} -> ${key}) IS NOT NULL`;

/**
 * What each type covers. A row may belong to more than one (user.updated that grants System
 * Administrator rights is both a user change and a permission change).
 */
export const SECURITY_LOG_ACTIONS: Record<SecurityLogCategory, CategoryRule> = {
  sign_in: { actions: ["auth.login", "auth.oidc_login", "auth.login_failed", "auth.locked", "auth.locks_cleared", "auth.sessions_ended", "auth.password_changed"] },
  two_factor: { actions: ["auth.two_factor_*"] },
  users: {
    actions: ["user.created", "user.updated", "user.anonymised", "user.email_changed", "user.data_exported", "user.data_export_downloaded", "audit.personal_erased", "invitation.accepted"],
  },
  permissions: {
    actions: ["member.*", "role.*", "role_package.applied", "folder.permissions_set", "folder.owner_team_set", "invitation.created", "invitation.revoked", "invitation.resent"],
    where: [{ actions: ["user.created", "user.updated"], when: sql`(${detailsHas("isAdmin")} OR ${detailsHas("isAuditor")})` }],
  },
  settings: {
    actions: [
      "auth.security_settings",
      "auth.google_settings",
      "auth.oidc_provider_*",
      "settings.*",
      "invitation.settings",
      "security.alert_settings",
      "license.installed",
      "license.removed",
      "cde.settings_updated",
      "project.modules_updated",
    ],
  },
  connections: { actions: ["privacy.kill_switch_on", "privacy.kill_switch_off", "privacy.connection_updated"] },
  api_access: {
    actions: [
      "auth.token_created",
      "oauth.authorize",
      "oauth.consent_granted",
      "oauth.consent_denied",
      "oauth.revoked",
      "oauth.client_created",
      "oauth.client_deleted",
      "oauth.client_secret_rotated",
      "oauth.code_reused",
      "oauth.refresh_reused",
    ],
  },
  audit: { actions: ["audit.*", "privacy.disposals_exported", "retention.completed", "trash.auto_purged", "project.closed", "project.reopened", "project.deleted"] },
  alerts: { actions: ["security.alert_*"] },
};

/** `action` matches one of the patterns (exact or "prefix.*"). */
function actionIn(patterns: string[]): SQL | undefined {
  const exact = patterns.filter((p) => !p.endsWith("*"));
  const prefixes = patterns.filter((p) => p.endsWith("*")).map((p) => `${p.slice(0, -1).replace(/[%_\\]/g, "\\$&")}%`);
  return or(exact.length ? inArray(auditLog.action, exact) : undefined, ...prefixes.map((p) => like(auditLog.action, p)));
}

function categoryWhere(c: SecurityLogCategory): SQL {
  const rule = SECURITY_LOG_ACTIONS[c];
  return or(actionIn(rule.actions), ...(rule.where ?? []).map((w) => and(actionIn(w.actions), w.when)))!;
}

/** Every security event (no type chosen). */
export function securityEventsWhere(): SQL {
  return or(...SECURITY_LOG_CATEGORIES.map(categoryWhere))!;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function parseTime(v: string | undefined, end: boolean): Date | undefined {
  if (!v) return undefined;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(v);
  const d = new Date(dateOnly ? `${v}T00:00:00Z` : v);
  if (Number.isNaN(d.getTime())) throw badRequest(msg("audit:errors.invalidTime", { value: v }));
  return dateOnly && end ? new Date(d.getTime() + DAY_MS) : d;
}

export const securityLogQuery = z.object({
  /** One type; empty = every security event. */
  type: z.enum(SECURITY_LOG_CATEGORIES as [SecurityLogCategory, ...SecurityLogCategory[]]).optional().or(z.literal("").transform(() => undefined)),
  /** Rows by the person or about them (target user). */
  userId: z.string().uuid().optional().or(z.literal("").transform(() => undefined)),
  from: z.string().trim().max(40).optional(),
  to: z.string().trim().max(40).optional(),
  /** Client IP address: exact, or the beginning of one ("10.0.4."). */
  ip: z
    .string()
    .trim()
    .max(64)
    .regex(/^[0-9a-fA-F.:]*$/)
    .optional(),
  /** One audit row (an alert links to the row that raised it). */
  id: z.coerce.number().int().positive().optional(),
  cursor: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  lang: z.string().max(10).optional(),
});
export type SecurityLogQuery = z.infer<typeof securityLogQuery>;

/** Conditions of a security log query. */
export function securityLogWhere(q: SecurityLogQuery): SQL {
  const from = parseTime(q.from, false);
  const to = parseTime(q.to, true);
  const ip = q.ip?.toLowerCase();
  const ipLike = ip ? (ip.endsWith(".") || ip.endsWith(":") ? `${ip}%` : ip) : null;
  return and(
    q.type ? categoryWhere(q.type) : securityEventsWhere(),
    q.id ? eq(auditLog.id, q.id) : undefined,
    from ? gte(auditLog.at, from) : undefined,
    to ? lt(auditLog.at, to) : undefined,
    q.userId ? or(eq(auditLog.userId, q.userId), and(eq(auditLog.targetType, "user"), eq(auditLog.targetId, q.userId))) : undefined,
    // The IP is in audit_personal while it is kept (P1-5); rows chained before 0049 still hold it.
    ipLike
      ? or(
          sql`EXISTS (SELECT 1 FROM ${auditPersonal} WHERE ${auditPersonal.auditId} = ${auditLog.id} AND lower(${auditPersonal.ip}) LIKE ${ipLike})`,
          sql`lower(${auditLog.ip}) LIKE ${ipLike}`,
        )
      : undefined,
  )!;
}
